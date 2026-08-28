import Foundation

public enum JSONValue: Codable, Equatable, Sendable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([JSONValue].self) {
            self = .array(value)
        } else {
            self = .object(try container.decode([String: JSONValue].self))
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null:
            try container.encodeNil()
        case .bool(let value):
            try container.encode(value)
        case .number(let value):
            try container.encode(value)
        case .string(let value):
            try container.encode(value)
        case .array(let value):
            try container.encode(value)
        case .object(let value):
            try container.encode(value)
        }
    }

    public var object: [String: JSONValue]? {
        guard case .object(let value) = self else { return nil }
        return value
    }

    public var string: String? {
        guard case .string(let value) = self else { return nil }
        return value
    }

    public var number: Double? {
        guard case .number(let value) = self else { return nil }
        return value
    }

    public var bool: Bool? {
        guard case .bool(let value) = self else { return nil }
        return value
    }
}

public struct HostRequest: Codable, Equatable, Sendable {
    public let requestId: String
    public let leaseId: String
    public let environmentId: String
    public let operation: String
    public let targetId: String?
    public let observationId: String?
    public let input: JSONValue
    public let timeoutMs: Int

    public init(
        requestId: String,
        leaseId: String,
        environmentId: String,
        operation: String,
        targetId: String? = nil,
        observationId: String? = nil,
        input: JSONValue,
        timeoutMs: Int
    ) {
        self.requestId = requestId
        self.leaseId = leaseId
        self.environmentId = environmentId
        self.operation = operation
        self.targetId = targetId
        self.observationId = observationId
        self.input = input
        self.timeoutMs = timeoutMs
    }
}

public struct HostCancel: Codable, Equatable, Sendable {
    public let leaseId: String
    public let reason: String
}

public enum HostCommand: Codable, Equatable, Sendable {
    case request(HostRequest)
    case cancel(HostCancel)

    private enum CodingKeys: String, CodingKey { case type, request, leaseId, reason }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        switch try container.decode(String.self, forKey: .type) {
        case "request":
            self = .request(try container.decode(HostRequest.self, forKey: .request))
        case "cancel":
            self = .cancel(
                HostCancel(
                    leaseId: try container.decode(String.self, forKey: .leaseId),
                    reason: try container.decode(String.self, forKey: .reason)
                )
            )
        default:
            throw DecodingError.dataCorruptedError(
                forKey: .type,
                in: container,
                debugDescription: "Unsupported host command"
            )
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .request(let request):
            try container.encode("request", forKey: .type)
            try container.encode(request, forKey: .request)
        case .cancel(let cancel):
            try container.encode("cancel", forKey: .type)
            try container.encode(cancel.leaseId, forKey: .leaseId)
            try container.encode(cancel.reason, forKey: .reason)
        }
    }
}

public struct HostErrorPayload: Codable, Equatable, Sendable {
    public let tag: String
    public let message: String
    public let detail: JSONValue?

    private enum CodingKeys: String, CodingKey { case tag = "_tag", message, detail }

    public init(tag: String, message: String, detail: JSONValue? = nil) {
        self.tag = tag
        self.message = String(message.prefix(4_096))
        self.detail = detail
    }
}

public struct HostResponse: Codable, Equatable, Sendable {
    public let requestId: String
    public let leaseId: String
    public let ok: Bool
    public let result: JSONValue?
    public let error: HostErrorPayload?

    public static func success(_ request: HostRequest, result: JSONValue) -> HostResponse {
        HostResponse(
            requestId: request.requestId,
            leaseId: request.leaseId,
            ok: true,
            result: result,
            error: nil
        )
    }

    public static func failure(
        _ request: HostRequest,
        tag: String,
        message: String,
        detail: JSONValue? = nil
    ) -> HostResponse {
        HostResponse(
            requestId: request.requestId,
            leaseId: request.leaseId,
            ok: false,
            result: nil,
            error: HostErrorPayload(tag: tag, message: message, detail: detail)
        )
    }
}

public enum TargetPolicy {
    private static let forbiddenBundleIds: Set<String> = [
        "com.apple.terminal",
        "com.github.wez.wezterm",
        "com.googlecode.iterm2",
        "com.mitchellh.ghostty",
        "com.t3tools.t3code",
        "com.t3tools.t3code.dev",
        "dev.warp.warp-stable",
        "net.kovidgoyal.kitty",
        "org.alacritty",
    ]

    private static let forbiddenProcessNames: Set<String> = [
        "Terminal",
        "Alacritty",
        "Ghostty",
        "Hyper",
        "iTerm2",
        "kitty",
        "Warp",
        "WezTerm",
        "T3 Code",
        "T3 Code (Dev)",
        "T3 Code (Alpha)",
    ]

    public static func isForbidden(bundleId: String?, processName: String) -> Bool {
        if let bundleId = bundleId?.lowercased(),
           forbiddenBundleIds.contains(bundleId) || bundleId.hasPrefix("com.t3tools.t3code.")
        {
            return true
        }
        return forbiddenProcessNames.contains { $0.caseInsensitiveCompare(processName) == .orderedSame }
    }
}

public struct TargetClassification: Equatable, Sendable {
    public let kind: String
    public let integration: String
    public let application: String?
    public let documentName: String?

    public init(
        kind: String,
        integration: String,
        application: String? = nil,
        documentName: String? = nil
    ) {
        self.kind = kind
        self.integration = integration
        self.application = application
        self.documentName = documentName
    }
}

public enum TargetClassifier {
    public static func classify(
        bundleId: String?,
        processName: String,
        windowTitle: String?
    ) -> TargetClassification {
        let normalizedBundleId = bundleId?.lowercased()
        let normalizedProcessName = processName.lowercased()
        if normalizedBundleId == "com.microsoft.excel" || normalizedProcessName == "microsoft excel" {
            return TargetClassification(
                kind: "office-document",
                integration: "office-accessibility",
                application: "excel",
                documentName: documentName(windowTitle, suffixes: [" - Excel"])
            )
        }
        if normalizedBundleId == "com.microsoft.powerpoint" ||
            normalizedProcessName == "microsoft powerpoint"
        {
            return TargetClassification(
                kind: "office-document",
                integration: "office-accessibility",
                application: "powerpoint",
                documentName: documentName(windowTitle, suffixes: [" - PowerPoint"])
            )
        }
        return TargetClassification(kind: "window", integration: "native-accessibility")
    }

    public static func matches(requestedKind: String?, targetKind: String) -> Bool {
        requestedKind == nil || requestedKind == targetKind
    }

    private static func documentName(_ rawTitle: String?, suffixes: [String]) -> String? {
        guard var title = rawTitle?.trimmingCharacters(in: .whitespacesAndNewlines),
              !title.isEmpty
        else { return nil }
        for suffix in suffixes where title.lowercased().hasSuffix(suffix.lowercased()) {
            title.removeLast(suffix.count)
            title = title.trimmingCharacters(in: .whitespacesAndNewlines)
            break
        }
        return title.isEmpty ? nil : String(title.prefix(512))
    }
}
