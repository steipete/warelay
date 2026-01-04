import AppKit
import ApplicationServices
import AVFoundation
import ClawdisIPC
import CoreGraphics
import CoreLocation
import Foundation
import Observation
import Speech
import UserNotifications

enum PermissionManager {
    static func ensure(_ caps: [Capability], interactive: Bool) async -> [Capability: Bool] {
        var results: [Capability: Bool] = [:]
        for cap in caps {
            results[cap] = await self.ensureCapability(cap, interactive: interactive)
        }
        return results
    }

    private static func ensureCapability(_ cap: Capability, interactive: Bool) async -> Bool {
        switch cap {
        case .notifications:
            await self.ensureNotifications(interactive: interactive)
        case .appleScript:
            await self.ensureAppleScript(interactive: interactive)
        case .accessibility:
            await self.ensureAccessibility(interactive: interactive)
        case .screenRecording:
            await self.ensureScreenRecording(interactive: interactive)
        case .microphone:
            await self.ensureMicrophone(interactive: interactive)
        case .speechRecognition:
            await self.ensureSpeechRecognition(interactive: interactive)
        case .camera:
            await self.ensureCamera(interactive: interactive)
        case .location:
            await self.ensureLocation(interactive: interactive)
        }
    }

    private static func ensureNotifications(interactive: Bool) async -> Bool {
        let center = UNUserNotificationCenter.current()
        let settings = await center.notificationSettings()

        switch settings.authorizationStatus {
        case .authorized, .provisional, .ephemeral:
            return true
        case .notDetermined:
            guard interactive else { return false }
            let granted = await (try? center.requestAuthorization(options: [.alert, .sound, .badge])) ?? false
            let updated = await center.notificationSettings()
            return granted &&
                (updated.authorizationStatus == .authorized || updated.authorizationStatus == .provisional)
        case .denied:
            if interactive {
                NotificationPermissionHelper.openSettings()
            }
            return false
        @unknown default:
            return false
        }
    }

    private static func ensureAppleScript(interactive: Bool) async -> Bool {
        let granted = await MainActor.run { AppleScriptPermission.isAuthorized() }
        if interactive, !granted {
            await AppleScriptPermission.requestAuthorization()
        }
        return await MainActor.run { AppleScriptPermission.isAuthorized() }
    }

    private static func ensureAccessibility(interactive: Bool) async -> Bool {
        let trusted = await MainActor.run { AXIsProcessTrusted() }
        if interactive, !trusted {
            await MainActor.run {
                let opts: NSDictionary = ["AXTrustedCheckOptionPrompt": true]
                _ = AXIsProcessTrustedWithOptions(opts)
            }
        }
        return await MainActor.run { AXIsProcessTrusted() }
    }

    private static func ensureScreenRecording(interactive: Bool) async -> Bool {
        let granted = ScreenRecordingProbe.isAuthorized()
        if interactive, !granted {
            await ScreenRecordingProbe.requestAuthorization()
        }
        return ScreenRecordingProbe.isAuthorized()
    }

    private static func ensureMicrophone(interactive: Bool) async -> Bool {
        let status = AVCaptureDevice.authorizationStatus(for: .audio)
        switch status {
        case .authorized:
            return true
        case .notDetermined:
            guard interactive else { return false }
            return await AVCaptureDevice.requestAccess(for: .audio)
        case .denied, .restricted:
            if interactive {
                MicrophonePermissionHelper.openSettings()
            }
            return false
        @unknown default:
            return false
        }
    }

    private static func ensureSpeechRecognition(interactive: Bool) async -> Bool {
        let status = SFSpeechRecognizer.authorizationStatus()
        if status == .notDetermined, interactive {
            await withUnsafeContinuation { (cont: UnsafeContinuation<Void, Never>) in
                SFSpeechRecognizer.requestAuthorization { _ in
                    DispatchQueue.main.async { cont.resume() }
                }
            }
        }
        return SFSpeechRecognizer.authorizationStatus() == .authorized
    }

    private static func ensureCamera(interactive: Bool) async -> Bool {
        let status = AVCaptureDevice.authorizationStatus(for: .video)
        switch status {
        case .authorized:
            return true
        case .notDetermined:
            guard interactive else { return false }
            return await AVCaptureDevice.requestAccess(for: .video)
        case .denied, .restricted:
            if interactive {
                CameraPermissionHelper.openSettings()
            }
            return false
        @unknown default:
            return false
        }
    }

    private static func ensureLocation(interactive: Bool) async -> Bool {
        let status = CLLocationManager.authorizationStatus()
        switch status {
        // Note: macOS only supports authorizedAlways, not authorizedWhenInUse (iOS only)
        case .authorizedAlways:
            return true
        case .notDetermined:
            guard interactive else { return false }
            let updated = await LocationPermissionRequester.shared.request(always: false)
            return updated == .authorizedAlways
        case .denied, .restricted:
            if interactive {
                LocationPermissionHelper.openSettings()
            }
            return false
        @unknown default:
            return false
        }
    }

    static func voiceWakePermissionsGranted() -> Bool {
        let mic = AVCaptureDevice.authorizationStatus(for: .audio) == .authorized
        let speech = SFSpeechRecognizer.authorizationStatus() == .authorized
        return mic && speech
    }

    static func ensureVoiceWakePermissions(interactive: Bool) async -> Bool {
        let results = await self.ensure([.microphone, .speechRecognition], interactive: interactive)
        return results[.microphone] == true && results[.speechRecognition] == true
    }

    static func status(_ caps: [Capability] = Capability.allCases) async -> [Capability: Bool] {
        var results: [Capability: Bool] = [:]
        for cap in caps {
            switch cap {
            case .notifications:
                let center = UNUserNotificationCenter.current()
                let settings = await center.notificationSettings()
                results[cap] = settings.authorizationStatus == .authorized
                    || settings.authorizationStatus == .provisional

            case .appleScript:
                results[cap] = await MainActor.run { AppleScriptPermission.isAuthorized() }

            case .accessibility:
                results[cap] = await MainActor.run { AXIsProcessTrusted() }

            case .screenRecording:
                if #available(macOS 10.15, *) {
                    results[cap] = CGPreflightScreenCaptureAccess()
                } else {
                    results[cap] = true
                }

            case .microphone:
                results[cap] = AVCaptureDevice.authorizationStatus(for: .audio) == .authorized

            case .speechRecognition:
                results[cap] = SFSpeechRecognizer.authorizationStatus() == .authorized

            case .camera:
                results[cap] = AVCaptureDevice.authorizationStatus(for: .video) == .authorized
            case .location:
                let status = CLLocationManager.authorizationStatus()
                // Note: macOS only supports authorizedAlways
                results[cap] = status == .authorizedAlways
            }
        }
        return results
    }
}

enum NotificationPermissionHelper {
    static func openSettings() {
        let candidates = [
            "x-apple.systempreferences:com.apple.Notifications-Settings.extension",
            "x-apple.systempreferences:com.apple.preference.notifications",
        ]

        for candidate in candidates {
            if let url = URL(string: candidate), NSWorkspace.shared.open(url) {
                return
            }
        }
    }
}

enum MicrophonePermissionHelper {
    static func openSettings() {
        let candidates = [
            "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
            "x-apple.systempreferences:com.apple.preference.security",
        ]

        for candidate in candidates {
            if let url = URL(string: candidate), NSWorkspace.shared.open(url) {
                return
            }
        }
    }
}

enum CameraPermissionHelper {
    static func openSettings() {
        let candidates = [
            "x-apple.systempreferences:com.apple.preference.security?Privacy_Camera",
            "x-apple.systempreferences:com.apple.preference.security",
        ]

        for candidate in candidates {
            if let url = URL(string: candidate), NSWorkspace.shared.open(url) {
                return
            }
        }
    }
}

enum LocationPermissionHelper {
    static func openSettings() {
        let candidates = [
            "x-apple.systempreferences:com.apple.preference.security?Privacy_LocationServices",
            "x-apple.systempreferences:com.apple.preference.security",
        ]

        for candidate in candidates {
            if let url = URL(string: candidate), NSWorkspace.shared.open(url) {
                return
            }
        }
    }
}

@MainActor
final class LocationPermissionRequester: NSObject, CLLocationManagerDelegate {
    static let shared = LocationPermissionRequester()
    private let manager = CLLocationManager()
    private var continuation: CheckedContinuation<CLAuthorizationStatus, Never>?

    override init() {
        super.init()
        self.manager.delegate = self
    }

    func request(always: Bool) async -> CLAuthorizationStatus {
        if always {
            self.manager.requestAlwaysAuthorization()
        } else {
            self.manager.requestWhenInUseAuthorization()
        }
        return await withCheckedContinuation { cont in
            self.continuation = cont
        }
    }

    // nonisolated for Swift 6 strict concurrency compatibility
    nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        let status = manager.authorizationStatus
        Task { @MainActor in
            guard let cont = self.continuation else { return }
            self.continuation = nil
            cont.resume(returning: status)
        }
    }
}

enum AppleScriptPermission {
    private static let logger = Logger(subsystem: "com.clawdis", category: "AppleScriptPermission")

    /// Sends a benign AppleScript to Terminal to verify Automation permission.
    @MainActor
    static func isAuthorized() -> Bool {
        let script = """
        tell application "Terminal"
            return "clawdis-ok"
        end tell
        """

        var error: NSDictionary?
        let appleScript = NSAppleScript(source: script)
        let result = appleScript?.executeAndReturnError(&error)

        if let error, let code = error["NSAppleScriptErrorNumber"] as? Int {
            if code == -1743 { // errAEEventWouldRequireUserConsent
                Self.logger.debug("AppleScript permission denied (-1743)")
                return false
            }
            Self.logger.debug("AppleScript check failed with code \(code)")
        }

        return result != nil
    }

    /// Triggers the TCC prompt and opens System Settings → Privacy & Security → Automation.
    @MainActor
    static func requestAuthorization() async {
        _ = self.isAuthorized() // first attempt triggers the dialog if not granted

        // Open the Automation pane to help the user if the prompt was dismissed.
        let urlStrings = [
            "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation",
            "x-apple.systempreferences:com.apple.preference.security",
        ]

        for candidate in urlStrings {
            if let url = URL(string: candidate), NSWorkspace.shared.open(url) {
                break
            }
        }
    }
}

@MainActor
@Observable
final class PermissionMonitor {
    static let shared = PermissionMonitor()

    private(set) var status: [Capability: Bool] = [:]

    private var monitorTimer: Timer?
    private var isChecking = false
    private var registrations = 0
    private var lastCheck: Date?
    private let minimumCheckInterval: TimeInterval = 0.5

    func register() {
        self.registrations += 1
        if self.registrations == 1 {
            self.startMonitoring()
        }
    }

    func unregister() {
        guard self.registrations > 0 else { return }
        self.registrations -= 1
        if self.registrations == 0 {
            self.stopMonitoring()
        }
    }

    func refreshNow() async {
        await self.checkStatus(force: true)
    }

    private func startMonitoring() {
        Task { await self.checkStatus(force: true) }

        if ProcessInfo.processInfo.isRunningTests {
            return
        }
        self.monitorTimer = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { [weak self] _ in
            guard let self else { return }
            Task { @MainActor in
                await self.checkStatus(force: false)
            }
        }
    }

    private func stopMonitoring() {
        self.monitorTimer?.invalidate()
        self.monitorTimer = nil
        self.lastCheck = nil
    }

    private func checkStatus(force: Bool) async {
        if self.isChecking { return }
        let now = Date()
        if !force, let lastCheck, now.timeIntervalSince(lastCheck) < self.minimumCheckInterval {
            return
        }

        self.isChecking = true

        let latest = await PermissionManager.status()
        if latest != self.status {
            self.status = latest
        }
        self.lastCheck = Date()

        self.isChecking = false
    }
}

enum ScreenRecordingProbe {
    static func isAuthorized() -> Bool {
        if #available(macOS 10.15, *) {
            return CGPreflightScreenCaptureAccess()
        }
        return true
    }

    @MainActor
    static func requestAuthorization() async {
        if #available(macOS 10.15, *) {
            _ = CGRequestScreenCaptureAccess()
        }
    }
}
