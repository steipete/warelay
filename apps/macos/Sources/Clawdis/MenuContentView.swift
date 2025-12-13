import AppKit
import AVFoundation
import Foundation
import SwiftUI

/// Menu contents for the Clawdis menu bar extra.
struct MenuContent: View {
    @ObservedObject var state: AppState
    let updater: UpdaterProviding?
    @ObservedObject private var gatewayManager = GatewayProcessManager.shared
    @ObservedObject private var healthStore = HealthStore.shared
    @ObservedObject private var heartbeatStore = HeartbeatStore.shared
    @ObservedObject private var controlChannel = ControlChannel.shared
    @ObservedObject private var activityStore = WorkActivityStore.shared
    @Environment(\.openSettings) private var openSettings
    @State private var availableMics: [AudioInputDevice] = []
    @State private var loadingMics = false
    @State private var sessionMenu: [SessionRow] = []
    @State private var contextSessions: [SessionRow] = []
    @State private var contextActiveCount: Int = 0
    @State private var contextCardWidth: CGFloat = 320

    private let activeSessionWindowSeconds: TimeInterval = 24 * 60 * 60
    private let contextCardPadding: CGFloat = 10
    private let contextBarHeight: CGFloat = 4
    private let contextFallbackWidth: CGFloat = 320
    private let contextSessionRowHeight: CGFloat = 18

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Toggle(isOn: self.activeBinding) {
                let label = self.state.connectionMode == .remote ? "Remote Clawdis Active" : "Clawdis Active"
                Text(label)
            }
            self.statusRow
            self.contextCardRow
            Toggle(isOn: self.heartbeatsBinding) { Text("Send Heartbeats") }
            self.heartbeatStatusRow
            Toggle(isOn: self.voiceWakeBinding) { Text("Voice Wake") }
                .disabled(!voiceWakeSupported)
                .opacity(voiceWakeSupported ? 1 : 0.5)
            if self.showVoiceWakeMicPicker {
                self.voiceWakeMicMenu
            }
            if AppStateStore.webChatEnabled {
                Button("Open Chat") {
                    WebChatManager.shared.show(sessionKey: WebChatManager.shared.preferredSessionKey())
                }
            }
            Toggle(isOn: Binding(get: { self.state.canvasEnabled }, set: { self.state.canvasEnabled = $0 })) {
                Text("Allow Canvas")
            }
            .onChange(of: self.state.canvasEnabled) { _, enabled in
                if !enabled {
                    CanvasManager.shared.hideAll()
                }
            }
            Divider()
            Button("Settings…") { self.open(tab: .general) }
                .keyboardShortcut(",", modifiers: [.command])
            Button("About Clawdis") { self.open(tab: .about) }
            if let updater, updater.isAvailable {
                Button("Check for Updates…") { updater.checkForUpdates(nil) }
            }
            if self.state.debugPaneEnabled {
                Menu("Debug") {
                    Menu {
                        ForEach(self.sessionMenu) { row in
                            Menu(row.key) {
                                Menu("Thinking") {
                                    ForEach(["low", "medium", "high", "default"], id: \.self) { level in
                                        let normalized = level == "default" ? nil : level
                                        Button {
                                            Task {
                                                try? await DebugActions.updateSession(
                                                    key: row.key,
                                                    thinking: normalized,
                                                    verbose: row.verboseLevel)
                                                await self.reloadSessionMenu()
                                            }
                                        } label: {
                                            Label(
                                                level.capitalized,
                                                systemImage: row.thinkingLevel == normalized ? "checkmark" : "")
                                        }
                                    }
                                }
                                Menu("Verbose") {
                                    ForEach(["on", "off", "default"], id: \.self) { level in
                                        let normalized = level == "default" ? nil : level
                                        Button {
                                            Task {
                                                try? await DebugActions.updateSession(
                                                    key: row.key,
                                                    thinking: row.thinkingLevel,
                                                    verbose: normalized)
                                                await self.reloadSessionMenu()
                                            }
                                        } label: {
                                            Label(
                                                level.capitalized,
                                                systemImage: row.verboseLevel == normalized ? "checkmark" : "")
                                        }
                                    }
                                }
                                Button {
                                    DebugActions.openSessionStoreInCode()
                                } label: {
                                    Label("Open Session Log", systemImage: "doc.text")
                                }
                            }
                        }
                        Divider()
                    } label: {
                        Label("Sessions", systemImage: "clock.arrow.circlepath")
                    }
                    Divider()
                    Button {
                        DebugActions.openConfigFolder()
                    } label: {
                        Label("Open Config Folder", systemImage: "folder")
                    }
                    Button {
                        Task { await DebugActions.runHealthCheckNow() }
                    } label: {
                        Label("Run Health Check Now", systemImage: "stethoscope")
                    }
                    Button {
                        Task { _ = await DebugActions.sendTestHeartbeat() }
                    } label: {
                        Label("Send Test Heartbeat", systemImage: "waveform.path.ecg")
                    }
                    Button {
                        Task { _ = await DebugActions.toggleVerboseLoggingMain() }
                    } label: {
                        Label(
                            DebugActions.verboseLoggingEnabledMain
                                ? "Verbose Logging (Main): On"
                                : "Verbose Logging (Main): Off",
                            systemImage: "text.alignleft")
                    }
                    Button {
                        DebugActions.openSessionStore()
                    } label: {
                        Label("Open Session Store", systemImage: "externaldrive")
                    }
                    Divider()
                    Button {
                        DebugActions.openAgentEventsWindow()
                    } label: {
                        Label("Open Agent Events…", systemImage: "bolt.horizontal.circle")
                    }
                    Button {
                        DebugActions.openLog()
                    } label: {
                        Label("Open Log", systemImage: "doc.text.magnifyingglass")
                    }
                    Button {
                        Task { _ = await DebugActions.sendDebugVoice() }
                    } label: {
                        Label("Send Debug Voice Text", systemImage: "waveform.circle")
                    }
                    Button {
                        Task { await DebugActions.sendTestNotification() }
                    } label: {
                        Label("Send Test Notification", systemImage: "bell")
                    }
                    Button {
                        Task { await DebugActions.openChatInBrowser() }
                    } label: {
                        Label("Open Chat in Browser…", systemImage: "safari")
                    }
                    Divider()
                    Button {
                        DebugActions.restartGateway()
                    } label: {
                        Label("Restart Gateway", systemImage: "arrow.clockwise")
                    }
                    Button {
                        DebugActions.restartApp()
                    } label: {
                        Label("Restart App", systemImage: "arrow.triangle.2.circlepath")
                    }
                }
            }
            Button("Quit") { NSApplication.shared.terminate(nil) }
        }
        .task(id: self.state.swabbleEnabled) {
            if self.state.swabbleEnabled {
                await self.loadMicrophones(force: true)
            }
        }
        .task {
            await self.reloadSessionMenu()
            await self.reloadContextSessions()
        }
        .task {
            VoicePushToTalkHotkey.shared.setEnabled(voiceWakeSupported && self.state.voicePushToTalkEnabled)
        }
        .onChange(of: self.state.voicePushToTalkEnabled) { _, enabled in
            VoicePushToTalkHotkey.shared.setEnabled(voiceWakeSupported && enabled)
        }
    }

    private func open(tab: SettingsTab) {
        SettingsTabRouter.request(tab)
        NSApp.activate(ignoringOtherApps: true)
        self.openSettings()
        NotificationCenter.default.post(name: .clawdisSelectSettingsTab, object: tab)
    }

    private var statusRow: some View {
        let (label, color): (String, Color) = {
            if let activity = self.activityStore.current {
                let color: Color = activity.role == .main ? .accentColor : .gray
                let roleLabel = activity.role == .main ? "Main" : "Other"
                let text = "\(roleLabel) · \(activity.label)"
                return (text, color)
            }

            let health = self.healthStore.state
            let isRefreshing = self.healthStore.isRefreshing
            let lastAge = self.healthStore.lastSuccess.map { age(from: $0) }

            if isRefreshing {
                return ("Health check running…", health.tint)
            }

            switch health {
            case .ok:
                let ageText = lastAge.map { " · checked \($0)" } ?? ""
                return ("Health ok\(ageText)", .green)
            case .linkingNeeded:
                return ("Health: login required", .red)
            case let .degraded(reason):
                let detail = HealthStore.shared.degradedSummary ?? reason
                let ageText = lastAge.map { " · checked \($0)" } ?? ""
                return ("\(detail)\(ageText)", .orange)
            case .unknown:
                return ("Health pending", .secondary)
            }
        }()

        return Button(
            action: {},
            label: {
                HStack(spacing: 8) {
                    Circle()
                        .fill(color)
                        .frame(width: 8, height: 8)
                    Text(label)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.primary)
                }
                .padding(.vertical, 4)
            })
            .buttonStyle(.plain)
            .disabled(true)
    }

    @ViewBuilder
    private var contextCardRow: some View {
        MenuHostedItem(
            width: self.contextCardWidth,
            rootView: AnyView(self.contextCardView))
    }

    private var contextPillWidth: CGFloat {
        let base = self.contextCardWidth > 0 ? self.contextCardWidth : self.contextFallbackWidth
        return max(1, base - (self.contextCardPadding * 2))
    }

    @ViewBuilder
    private var contextCardView: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                Text("Context")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                Spacer(minLength: 10)
                Text(self.contextSubtitle)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            if self.contextSessions.isEmpty {
                Text("No active sessions")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(self.contextSessions) { row in
                        self.contextSessionRow(row)
                    }
                }
            }
        }
        .padding(self.contextCardPadding)
        .frame(width: self.contextCardWidth, alignment: .leading)
        .background {
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(Color.white.opacity(0.04))
                .overlay {
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .strokeBorder(Color.white.opacity(0.06), lineWidth: 1)
                }
        }
    }

    private var contextSubtitle: String {
        let count = self.contextActiveCount
        if count == 1 { return "1 session · 24h" }
        return "\(count) sessions · 24h"
    }

    @ViewBuilder
    private func contextSessionRow(_ row: SessionRow) -> some View {
        let width = self.contextPillWidth
        ZStack(alignment: .bottomLeading) {
            ContextUsageBar(
                usedTokens: row.tokens.total,
                contextTokens: row.tokens.contextTokens,
                width: width,
                height: self.contextBarHeight)
                .padding(.bottom, 0)

            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(row.key)
                    .font(.caption.weight(row.key == "main" ? .semibold : .regular))
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .layoutPriority(1)
                Spacer(minLength: 8)
                Text(row.tokens.contextSummaryShort)
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .fixedSize(horizontal: true, vertical: false)
                    .layoutPriority(2)
            }
            .padding(.bottom, self.contextBarHeight + 4)
            .frame(width: width)
        }
        .frame(width: width, height: self.contextSessionRowHeight, alignment: .bottomLeading)
    }

    private var heartbeatStatusRow: some View {
        let (label, color): (String, Color) = {
            if case .degraded = self.controlChannel.state {
                return ("Control channel disconnected", .red)
            } else if let evt = self.heartbeatStore.lastEvent {
                let ageText = age(from: Date(timeIntervalSince1970: evt.ts / 1000))
                switch evt.status {
                case "sent":
                    return ("Last heartbeat sent · \(ageText)", .blue)
                case "ok-empty", "ok-token":
                    return ("Heartbeat ok · \(ageText)", .green)
                case "skipped":
                    return ("Heartbeat skipped · \(ageText)", .secondary)
                case "failed":
                    return ("Heartbeat failed · \(ageText)", .red)
                default:
                    return ("Heartbeat · \(ageText)", .secondary)
                }
            } else {
                return ("No heartbeat yet", .secondary)
            }
        }()

        return Button(
            action: {},
            label: {
                HStack(spacing: 8) {
                    Circle()
                        .fill(color)
                        .frame(width: 8, height: 8)
                    Text(label)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.primary)
                }
                .padding(.vertical, 2)
            })
            .buttonStyle(.plain)
            .disabled(true)
    }

    private var activeBinding: Binding<Bool> {
        Binding(get: { !self.state.isPaused }, set: { self.state.isPaused = !$0 })
    }

    private var heartbeatsBinding: Binding<Bool> {
        Binding(get: { self.state.heartbeatsEnabled }, set: { self.state.heartbeatsEnabled = $0 })
    }

    private var voiceWakeBinding: Binding<Bool> {
        Binding(
            get: { self.state.swabbleEnabled },
            set: { newValue in
                Task { await self.state.setVoiceWakeEnabled(newValue) }
            })
    }

    private var showVoiceWakeMicPicker: Bool {
        voiceWakeSupported && self.state.swabbleEnabled
    }

    private var voiceWakeMicMenu: some View {
        Menu {
            self.microphoneMenuItems

            if self.loadingMics {
                Divider()
                Label("Refreshing microphones…", systemImage: "arrow.triangle.2.circlepath")
                    .labelStyle(.titleOnly)
                    .foregroundStyle(.secondary)
                    .disabled(true)
            }
        } label: {
            HStack {
                Text("Microphone")
                Spacer()
                Text(self.selectedMicLabel)
                    .foregroundStyle(.secondary)
            }
        }
        .task { await self.loadMicrophones() }
    }

    private var selectedMicLabel: String {
        if self.state.voiceWakeMicID.isEmpty { return self.defaultMicLabel }
        if let match = self.availableMics.first(where: { $0.uid == self.state.voiceWakeMicID }) {
            return match.name
        }
        return "Unavailable"
    }

    private var microphoneMenuItems: some View {
        Group {
            Button {
                self.state.voiceWakeMicID = ""
            } label: {
                Label(self.defaultMicLabel, systemImage: self.state.voiceWakeMicID.isEmpty ? "checkmark" : "")
                    .labelStyle(.titleAndIcon)
            }
            .buttonStyle(.plain)

            ForEach(self.availableMics) { mic in
                Button {
                    self.state.voiceWakeMicID = mic.uid
                } label: {
                    Label(mic.name, systemImage: self.state.voiceWakeMicID == mic.uid ? "checkmark" : "")
                        .labelStyle(.titleAndIcon)
                }
                .buttonStyle(.plain)
            }
        }
    }

    private var defaultMicLabel: String {
        if let host = Host.current().localizedName, !host.isEmpty {
            return "Auto-detect (\(host))"
        }
        return "System default"
    }

    @MainActor
    private func reloadSessionMenu() async {
        self.sessionMenu = await DebugActions.recentSessions()
    }

    @MainActor
    private func loadMicrophones(force: Bool = false) async {
        guard self.showVoiceWakeMicPicker else {
            self.availableMics = []
            self.loadingMics = false
            return
        }
        if !force, !self.availableMics.isEmpty { return }
        self.loadingMics = true
        let discovery = AVCaptureDevice.DiscoverySession(
            deviceTypes: [.external, .microphone],
            mediaType: .audio,
            position: .unspecified)
        self.availableMics = discovery.devices
            .sorted { lhs, rhs in
                lhs.localizedName.localizedCaseInsensitiveCompare(rhs.localizedName) == .orderedAscending
            }
            .map { AudioInputDevice(uid: $0.uniqueID, name: $0.localizedName) }
        self.loadingMics = false
    }

    private struct AudioInputDevice: Identifiable, Equatable {
        let uid: String
        let name: String
        var id: String { self.uid }
    }

    private func reloadContextSessions() async {
        let hints = SessionLoader.configHints()
        let store = SessionLoader.resolveStorePath(override: hints.storePath)
        let defaults = SessionDefaults(
            model: hints.model ?? SessionLoader.fallbackModel,
            contextTokens: hints.contextTokens ?? SessionLoader.fallbackContextTokens)

        guard let rows = try? await SessionLoader.loadRows(at: store, defaults: defaults) else {
            self.contextSessions = []
            return
        }

        let now = Date()
        let active = rows.filter { row in
            guard let updatedAt = row.updatedAt else { return false }
            return now.timeIntervalSince(updatedAt) <= self.activeSessionWindowSeconds
        }

        let activeCount = active.count
        let main = rows.first(where: { $0.key == "main" })
        var merged = active
        if let main, !merged.contains(where: { $0.key == "main" }) {
            merged.insert(main, at: 0)
        }
        // Keep stable ordering: main first, then most recent.
        let sorted = merged.sorted { lhs, rhs in
            if lhs.key == "main" { return true }
            if rhs.key == "main" { return false }
            return (lhs.updatedAt ?? .distantPast) > (rhs.updatedAt ?? .distantPast)
        }

        self.contextSessions = sorted
        self.contextActiveCount = activeCount
    }
}
