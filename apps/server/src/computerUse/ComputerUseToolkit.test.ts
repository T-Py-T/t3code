import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  ComputerUseHostId,
  ComputerUseMalformedResponseError,
  ComputerUseObservationId,
  ComputerUseTargetId,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type ComputerUseHostResponse,
  type ComputerUseObservation,
  type ComputerUseTarget,
  type ComputerUseVerifiedHost,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import * as ComputerUseBroker from "./ComputerUseBroker.ts";
import * as ComputerUseControl from "./ComputerUseControl.ts";
import * as ComputerUsePolicy from "./ComputerUsePolicy.ts";
import * as ComputerUseHistory from "./ComputerUseHistory.ts";
import * as ComputerUseToolkit from "./ComputerUseToolkit.ts";
import * as ComputerUseScreenshotStore from "./ComputerUseScreenshotStore.ts";

const environmentId = EnvironmentId.make("environment-1");
const invocationScope: ComputerUseBroker.ComputerUseInvocationScope = {
  environmentId,
  threadId: ThreadId.make("thread-1"),
  turnId: TurnId.make("turn-1"),
  providerSessionId: "provider-session-1",
  providerInstanceId: ProviderInstanceId.make("codex"),
};
const host: ComputerUseVerifiedHost = {
  hostId: ComputerUseHostId.make("host-1"),
  environmentId,
  platform: "macos",
  protocolVersion: 1,
  supportedOperations: ["status", "listTargets", "observe", "act"],
  verifiedIdentity: {
    subject: "com.t3tools.t3code.computer-use",
    publisher: "T3 Code",
  },
};
const target: ComputerUseTarget = {
  targetId: ComputerUseTargetId.make("target-text-edit"),
  kind: "application",
  displayName: "TextEdit",
  applicationId: "com.apple.TextEdit",
  stableIdentity: "macos:com.apple.TextEdit:APPLE",
};
const observation: ComputerUseObservation = {
  observationId: ComputerUseObservationId.make("observation-1"),
  target,
  capturedAt: "2026-08-27T20:00:00.000Z",
  width: 1280,
  height: 720,
  elements: [],
  screenshot: {
    mimeType: "image/png",
    base64: "c2NyZWVuc2hvdA==",
    width: 1280,
    height: 720,
  },
};

const makeHarness = Effect.gen(function* () {
  const broker = yield* ComputerUseBroker.make.pipe(Effect.provide(NodeServices.layer));
  const control = yield* ComputerUseControl.make;
  const policy = yield* ComputerUsePolicy.make;
  const history = yield* ComputerUseHistory.make;
  const screenshotStore = yield* ComputerUseScreenshotStore.make.pipe(
    Effect.provide(NodeServices.layer),
  );
  const toolkit = yield* ComputerUseToolkit.make.pipe(
    Effect.provideService(ComputerUseBroker.ComputerUseBroker, broker),
    Effect.provideService(ComputerUseControl.ComputerUseControl, control),
    Effect.provideService(ComputerUsePolicy.ComputerUsePolicy, policy),
    Effect.provideService(ComputerUseHistory.ComputerUseHistory, history),
    Effect.provideService(ComputerUseScreenshotStore.ComputerUseScreenshotStore, screenshotStore),
    Effect.provide(NodeServices.layer),
  );
  return { broker, history, policy, toolkit } as const;
});

const respondTo = (
  broker: ComputerUseBroker.ComputerUseBroker["Service"],
  response: Omit<ComputerUseHostResponse, "hostId">,
) => broker.respond({ ...response, hostId: host.hostId } as ComputerUseHostResponse);

for (const providerInstance of ["codex", "pi", "atomic"] as const) {
  it.effect(`exposes the same policy-governed toolkit to ${providerInstance}`, () =>
    Effect.scoped(
      Effect.gen(function* () {
        const providerScope = {
          ...invocationScope,
          providerInstanceId: ProviderInstanceId.make(providerInstance),
        };
        const { broker, history, policy, toolkit } = yield* makeHarness;
        const operations: string[] = [];
        const events = yield* broker.connect(host);
        yield* Stream.runForEach(events, (event) => {
          if (event.type !== "request") return Effect.void;
          operations.push(event.request.operation);
          const correlation = {
            connectionId: event.connectionId,
            leaseId: event.request.leaseId,
            requestId: event.request.requestId,
          };
          switch (event.request.operation) {
            case "status":
              return respondTo(broker, {
                ...correlation,
                ok: true,
                result: {
                  locked: false,
                  permissions: {
                    accessibility: "granted",
                    screenCapture: "granted",
                    input: "granted",
                  },
                },
              });
            case "listTargets":
              return respondTo(broker, {
                ...correlation,
                ok: true,
                result: { targets: [target] },
              });
            case "observe":
              return respondTo(broker, { ...correlation, ok: true, result: observation });
            case "act":
              return respondTo(broker, {
                ...correlation,
                ok: true,
                result: { completedActions: event.request.input.actions.length, observation },
              });
          }
        }).pipe(Effect.forkScoped);
        yield* Effect.yieldNow;

        expect(yield* toolkit.status({ scope: providerScope })).toEqual({
          host,
          status: {
            locked: false,
            permissions: {
              accessibility: "granted",
              screenCapture: "granted",
              input: "granted",
            },
          },
        });
        expect(yield* toolkit.listTargets({ scope: providerScope })).toEqual({ targets: [target] });

        expect(
          yield* toolkit.observe({
            scope: providerScope,
            target,
            runtimeMode: "full-access",
          }),
        ).toMatchObject({
          _tag: "policy",
          approvalId: "computer-use-approval-0",
          decision: { _tag: "request-app-grant", access: "observe" },
        });
        expect(operations).toEqual(["status", "listTargets"]);
        expect((yield* history.list(environmentId)).map((entry) => entry.state)).toEqual([
          "waiting-approval",
          "requested",
          "completed",
          "requested",
          "completed",
          "requested",
        ]);

        yield* policy.grant({
          scope: { ...providerScope, hostId: host.hostId },
          target,
          access: "operate",
          duration: "turn",
        });
        expect(
          yield* toolkit.observe({
            scope: providerScope,
            target,
            runtimeMode: "full-access",
          }),
        ).toEqual({ _tag: "success", value: observation });
        expect(
          yield* toolkit.act({
            scope: providerScope,
            target,
            observationId: observation.observationId,
            batch: { actions: [{ _tag: "text-entry", text: "typed-secret" }] },
            risk: "reversible-local",
            runtimeMode: "full-access",
          }),
        ).toEqual({
          _tag: "success",
          value: { completedActions: 1, observation },
        });
        const persistedMetadata = (yield* history.list(environmentId))
          .flatMap((entry) => [
            entry.summary,
            entry.resultTag ?? "",
            entry.target?.displayName ?? "",
            entry.target?.applicationId ?? "",
            entry.target?.stableIdentity ?? "",
          ])
          .join("\n");
        expect(persistedMetadata).not.toContain("typed-secret");
        expect(persistedMetadata).not.toContain("field-1");
        expect(
          (yield* history.list(environmentId)).some(
            (entry) =>
              entry.observationId === observation.observationId &&
              entry.screenshotRevealToken !== undefined,
          ),
        ).toBe(true);
        const externalBoundary = yield* toolkit.act({
          scope: providerScope,
          target,
          observationId: observation.observationId,
          batch: { actions: [{ _tag: "click", x: 30, y: 40 }] },
          risk: "external-side-effect",
          runtimeMode: "full-access",
        });
        expect(externalBoundary).toMatchObject({
          _tag: "policy",
          approvalId: "computer-use-approval-1",
          decision: { _tag: "request-action-confirmation", risk: "external-side-effect" },
          action: {
            requestIdentity: expect.any(String),
            summary: "Click at (30, 40)",
          },
        });
        expect(operations).toEqual(["status", "listTargets", "observe", "act"]);
        expect(
          (yield* history.list(environmentId)).every(
            (entry) => entry.providerInstanceId === providerInstance,
          ),
        ).toBe(true);
      }),
    ),
  );
}

it.effect("maps malformed helper results to the broker's typed failure", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { broker, history, policy, toolkit } = yield* makeHarness;
      const events = yield* broker.connect(host);
      yield* Stream.runForEach(events, (event) => {
        if (event.type !== "request") return Effect.void;
        return respondTo(broker, {
          connectionId: event.connectionId,
          leaseId: event.request.leaseId,
          requestId: event.request.requestId,
          ok: true,
          result: { screenshot: "unbounded-and-invalid" },
        });
      }).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* policy.grant({
        scope: { ...invocationScope, hostId: host.hostId },
        target,
        access: "observe",
        duration: "turn",
      });

      const failure = yield* toolkit
        .observe({ scope: invocationScope, target, runtimeMode: "approval-required" })
        .pipe(Effect.flip);
      expect(failure).toBeInstanceOf(ComputerUseMalformedResponseError);
      expect(yield* history.list(environmentId, 1)).toMatchObject([
        { state: "failed", resultTag: "ComputerUseMalformedResponseError" },
      ]);
    }),
  ),
);

it.effect("fails closed when a host observation changes target identity", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { broker, policy, toolkit } = yield* makeHarness;
      const changedObservation: ComputerUseObservation = {
        ...observation,
        target: { ...target, stableIdentity: `${target.stableIdentity}:changed` },
      };
      const events = yield* broker.connect(host);
      yield* Stream.runForEach(events, (event) => {
        if (event.type !== "request") return Effect.void;
        return respondTo(broker, {
          connectionId: event.connectionId,
          leaseId: event.request.leaseId,
          requestId: event.request.requestId,
          ok: true,
          result: changedObservation,
        });
      }).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* policy.grant({
        scope: { ...invocationScope, hostId: host.hostId },
        target,
        access: "observe",
        duration: "turn",
      });

      expect(
        yield* toolkit.observe({
          scope: invocationScope,
          target,
          runtimeMode: "approval-required",
        }),
      ).toMatchObject({
        _tag: "policy",
        decision: { _tag: "deny", reason: "identity-changed" },
      });
    }),
  ),
);
