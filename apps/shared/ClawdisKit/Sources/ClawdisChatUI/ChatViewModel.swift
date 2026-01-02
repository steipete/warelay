import ClawdisKit
import Foundation
import Observation
import OSLog
import UniformTypeIdentifiers

#if canImport(AppKit)
import AppKit
#elseif canImport(UIKit)
import UIKit
#endif

private let chatUILogger = Logger(subsystem: "com.steipete.clawdis", category: "ClawdisChatUI")

@MainActor
@Observable
public final class ClawdisChatViewModel {
    public private(set) var messages: [ClawdisChatMessage] = []
    public var input: String = ""
    public var thinkingLevel: String = "off"
    public private(set) var isLoading = false
    public private(set) var isSending = false
    public private(set) var isAborting = false
    public var errorText: String?
    public var attachments: [ClawdisPendingAttachment] = []
    public private(set) var healthOK: Bool = false
    public private(set) var pendingRunCount: Int = 0

    public private(set) var sessionKey: String
    public private(set) var sessionId: String?
    public private(set) var streamingAssistantText: String?
    public private(set) var pendingToolCalls: [ClawdisChatPendingToolCall] = []
    public private(set) var sessions: [ClawdisChatSessionEntry] = []
    private let transport: any ClawdisChatTransport

    @ObservationIgnored
    private nonisolated(unsafe) var eventTask: Task<Void, Never>?
    private var pendingRuns = Set<String>() {
        didSet { self.pendingRunCount = self.pendingRuns.count }
    }

    @ObservationIgnored
    private nonisolated(unsafe) var pendingRunTimeoutTasks: [String: Task<Void, Never>] = [:]
    private let pendingRunTimeoutMs: UInt64 = 120_000

    private var pendingToolCallsById: [String: ClawdisChatPendingToolCall] = [:] {
        didSet {
            self.pendingToolCalls = self.pendingToolCallsById.values
                .sorted { ($0.startedAt ?? 0) < ($1.startedAt ?? 0) }
        }
    }

    private var lastHealthPollAt: Date?

    public init(sessionKey: String, transport: any ClawdisChatTransport) {
        self.sessionKey = sessionKey
        self.transport = transport

        self.eventTask = Task { [weak self] in
            guard let self else { return }
            let stream = self.transport.events()
            for await evt in stream {
                if Task.isCancelled { return }
                await MainActor.run { [weak self] in
                    self?.handleTransportEvent(evt)
                }
            }
        }
    }

    deinit {
        self.eventTask?.cancel()
        for (_, task) in self.pendingRunTimeoutTasks {
            task.cancel()
        }
    }

    public func load() {
        Task { await self.bootstrap() }
    }

    public func refresh() {
        Task { await self.bootstrap() }
    }

    public func send() {
        Task { await self.performSend() }
    }

    public func abort() {
        Task { await self.performAbort() }
    }

    public func refreshSessions(limit: Int? = nil) {
        Task { await self.fetchSessions(limit: limit) }
    }

    public func switchSession(to sessionKey: String) {
        Task { await self.performSwitchSession(to: sessionKey) }
    }

    public var sessionChoices: [ClawdisChatSessionEntry] {
        let now = Date().timeIntervalSince1970 * 1000
        let cutoff = now - (24 * 60 * 60 * 1000)
        let sorted = self.sessions.sorted { ($0.updatedAt ?? 0) > ($1.updatedAt ?? 0) }
        var seen = Set<String>()
        var recent: [ClawdisChatSessionEntry] = []
        for entry in sorted {
            guard !seen.contains(entry.key) else { continue }
            seen.insert(entry.key)
            guard (entry.updatedAt ?? 0) >= cutoff else { continue }
            recent.append(entry)
        }

        let mainKey = "main"
        var result: [ClawdisChatSessionEntry] = []
        var included = Set<String>()
        if let main = sorted.first(where: { $0.key == mainKey }) {
            result.append(main)
            included.insert(mainKey)
        } else if self.sessionKey == mainKey {
            result.append(self.placeholderSession(key: mainKey))
            included.insert(mainKey)
        }

        for entry in recent where !included.contains(entry.key) {
            result.append(entry)
            included.insert(entry.key)
        }

        if !included.contains(self.sessionKey) {
            result.append(self.placeholderSession(key: self.sessionKey))
        }

        return result
    }

    public func addAttachments(urls: [URL]) {
        Task { await self.loadAttachments(urls: urls) }
    }

    public func addImageAttachment(data: Data, fileName: String, mimeType: String) {
        Task { await self.addImageAttachment(url: nil, data: data, fileName: fileName, mimeType: mimeType) }
    }

    public func removeAttachment(_ id: ClawdisPendingAttachment.ID) {
        self.attachments.removeAll { $0.id == id }
    }

    public var canSend: Bool {
        let trimmed = self.input.trimmingCharacters(in: .whitespacesAndNewlines)
        return !self.isSending && self.pendingRunCount == 0 && (!trimmed.isEmpty || !self.attachments.isEmpty)
    }

    // MARK: - Internals

    private func bootstrap() async {
        self.isLoading = true
        self.errorText = nil
        self.healthOK = false
        self.clearPendingRuns(reason: nil)
        self.pendingToolCallsById = [:]
        self.streamingAssistantText = nil
        self.sessionId = nil
        defer { self.isLoading = false }
        do {
            do {
                try await self.transport.setActiveSessionKey(self.sessionKey)
            } catch {
                // Best-effort only; history/send/health still work without push events.
            }

            let payload = try await self.transport.requestHistory(sessionKey: self.sessionKey)
            self.messages = Self.decodeMessages(payload.messages ?? [])
            self.sessionId = payload.sessionId
            if let level = payload.thinkingLevel, !level.isEmpty {
                self.thinkingLevel = level
            }
            await self.pollHealthIfNeeded(force: true)
            await self.fetchSessions(limit: 50)
            self.errorText = nil
        } catch {
            self.errorText = error.localizedDescription
            chatUILogger.error("bootstrap failed \(error.localizedDescription, privacy: .public)")
        }
    }

    private static func decodeMessages(_ raw: [AnyCodable]) -> [ClawdisChatMessage] {
        let decoded = raw.compactMap { item in
            (try? ChatPayloadDecoding.decode(item, as: ClawdisChatMessage.self))
        }
        let sanitized = decoded.map { Self.sanitizeAssistantMessage($0) }
        return Self.dedupeMessages(sanitized)
    }

    private static func dedupeMessages(_ messages: [ClawdisChatMessage]) -> [ClawdisChatMessage] {
        var result: [ClawdisChatMessage] = []
        result.reserveCapacity(messages.count)
        var seen = Set<String>()

        for message in messages {
            guard let key = Self.dedupeKey(for: message) else {
                result.append(message)
                continue
            }
            if seen.contains(key) { continue }
            seen.insert(key)
            result.append(message)
        }

        return result
    }

    private static func dedupeKey(for message: ClawdisChatMessage) -> String? {
        guard let timestamp = message.timestamp else { return nil }
        let text = message.content.compactMap(\.text).joined(separator: "\n")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }
        return "\(message.role)|\(timestamp)|\(text)"
    }

    private func performSend() async {
        guard !self.isSending else { return }
        let trimmed = self.input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty || !self.attachments.isEmpty else { return }

        guard self.healthOK else {
            self.errorText = "Gateway health not OK; cannot send"
            return
        }

        self.isSending = true
        self.errorText = nil
        let runId = UUID().uuidString
        let messageText = trimmed.isEmpty && !self.attachments.isEmpty ? "See attached." : trimmed
        self.pendingRuns.insert(runId)
        self.armPendingRunTimeout(runId: runId)
        self.pendingToolCallsById = [:]
        self.streamingAssistantText = nil

        // Optimistically append user message to UI.
        var userContent: [ClawdisChatMessageContent] = [
            ClawdisChatMessageContent(
                type: "text",
                text: messageText,
                thinking: nil,
                thinkingSignature: nil,
                mimeType: nil,
                fileName: nil,
                content: nil,
                id: nil,
                name: nil,
                arguments: nil),
        ]
        let encodedAttachments = self.attachments.map { att -> ClawdisChatAttachmentPayload in
            ClawdisChatAttachmentPayload(
                type: att.type,
                mimeType: att.mimeType,
                fileName: att.fileName,
                content: att.data.base64EncodedString())
        }
        for att in encodedAttachments {
            userContent.append(
                ClawdisChatMessageContent(
                    type: att.type,
                    text: nil,
                    thinking: nil,
                    thinkingSignature: nil,
                    mimeType: att.mimeType,
                    fileName: att.fileName,
                    content: AnyCodable(att.content),
                    id: nil,
                    name: nil,
                    arguments: nil))
        }
        self.messages.append(
            ClawdisChatMessage(
                id: UUID(),
                role: "user",
                content: userContent,
                timestamp: Date().timeIntervalSince1970 * 1000))

        // Clear input immediately for responsive UX (before network await)
        self.input = ""
        self.attachments = []

        do {
            let response = try await self.transport.sendMessage(
                sessionKey: self.sessionKey,
                message: messageText,
                thinking: self.thinkingLevel,
                idempotencyKey: runId,
                attachments: encodedAttachments)
            if response.runId != runId {
                self.clearPendingRun(runId)
                self.pendingRuns.insert(response.runId)
                self.armPendingRunTimeout(runId: response.runId)
            }
        } catch {
            self.clearPendingRun(runId)
            self.errorText = error.localizedDescription
            chatUILogger.error("chat.send failed \(error.localizedDescription, privacy: .public)")
        }

        self.isSending = false
    }

    private func performAbort() async {
        guard !self.pendingRuns.isEmpty else { return }
        guard !self.isAborting else { return }
        self.isAborting = true
        defer { self.isAborting = false }

        let runIds = Array(self.pendingRuns)
        for runId in runIds {
            do {
                try await self.transport.abortRun(sessionKey: self.sessionKey, runId: runId)
            } catch {
                // Best-effort.
            }
        }
    }

    private func fetchSessions(limit: Int?) async {
        do {
            let res = try await self.transport.listSessions(limit: limit)
            self.sessions = res.sessions
        } catch {
            // Best-effort.
        }
    }

    private func performSwitchSession(to sessionKey: String) async {
        let next = sessionKey.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !next.isEmpty else { return }
        guard next != self.sessionKey else { return }
        self.sessionKey = next
        await self.bootstrap()
    }

    private func placeholderSession(key: String) -> ClawdisChatSessionEntry {
        ClawdisChatSessionEntry(
            key: key,
            kind: nil,
            displayName: nil,
            surface: nil,
            subject: nil,
            room: nil,
            space: nil,
            updatedAt: nil,
            sessionId: nil,
            systemSent: nil,
            abortedLastRun: nil,
            thinkingLevel: nil,
            verboseLevel: nil,
            inputTokens: nil,
            outputTokens: nil,
            totalTokens: nil,
            model: nil,
            contextTokens: nil)
    }

    private func handleTransportEvent(_ evt: ClawdisChatTransportEvent) {
        switch evt {
        case let .health(ok):
            self.healthOK = ok
        case .tick:
            Task { await self.pollHealthIfNeeded(force: false) }
        case let .chat(chat):
            self.handleChatEvent(chat)
        case let .agent(agent):
            self.handleAgentEvent(agent)
        case .seqGap:
            self.errorText = "Event stream interrupted; try refreshing."
            self.clearPendingRuns(reason: nil)
        }
    }

    private func handleChatEvent(_ chat: ClawdisChatEventPayload) {
        if let sessionKey = chat.sessionKey, sessionKey != self.sessionKey {
            return
        }

        let isOurRun = chat.runId.flatMap { self.pendingRuns.contains($0) } ?? false
        if !isOurRun {
            // Keep multiple clients in sync: if another client finishes a run for our session, refresh history.
            switch chat.state {
            case "final", "aborted", "error":
                self.streamingAssistantText = nil
                self.pendingToolCallsById = [:]
                Task { await self.refreshHistoryAfterRun() }
            default:
                break
            }
            return
        }

        switch chat.state {
        case "final", "aborted", "error":
            if chat.state == "error" {
                self.errorText = chat.errorMessage ?? "Chat failed"
            }
            if let runId = chat.runId {
                self.clearPendingRun(runId)
            } else if self.pendingRuns.count <= 1 {
                self.clearPendingRuns(reason: nil)
            }
            self.pendingToolCallsById = [:]
            self.streamingAssistantText = nil
            Task { await self.refreshHistoryAfterRun() }
        default:
            break
        }
    }

    private func handleAgentEvent(_ evt: ClawdisAgentEventPayload) {
        if let sessionId, evt.runId != sessionId {
            return
        }

        switch evt.stream {
        case "assistant":
            if let text = evt.data["text"]?.value as? String {
                let sanitized = Self.stripAssistantThinking(from: text)
                self.streamingAssistantText = sanitized.isEmpty ? nil : sanitized
            }
        case "tool":
            guard let phase = evt.data["phase"]?.value as? String else { return }
            guard let name = evt.data["name"]?.value as? String else { return }
            guard let toolCallId = evt.data["toolCallId"]?.value as? String else { return }
            if phase == "start" {
                let args = evt.data["args"]
                self.pendingToolCallsById[toolCallId] = ClawdisChatPendingToolCall(
                    toolCallId: toolCallId,
                    name: name,
                    args: args,
                    startedAt: evt.ts.map(Double.init) ?? Date().timeIntervalSince1970 * 1000,
                    isError: nil)
            } else if phase == "result" {
                self.pendingToolCallsById[toolCallId] = nil
            }
        default:
            break
        }
    }

    private static func sanitizeAssistantMessage(_ message: ClawdisChatMessage) -> ClawdisChatMessage {
        guard message.role.lowercased() == "assistant" else { return message }
        let sanitizedContent = message.content.map { content -> ClawdisChatMessageContent in
            let kind = (content.type ?? "text").lowercased()
            guard kind == "text" || kind.isEmpty, let text = content.text else { return content }
            let sanitized = Self.stripAssistantThinking(from: text)
            guard sanitized != text else { return content }
            return ClawdisChatMessageContent(
                type: content.type,
                text: sanitized,
                thinking: content.thinking,
                thinkingSignature: content.thinkingSignature,
                mimeType: content.mimeType,
                fileName: content.fileName,
                content: content.content,
                id: content.id,
                name: content.name,
                arguments: content.arguments)
        }
        guard sanitizedContent != message.content else { return message }
        return ClawdisChatMessage(
            id: message.id,
            role: message.role,
            content: sanitizedContent,
            timestamp: message.timestamp,
            toolCallId: message.toolCallId,
            toolName: message.toolName,
            usage: message.usage,
            stopReason: message.stopReason)
    }

    private static func stripAssistantThinking(from text: String) -> String {
        guard text.contains("<") else { return text }
        let original = text
        var result = text
        result = Self.removeTagBlocks(tag: "think", from: result)
        result = Self.stripStandaloneTags(tag: "think", from: result)
        result = Self.stripStandaloneTags(tag: "final", from: result)
        guard result != original else { return text }
        return result.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func removeTagBlocks(tag: String, from text: String) -> String {
        var result = text
        let openToken = "<\(tag)"
        let closeToken = "</\(tag)>"
        while let openRange = result.range(
            of: openToken,
            options: [.caseInsensitive, .diacriticInsensitive])
        {
            guard let tagEnd = result.range(of: ">", range: openRange.upperBound..<result.endIndex) else {
                result.removeSubrange(openRange.lowerBound..<result.endIndex)
                break
            }
            if let closeRange = result.range(
                of: closeToken,
                options: [.caseInsensitive, .diacriticInsensitive],
                range: tagEnd.upperBound..<result.endIndex)
            {
                result.removeSubrange(openRange.lowerBound..<closeRange.upperBound)
            } else {
                result.removeSubrange(openRange.lowerBound..<result.endIndex)
                break
            }
        }
        return result
    }

    private static func stripStandaloneTags(tag: String, from text: String) -> String {
        var result = text
        let openToken = "<\(tag)"
        let closeToken = "</\(tag)>"
        while let openRange = result.range(
            of: openToken,
            options: [.caseInsensitive, .diacriticInsensitive])
        {
            guard let tagEnd = result.range(of: ">", range: openRange.upperBound..<result.endIndex) else {
                result.removeSubrange(openRange.lowerBound..<result.endIndex)
                break
            }
            result.removeSubrange(openRange.lowerBound..<tagEnd.upperBound)
        }
        result = result.replacingOccurrences(
            of: closeToken,
            with: "",
            options: [.caseInsensitive, .diacriticInsensitive])
        return result
    }

    private func refreshHistoryAfterRun() async {
        do {
            let payload = try await self.transport.requestHistory(sessionKey: self.sessionKey)
            self.messages = Self.decodeMessages(payload.messages ?? [])
            self.sessionId = payload.sessionId
            if let level = payload.thinkingLevel, !level.isEmpty {
                self.thinkingLevel = level
            }
        } catch {
            chatUILogger.error("refresh history failed \(error.localizedDescription, privacy: .public)")
        }
    }

    private func armPendingRunTimeout(runId: String) {
        self.pendingRunTimeoutTasks[runId]?.cancel()
        self.pendingRunTimeoutTasks[runId] = Task { [weak self] in
            let timeoutMs = await MainActor.run { self?.pendingRunTimeoutMs ?? 0 }
            try? await Task.sleep(nanoseconds: timeoutMs * 1_000_000)
            await MainActor.run { [weak self] in
                guard let self else { return }
                guard self.pendingRuns.contains(runId) else { return }
                self.clearPendingRun(runId)
                self.errorText = "Timed out waiting for a reply; try again or refresh."
            }
        }
    }

    private func clearPendingRun(_ runId: String) {
        self.pendingRuns.remove(runId)
        self.pendingRunTimeoutTasks[runId]?.cancel()
        self.pendingRunTimeoutTasks[runId] = nil
    }

    private func clearPendingRuns(reason: String?) {
        for runId in self.pendingRuns {
            self.pendingRunTimeoutTasks[runId]?.cancel()
        }
        self.pendingRunTimeoutTasks.removeAll()
        self.pendingRuns.removeAll()
        if let reason, !reason.isEmpty {
            self.errorText = reason
        }
    }

    private func pollHealthIfNeeded(force: Bool) async {
        if !force, let last = self.lastHealthPollAt, Date().timeIntervalSince(last) < 10 {
            return
        }
        self.lastHealthPollAt = Date()
        do {
            let ok = try await self.transport.requestHealth(timeoutMs: 5000)
            self.healthOK = ok
        } catch {
            self.healthOK = false
        }
    }

    private func loadAttachments(urls: [URL]) async {
        for url in urls {
            do {
                let data = try await Task.detached { try Data(contentsOf: url) }.value
                await self.addImageAttachment(
                    url: url,
                    data: data,
                    fileName: url.lastPathComponent,
                    mimeType: Self.mimeType(for: url) ?? "application/octet-stream")
            } catch {
                await MainActor.run { self.errorText = error.localizedDescription }
            }
        }
    }

    private static func mimeType(for url: URL) -> String? {
        let ext = url.pathExtension
        guard !ext.isEmpty else { return nil }
        return (UTType(filenameExtension: ext) ?? .data).preferredMIMEType
    }

    private func addImageAttachment(url: URL?, data: Data, fileName: String, mimeType: String) async {
        if data.count > 5_000_000 {
            self.errorText = "Attachment \(fileName) exceeds 5 MB limit"
            return
        }

        let uti: UTType = {
            if let url {
                return UTType(filenameExtension: url.pathExtension) ?? .data
            }
            return UTType(mimeType: mimeType) ?? .data
        }()
        guard uti.conforms(to: .image) else {
            self.errorText = "Only image attachments are supported right now"
            return
        }

        let preview = Self.previewImage(data: data)
        self.attachments.append(
            ClawdisPendingAttachment(
                url: url,
                data: data,
                fileName: fileName,
                mimeType: mimeType,
                preview: preview))
    }

    private static func previewImage(data: Data) -> ClawdisPlatformImage? {
        #if canImport(AppKit)
        NSImage(data: data)
        #elseif canImport(UIKit)
        UIImage(data: data)
        #else
        nil
        #endif
    }
}
