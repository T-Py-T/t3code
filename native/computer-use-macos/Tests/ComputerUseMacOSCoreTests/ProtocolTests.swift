import Foundation
import Testing
@testable import ComputerUseMacOSCore

@Test func requestAndCancellationRoundTrip() throws {
    let encoder = JSONEncoder()
    let decoder = JSONDecoder()
    let request = HostCommand.request(
        HostRequest(
            requestId: "request-1",
            leaseId: "lease-1",
            environmentId: "environment-1",
            operation: "act",
            targetId: "target-1",
            observationId: "observation-1",
            input: .object(["actions": .array([.object(["_tag": .string("click")])])]),
            timeoutMs: 15_000
        )
    )
    #expect(try decoder.decode(HostCommand.self, from: encoder.encode(request)) == request)

    let cancel = HostCommand.cancel(HostCancel(leaseId: "lease-1", reason: "takeover"))
    #expect(try decoder.decode(HostCommand.self, from: encoder.encode(cancel)) == cancel)
}

@Test func forbiddenTargetsFailClosed() {
    #expect(TargetPolicy.isForbidden(bundleId: "com.apple.Terminal", processName: "Terminal"))
    #expect(TargetPolicy.isForbidden(bundleId: "com.googlecode.iterm2", processName: "iTerm2"))
    #expect(TargetPolicy.isForbidden(bundleId: "com.mitchellh.ghostty", processName: "Ghostty"))
    #expect(TargetPolicy.isForbidden(bundleId: "com.t3tools.t3code.dev", processName: "T3 Code"))
    #expect(
        TargetPolicy.isForbidden(
            bundleId: "com.t3tools.t3code.dev.t3codecomputeruse",
            processName: "T3 Code (Dev)"
        )
    )
    #expect(TargetPolicy.isForbidden(bundleId: nil, processName: "T3 Code (Alpha)"))
    #expect(!TargetPolicy.isForbidden(bundleId: "com.apple.TextEdit", processName: "TextEdit"))
}

@Test func officeTargetsAdvertiseStructuredDocumentControl() {
    let excel = TargetClassifier.classify(
        bundleId: "com.microsoft.Excel",
        processName: "Microsoft Excel",
        windowTitle: "Book1"
    )
    #expect(excel.kind == "office-document")
    #expect(excel.integration == "office-accessibility")
    #expect(excel.application == "excel")
    #expect(excel.documentName == "Book1")

    let powerpoint = TargetClassifier.classify(
        bundleId: "com.microsoft.Powerpoint",
        processName: "Microsoft PowerPoint",
        windowTitle: "Quarterly Review - PowerPoint"
    )
    #expect(powerpoint.kind == "office-document")
    #expect(powerpoint.application == "powerpoint")
    #expect(powerpoint.documentName == "Quarterly Review")

    let textEdit = TargetClassifier.classify(
        bundleId: "com.apple.TextEdit",
        processName: "TextEdit",
        windowTitle: "Notes"
    )
    #expect(textEdit.kind == "window")
    #expect(textEdit.integration == "native-accessibility")
    #expect(textEdit.application == nil)

    #expect(TargetClassifier.matches(requestedKind: nil, targetKind: textEdit.kind))
    #expect(TargetClassifier.matches(requestedKind: "office-document", targetKind: excel.kind))
    #expect(!TargetClassifier.matches(requestedKind: "window", targetKind: excel.kind))
}

@Test func hostErrorsAreBounded() {
    let error = HostErrorPayload(
        tag: "ComputerUseInterruptedError",
        message: String(repeating: "x", count: 5_000)
    )
    #expect(error.message.count == 4_096)
}

@Test func cancellationRemainsLatchedForTheLease() {
    var cancellations = LeaseCancellationRegistry()
    cancellations.cancel("lease-1")
    #expect(cancellations.contains("lease-1"))
    cancellations.cancel("lease-2")
    #expect(cancellations.contains("lease-1"))
    #expect(cancellations.contains("lease-2"))
}

@Test func unreadableSessionStateFailsClosedAsLocked() {
    #expect(macOsSessionIsLocked(nil))
    #expect(macOsSessionIsLocked([:]) == false)
    #expect(macOsSessionIsLocked(["CGSSessionScreenIsLocked": true]))
}
