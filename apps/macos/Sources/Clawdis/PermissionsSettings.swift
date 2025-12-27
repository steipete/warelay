import ClawdisIPC
import SwiftUI

struct PermissionsSettings: View {
    let status: [Capability: Bool]
    let refresh: () async -> Void
    let showOnboarding: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Allow these so Clawdis can notify and capture when needed.")
                .padding(.top, 4)

            PermissionStatusList(status: self.status, refresh: self.refresh)
                .padding(.horizontal, 2)
                .padding(.vertical, 6)

            Button("Show onboarding") { self.showOnboarding() }
                .buttonStyle(.bordered)
            Spacer()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 12)
    }
}

struct PermissionStatusList: View {
    let status: [Capability: Bool]
    let refresh: () async -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(Capability.allCases, id: \.self) { cap in
                PermissionRow(capability: cap, status: self.status[cap] ?? false) {
                    Task { await self.handle(cap) }
                }
            }
            Button {
                Task { await self.refresh() }
            } label: {
                Label("Refresh", systemImage: "arrow.clockwise")
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
            .font(.footnote)
            .padding(.top, 2)
            .help("Refresh status")

            if (self.status[.accessibility] ?? false) == false || (self.status[.screenRecording] ?? false) == false {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Note: macOS may require restarting Clawdis after enabling Accessibility or Screen Recording.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)

                    Button {
                        LaunchdManager.startClawdis()
                    } label: {
                        Label("Restart Clawdis", systemImage: "arrow.counterclockwise")
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                }
                .padding(.top, 4)
            }
        }
    }

    @MainActor
    private func handle(_ cap: Capability) async {
        _ = await PermissionManager.ensure([cap], interactive: true)
        await self.refresh()
    }
}

struct PermissionRow: View {
    let capability: Capability
    let status: Bool
    let compact: Bool
    let action: () -> Void

    init(capability: Capability, status: Bool, compact: Bool = false, action: @escaping () -> Void) {
        self.capability = capability
        self.status = status
        self.compact = compact
        self.action = action
    }

    var body: some View {
        HStack(spacing: self.compact ? 10 : 12) {
            ZStack {
                Circle().fill(self.status ? Color.green.opacity(0.2) : Color.gray.opacity(0.15))
                    .frame(width: self.iconSize, height: self.iconSize)
                Image(systemName: self.icon)
                    .foregroundStyle(self.status ? Color.green : Color.secondary)
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(self.title).font(.body.weight(.semibold))
                Text(self.subtitle).font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            if self.status {
                Label("Granted", systemImage: "checkmark.circle.fill")
                    .foregroundStyle(.green)
            } else {
                Button("Grant") { self.action() }
                    .buttonStyle(.bordered)
            }
        }
        .padding(.vertical, self.compact ? 4 : 6)
    }

    private var iconSize: CGFloat { self.compact ? 28 : 32 }

    private var title: String {
        switch self.capability {
        case .appleScript: "Automation (AppleScript)"
        case .notifications: "Notifications"
        case .accessibility: "Accessibility"
        case .screenRecording: "Screen Recording"
        case .microphone: "Microphone"
        case .speechRecognition: "Speech Recognition"
        }
    }

    private var subtitle: String {
        switch self.capability {
        case .appleScript:
            "Control other apps (e.g. Terminal) for automation actions"
        case .notifications: "Show desktop alerts for agent activity"
        case .accessibility: "Control UI elements when an action requires it"
        case .screenRecording: "Capture the screen for context or screenshots"
        case .microphone: "Allow Voice Wake and audio capture"
        case .speechRecognition: "Transcribe Voice Wake trigger phrases on-device"
        }
    }

    private var icon: String {
        switch self.capability {
        case .appleScript: "applescript"
        case .notifications: "bell"
        case .accessibility: "hand.raised"
        case .screenRecording: "display"
        case .microphone: "mic"
        case .speechRecognition: "waveform"
        }
    }
}

#if DEBUG
struct PermissionsSettings_Previews: PreviewProvider {
    static var previews: some View {
        PermissionsSettings(
            status: [
                .appleScript: true,
                .notifications: true,
                .accessibility: false,
                .screenRecording: false,
                .microphone: true,
                .speechRecognition: false,
            ],
            refresh: {},
            showOnboarding: {})
            .frame(width: SettingsTab.windowWidth, height: SettingsTab.windowHeight)
    }
}
#endif
