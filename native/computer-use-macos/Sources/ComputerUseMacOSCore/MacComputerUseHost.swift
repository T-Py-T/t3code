import AppKit
import ApplicationServices
import CoreGraphics
import CryptoKit
import Foundation
import ImageIO
import ScreenCaptureKit
import Security
import UniformTypeIdentifiers

private struct TargetRecord: Sendable {
    let targetId: String
    let displayName: String
    let applicationId: String
    let stableIdentity: String
    let processId: pid_t
    let windowId: CGWindowID
    let bounds: CGRect
    let classification: TargetClassification

    var json: JSONValue {
        var object: [String: JSONValue] = [
            "targetId": .string(targetId),
            "kind": .string(classification.kind),
            "displayName": .string(displayName),
            "applicationId": .string(applicationId),
            "stableIdentity": .string(stableIdentity),
            "integration": .object([
                "_tag": .string(classification.integration),
                "supportedOperations": .array([.string("observe"), .string("act")]),
            ]),
        ]
        if let application = classification.application,
           case .object(var integration) = object["integration"]
        {
            integration["application"] = .string(application)
            if let documentName = classification.documentName {
                integration["documentName"] = .string(documentName)
            }
            object["integration"] = .object(integration)
        }
        return .object(object)
    }
}

private struct ObservationRecord {
    let observationId: String
    let target: TargetRecord
    let elements: [String: AXUIElement]
}

struct LeaseCancellationRegistry: Sendable {
    private var cancelled: Set<String> = []

    mutating func cancel(_ leaseId: String) { cancelled.insert(leaseId) }
    func contains(_ leaseId: String) -> Bool { cancelled.contains(leaseId) }
}

private enum HostFailure: Error {
    case permissionMissing(String)
    case targetNotFound
    case targetIdentityChanged
    case staleObservation
    case unsupportedOperation(String)
    case policyDenied
    case targetClosed
    case lockStateChanged
    case humanInputDetected
    case interrupted
    case malformedRequest(String)

    var payload: HostErrorPayload {
        switch self {
        case .permissionMissing(let permission):
            return HostErrorPayload(
                tag: "ComputerUsePermissionMissingError",
                message: "Required macOS permission is missing.",
                detail: .object(["permission": .string(permission)])
            )
        case .targetNotFound:
            return HostErrorPayload(
                tag: "ComputerUseTargetNotFoundError",
                message: "The requested window is not available."
            )
        case .targetIdentityChanged:
            return HostErrorPayload(
                tag: "ComputerUseTargetIdentityChangedError",
                message: "The requested application identity changed."
            )
        case .staleObservation:
            return HostErrorPayload(
                tag: "ComputerUseStaleObservationError",
                message: "The observation is no longer current."
            )
        case .unsupportedOperation(let operation):
            return HostErrorPayload(
                tag: "ComputerUseUnsupportedOperationError",
                message: "The requested Computer Use operation is unsupported.",
                detail: .object(["operation": .string(operation)])
            )
        case .policyDenied:
            return HostErrorPayload(
                tag: "ComputerUsePolicyDeniedError",
                message: "The helper denied this protected target."
            )
        case .targetClosed:
            return HostErrorPayload(
                tag: "ComputerUseTargetClosedError",
                message: "The target closed during the action."
            )
        case .lockStateChanged:
            return HostErrorPayload(
                tag: "ComputerUseLockStateChangedError",
                message: "The macOS desktop locked during Computer Use. Unlock it locally to continue."
            )
        case .humanInputDetected:
            return HostErrorPayload(
                tag: "ComputerUseHumanInputDetectedError",
                message: "Local keyboard or pointer input interrupted Computer Use."
            )
        case .interrupted:
            return HostErrorPayload(
                tag: "ComputerUseInterruptedError",
                message: "The action was interrupted."
            )
        case .malformedRequest(let field):
            return HostErrorPayload(
                tag: "ComputerUseMalformedResponseError",
                message: "The helper received a malformed request.",
                detail: .object(["field": .string(field)])
            )
        }
    }
}

private func number(_ value: CFTypeRef?) -> Double? {
    guard let value else { return nil }
    if CFGetTypeID(value) == CFNumberGetTypeID() {
        return (value as? NSNumber)?.doubleValue
    }
    return nil
}

private func string(_ value: CFTypeRef?) -> String? {
    guard let value else { return nil }
    return value as? String
}

private func axValue(_ element: AXUIElement, _ attribute: String) -> CFTypeRef? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success else {
        return nil
    }
    return value
}

private func sha256Hex(_ data: Data) -> String {
    SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
}

func macOsExecutableIdentity(executableURL: URL?) -> String? {
    guard let executableURL else { return nil }
    let canonicalURL = executableURL.resolvingSymlinksInPath().standardizedFileURL
    var staticCode: SecStaticCode?
    let codeAvailable = SecStaticCodeCreateWithPath(canonicalURL as CFURL, [], &staticCode) == errSecSuccess
    if codeAvailable, let staticCode,
       SecStaticCodeCheckValidity(staticCode, [], nil) == errSecSuccess
    {
        var information: CFDictionary?
        let signingInformation = SecCSFlags(rawValue: UInt32(kSecCSSigningInformation))
        if SecCodeCopySigningInformation(staticCode, signingInformation, &information) == errSecSuccess,
           let values = information as? [CFString: Any]
        {
            if let team = values[kSecCodeInfoTeamIdentifier] as? String, !team.isEmpty {
                return "team:\(team)"
            }
            if let platform = values[kSecCodeInfoPlatformIdentifier] as? String, !platform.isEmpty {
                return "platform:\(platform)"
            }
        }
    }
    guard let executableData = try? Data(contentsOf: canonicalURL, options: .mappedIfSafe) else {
        return nil
    }
    let pathDigest = sha256Hex(Data(canonicalURL.path.utf8))
    return "unsigned:path-sha256:\(pathDigest):exe-sha256:\(sha256Hex(executableData))"
}

private func targetId(windowId: CGWindowID) -> String { "macos-window:\(windowId)" }

func macOsSessionIsLocked(_ session: [String: Any]?) -> Bool {
    guard let session else { return true }
    return session["CGSSessionScreenIsLocked"] as? Bool ?? false
}

private let syntheticEventMarker: Int64 = 0x543343554D41434

private func markSynthetic(_ event: CGEvent) {
    event.setIntegerValueField(.eventSourceUserData, value: syntheticEventMarker)
}

private let humanInputEventCallback: CGEventTapCallBack = { _, type, event, userInfo in
    guard let userInfo else { return Unmanaged.passUnretained(event) }
    let monitor = Unmanaged<HumanInputMonitor>.fromOpaque(userInfo).takeUnretainedValue()
    if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
        monitor.enableTap()
    } else if event.getIntegerValueField(.eventSourceUserData) != syntheticEventMarker {
        monitor.recordInput()
    }
    return Unmanaged.passUnretained(event)
}

private final class HumanInputMonitor: @unchecked Sendable {
    private let lock = NSLock()
    private var generation: UInt64 = 0
    private var available = false
    private var tap: CFMachPort?
    private var runLoop: CFRunLoop?
    private var thread: Thread?

    init() {
        let ready = DispatchSemaphore(value: 0)
        let thread = Thread { [weak self] in self?.run(ready: ready) }
        thread.name = "T3 Computer Use input monitor"
        self.thread = thread
        thread.start()
        _ = ready.wait(timeout: .now() + 2)
    }

    deinit {
        lock.lock()
        let activeRunLoop = runLoop
        lock.unlock()
        if let activeRunLoop { CFRunLoopStop(activeRunLoop) }
    }

    func snapshot() -> UInt64? {
        lock.lock()
        defer { lock.unlock() }
        return available ? generation : nil
    }

    func recordInput() {
        lock.lock()
        generation &+= 1
        lock.unlock()
    }

    func enableTap() {
        lock.lock()
        let activeTap = tap
        lock.unlock()
        if let activeTap { CGEvent.tapEnable(tap: activeTap, enable: true) }
    }

    private func run(ready: DispatchSemaphore) {
        let eventTypes: [CGEventType] = [
            .keyDown, .keyUp, .flagsChanged,
            .leftMouseDown, .leftMouseUp, .rightMouseDown, .rightMouseUp,
            .otherMouseDown, .otherMouseUp, .mouseMoved,
            .leftMouseDragged, .rightMouseDragged, .otherMouseDragged, .scrollWheel,
        ]
        let mask = eventTypes.reduce(CGEventMask(0)) {
            $0 | (CGEventMask(1) << CGEventMask($1.rawValue))
        }
        guard let eventTap = CGEvent.tapCreate(
            tap: .cgSessionEventTap,
            place: .headInsertEventTap,
            options: .listenOnly,
            eventsOfInterest: mask,
            callback: humanInputEventCallback,
            userInfo: Unmanaged.passUnretained(self).toOpaque()
        ) else {
            ready.signal()
            return
        }
        let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, eventTap, 0)
        let activeRunLoop = CFRunLoopGetCurrent()
        lock.lock()
        tap = eventTap
        runLoop = activeRunLoop
        available = true
        lock.unlock()
        CFRunLoopAddSource(activeRunLoop, source, .commonModes)
        CGEvent.tapEnable(tap: eventTap, enable: true)
        ready.signal()
        CFRunLoopRun()
        lock.lock()
        available = false
        tap = nil
        runLoop = nil
        lock.unlock()
    }
}

private func mouseEvent(
    type: CGEventType,
    point: CGPoint,
    button: CGMouseButton,
    clickState: Int64? = nil
) throws {
    guard let event = CGEvent(
        mouseEventSource: CGEventSource(stateID: .hidSystemState),
        mouseType: type,
        mouseCursorPosition: point,
        mouseButton: button
    ) else { throw HostFailure.unsupportedOperation("pointer-event") }
    if let clickState { event.setIntegerValueField(.mouseEventClickState, value: clickState) }
    markSynthetic(event)
    event.post(tap: .cghidEventTap)
}

private let keyCodes: [String: CGKeyCode] = [
    "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7,
    "c": 8, "v": 9, "b": 11, "q": 12, "w": 13, "e": 14, "r": 15,
    "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22,
    "5": 23, "=": 24, "9": 25, "7": 26, "-": 27, "8": 28, "0": 29,
    "]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35,
    "enter": 36, "l": 37, "j": 38, "'": 39, "k": 40, ";": 41,
    "\\": 42, ",": 43, "/": 44, "n": 45, "m": 46, ".": 47,
    "tab": 48, "space": 49, "`": 50, "backspace": 51, "escape": 53,
    "meta": 55, "shift": 56, "alt": 58, "control": 59,
    "left": 123, "right": 124, "down": 125, "up": 126,
]

private struct PasteboardSnapshot {
    let items: [[NSPasteboard.PasteboardType: Data]]

    init(_ pasteboard: NSPasteboard) {
        items = (pasteboard.pasteboardItems ?? []).map { item in
            Dictionary(
                uniqueKeysWithValues: item.types.compactMap { type in
                    item.data(forType: type).map { (type, $0) }
                }
            )
        }
    }

    func restore(to pasteboard: NSPasteboard) {
        pasteboard.clearContents()
        let restored = items.map { encoded in
            let item = NSPasteboardItem()
            for (type, data) in encoded {
                item.setData(data, forType: type)
            }
            return item
        }
        if !restored.isEmpty {
            pasteboard.writeObjects(restored)
        }
    }
}

private func eventFlags(_ modifiers: [JSONValue]) -> CGEventFlags {
    modifiers.reduce(into: CGEventFlags()) { flags, value in
        switch value.string?.lowercased() {
        case "shift": flags.insert(.maskShift)
        case "control": flags.insert(.maskControl)
        case "alt": flags.insert(.maskAlternate)
        case "meta": flags.insert(.maskCommand)
        case "fn": flags.insert(.maskSecondaryFn)
        default: break
        }
    }
}

private func postKey(key: String, modifiers: [JSONValue], phase: String) throws {
    guard let code = keyCodes[key.lowercased()] else {
        throw HostFailure.unsupportedOperation("keypress:\(key)")
    }
    let flags = eventFlags(modifiers)
    func post(_ down: Bool) throws {
        guard let event = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: down) else {
            throw HostFailure.unsupportedOperation("keypress")
        }
        event.flags = flags
        markSynthetic(event)
        event.post(tap: .cghidEventTap)
    }
    if phase == "press" || phase == "down" { try post(true) }
    if phase == "press" || phase == "up" { try post(false) }
}

public actor MacComputerUseHost {
    private var observations: [String: ObservationRecord] = [:]
    private var cancellations = LeaseCancellationRegistry()
    private let humanInputMonitor = HumanInputMonitor()

    public init() {}

    public func cancel(_ cancel: HostCancel) {
        cancellations.cancel(cancel.leaseId)
        releaseSyntheticInput()
    }

    public func handle(_ request: HostRequest) async -> HostResponse {
        do {
            let result: JSONValue
            switch request.operation {
            case "status": result = status()
            case "listTargets":
                let requestedKind = request.input.object?["kind"]?.string
                let targets = discoverTargets().filter {
                    TargetClassifier.matches(
                        requestedKind: requestedKind,
                        targetKind: $0.classification.kind
                    )
                }
                result = .object(["targets": .array(targets.map(\.json))])
            case "observe":
                guard let requestedTargetId = request.targetId else {
                    throw HostFailure.malformedRequest("targetId")
                }
                let includeScreenshot = request.input.object?["includeScreenshot"]?.bool ?? true
                let includeAccessibility = request.input.object?["includeAccessibility"]?.bool ?? true
                result = try await observe(
                    targetId: requestedTargetId,
                    includeScreenshot: includeScreenshot,
                    includeAccessibility: includeAccessibility
                )
            case "act": result = try await act(request)
            default: throw HostFailure.unsupportedOperation(request.operation)
            }
            return .success(request, result: result)
        } catch let failure as HostFailure {
            releaseSyntheticInput()
            let payload = failure.payload
            return .failure(
                request,
                tag: payload.tag,
                message: payload.message,
                detail: payload.detail
            )
        } catch {
            releaseSyntheticInput()
            return .failure(
                request,
                tag: "ComputerUseUnsupportedOperationError",
                message: "The macOS helper could not complete the operation."
            )
        }
    }

    private func status() -> JSONValue {
        let accessibility = AXIsProcessTrusted()
        let screenCapture = CGPreflightScreenCaptureAccess()
        let foreground = NSWorkspace.shared.frontmostApplication.flatMap { application in
            discoverTargets().first(where: { $0.processId == application.processIdentifier })
        }
        var object: [String: JSONValue] = [
            "locked": .bool(screenIsLocked()),
            "permissions": .object([
                "accessibility": .string(accessibility ? "granted" : "denied"),
                "screenCapture": .string(screenCapture ? "granted" : "denied"),
                "input": .string(accessibility ? "granted" : "denied"),
            ]),
        ]
        if let foreground { object["foregroundTargetId"] = .string(foreground.targetId) }
        return .object(object)
    }

    private func screenIsLocked() -> Bool {
        macOsSessionIsLocked(CGSessionCopyCurrentDictionary() as? [String: Any])
    }

    private func discoverTargets() -> [TargetRecord] {
        guard let raw = CGWindowListCopyWindowInfo(
            [.optionOnScreenOnly, .excludeDesktopElements],
            kCGNullWindowID
        ) as? [[String: Any]] else { return [] }
        return raw.compactMap { window in
            guard let windowId = window[kCGWindowNumber as String] as? CGWindowID,
                  let processId = window[kCGWindowOwnerPID as String] as? pid_t,
                  let owner = window[kCGWindowOwnerName as String] as? String,
                  let boundsDictionary = window[kCGWindowBounds as String] as? NSDictionary,
                  let bounds = CGRect(dictionaryRepresentation: boundsDictionary),
                  bounds.width >= 32,
                  bounds.height >= 32,
                  (window[kCGWindowLayer as String] as? Int ?? 0) == 0
            else { return nil }
            let application = NSRunningApplication(processIdentifier: processId)
            let bundleId = application?.bundleIdentifier
            guard !TargetPolicy.isForbidden(bundleId: bundleId, processName: owner) else {
                return nil
            }
            let applicationId = bundleId ?? application?.executableURL?.path ?? owner
            guard let executableIdentity = macOsExecutableIdentity(
                executableURL: application?.executableURL
            ) else { return nil }
            let title = (window[kCGWindowName as String] as? String)?.trimmingCharacters(
                in: .whitespacesAndNewlines
            )
            let displayName = title.flatMap { $0.isEmpty ? nil : "\(owner) — \($0)" } ?? owner
            let classification = TargetClassifier.classify(
                bundleId: bundleId,
                processName: owner,
                windowTitle: title
            )
            return TargetRecord(
                targetId: targetId(windowId: windowId),
                displayName: displayName,
                applicationId: applicationId,
                stableIdentity: "macos:\(applicationId):\(executableIdentity)",
                processId: processId,
                windowId: windowId,
                bounds: bounds,
                classification: classification
            )
        }
    }

    private func requireTarget(_ requestedTargetId: String) throws -> TargetRecord {
        guard let target = discoverTargets().first(where: { $0.targetId == requestedTargetId }) else {
            throw HostFailure.targetNotFound
        }
        let app = NSRunningApplication(processIdentifier: target.processId)
        if TargetPolicy.isForbidden(bundleId: app?.bundleIdentifier, processName: app?.localizedName ?? "") {
            throw HostFailure.policyDenied
        }
        return target
    }

    private func capture(_ target: TargetRecord) async throws -> JSONValue {
        guard CGPreflightScreenCaptureAccess() else {
            throw HostFailure.permissionMissing("screen-capture")
        }
        let content = try await SCShareableContent.excludingDesktopWindows(
            false,
            onScreenWindowsOnly: true
        )
        guard let window = content.windows.first(where: { $0.windowID == target.windowId }) else {
            throw HostFailure.targetClosed
        }
        let filter = SCContentFilter(desktopIndependentWindow: window)
        let configuration = SCStreamConfiguration()
        let scale = NSScreen.main?.backingScaleFactor ?? 1
        let sourceWidth = max(1, target.bounds.width * scale)
        let sourceHeight = max(1, target.bounds.height * scale)
        let pixelScale = min(
            1,
            2_048 / sourceWidth,
            2_048 / sourceHeight,
            sqrt(2_000_000 / (sourceWidth * sourceHeight))
        )
        configuration.width = max(1, Int(sourceWidth * pixelScale))
        configuration.height = max(1, Int(sourceHeight * pixelScale))
        configuration.showsCursor = true
        let image = try await SCScreenshotManager.captureImage(
            contentFilter: filter,
            configuration: configuration
        )
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(
            data,
            UTType.png.identifier as CFString,
            1,
            nil
        ) else { throw HostFailure.unsupportedOperation("screenshot-encode") }
        CGImageDestinationAddImage(destination, image, nil)
        guard CGImageDestinationFinalize(destination) else {
            throw HostFailure.unsupportedOperation("screenshot-encode")
        }
        return .object([
            "mimeType": .string("image/png"),
            "base64": .string((data as Data).base64EncodedString()),
            "width": .number(Double(image.width)),
            "height": .number(Double(image.height)),
        ])
    }

    private func accessibilityElements(
        for target: TargetRecord
    ) -> ([JSONValue], [String: AXUIElement]) {
        guard AXIsProcessTrusted() else { return ([], [:]) }
        let application = AXUIElementCreateApplication(target.processId)
        var encoded: [JSONValue] = []
        var indexed: [String: AXUIElement] = [:]
        var queue: [(AXUIElement, String)] = [(application, "root")]
        while !queue.isEmpty && encoded.count < 5_000 {
            let (element, path) = queue.removeFirst()
            let role = string(axValue(element, kAXRoleAttribute)) ?? "unknown"
            var item: [String: JSONValue] = [
                "elementId": .string(path),
                "role": .string(role),
            ]
            if let title = string(axValue(element, kAXTitleAttribute)), !title.isEmpty {
                item["name"] = .string(String(title.prefix(65_536)))
            }
            if let value = string(axValue(element, kAXValueAttribute)), !value.isEmpty {
                item["value"] = .string(String(value.prefix(65_536)))
            }
            if let enabled = axValue(element, kAXEnabledAttribute) as? Bool {
                item["enabled"] = .bool(enabled)
            }
            var actionNames: CFArray?
            if AXUIElementCopyActionNames(element, &actionNames) == .success,
               let names = actionNames as? [String],
               !names.isEmpty
            {
                item["actions"] = .array(names.prefix(64).map(JSONValue.string))
            }
            encoded.append(.object(item))
            indexed[path] = element
            if let children = axValue(element, kAXChildrenAttribute) as? [AXUIElement] {
                for (index, child) in children.prefix(256).enumerated() {
                    queue.append((child, "\(path).\(index)"))
                }
            }
        }
        return (encoded, indexed)
    }

    private func observe(
        targetId requestedTargetId: String,
        includeScreenshot: Bool = true,
        includeAccessibility: Bool = true
    ) async throws -> JSONValue {
        if screenIsLocked() { throw HostFailure.lockStateChanged }
        let target = try requireTarget(requestedTargetId)
        let observationId = UUID().uuidString.lowercased()
        let screenshot = includeScreenshot ? try await capture(target) : nil
        let (elements, indexedElements) = includeAccessibility
            ? accessibilityElements(for: target)
            : ([], [:])
        observations = observations.filter { $0.value.target.targetId != target.targetId }
        observations[observationId] = ObservationRecord(
            observationId: observationId,
            target: target,
            elements: indexedElements
        )
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        var result: [String: JSONValue] = [
            "observationId": .string(observationId),
            "target": target.json,
            "capturedAt": .string(formatter.string(from: Date())),
            "width": .number(Double(max(1, Int(target.bounds.width)))),
            "height": .number(Double(max(1, Int(target.bounds.height)))),
            "elements": .array(elements),
        ]
        if let screenshot { result["screenshot"] = screenshot }
        return .object(result)
    }

    private func requireActive(_ leaseId: String, humanInputGeneration: UInt64? = nil) throws {
        if cancellations.contains(leaseId) { throw HostFailure.interrupted }
        if screenIsLocked() { throw HostFailure.lockStateChanged }
        if let humanInputGeneration,
           humanInputMonitor.snapshot() != humanInputGeneration
        {
            throw HostFailure.humanInputDetected
        }
    }

    private func targetPoint(_ action: [String: JSONValue], target: TargetRecord) throws -> CGPoint {
        guard let x = action["x"]?.number, let y = action["y"]?.number else {
            throw HostFailure.malformedRequest("coordinates")
        }
        guard x >= 0, y >= 0, x <= target.bounds.width, y <= target.bounds.height else {
            throw HostFailure.staleObservation
        }
        return CGPoint(x: target.bounds.minX + x, y: target.bounds.minY + y)
    }

    private func focus(_ target: TargetRecord) async throws {
        guard let application = NSRunningApplication(processIdentifier: target.processId),
              application.activate(options: [.activateAllWindows])
        else { throw HostFailure.unsupportedOperation("foreground-input") }
        let applicationElement = AXUIElementCreateApplication(target.processId)
        guard let windows = axValue(applicationElement, kAXWindowsAttribute) as? [AXUIElement]
        else { throw HostFailure.unsupportedOperation("foreground-window") }
        let matchingWindow = windows.first { window in
                guard let rawPosition = axValue(window, kAXPositionAttribute),
                      CFGetTypeID(rawPosition) == AXValueGetTypeID(),
                      let rawSize = axValue(window, kAXSizeAttribute),
                      CFGetTypeID(rawSize) == AXValueGetTypeID()
                else { return false }
                var position = CGPoint.zero
                var size = CGSize.zero
                guard AXValueGetValue(rawPosition as! AXValue, .cgPoint, &position),
                      AXValueGetValue(rawSize as! AXValue, .cgSize, &size)
                else { return false }
                return abs(position.x - target.bounds.minX) <= 2 &&
                    abs(position.y - target.bounds.minY) <= 2 &&
                    abs(size.width - target.bounds.width) <= 2 &&
                    abs(size.height - target.bounds.height) <= 2
        }
        guard let matchingWindow else { throw HostFailure.unsupportedOperation("foreground-window") }
        _ = AXUIElementSetAttributeValue(
            applicationElement,
            kAXFocusedWindowAttribute as CFString,
            matchingWindow
        )
        _ = AXUIElementSetAttributeValue(
            matchingWindow,
            kAXMainAttribute as CFString,
            kCFBooleanTrue
        )
        _ = AXUIElementPerformAction(matchingWindow, kAXRaiseAction as CFString)
        try await Task.sleep(for: .milliseconds(100))
        let current = try requireTarget(target.targetId)
        guard current.stableIdentity == target.stableIdentity,
              current.bounds == target.bounds,
              NSWorkspace.shared.frontmostApplication?.processIdentifier == target.processId
        else { throw HostFailure.targetIdentityChanged }
    }

    private func typeText(_ text: String) throws {
        guard let source = CGEventSource(stateID: .hidSystemState),
              let down = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: true),
              let up = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: false)
        else { throw HostFailure.unsupportedOperation("text-entry") }
        let units = Array(text.utf16)
        var cursor = 0
        while cursor < units.count {
            let end = min(cursor + 64, units.count)
            let slice = Array(units[cursor..<end])
            slice.withUnsafeBufferPointer { buffer in
                down.keyboardSetUnicodeString(stringLength: buffer.count, unicodeString: buffer.baseAddress!)
                up.keyboardSetUnicodeString(stringLength: buffer.count, unicodeString: buffer.baseAddress!)
            }
            markSynthetic(down)
            markSynthetic(up)
            down.post(tap: .cghidEventTap)
            up.post(tap: .cghidEventTap)
            cursor = end
        }
    }

    private func perform(
        _ action: [String: JSONValue],
        target: TargetRecord,
        observation: ObservationRecord
    ) async throws {
        guard let tag = action["_tag"]?.string else {
            throw HostFailure.malformedRequest("action._tag")
        }
        switch tag {
        case "click", "double-click", "secondary-click":
            let point = try targetPoint(action, target: target)
            let secondary = tag == "secondary-click"
            let button: CGMouseButton = secondary ? .right : .left
            let down: CGEventType = secondary ? .rightMouseDown : .leftMouseDown
            let up: CGEventType = secondary ? .rightMouseUp : .leftMouseUp
            let clicks: Int64 = tag == "double-click" ? 2 : 1
            for count in 1...clicks {
                try mouseEvent(type: down, point: point, button: button, clickState: count)
                try mouseEvent(type: up, point: point, button: button, clickState: count)
            }
        case "move":
            try mouseEvent(type: .mouseMoved, point: targetPoint(action, target: target), button: .left)
        case "drag":
            guard let from = action["from"]?.object, let to = action["to"]?.object else {
                throw HostFailure.malformedRequest("drag")
            }
            let start = try targetPoint(from, target: target)
            let end = try targetPoint(to, target: target)
            try mouseEvent(type: .leftMouseDown, point: start, button: .left)
            try mouseEvent(type: .leftMouseDragged, point: end, button: .left)
            try mouseEvent(type: .leftMouseUp, point: end, button: .left)
        case "scroll":
            guard let deltaX = action["deltaX"]?.number,
                  let deltaY = action["deltaY"]?.number,
                  let event = CGEvent(
                    scrollWheelEvent2Source: nil,
                    units: .pixel,
                    wheelCount: 2,
                    wheel1: Int32(deltaY),
                    wheel2: Int32(deltaX),
                    wheel3: 0
                  )
            else { throw HostFailure.malformedRequest("scroll") }
            markSynthetic(event)
            event.post(tap: .cghidEventTap)
        case "text-entry":
            try typeText(action["text"]?.string ?? "")
        case "paste":
            let pasteboard = NSPasteboard.general
            let previous = PasteboardSnapshot(pasteboard)
            defer { previous.restore(to: pasteboard) }
            pasteboard.clearContents()
            pasteboard.setString(action["text"]?.string ?? "", forType: .string)
            try postKey(key: "v", modifiers: [.string("meta")], phase: "press")
            try await Task.sleep(for: .milliseconds(100))
        case "keypress":
            try postKey(
                key: action["key"]?.string ?? "",
                modifiers: {
                    guard case .array(let values) = action["modifiers"] else { return [] }
                    return values
                }(),
                phase: action["phase"]?.string ?? "press"
            )
        case "selection":
            guard let elementId = action["elementId"]?.string,
                  let element = observation.elements[elementId],
                  let start = action["start"]?.number,
                  let end = action["end"]?.number,
                  end >= start
            else { throw HostFailure.malformedRequest("selection") }
            var range = CFRange(location: Int(start), length: Int(end - start))
            guard let value = AXValueCreate(.cfRange, &range),
                  AXUIElementSetAttributeValue(
                    element,
                    kAXSelectedTextRangeAttribute as CFString,
                    value
                  ) == .success
            else { throw HostFailure.unsupportedOperation("selection") }
        case "direct-value":
            guard let elementId = action["elementId"]?.string,
                  let element = observation.elements[elementId],
                  let value = action["value"]?.string,
                  AXUIElementSetAttributeValue(
                    element,
                    kAXValueAttribute as CFString,
                    value as CFTypeRef
                  ) == .success
            else { throw HostFailure.unsupportedOperation("direct-value") }
        case "accessibility-action":
            guard let elementId = action["elementId"]?.string,
                  let element = observation.elements[elementId],
                  let name = action["action"]?.string,
                  AXUIElementPerformAction(element, name as CFString) == .success
            else { throw HostFailure.unsupportedOperation("accessibility-action") }
        case "wait":
            let milliseconds = Int(action["durationMs"]?.number ?? 0)
            try await Task.sleep(for: .milliseconds(milliseconds))
        case "screenshot-refresh":
            break
        default:
            throw HostFailure.unsupportedOperation(tag)
        }
    }

    private func act(_ request: HostRequest) async throws -> JSONValue {
        defer { releaseSyntheticInput() }
        guard AXIsProcessTrusted() else { throw HostFailure.permissionMissing("accessibility") }
        guard let requestedTargetId = request.targetId else {
            throw HostFailure.malformedRequest("targetId")
        }
        guard let observationId = request.observationId,
              let observation = observations.removeValue(forKey: observationId)
        else { throw HostFailure.staleObservation }
        let target = try requireTarget(requestedTargetId)
        guard observation.target.targetId == target.targetId,
              observation.target.stableIdentity == target.stableIdentity
        else {
            throw HostFailure.targetIdentityChanged
        }
        guard observation.target.bounds == target.bounds else { throw HostFailure.staleObservation }
        guard let actionsValue = request.input.object?["actions"],
              case .array(let actions) = actionsValue,
              !actions.isEmpty,
              actions.count <= 64
        else { throw HostFailure.malformedRequest("actions") }
        guard let humanInputGeneration = humanInputMonitor.snapshot() else {
            throw HostFailure.permissionMissing("input-monitoring")
        }
        try await focus(target)
        try requireActive(request.leaseId, humanInputGeneration: humanInputGeneration)
        var completed = 0
        for value in actions {
            try requireActive(request.leaseId, humanInputGeneration: humanInputGeneration)
            guard let action = value.object else { throw HostFailure.malformedRequest("action") }
            try await perform(action, target: target, observation: observation)
            completed += 1
        }
        try requireActive(request.leaseId, humanInputGeneration: humanInputGeneration)
        let fresh = try await observe(targetId: target.targetId)
        return .object([
            "completedActions": .number(Double(completed)),
            "observation": fresh,
        ])
    }

    private func releaseSyntheticInput() {
        let location = CGEvent(source: nil)?.location ?? .zero
        try? mouseEvent(type: .leftMouseUp, point: location, button: .left)
        try? mouseEvent(type: .rightMouseUp, point: location, button: .right)
        for key in ["shift", "control", "alt", "meta"] {
            if let code = keyCodes[key] {
                if let event = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false) {
                    markSynthetic(event)
                    event.post(tap: .cghidEventTap)
                }
            }
        }
    }
}
