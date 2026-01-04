import AppKit
import ClawdisIPC
import ClawdisKit
import Foundation

actor MacNodeRuntime {
    private let cameraCapture = CameraCaptureService()
    @MainActor private let screenRecorder = ScreenRecordService()
    @MainActor private let locationService = MacNodeLocationService()

    // swiftlint:disable:next function_body_length cyclomatic_complexity
    func handleInvoke(_ req: BridgeInvokeRequest) async -> BridgeInvokeResponse {
        let command = req.command
        if command.hasPrefix("canvas.") || command.hasPrefix("canvas.a2ui."), !Self.canvasEnabled() {
            return BridgeInvokeResponse(
                id: req.id,
                ok: false,
                error: ClawdisNodeError(
                    code: .unavailable,
                    message: "CANVAS_DISABLED: enable Canvas in Settings"))
        }
        do {
            switch command {
            case ClawdisCanvasCommand.present.rawValue:
                let params = (try? Self.decodeParams(ClawdisCanvasPresentParams.self, from: req.paramsJSON)) ??
                    ClawdisCanvasPresentParams()
                let urlTrimmed = params.url?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                let url = urlTrimmed.isEmpty ? nil : urlTrimmed
                let placement = params.placement.map {
                    CanvasPlacement(x: $0.x, y: $0.y, width: $0.width, height: $0.height)
                }
                try await MainActor.run {
                    _ = try CanvasManager.shared.showDetailed(
                        sessionKey: "main",
                        target: url,
                        placement: placement)
                }
                return BridgeInvokeResponse(id: req.id, ok: true)

            case ClawdisCanvasCommand.hide.rawValue:
                await MainActor.run {
                    CanvasManager.shared.hide(sessionKey: "main")
                }
                return BridgeInvokeResponse(id: req.id, ok: true)

            case ClawdisCanvasCommand.navigate.rawValue:
                let params = try Self.decodeParams(ClawdisCanvasNavigateParams.self, from: req.paramsJSON)
                try await MainActor.run {
                    _ = try CanvasManager.shared.show(sessionKey: "main", path: params.url)
                }
                return BridgeInvokeResponse(id: req.id, ok: true)

            case ClawdisCanvasCommand.evalJS.rawValue:
                let params = try Self.decodeParams(ClawdisCanvasEvalParams.self, from: req.paramsJSON)
                let result = try await CanvasManager.shared.eval(
                    sessionKey: "main",
                    javaScript: params.javaScript)
                let payload = try Self.encodePayload(["result": result] as [String: String])
                return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: payload)

            case ClawdisCanvasCommand.snapshot.rawValue:
                let params = try? Self.decodeParams(ClawdisCanvasSnapshotParams.self, from: req.paramsJSON)
                let format = params?.format ?? .jpeg
                let maxWidth: Int? = {
                    if let raw = params?.maxWidth, raw > 0 { return raw }
                    return switch format {
                    case .png: 900
                    case .jpeg: 1600
                    }
                }()
                let quality = params?.quality ?? 0.9

                let path = try await CanvasManager.shared.snapshot(sessionKey: "main", outPath: nil)
                defer { try? FileManager.default.removeItem(atPath: path) }
                let data = try Data(contentsOf: URL(fileURLWithPath: path))
                guard let image = NSImage(data: data) else {
                    return Self.errorResponse(req, code: .unavailable, message: "canvas snapshot decode failed")
                }
                let encoded = try Self.encodeCanvasSnapshot(
                    image: image,
                    format: format,
                    maxWidth: maxWidth,
                    quality: quality)
                let payload = try Self.encodePayload([
                    "format": format == .jpeg ? "jpeg" : "png",
                    "base64": encoded.base64EncodedString(),
                ])
                return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: payload)

            case ClawdisCanvasA2UICommand.reset.rawValue:
                return try await self.handleA2UIReset(req)

            case ClawdisCanvasA2UICommand.push.rawValue, ClawdisCanvasA2UICommand.pushJSONL.rawValue:
                return try await self.handleA2UIPush(req)

            case ClawdisCameraCommand.snap.rawValue:
                guard Self.cameraEnabled() else {
                    return BridgeInvokeResponse(
                        id: req.id,
                        ok: false,
                        error: ClawdisNodeError(
                            code: .unavailable,
                            message: "CAMERA_DISABLED: enable Camera in Settings"))
                }
                let params = (try? Self.decodeParams(ClawdisCameraSnapParams.self, from: req.paramsJSON)) ??
                    ClawdisCameraSnapParams()
                let delayMs = min(10_000, max(0, params.delayMs ?? 2000))
                let res = try await self.cameraCapture.snap(
                    facing: CameraFacing(rawValue: params.facing?.rawValue ?? "") ?? .front,
                    maxWidth: params.maxWidth,
                    quality: params.quality,
                    deviceId: params.deviceId,
                    delayMs: delayMs)
                struct SnapPayload: Encodable {
                    var format: String
                    var base64: String
                    var width: Int
                    var height: Int
                }
                let payload = try Self.encodePayload(SnapPayload(
                    format: (params.format ?? .jpg).rawValue,
                    base64: res.data.base64EncodedString(),
                    width: Int(res.size.width),
                    height: Int(res.size.height)))
                return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: payload)

            case ClawdisCameraCommand.clip.rawValue:
                guard Self.cameraEnabled() else {
                    return BridgeInvokeResponse(
                        id: req.id,
                        ok: false,
                        error: ClawdisNodeError(
                            code: .unavailable,
                            message: "CAMERA_DISABLED: enable Camera in Settings"))
                }
                let params = (try? Self.decodeParams(ClawdisCameraClipParams.self, from: req.paramsJSON)) ??
                    ClawdisCameraClipParams()
                let res = try await self.cameraCapture.clip(
                    facing: CameraFacing(rawValue: params.facing?.rawValue ?? "") ?? .front,
                    durationMs: params.durationMs,
                    includeAudio: params.includeAudio ?? true,
                    deviceId: params.deviceId,
                    outPath: nil)
                defer { try? FileManager.default.removeItem(atPath: res.path) }
                let data = try Data(contentsOf: URL(fileURLWithPath: res.path))
                struct ClipPayload: Encodable {
                    var format: String
                    var base64: String
                    var durationMs: Int
                    var hasAudio: Bool
                }
                let payload = try Self.encodePayload(ClipPayload(
                    format: (params.format ?? .mp4).rawValue,
                    base64: data.base64EncodedString(),
                    durationMs: res.durationMs,
                    hasAudio: res.hasAudio))
                return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: payload)

            case ClawdisCameraCommand.list.rawValue:
                guard Self.cameraEnabled() else {
                    return BridgeInvokeResponse(
                        id: req.id,
                        ok: false,
                        error: ClawdisNodeError(
                            code: .unavailable,
                            message: "CAMERA_DISABLED: enable Camera in Settings"))
                }
                let devices = await self.cameraCapture.listDevices()
                let payload = try Self.encodePayload(["devices": devices])
                return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: payload)

            case ClawdisLocationCommand.get.rawValue:
                let mode = Self.locationMode()
                guard mode != .off else {
                    return BridgeInvokeResponse(
                        id: req.id,
                        ok: false,
                        error: ClawdisNodeError(
                            code: .unavailable,
                            message: "LOCATION_DISABLED: enable Location in Settings"))
                }
                let params = (try? Self.decodeParams(ClawdisLocationGetParams.self, from: req.paramsJSON)) ??
                    ClawdisLocationGetParams()
                let desired = params.desiredAccuracy ??
                    (Self.locationPreciseEnabled() ? .precise : .balanced)
                let status = await self.locationService.authorizationStatus()
                // Note: macOS only supports authorizedAlways (authorizedWhenInUse is iOS only)
                if status != .authorizedAlways {
                    return BridgeInvokeResponse(
                        id: req.id,
                        ok: false,
                        error: ClawdisNodeError(
                            code: .unavailable,
                            message: "LOCATION_PERMISSION_REQUIRED: grant Location permission"))
                }
                do {
                    let location = try await self.locationService.currentLocation(
                        desiredAccuracy: desired,
                        maxAgeMs: params.maxAgeMs,
                        timeoutMs: params.timeoutMs)
                    let isPrecise = await self.locationService.accuracyAuthorization() == .fullAccuracy
                    let payload = ClawdisLocationPayload(
                        lat: location.coordinate.latitude,
                        lon: location.coordinate.longitude,
                        accuracyMeters: location.horizontalAccuracy,
                        altitudeMeters: location.verticalAccuracy >= 0 ? location.altitude : nil,
                        speedMps: location.speed >= 0 ? location.speed : nil,
                        headingDeg: location.course >= 0 ? location.course : nil,
                        timestamp: ISO8601DateFormatter().string(from: location.timestamp),
                        isPrecise: isPrecise,
                        source: nil)
                    let json = try Self.encodePayload(payload)
                    return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: json)
                } catch MacNodeLocationService.Error.timeout {
                    return BridgeInvokeResponse(
                        id: req.id,
                        ok: false,
                        error: ClawdisNodeError(
                            code: .unavailable,
                            message: "LOCATION_TIMEOUT: no fix in time"))
                } catch {
                    return BridgeInvokeResponse(
                        id: req.id,
                        ok: false,
                        error: ClawdisNodeError(
                            code: .unavailable,
                            message: "LOCATION_UNAVAILABLE: \(error.localizedDescription)"))
                }

            case MacNodeScreenCommand.record.rawValue:
                let params = (try? Self.decodeParams(MacNodeScreenRecordParams.self, from: req.paramsJSON)) ??
                    MacNodeScreenRecordParams()
                if let format = params.format?.lowercased(), !format.isEmpty, format != "mp4" {
                    return Self.errorResponse(
                        req,
                        code: .invalidRequest,
                        message: "INVALID_REQUEST: screen format must be mp4")
                }
                let res = try await self.screenRecorder.record(
                    screenIndex: params.screenIndex,
                    durationMs: params.durationMs,
                    fps: params.fps,
                    includeAudio: params.includeAudio,
                    outPath: nil)
                defer { try? FileManager.default.removeItem(atPath: res.path) }
                let data = try Data(contentsOf: URL(fileURLWithPath: res.path))
                struct ScreenPayload: Encodable {
                    var format: String
                    var base64: String
                    var durationMs: Int?
                    var fps: Double?
                    var screenIndex: Int?
                    var hasAudio: Bool
                }
                let payload = try Self.encodePayload(ScreenPayload(
                    format: "mp4",
                    base64: data.base64EncodedString(),
                    durationMs: params.durationMs,
                    fps: params.fps,
                    screenIndex: params.screenIndex,
                    hasAudio: res.hasAudio))
                return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: payload)

            case ClawdisSystemCommand.run.rawValue:
                return try await self.handleSystemRun(req)

            case ClawdisSystemCommand.notify.rawValue:
                return try await self.handleSystemNotify(req)

            default:
                return Self.errorResponse(req, code: .invalidRequest, message: "INVALID_REQUEST: unknown command")
            }
        } catch {
            return Self.errorResponse(req, code: .unavailable, message: error.localizedDescription)
        }
    }

    private func handleA2UIReset(_ req: BridgeInvokeRequest) async throws -> BridgeInvokeResponse {
        try await self.ensureA2UIHost()

        let json = try await CanvasManager.shared.eval(sessionKey: "main", javaScript: """
        (() => {
          if (!globalThis.clawdisA2UI) return JSON.stringify({ ok: false, error: "missing clawdisA2UI" });
          return JSON.stringify(globalThis.clawdisA2UI.reset());
        })()
        """)
        return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: json)
    }

    private func handleA2UIPush(_ req: BridgeInvokeRequest) async throws -> BridgeInvokeResponse {
        let command = req.command
        let messages: [ClawdisKit.AnyCodable]
        if command == ClawdisCanvasA2UICommand.pushJSONL.rawValue {
            let params = try Self.decodeParams(ClawdisCanvasA2UIPushJSONLParams.self, from: req.paramsJSON)
            messages = try ClawdisCanvasA2UIJSONL.decodeMessagesFromJSONL(params.jsonl)
        } else {
            do {
                let params = try Self.decodeParams(ClawdisCanvasA2UIPushParams.self, from: req.paramsJSON)
                messages = params.messages
            } catch {
                let params = try Self.decodeParams(ClawdisCanvasA2UIPushJSONLParams.self, from: req.paramsJSON)
                messages = try ClawdisCanvasA2UIJSONL.decodeMessagesFromJSONL(params.jsonl)
            }
        }

        try await self.ensureA2UIHost()

        let messagesJSON = try ClawdisCanvasA2UIJSONL.encodeMessagesJSONArray(messages)
        let js = """
        (() => {
          try {
            if (!globalThis.clawdisA2UI) return JSON.stringify({ ok: false, error: "missing clawdisA2UI" });
            const messages = \(messagesJSON);
            return JSON.stringify(globalThis.clawdisA2UI.applyMessages(messages));
          } catch (e) {
            return JSON.stringify({ ok: false, error: String(e?.message ?? e) });
          }
        })()
        """
        let resultJSON = try await CanvasManager.shared.eval(sessionKey: "main", javaScript: js)
        return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: resultJSON)
    }

    private func ensureA2UIHost() async throws {
        if await self.isA2UIReady() { return }
        guard let a2uiUrl = await self.resolveA2UIHostUrl() else {
            throw NSError(domain: "Canvas", code: 30, userInfo: [
                NSLocalizedDescriptionKey: "A2UI_HOST_NOT_CONFIGURED: gateway did not advertise canvas host",
            ])
        }
        _ = try await MainActor.run {
            try CanvasManager.shared.show(sessionKey: "main", path: a2uiUrl)
        }
        if await self.isA2UIReady(poll: true) { return }
        throw NSError(domain: "Canvas", code: 31, userInfo: [
            NSLocalizedDescriptionKey: "A2UI_HOST_UNAVAILABLE: A2UI host not reachable",
        ])
    }

    private func resolveA2UIHostUrl() async -> String? {
        guard let raw = await GatewayConnection.shared.canvasHostUrl() else { return nil }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let baseUrl = URL(string: trimmed) else { return nil }
        return baseUrl.appendingPathComponent("__clawdis__/a2ui/").absoluteString + "?platform=macos"
    }

    private func isA2UIReady(poll: Bool = false) async -> Bool {
        let deadline = poll ? Date().addingTimeInterval(6.0) : Date()
        while true {
            do {
                let ready = try await CanvasManager.shared.eval(sessionKey: "main", javaScript: """
                (() => String(Boolean(globalThis.clawdisA2UI)))()
                """)
                let trimmed = ready.trimmingCharacters(in: .whitespacesAndNewlines)
                if trimmed == "true" { return true }
            } catch {
                // Ignore transient eval failures while the page is loading.
            }

            guard poll, Date() < deadline else { return false }
            try? await Task.sleep(nanoseconds: 120_000_000)
        }
    }

    private func handleSystemRun(_ req: BridgeInvokeRequest) async throws -> BridgeInvokeResponse {
        let params = try Self.decodeParams(ClawdisSystemRunParams.self, from: req.paramsJSON)
        let command = params.command
        guard !command.isEmpty else {
            return Self.errorResponse(req, code: .invalidRequest, message: "INVALID_REQUEST: command required")
        }

        if params.needsScreenRecording == true {
            let authorized = await PermissionManager
                .status([.screenRecording])[.screenRecording] ?? false
            if !authorized {
                return Self.errorResponse(
                    req,
                    code: .unavailable,
                    message: "PERMISSION_MISSING: screenRecording")
            }
        }

        let timeoutSec = params.timeoutMs.flatMap { Double($0) / 1000.0 }
        let result = await ShellExecutor.runDetailed(
            command: command,
            cwd: params.cwd,
            env: params.env,
            timeout: timeoutSec)

        struct RunPayload: Encodable {
            var exitCode: Int?
            var timedOut: Bool
            var success: Bool
            var stdout: String
            var stderr: String
            var error: String?
        }

        let payload = try Self.encodePayload(RunPayload(
            exitCode: result.exitCode,
            timedOut: result.timedOut,
            success: result.success,
            stdout: result.stdout,
            stderr: result.stderr,
            error: result.errorMessage))
        return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: payload)
    }

    private func handleSystemNotify(_ req: BridgeInvokeRequest) async throws -> BridgeInvokeResponse {
        let params = try Self.decodeParams(ClawdisSystemNotifyParams.self, from: req.paramsJSON)
        let title = params.title.trimmingCharacters(in: .whitespacesAndNewlines)
        let body = params.body.trimmingCharacters(in: .whitespacesAndNewlines)
        if title.isEmpty, body.isEmpty {
            return Self.errorResponse(req, code: .invalidRequest, message: "INVALID_REQUEST: empty notification")
        }

        let priority = params.priority.flatMap { NotificationPriority(rawValue: $0.rawValue) }
        let delivery = params.delivery.flatMap { NotificationDelivery(rawValue: $0.rawValue) } ?? .system
        let manager = NotificationManager()

        switch delivery {
        case .system:
            let ok = await manager.send(
                title: title,
                body: body,
                sound: params.sound,
                priority: priority)
            return ok
                ? BridgeInvokeResponse(id: req.id, ok: true)
                : Self.errorResponse(req, code: .unavailable, message: "NOT_AUTHORIZED: notifications")
        case .overlay:
            await NotifyOverlayController.shared.present(title: title, body: body)
            return BridgeInvokeResponse(id: req.id, ok: true)
        case .auto:
            let ok = await manager.send(
                title: title,
                body: body,
                sound: params.sound,
                priority: priority)
            if ok {
                return BridgeInvokeResponse(id: req.id, ok: true)
            }
            await NotifyOverlayController.shared.present(title: title, body: body)
            return BridgeInvokeResponse(id: req.id, ok: true)
        }
    }

    private static func decodeParams<T: Decodable>(_ type: T.Type, from json: String?) throws -> T {
        guard let json, let data = json.data(using: .utf8) else {
            throw NSError(domain: "Bridge", code: 20, userInfo: [
                NSLocalizedDescriptionKey: "INVALID_REQUEST: paramsJSON required",
            ])
        }
        return try JSONDecoder().decode(type, from: data)
    }

    private static func encodePayload(_ obj: some Encodable) throws -> String {
        let data = try JSONEncoder().encode(obj)
        guard let json = String(bytes: data, encoding: .utf8) else {
            throw NSError(domain: "Node", code: 21, userInfo: [
                NSLocalizedDescriptionKey: "Failed to encode payload as UTF-8",
            ])
        }
        return json
    }

    private nonisolated static func canvasEnabled() -> Bool {
        UserDefaults.standard.object(forKey: canvasEnabledKey) as? Bool ?? true
    }

    private nonisolated static func cameraEnabled() -> Bool {
        UserDefaults.standard.object(forKey: cameraEnabledKey) as? Bool ?? false
    }

    private nonisolated static func locationMode() -> ClawdisLocationMode {
        let raw = UserDefaults.standard.string(forKey: locationModeKey) ?? "off"
        return ClawdisLocationMode(rawValue: raw) ?? .off
    }

    private nonisolated static func locationPreciseEnabled() -> Bool {
        if UserDefaults.standard.object(forKey: locationPreciseKey) == nil { return true }
        return UserDefaults.standard.bool(forKey: locationPreciseKey)
    }

    private static func errorResponse(
        _ req: BridgeInvokeRequest,
        code: ClawdisNodeErrorCode,
        message: String) -> BridgeInvokeResponse
    {
        BridgeInvokeResponse(
            id: req.id,
            ok: false,
            error: ClawdisNodeError(code: code, message: message))
    }

    private static func encodeCanvasSnapshot(
        image: NSImage,
        format: ClawdisCanvasSnapshotFormat,
        maxWidth: Int?,
        quality: Double) throws -> Data
    {
        let source = Self.scaleImage(image, maxWidth: maxWidth) ?? image
        guard let tiff = source.tiffRepresentation,
              let rep = NSBitmapImageRep(data: tiff)
        else {
            throw NSError(domain: "Canvas", code: 22, userInfo: [
                NSLocalizedDescriptionKey: "snapshot encode failed",
            ])
        }

        switch format {
        case .png:
            guard let data = rep.representation(using: .png, properties: [:]) else {
                throw NSError(domain: "Canvas", code: 23, userInfo: [
                    NSLocalizedDescriptionKey: "png encode failed",
                ])
            }
            return data
        case .jpeg:
            let clamped = min(1.0, max(0.05, quality))
            guard let data = rep.representation(
                using: .jpeg,
                properties: [.compressionFactor: clamped])
            else {
                throw NSError(domain: "Canvas", code: 24, userInfo: [
                    NSLocalizedDescriptionKey: "jpeg encode failed",
                ])
            }
            return data
        }
    }

    private static func scaleImage(_ image: NSImage, maxWidth: Int?) -> NSImage? {
        guard let maxWidth, maxWidth > 0 else { return image }
        let size = image.size
        guard size.width > 0, size.width > CGFloat(maxWidth) else { return image }
        let scale = CGFloat(maxWidth) / size.width
        let target = NSSize(width: CGFloat(maxWidth), height: size.height * scale)

        let out = NSImage(size: target)
        out.lockFocus()
        image.draw(
            in: NSRect(origin: .zero, size: target),
            from: NSRect(origin: .zero, size: size),
            operation: .copy,
            fraction: 1.0)
        out.unlockFocus()
        return out
    }
}
