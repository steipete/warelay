import Foundation
import Network
import Observation
import OSLog
import SwiftUI

struct HealthSnapshot: Codable, Sendable {
    struct Telegram: Codable, Sendable {
        struct Probe: Codable, Sendable {
            struct Bot: Codable, Sendable {
                let id: Int?
                let username: String?
            }

            let ok: Bool
            let status: Int?
            let error: String?
            let elapsedMs: Double?
            let bot: Bot?
        }

        let configured: Bool
        let probe: Probe?
    }

    struct Web: Codable, Sendable {
        struct Connect: Codable, Sendable {
            let ok: Bool
            let status: Int?
            let error: String?
            let elapsedMs: Double?
        }

        let linked: Bool
        let authAgeMs: Double?
        let connect: Connect?
    }

    struct SessionInfo: Codable, Sendable {
        let key: String
        let updatedAt: Double?
        let age: Double?
    }

    struct Sessions: Codable, Sendable {
        let path: String
        let count: Int
        let recent: [SessionInfo]
    }

    let ok: Bool?
    let ts: Double
    let durationMs: Double
    let web: Web
    let telegram: Telegram?
    let heartbeatSeconds: Int?
    let sessions: Sessions
}

enum HealthState: Equatable {
    case unknown
    case ok
    case linkingNeeded
    case degraded(String)

    var tint: Color {
        switch self {
        case .ok: .green
        case .linkingNeeded: .red
        case .degraded: .orange
        case .unknown: .secondary
        }
    }
}

@MainActor
@Observable
final class HealthStore {
    static let shared = HealthStore()

    private static let logger = Logger(subsystem: "com.steipete.clawdis", category: "health")

    private(set) var snapshot: HealthSnapshot?
    private(set) var lastSuccess: Date?
    private(set) var lastError: String?
    private(set) var isRefreshing = false

    private var loopTask: Task<Void, Never>?
    private let refreshInterval: TimeInterval = 60

    private init() {
        // Avoid background health polling in SwiftUI previews and tests.
        if !ProcessInfo.processInfo.isPreview, !ProcessInfo.processInfo.isRunningTests {
            self.start()
        }
    }

    func start() {
        guard self.loopTask == nil else { return }
        self.loopTask = Task { [weak self] in
            guard let self else { return }
            while !Task.isCancelled {
                await self.refresh()
                try? await Task.sleep(nanoseconds: UInt64(self.refreshInterval * 1_000_000_000))
            }
        }
    }

    func stop() {
        self.loopTask?.cancel()
        self.loopTask = nil
    }

    func refresh(onDemand: Bool = false) async {
        guard !self.isRefreshing else { return }
        self.isRefreshing = true
        defer { self.isRefreshing = false }

        do {
            let data = try await ControlChannel.shared.health(timeout: 15)
            if let decoded = decodeHealthSnapshot(from: data) {
                self.snapshot = decoded
                self.lastSuccess = Date()
                self.lastError = nil
            } else {
                self.lastError = "health output not JSON"
                if onDemand { self.snapshot = nil }
            }
        } catch {
            self.lastError = error.localizedDescription
            if onDemand { self.snapshot = nil }
        }
    }

    private static func isTelegramHealthy(_ snap: HealthSnapshot) -> Bool {
        guard let tg = snap.telegram, tg.configured else { return false }
        // If probe is missing, treat it as "configured but unknown health" (not a hard fail).
        return tg.probe?.ok ?? true
    }

    var state: HealthState {
        if let error = self.lastError, !error.isEmpty {
            return .degraded(error)
        }
        guard let snap = self.snapshot else { return .unknown }
        if !snap.web.linked {
            // WhatsApp Web linking is optional if Telegram is healthy; don't paint the whole app red.
            return Self.isTelegramHealthy(snap) ? .degraded("Not linked") : .linkingNeeded
        }
        if let connect = snap.web.connect, !connect.ok {
            let reason = connect.error ?? "connect failed"
            return .degraded(reason)
        }
        return .ok
    }

    var summaryLine: String {
        if self.isRefreshing { return "Health check running…" }
        if let error = self.lastError { return "Health check failed: \(error)" }
        guard let snap = self.snapshot else { return "Health check pending" }
        if !snap.web.linked {
            if let tg = snap.telegram, tg.configured {
                let tgLabel = (tg.probe?.ok ?? true) ? "Telegram ok" : "Telegram degraded"
                return "\(tgLabel) · Not linked — run clawdis login"
            }
            return "Not linked — run clawdis login"
        }
        let auth = snap.web.authAgeMs.map { msToAge($0) } ?? "unknown"
        if let connect = snap.web.connect, !connect.ok {
            let code = connect.status.map(String.init) ?? "?"
            return "Link stale? status \(code)"
        }
        return "linked · auth \(auth) · socket ok"
    }

    /// Short, human-friendly detail for the last failure, used in the UI.
    var detailLine: String? {
        if let error = self.lastError, !error.isEmpty {
            let lower = error.lowercased()
            if lower.contains("connection refused") {
                return "The gateway control port (127.0.0.1:18789) isn’t listening — restart Clawdis to bring it back."
            }
            if lower.contains("timeout") {
                return "Timed out waiting for the control server; the gateway may be crashed or still starting."
            }
            return error
        }
        return nil
    }

    func describeFailure(from snap: HealthSnapshot, fallback: String?) -> String {
        if !snap.web.linked {
            return "Not linked — run clawdis login"
        }
        if let connect = snap.web.connect, !connect.ok {
            let elapsed = connect.elapsedMs.map { "\(Int($0))ms" } ?? "unknown duration"
            if let err = connect.error, err.lowercased().contains("timeout") || connect.status == nil {
                return "Health check timed out (\(elapsed))"
            }
            let code = connect.status.map { "status \($0)" } ?? "status unknown"
            let reason = connect.error ?? "connect failed"
            return "\(reason) (\(code), \(elapsed))"
        }
        if let fallback, !fallback.isEmpty {
            return fallback
        }
        return "health probe failed"
    }

    var degradedSummary: String? {
        guard case let .degraded(reason) = self.state else { return nil }
        if reason == "[object Object]" || reason.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
           let snap = self.snapshot
        {
            return self.describeFailure(from: snap, fallback: reason)
        }
        return reason
    }
}

func msToAge(_ ms: Double) -> String {
    let minutes = Int(round(ms / 60000))
    if minutes < 1 { return "just now" }
    if minutes < 60 { return "\(minutes)m" }
    let hours = Int(round(Double(minutes) / 60))
    if hours < 48 { return "\(hours)h" }
    let days = Int(round(Double(hours) / 24))
    return "\(days)d"
}

/// Decode a health snapshot, tolerating stray log lines before/after the JSON blob.
func decodeHealthSnapshot(from data: Data) -> HealthSnapshot? {
    let decoder = JSONDecoder()
    if let snap = try? decoder.decode(HealthSnapshot.self, from: data) {
        return snap
    }
    guard let text = String(data: data, encoding: .utf8) else { return nil }
    guard let firstBrace = text.firstIndex(of: "{"), let lastBrace = text.lastIndex(of: "}") else {
        return nil
    }
    let slice = text[firstBrace...lastBrace]
    let cleaned = Data(slice.utf8)
    return try? decoder.decode(HealthSnapshot.self, from: cleaned)
}
