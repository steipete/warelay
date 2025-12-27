import SwiftUI

@MainActor
struct ConfigSettings: View {
    private let isPreview = ProcessInfo.processInfo.isPreview
    private let isNixMode = ProcessInfo.processInfo.isNixMode
    private let state = AppStateStore.shared
    private let labelColumnWidth: CGFloat = 120
    private static let browserAttachOnlyHelp =
        "When enabled, the browser server will only connect if the clawd browser is already running."
    private static let browserProfileNote =
        "Clawd uses a separate Chrome profile and ports (default 18791/18792) "
            + "so it won’t interfere with your daily browser."
    @State private var configModel: String = ""
    @State private var customModel: String = ""
    @State private var configSaving = false
    @State private var hasLoaded = false
    @State private var models: [ModelChoice] = []
    @State private var modelsLoading = false
    @State private var modelError: String?
    @State private var modelsSourceLabel: String?
    @AppStorage(modelCatalogPathKey) private var modelCatalogPath: String = ModelCatalogLoader.defaultPath
    @AppStorage(modelCatalogReloadKey) private var modelCatalogReloadBump: Int = 0
    @State private var allowAutosave = false
    @State private var heartbeatMinutes: Int?
    @State private var heartbeatBody: String = "HEARTBEAT"

    // clawd browser settings (stored in ~/.clawdis/clawdis.json under "browser")
    @State private var browserEnabled: Bool = true
    @State private var browserControlUrl: String = "http://127.0.0.1:18791"
    @State private var browserColorHex: String = "#FF4500"
    @State private var browserAttachOnly: Bool = false

    var body: some View {
        ScrollView { self.content }
            .onChange(of: self.modelCatalogPath) { _, _ in
                Task { await self.loadModels() }
            }
            .onChange(of: self.modelCatalogReloadBump) { _, _ in
                Task { await self.loadModels() }
            }
            .task {
                guard !self.hasLoaded else { return }
                guard !self.isPreview else { return }
                self.hasLoaded = true
                self.loadConfig()
                await self.loadModels()
                self.allowAutosave = true
            }
    }

    private var content: some View {
        VStack(alignment: .leading, spacing: 14) {
            self.header
            self.agentSection
                .disabled(self.isNixMode)
            self.heartbeatSection
                .disabled(self.isNixMode)
            self.browserSection
                .disabled(self.isNixMode)
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 24)
        .padding(.vertical, 18)
        .groupBoxStyle(PlainSettingsGroupBoxStyle())
    }

    @ViewBuilder
    private var header: some View {
        Text("Clawdis CLI config")
            .font(.title3.weight(.semibold))
        Text(self.isNixMode
            ? "This tab is read-only in Nix mode. Edit config via Nix and rebuild."
            : "Edit ~/.clawdis/clawdis.json (agent / session / routing / messages).")
            .font(.callout)
            .foregroundStyle(.secondary)
    }

    private var agentSection: some View {
        GroupBox("Agent") {
            Grid(alignment: .leadingFirstTextBaseline, horizontalSpacing: 14, verticalSpacing: 10) {
                GridRow {
                    self.gridLabel("Model")
                    VStack(alignment: .leading, spacing: 6) {
                        self.modelPicker
                        self.customModelField
                        self.modelMetaLabels
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var modelPicker: some View {
        Picker("Model", selection: self.$configModel) {
            ForEach(self.models) { choice in
                Text("\(choice.name) — \(choice.provider.uppercased())")
                    .tag(choice.id)
            }
            Text("Manual entry…").tag("__custom__")
        }
        .labelsHidden()
        .frame(maxWidth: .infinity)
        .disabled(self.modelsLoading || (!self.modelError.isNilOrEmpty && self.models.isEmpty))
        .onChange(of: self.configModel) { _, _ in
            self.autosaveConfig()
        }
    }

    @ViewBuilder
    private var customModelField: some View {
        if self.configModel == "__custom__" {
            TextField("Enter model ID", text: self.$customModel)
                .textFieldStyle(.roundedBorder)
                .frame(maxWidth: .infinity)
                .onChange(of: self.customModel) { _, newValue in
                    self.configModel = newValue
                    self.autosaveConfig()
                }
        }
    }

    @ViewBuilder
    private var modelMetaLabels: some View {
        if let contextLabel = self.selectedContextLabel {
            Text(contextLabel)
                .font(.footnote)
                .foregroundStyle(.secondary)
        }

        if let authMode = self.selectedAnthropicAuthMode {
            HStack(spacing: 8) {
                Circle()
                    .fill(authMode.isConfigured ? Color.green : Color.orange)
                    .frame(width: 8, height: 8)
                Text("Anthropic auth: \(authMode.shortLabel)")
            }
            .font(.footnote)
            .foregroundStyle(authMode.isConfigured ? Color.secondary : Color.orange)
            .help(self.anthropicAuthHelpText)

            AnthropicAuthControls(connectionMode: self.state.connectionMode)
        }

        if let modelError {
            Text(modelError)
                .font(.footnote)
                .foregroundStyle(.secondary)
        }

        if let modelsSourceLabel {
            Text("Model catalog: \(modelsSourceLabel)")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
    }

    private var anthropicAuthHelpText: String {
        "Determined from Clawdis OAuth token file (~/.clawdis/credentials/oauth.json) " +
            "or environment variables (ANTHROPIC_OAUTH_TOKEN / ANTHROPIC_API_KEY)."
    }

    private var heartbeatSection: some View {
        GroupBox("Heartbeat") {
            Grid(alignment: .leadingFirstTextBaseline, horizontalSpacing: 14, verticalSpacing: 10) {
                GridRow {
                    self.gridLabel("Schedule")
                    VStack(alignment: .leading, spacing: 6) {
                        HStack(spacing: 12) {
                            Stepper(
                                value: Binding(
                                    get: { self.heartbeatMinutes ?? 10 },
                                    set: { self.heartbeatMinutes = $0; self.autosaveConfig() }),
                                in: 0...720)
                            {
                                Text("Every \(self.heartbeatMinutes ?? 10) min")
                                    .frame(width: 150, alignment: .leading)
                            }
                            .help("Set to 0 to disable automatic heartbeats")

                            TextField("HEARTBEAT", text: self.$heartbeatBody)
                                .textFieldStyle(.roundedBorder)
                                .frame(maxWidth: .infinity)
                                .onChange(of: self.heartbeatBody) { _, _ in
                                    self.autosaveConfig()
                                }
                                .help("Message body sent on each heartbeat")
                        }
                        Text("Heartbeats keep agent sessions warm; 0 minutes disables them.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var browserSection: some View {
        GroupBox("Browser (clawd)") {
            Grid(alignment: .leadingFirstTextBaseline, horizontalSpacing: 14, verticalSpacing: 10) {
                GridRow {
                    self.gridLabel("Enabled")
                    Toggle("", isOn: self.$browserEnabled)
                        .labelsHidden()
                        .toggleStyle(.checkbox)
                        .onChange(of: self.browserEnabled) { _, _ in self.autosaveConfig() }
                }
                GridRow {
                    self.gridLabel("Control URL")
                    TextField("http://127.0.0.1:18791", text: self.$browserControlUrl)
                        .textFieldStyle(.roundedBorder)
                        .frame(maxWidth: .infinity)
                        .disabled(!self.browserEnabled)
                        .onChange(of: self.browserControlUrl) { _, _ in self.autosaveConfig() }
                }
                GridRow {
                    self.gridLabel("Browser path")
                    VStack(alignment: .leading, spacing: 2) {
                        if let label = self.browserPathLabel {
                            Text(label)
                                .font(.caption.monospaced())
                                .foregroundStyle(.secondary)
                                .textSelection(.enabled)
                                .lineLimit(1)
                                .truncationMode(.middle)
                        } else {
                            Text("—")
                                .foregroundStyle(.secondary)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                GridRow {
                    self.gridLabel("Accent")
                    HStack(spacing: 8) {
                        TextField("#FF4500", text: self.$browserColorHex)
                            .textFieldStyle(.roundedBorder)
                            .frame(width: 120)
                            .disabled(!self.browserEnabled)
                            .onChange(of: self.browserColorHex) { _, _ in self.autosaveConfig() }
                        Circle()
                            .fill(self.browserColor)
                            .frame(width: 12, height: 12)
                            .overlay(Circle().stroke(Color.secondary.opacity(0.25), lineWidth: 1))
                        Text("lobster-orange")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }
                GridRow {
                    self.gridLabel("Attach only")
                    Toggle("", isOn: self.$browserAttachOnly)
                        .labelsHidden()
                        .toggleStyle(.checkbox)
                        .disabled(!self.browserEnabled)
                        .onChange(of: self.browserAttachOnly) { _, _ in self.autosaveConfig() }
                        .help(Self.browserAttachOnlyHelp)
                }
                GridRow {
                    Color.clear
                        .frame(width: self.labelColumnWidth, height: 1)
                    Text(Self.browserProfileNote)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func gridLabel(_ text: String) -> some View {
        Text(text)
            .foregroundStyle(.secondary)
            .frame(width: self.labelColumnWidth, alignment: .leading)
    }

    private func loadConfig() {
        let parsed = self.loadConfigDict()
        let agent = parsed["agent"] as? [String: Any]
        let heartbeatMinutes = agent?["heartbeatMinutes"] as? Int
        let heartbeatBody = agent?["heartbeatBody"] as? String
        let browser = parsed["browser"] as? [String: Any]

        let loadedModel = (agent?["model"] as? String) ?? ""
        if !loadedModel.isEmpty {
            self.configModel = loadedModel
            self.customModel = loadedModel
        } else {
            self.configModel = SessionLoader.fallbackModel
            self.customModel = SessionLoader.fallbackModel
        }

        if let heartbeatMinutes { self.heartbeatMinutes = heartbeatMinutes }
        if let heartbeatBody, !heartbeatBody.isEmpty { self.heartbeatBody = heartbeatBody }

        if let browser {
            if let enabled = browser["enabled"] as? Bool { self.browserEnabled = enabled }
            if let url = browser["controlUrl"] as? String, !url.isEmpty { self.browserControlUrl = url }
            if let color = browser["color"] as? String, !color.isEmpty { self.browserColorHex = color }
            if let attachOnly = browser["attachOnly"] as? Bool { self.browserAttachOnly = attachOnly }
        }
    }

    private func autosaveConfig() {
        guard self.allowAutosave, !self.isNixMode else { return }
        Task { await self.saveConfig() }
    }

    private func saveConfig() async {
        guard !self.configSaving else { return }
        self.configSaving = true
        defer { self.configSaving = false }

        var root = self.loadConfigDict()
        var agent = root["agent"] as? [String: Any] ?? [:]
        var browser = root["browser"] as? [String: Any] ?? [:]

        let chosenModel = (self.configModel == "__custom__" ? self.customModel : self.configModel)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedModel = chosenModel
        if !trimmedModel.isEmpty { agent["model"] = trimmedModel }

        if let heartbeatMinutes {
            agent["heartbeatMinutes"] = heartbeatMinutes
        }

        let trimmedBody = self.heartbeatBody.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmedBody.isEmpty {
            agent["heartbeatBody"] = trimmedBody
        }

        root["agent"] = agent

        browser["enabled"] = self.browserEnabled
        let trimmedUrl = self.browserControlUrl.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmedUrl.isEmpty { browser["controlUrl"] = trimmedUrl }
        let trimmedColor = self.browserColorHex.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmedColor.isEmpty { browser["color"] = trimmedColor }
        browser["attachOnly"] = self.browserAttachOnly
        root["browser"] = browser

        ClawdisConfigFile.saveDict(root)
    }

    private func loadConfigDict() -> [String: Any] {
        ClawdisConfigFile.loadDict()
    }

    private var browserColor: Color {
        let raw = self.browserColorHex.trimmingCharacters(in: .whitespacesAndNewlines)
        let hex = raw.hasPrefix("#") ? String(raw.dropFirst()) : raw
        guard hex.count == 6, let value = Int(hex, radix: 16) else { return .orange }
        let r = Double((value >> 16) & 0xFF) / 255.0
        let g = Double((value >> 8) & 0xFF) / 255.0
        let b = Double(value & 0xFF) / 255.0
        return Color(red: r, green: g, blue: b)
    }

    private var browserPathLabel: String? {
        guard self.browserEnabled else { return nil }

        let host = (URL(string: self.browserControlUrl)?.host ?? "").lowercased()
        if !host.isEmpty, !Self.isLoopbackHost(host) {
            return "remote (\(host))"
        }

        guard let candidate = Self.detectedBrowserCandidate() else { return nil }
        return candidate.executablePath ?? candidate.appPath
    }

    private struct BrowserCandidate {
        let name: String
        let appPath: String
        let executablePath: String?
    }

    private static func detectedBrowserCandidate() -> BrowserCandidate? {
        let candidates: [(name: String, appName: String)] = [
            ("Google Chrome Canary", "Google Chrome Canary.app"),
            ("Chromium", "Chromium.app"),
            ("Google Chrome", "Google Chrome.app"),
        ]

        let roots = [
            "/Applications",
            "\(NSHomeDirectory())/Applications",
        ]

        let fm = FileManager.default
        for (name, appName) in candidates {
            for root in roots {
                let appPath = "\(root)/\(appName)"
                if fm.fileExists(atPath: appPath) {
                    let bundle = Bundle(url: URL(fileURLWithPath: appPath))
                    let exec = bundle?.executableURL?.path
                    return BrowserCandidate(name: name, appPath: appPath, executablePath: exec)
                }
            }
        }

        return nil
    }

    private static func isLoopbackHost(_ host: String) -> Bool {
        if host == "localhost" { return true }
        if host == "127.0.0.1" { return true }
        if host == "::1" { return true }
        return false
    }

    private func loadModels() async {
        guard !self.modelsLoading else { return }
        self.modelsLoading = true
        self.modelError = nil
        self.modelsSourceLabel = nil
        do {
            let res: ModelsListResult =
                try await GatewayConnection.shared
                    .requestDecoded(
                        method: .modelsList,
                        timeoutMs: 15000)
            self.models = res.models
            self.modelsSourceLabel = "gateway"
            if !self.configModel.isEmpty,
               !res.models.contains(where: { $0.id == self.configModel })
            {
                self.customModel = self.configModel
                self.configModel = "__custom__"
            }
        } catch {
            do {
                let loaded = try await ModelCatalogLoader.load(from: self.modelCatalogPath)
                self.models = loaded
                self.modelsSourceLabel = "local fallback"
                if !self.configModel.isEmpty,
                   !loaded.contains(where: { $0.id == self.configModel })
                {
                    self.customModel = self.configModel
                    self.configModel = "__custom__"
                }
            } catch {
                self.modelError = error.localizedDescription
                self.models = []
            }
        }
        self.modelsLoading = false
    }

    private struct ModelsListResult: Decodable {
        let models: [ModelChoice]
    }

    private var selectedContextLabel: String? {
        let chosenId = (self.configModel == "__custom__") ? self.customModel : self.configModel
        guard
            !chosenId.isEmpty,
            let choice = self.models.first(where: { $0.id == chosenId }),
            let context = choice.contextWindow
        else {
            return nil
        }

        let human = context >= 1000 ? "\(context / 1000)k" : "\(context)"
        return "Context window: \(human) tokens"
    }

    private var selectedAnthropicAuthMode: AnthropicAuthMode? {
        let chosenId = (self.configModel == "__custom__") ? self.customModel : self.configModel
        guard !chosenId.isEmpty, let choice = self.models.first(where: { $0.id == chosenId }) else { return nil }
        guard choice.provider.lowercased() == "anthropic" else { return nil }
        return AnthropicAuthResolver.resolve()
    }

    private struct PlainSettingsGroupBoxStyle: GroupBoxStyle {
        func makeBody(configuration: Configuration) -> some View {
            VStack(alignment: .leading, spacing: 10) {
                configuration.label
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                configuration.content
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

#if DEBUG
struct ConfigSettings_Previews: PreviewProvider {
    static var previews: some View {
        ConfigSettings()
            .frame(width: SettingsTab.windowWidth, height: SettingsTab.windowHeight)
    }
}
#endif
