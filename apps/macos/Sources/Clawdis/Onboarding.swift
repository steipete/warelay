import AppKit
import ClawdisChatUI
import ClawdisIPC
import Combine
import Observation
import SwiftUI

enum UIStrings {
    static let welcomeTitle = "Welcome to Clawdis"
}

@MainActor
final class OnboardingController {
    static let shared = OnboardingController()
    private var window: NSWindow?

    func show() {
        if ProcessInfo.processInfo.isNixMode {
            // Nix mode is fully declarative; onboarding would suggest interactive setup that doesn't apply.
            UserDefaults.standard.set(true, forKey: "clawdis.onboardingSeen")
            UserDefaults.standard.set(currentOnboardingVersion, forKey: onboardingVersionKey)
            AppStateStore.shared.onboardingSeen = true
            return
        }
        if let window {
            DockIconManager.shared.temporarilyShowDock()
            window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            return
        }
        let hosting = NSHostingController(rootView: OnboardingView())
        let window = NSWindow(contentViewController: hosting)
        window.title = UIStrings.welcomeTitle
        window.setContentSize(NSSize(width: 630, height: 644))
        window.styleMask = [.titled, .closable, .fullSizeContentView]
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.isMovableByWindowBackground = true
        window.center()
        DockIconManager.shared.temporarilyShowDock()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        self.window = window
    }

    func close() {
        self.window?.close()
        self.window = nil
    }
}

struct OnboardingView: View {
    @Environment(\.openSettings) var openSettings
    @State var currentPage = 0
    @State var isRequesting = false
    @State var installingCLI = false
    @State var cliStatus: String?
    @State var copied = false
    @State var monitoringPermissions = false
    @State var monitoringDiscovery = false
    @State var cliInstalled = false
    @State var cliInstallLocation: String?
    @State var workspacePath: String = ""
    @State var workspaceStatus: String?
    @State var workspaceApplying = false
    @State var anthropicAuthPKCE: AnthropicOAuth.PKCE?
    @State var anthropicAuthCode: String = ""
    @State var anthropicAuthStatus: String?
    @State var anthropicAuthBusy = false
    @State var anthropicAuthConnected = false
    @State var anthropicAuthDetectedStatus: ClawdisOAuthStore.AnthropicOAuthStatus = .missingFile
    @State var anthropicAuthAutoDetectClipboard = true
    @State var anthropicAuthAutoConnectClipboard = true
    @State var anthropicAuthLastPasteboardChangeCount = NSPasteboard.general.changeCount
    @State var monitoringAuth = false
    @State var authMonitorTask: Task<Void, Never>?
    @State var needsBootstrap = false
    @State var didAutoKickoff = false
    @State var showAdvancedConnection = false
    @State var preferredGatewayID: String?
    @State var gatewayDiscovery: GatewayDiscoveryModel
    @State var onboardingChatModel: ClawdisChatViewModel
    @State var localGatewayProbe: LocalGatewayProbe?
    @Bindable var state: AppState
    var permissionMonitor: PermissionMonitor

    let pageWidth: CGFloat = 630
    let contentHeight: CGFloat = 420
    let connectionPageIndex = 1
    let anthropicAuthPageIndex = 2
    let onboardingChatPageIndex = 8

    static let clipboardPoll: AnyPublisher<Date, Never> = {
        if ProcessInfo.processInfo.isRunningTests {
            return Empty(completeImmediately: false).eraseToAnyPublisher()
        }
        return Timer.publish(every: 0.4, on: .main, in: .common)
            .autoconnect()
            .eraseToAnyPublisher()
    }()

    let permissionsPageIndex = 5
    static func pageOrder(
        for mode: AppState.ConnectionMode,
        needsBootstrap: Bool) -> [Int]
    {
        switch mode {
        case .remote:
            // Remote setup doesn't need local gateway/CLI/workspace setup pages,
            // and WhatsApp/Telegram setup is optional.
            needsBootstrap ? [0, 1, 5, 8, 9] : [0, 1, 5, 9]
        case .unconfigured:
            needsBootstrap ? [0, 1, 8, 9] : [0, 1, 9]
        case .local:
            needsBootstrap ? [0, 1, 2, 5, 6, 8, 9] : [0, 1, 2, 5, 6, 9]
        }
    }

    var pageOrder: [Int] {
        Self.pageOrder(for: self.state.connectionMode, needsBootstrap: self.needsBootstrap)
    }

    var pageCount: Int { self.pageOrder.count }
    var activePageIndex: Int {
        self.activePageIndex(for: self.currentPage)
    }

    var buttonTitle: String { self.currentPage == self.pageCount - 1 ? "Finish" : "Next" }
    var devLinkCommand: String {
        let bundlePath = Bundle.main.bundlePath
        return "ln -sf '\(bundlePath)/Contents/Resources/Relay/clawdis' /usr/local/bin/clawdis"
    }

    struct LocalGatewayProbe: Equatable {
        let port: Int
        let pid: Int32
        let command: String
        let expected: Bool
    }

    init(
        state: AppState = AppStateStore.shared,
        permissionMonitor: PermissionMonitor = .shared,
        discoveryModel: GatewayDiscoveryModel = GatewayDiscoveryModel())
    {
        self.state = state
        self.permissionMonitor = permissionMonitor
        self._gatewayDiscovery = State(initialValue: discoveryModel)
        self._onboardingChatModel = State(
            initialValue: ClawdisChatViewModel(
                sessionKey: "onboarding",
                transport: MacGatewayChatTransport()))
    }
}
