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

@Test func hostErrorsAreBounded() {
    let error = HostErrorPayload(
        tag: "ComputerUseInterruptedError",
        message: String(repeating: "x", count: 5_000)
    )
    #expect(error.message.count == 4_096)
}

@Test func cancellationSurvivesUntilItsRequestCompletes() {
    var cancellations = LeaseCancellationRegistry()
    cancellations.cancel("lease-1")
    #expect(cancellations.contains("lease-1"))
    cancellations.complete("lease-1")
    #expect(!cancellations.contains("lease-1"))
}
