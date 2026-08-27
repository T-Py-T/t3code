import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  ComputerUseHostId,
  ComputerUseHostFailureError,
  ComputerUseInvalidRequestError,
  ComputerUseLeaseBusyError,
  ComputerUseMalformedResponseError,
  ComputerUseObservationId,
  ComputerUseStoppedError,
  ComputerUseTimeoutError,
  ComputerUseTargetId,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type ComputerUseConnectionId,
  type ComputerUseHostResponse,
  type ComputerUseHostStreamEvent,
  type ComputerUseLeaseId,
  type ComputerUseRequestId,
  type ComputerUseVerifiedHost,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ComputerUseBroker from "./ComputerUseBroker.ts";

const makeBroker = ComputerUseBroker.make.pipe(Effect.provide(NodeServices.layer));

const environmentId = EnvironmentId.make("environment-1");
const scope: ComputerUseBroker.ComputerUseInvocationScope = {
  environmentId,
  threadId: ThreadId.make("thread-1"),
  turnId: TurnId.make("turn-1"),
  providerSessionId: "provider-session-1",
  providerInstanceId: ProviderInstanceId.make("codex"),
};
const targetId = ComputerUseTargetId.make("target-text-edit");
const observationId = ComputerUseObservationId.make("observation-1");

const host: ComputerUseVerifiedHost = {
  hostId: ComputerUseHostId.make("host-1"),
  environmentId,
  platform: "macos",
  protocolVersion: 1,
  supportedOperations: ["observe"],
  verifiedIdentity: {
    subject: "com.t3tools.t3code.computer-use",
    publisher: "T3 Code",
  },
};

const requestsFrom = (events: Stream.Stream<ComputerUseHostStreamEvent>) =>
  events.pipe(
    Stream.filterMap((event) =>
      event.type === "request"
        ? Result.succeed({ ...event.request, connectionId: event.connectionId })
        : Result.failVoid,
    ),
  );

it.effect("routes an observation through a verified host without provider metadata leakage", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker;
      const requests = requestsFrom(yield* broker.connect(host));

      yield* Stream.runForEach(requests, (request) => {
        expect(request.operation).toBe("observe");
        if (request.operation !== "observe") throw new Error("expected observe request");
        expect(request.targetId).toBe(targetId);
        expect(request).not.toHaveProperty("threadId");
        expect(request).not.toHaveProperty("turnId");
        expect(request).not.toHaveProperty("providerSessionId");
        expect(request).not.toHaveProperty("providerInstanceId");

        return broker.respond({
          hostId: host.hostId,
          connectionId: request.connectionId,
          leaseId: request.leaseId,
          requestId: request.requestId,
          ok: true,
          result: {
            observationId,
            targetId,
            width: 1280,
            height: 720,
          },
        });
      }).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;

      const result = yield* broker.invoke<{
        readonly observationId: ComputerUseObservationId;
        readonly targetId: ComputerUseTargetId;
        readonly width: number;
        readonly height: number;
      }>({
        scope,
        operation: "observe",
        targetId,
        input: {},
      });

      expect(result).toEqual({ observationId, targetId, width: 1280, height: 720 });
    }),
  ),
);

it.effect("rejects a competing turn until the active lease is stopped", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker;
      const leaseIds: string[] = [];
      const requests = requestsFrom(yield* broker.connect(host));
      yield* Stream.runForEach(requests, (request) => {
        leaseIds.push(request.leaseId);
        return broker.respond({
          hostId: host.hostId,
          connectionId: request.connectionId,
          leaseId: request.leaseId,
          requestId: request.requestId,
          ok: true,
          result: "observed",
        });
      }).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;

      expect(yield* broker.invoke({ scope, operation: "observe", targetId, input: {} })).toBe(
        "observed",
      );

      const competingScope: ComputerUseBroker.ComputerUseInvocationScope = {
        ...scope,
        threadId: ThreadId.make("thread-2"),
        turnId: TurnId.make("turn-2"),
        providerSessionId: "provider-session-2",
      };
      const busy = yield* broker
        .invoke<void>({ scope: competingScope, operation: "observe", targetId, input: {} })
        .pipe(Effect.flip);
      expect(busy).toBeInstanceOf(ComputerUseLeaseBusyError);
      expect(busy).toMatchObject({
        activeThreadId: scope.threadId,
        activeTurnId: scope.turnId,
      });

      yield* broker.stop({ scope, reason: "user" });

      expect(
        yield* broker.invoke({ scope: competingScope, operation: "observe", targetId, input: {} }),
      ).toBe("observed");
      expect(leaseIds).toHaveLength(2);
      expect(leaseIds[1]).not.toBe(leaseIds[0]);
    }),
  ),
);

it.effect("rejects malformed calls before they can capture a control lease", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker;
      const requests = requestsFrom(yield* broker.connect(host));
      yield* Stream.runForEach(requests, (request) =>
        broker.respond({
          hostId: host.hostId,
          connectionId: request.connectionId,
          leaseId: request.leaseId,
          requestId: request.requestId,
          ok: true,
          result: "observed",
        }),
      ).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;

      const invalid = yield* broker
        .invoke<void>({ scope, operation: "observe", input: {} })
        .pipe(Effect.flip);
      expect(invalid).toBeInstanceOf(ComputerUseInvalidRequestError);

      const nextScope = {
        ...scope,
        threadId: ThreadId.make("thread-after-invalid"),
        turnId: TurnId.make("turn-after-invalid"),
      };
      expect(
        yield* broker.invoke({ scope: nextScope, operation: "observe", targetId, input: {} }),
      ).toBe("observed");
    }),
  ),
);

it.effect("serializes mutating action batches for one control lease", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker;
      const firstReceived = yield* Deferred.make<void>();
      const secondReceived = yield* Deferred.make<void>();
      const routed: Array<{
        readonly connectionId: ComputerUseConnectionId;
        readonly leaseId: ComputerUseLeaseId;
        readonly requestId: ComputerUseRequestId;
      }> = [];
      const requests = requestsFrom(
        yield* broker.connect({ ...host, supportedOperations: ["act"] }),
      );
      yield* Stream.runForEach(requests, (request) =>
        Effect.gen(function* () {
          routed.push(request);
          yield* routed.length === 1
            ? Deferred.succeed(firstReceived, undefined)
            : Deferred.succeed(secondReceived, undefined);
        }),
      ).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;

      const invokeAction = (x: number) =>
        broker.invoke({
          scope,
          operation: "act",
          targetId,
          observationId,
          input: { actions: [{ _tag: "click" as const, x, y: 20 }] },
        });
      const first = yield* invokeAction(10).pipe(Effect.forkScoped);
      const second = yield* invokeAction(20).pipe(Effect.forkScoped);

      yield* Deferred.await(firstReceived);
      yield* Effect.yieldNow;
      expect(routed).toHaveLength(1);

      const firstRequest = routed[0];
      if (!firstRequest) throw new Error("first action request was not routed");
      yield* broker.respond({
        hostId: host.hostId,
        connectionId: firstRequest.connectionId,
        leaseId: firstRequest.leaseId,
        requestId: firstRequest.requestId,
        ok: true,
        result: "first",
      });

      yield* Deferred.await(secondReceived);
      expect(routed).toHaveLength(2);
      const secondRequest = routed[1];
      if (!secondRequest) throw new Error("second action request was not routed");
      yield* broker.respond({
        hostId: host.hostId,
        connectionId: secondRequest.connectionId,
        leaseId: secondRequest.leaseId,
        requestId: secondRequest.requestId,
        ok: true,
        result: "second",
      });

      expect(yield* Fiber.join(first)).toBe("first");
      expect(yield* Fiber.join(second)).toBe("second");
    }),
  ),
);

it.effect("settles an in-flight host request when the lease is stopped", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker;
      const requestReceived = yield* Deferred.make<void>();
      const cancelReceived = yield* Deferred.make<{
        readonly leaseId: ComputerUseLeaseId;
        readonly reason: "user";
      }>();
      const events = yield* broker.connect(host);
      yield* Stream.runForEach(events, (event) => {
        if (event.type === "request") return Deferred.succeed(requestReceived, undefined);
        if (event.type === "cancel" && event.reason === "user") {
          return Deferred.succeed(cancelReceived, {
            leaseId: event.leaseId,
            reason: event.reason,
          });
        }
        return Effect.void;
      }).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;

      const inFlight = yield* broker
        .invoke<void>({ scope, operation: "observe", targetId, input: {} })
        .pipe(Effect.forkScoped);
      yield* Deferred.await(requestReceived);

      yield* broker.stop({ scope, reason: "user" });
      yield* Effect.yieldNow;

      expect(yield* Deferred.await(cancelReceived)).toMatchObject({ reason: "user" });

      const completion = inFlight.pollUnsafe();
      expect(completion).toBeDefined();
      if (completion === undefined) return;

      const error = yield* Fiber.join(inFlight).pipe(Effect.flip);
      expect(error).toBeInstanceOf(ComputerUseStoppedError);
      expect(error).toMatchObject({
        environmentId: scope.environmentId,
        threadId: scope.threadId,
        turnId: scope.turnId,
        reason: "user",
      });
    }),
  ),
);

it.effect("settles an in-flight request when the authoritative host disconnects", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker;
      const requestReceived = yield* Deferred.make<void>();
      const requests = requestsFrom(yield* broker.connect(host));
      const consumer = yield* Stream.runForEach(requests, () =>
        Deferred.succeed(requestReceived, undefined),
      ).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;

      const inFlight = yield* broker
        .invoke<void>({ scope, operation: "observe", targetId, input: {} })
        .pipe(Effect.forkScoped);
      yield* Deferred.await(requestReceived);

      yield* Fiber.interrupt(consumer);
      yield* Effect.yieldNow;

      const completion = inFlight.pollUnsafe();
      expect(completion).toBeDefined();
      if (completion === undefined) return;

      const error = yield* Fiber.join(inFlight).pipe(Effect.flip);
      expect(error).toBeInstanceOf(ComputerUseStoppedError);
      expect(error).toMatchObject({
        environmentId: scope.environmentId,
        reason: "host-disconnected",
      });
    }),
  ),
);

it.effect("maps host failures to bounded typed diagnostics", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker;
      const responseSent = yield* Deferred.make<void>();
      const requests = requestsFrom(
        yield* broker.connect({ ...host, supportedOperations: ["act"] }),
      );
      yield* Stream.runForEach(requests, (request) =>
        broker
          .respond({
            hostId: host.hostId,
            connectionId: request.connectionId,
            leaseId: request.leaseId,
            requestId: request.requestId,
            ok: false,
            error: {
              _tag: "ComputerUseStaleObservationError",
              message: "Window changed near secret customer data.",
              detail: { currentObservationId: "secret-observation-id" },
            },
          })
          .pipe(Effect.andThen(Deferred.succeed(responseSent, undefined))),
      ).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;

      const inFlight = yield* broker
        .invoke<void>({
          scope,
          operation: "act",
          targetId,
          observationId,
          input: { actions: [{ _tag: "click", x: 10, y: 20 }] },
        })
        .pipe(Effect.forkScoped);
      yield* Deferred.await(responseSent);
      yield* Effect.yieldNow;

      const completion = inFlight.pollUnsafe();
      expect(completion).toBeDefined();
      if (completion === undefined) return;

      const error = yield* Fiber.join(inFlight).pipe(Effect.flip);
      expect(error).toBeInstanceOf(ComputerUseHostFailureError);
      expect(error).toMatchObject({
        reason: "stale-observation",
        operation: "act",
        remoteTag: "ComputerUseStaleObservationError",
        remoteMessageLength: 41,
        remoteDetailKind: "object",
      });
      expect(error.message).not.toContain("secret");
      expect("remoteMessage" in error).toBe(false);
      expect("remoteDetail" in error).toBe(false);
    }),
  ),
);

it.effect("fails a malformed negative host response instead of waiting forever", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker;
      const responseSent = yield* Deferred.make<void>();
      const requests = requestsFrom(yield* broker.connect(host));
      yield* Stream.runForEach(requests, (request) =>
        broker
          .respond({
            hostId: host.hostId,
            connectionId: request.connectionId,
            leaseId: request.leaseId,
            requestId: request.requestId,
            ok: false,
          } as unknown as ComputerUseHostResponse)
          .pipe(Effect.andThen(Deferred.succeed(responseSent, undefined))),
      ).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;

      const inFlight = yield* broker
        .invoke<void>({ scope, operation: "observe", targetId, input: {} })
        .pipe(Effect.forkScoped);
      yield* Deferred.await(responseSent);
      yield* Effect.yieldNow;

      const completion = inFlight.pollUnsafe();
      expect(completion).toBeDefined();
      if (completion === undefined) return;

      const error = yield* Fiber.join(inFlight).pipe(Effect.flip);
      expect(error).toBeInstanceOf(ComputerUseMalformedResponseError);
      expect(error).toMatchObject({
        environmentId: scope.environmentId,
        operation: "observe",
      });
    }),
  ),
);

it.effect("reports a bounded timeout and clears the pending request", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker;
      const requestReceived = yield* Deferred.make<void>();
      const requests = requestsFrom(yield* broker.connect(host));
      yield* Stream.runForEach(requests, () => Deferred.succeed(requestReceived, undefined)).pipe(
        Effect.forkScoped,
      );
      yield* Effect.yieldNow;

      const inFlight = yield* broker
        .invoke<void>({ scope, operation: "observe", targetId, input: {}, timeoutMs: 1_000 })
        .pipe(Effect.forkScoped);
      yield* Deferred.await(requestReceived);
      yield* TestClock.adjust("1 second");

      const error = yield* Fiber.join(inFlight).pipe(Effect.flip);
      expect(error).toBeInstanceOf(ComputerUseTimeoutError);
      expect(error).toMatchObject({
        environmentId: scope.environmentId,
        operation: "observe",
        timeoutMs: 1_000,
      });
    }),
  ),
);

it.effect("ends the old lease when a replacement host connects", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker;
      const firstRequestReceived = yield* Deferred.make<string>();
      const firstRequests = requestsFrom(yield* broker.connect(host));
      const firstConsumer = yield* Stream.runForEach(firstRequests, (request) =>
        Deferred.succeed(firstRequestReceived, request.leaseId),
      ).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;

      const inFlight = yield* broker
        .invoke<void>({ scope, operation: "observe", targetId, input: {} })
        .pipe(Effect.forkScoped);
      const firstLeaseId = yield* Deferred.await(firstRequestReceived);

      const replacementHost: ComputerUseVerifiedHost = {
        ...host,
        hostId: ComputerUseHostId.make("host-2"),
      };
      let replacementLeaseId = "";
      const replacementRequests = requestsFrom(yield* broker.connect(replacementHost));
      yield* Stream.runForEach(replacementRequests, (request) => {
        replacementLeaseId = request.leaseId;
        return broker.respond({
          hostId: replacementHost.hostId,
          connectionId: request.connectionId,
          leaseId: request.leaseId,
          requestId: request.requestId,
          ok: true,
          result: "replacement",
        });
      }).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;

      const completion = inFlight.pollUnsafe();
      expect(completion).toBeDefined();
      if (completion === undefined) return;
      const error = yield* Fiber.join(inFlight).pipe(Effect.flip);
      expect(error).toBeInstanceOf(ComputerUseStoppedError);
      expect(error).toMatchObject({ reason: "host-disconnected" });
      expect(firstConsumer.pollUnsafe()).toBeDefined();

      expect(yield* broker.invoke({ scope, operation: "observe", targetId, input: {} })).toBe(
        "replacement",
      );
      expect(replacementLeaseId).not.toBe(firstLeaseId);
    }),
  ),
);
