import Observation
import SwiftUI

struct SettingsRootView: View {
    @Bindable var state: AppState
    private let permissionMonitor = PermissionMonitor.shared
    @State private var monitoringPermissions = false
    @State private var selectedTab: SettingsTab = .general
    let updater: UpdaterProviding?
    private let isPreview = ProcessInfo.processInfo.isPreview
    private let isNixMode = ProcessInfo.processInfo.isNixMode

    init(state: AppState, updater: UpdaterProviding?, initialTab: SettingsTab? = nil) {
        self.state = state
        self.updater = updater
        self._selectedTab = State(initialValue: initialTab ?? .general)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if self.isNixMode {
                self.nixManagedBanner
            }

            TabView(selection: self.$selectedTab) {
                GeneralSettings(state: self.state)
                    .tabItem { Label("General", systemImage: "gearshape") }
                    .tag(SettingsTab.general)

                ConnectionsSettings()
                    .tabItem { Label("Connections", systemImage: "link") }
                    .tag(SettingsTab.connections)

                VoiceWakeSettings(state: self.state)
                    .tabItem { Label("Voice Wake", systemImage: "waveform.circle") }
                    .tag(SettingsTab.voiceWake)

                ConfigSettings()
                    .tabItem { Label("Config", systemImage: "slider.horizontal.3") }
                    .tag(SettingsTab.config)

                InstancesSettings()
                    .tabItem { Label("Instances", systemImage: "network") }
                    .tag(SettingsTab.instances)

                SessionsSettings()
                    .tabItem { Label("Sessions", systemImage: "clock.arrow.circlepath") }
                    .tag(SettingsTab.sessions)

                CronSettings()
                    .tabItem { Label("Cron", systemImage: "calendar") }
                    .tag(SettingsTab.cron)

                SkillsSettings(state: self.state)
                    .tabItem { Label("Skills", systemImage: "sparkles") }
                    .tag(SettingsTab.skills)

                PermissionsSettings(
                    status: self.permissionMonitor.status,
                    refresh: self.refreshPerms,
                    showOnboarding: { OnboardingController.shared.show() })
                    .tabItem { Label("Permissions", systemImage: "lock.shield") }
                    .tag(SettingsTab.permissions)

                if self.state.debugPaneEnabled {
                    DebugSettings()
                        .tabItem { Label("Debug", systemImage: "ant") }
                        .tag(SettingsTab.debug)
                }

                AboutSettings(updater: self.updater)
                    .tabItem { Label("About", systemImage: "info.circle") }
                    .tag(SettingsTab.about)
            }
        }
        .padding(.horizontal, 28)
        .padding(.vertical, 22)
        .frame(width: SettingsTab.windowWidth, height: SettingsTab.windowHeight, alignment: .topLeading)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .onReceive(NotificationCenter.default.publisher(for: .clawdisSelectSettingsTab)) { note in
            if let tab = note.object as? SettingsTab {
                withAnimation(.spring(response: 0.32, dampingFraction: 0.85)) {
                    self.selectedTab = tab
                }
            }
        }
        .onAppear {
            if let pending = SettingsTabRouter.consumePending() {
                self.selectedTab = self.validTab(for: pending)
            }
            self.updatePermissionMonitoring(for: self.selectedTab)
        }
        .onChange(of: self.state.debugPaneEnabled) { _, enabled in
            if !enabled, self.selectedTab == .debug {
                self.selectedTab = .general
            }
        }
        .onChange(of: self.selectedTab) { _, newValue in
            self.updatePermissionMonitoring(for: newValue)
        }
        .onDisappear { self.stopPermissionMonitoring() }
        .task {
            guard !self.isPreview else { return }
            await self.refreshPerms()
        }
    }

    private var nixManagedBanner: some View {
        let configPath = ProcessInfo.processInfo.environment["CLAWDIS_CONFIG_PATH"] ?? "~/.clawdis/clawdis.json"
        let stateDir = ProcessInfo.processInfo.environment["CLAWDIS_STATE_DIR"] ?? "~/.clawdis"

        return VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Image(systemName: "gearshape.2.fill")
                    .foregroundStyle(.secondary)
                Text("Managed by Nix")
                    .font(.callout.weight(.semibold))
                    .foregroundStyle(.secondary)
            }

            VStack(alignment: .leading, spacing: 2) {
                Text("Config: \(configPath)")
                Text("State:  \(stateDir)")
            }
            .font(.caption.monospaced())
            .foregroundStyle(.secondary)
            .textSelection(.enabled)
            .lineLimit(1)
            .truncationMode(.middle)
        }
        .padding(.vertical, 8)
        .padding(.horizontal, 10)
        .background(Color.gray.opacity(0.12))
        .cornerRadius(10)
    }

    private func validTab(for requested: SettingsTab) -> SettingsTab {
        if requested == .debug, !self.state.debugPaneEnabled { return .general }
        return requested
    }

    @MainActor
    private func refreshPerms() async {
        guard !self.isPreview else { return }
        await self.permissionMonitor.refreshNow()
    }

    private func updatePermissionMonitoring(for tab: SettingsTab) {
        guard !self.isPreview else { return }
        let shouldMonitor = tab == .permissions
        if shouldMonitor, !self.monitoringPermissions {
            self.monitoringPermissions = true
            PermissionMonitor.shared.register()
        } else if !shouldMonitor, self.monitoringPermissions {
            self.monitoringPermissions = false
            PermissionMonitor.shared.unregister()
        }
    }

    private func stopPermissionMonitoring() {
        guard self.monitoringPermissions else { return }
        self.monitoringPermissions = false
        PermissionMonitor.shared.unregister()
    }
}

enum SettingsTab: CaseIterable {
    case general, connections, skills, sessions, cron, config, instances, voiceWake, permissions, debug, about
    static let windowWidth: CGFloat = 824 // wider
    static let windowHeight: CGFloat = 790 // +10% (more room)
    var title: String {
        switch self {
        case .general: "General"
        case .connections: "Connections"
        case .skills: "Skills"
        case .sessions: "Sessions"
        case .cron: "Cron"
        case .config: "Config"
        case .instances: "Instances"
        case .voiceWake: "Voice Wake"
        case .permissions: "Permissions"
        case .debug: "Debug"
        case .about: "About"
        }
    }
}

@MainActor
enum SettingsTabRouter {
    private static var pending: SettingsTab?

    static func request(_ tab: SettingsTab) {
        self.pending = tab
    }

    static func consumePending() -> SettingsTab? {
        defer { self.pending = nil }
        return self.pending
    }
}

extension Notification.Name {
    static let clawdisSelectSettingsTab = Notification.Name("clawdisSelectSettingsTab")
}

#if DEBUG
struct SettingsRootView_Previews: PreviewProvider {
    static var previews: some View {
        ForEach(SettingsTab.allCases, id: \.self) { tab in
            SettingsRootView(state: .preview, updater: DisabledUpdaterController(), initialTab: tab)
                .previewDisplayName(tab.title)
                .frame(width: SettingsTab.windowWidth, height: SettingsTab.windowHeight)
        }
    }
}
#endif
