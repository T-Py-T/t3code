import {
  ComputerUseConnectionId,
  ComputerUseHostFailureError,
  ComputerUseHostRequest,
  ComputerUseInvalidRequestError,
  ComputerUseLeaseBusyError,
  ComputerUseLeaseId,
  ComputerUseMalformedResponseError,
  ComputerUseNoAvailableHostError,
  ComputerUseRequestId,
  ComputerUseStoppedError,
  ComputerUseTimeoutError,
  type ComputerUseBrokerError,
  type ComputerUseActiveControl,
  type ComputerUseHostResponse,
  type ComputerUseHostFailureReason,
  type ComputerUseHostFailureTag,
  type ComputerUseHostStreamEvent,
  type ComputerUseObservationId,
  type ComputerUseOperation,
  type ComputerUseStopReason,
  type ComputerUseTargetId,
  type ComputerUseVerifiedHost,
  type EnvironmentId,
  type ProviderInstanceId,
  type ThreadId,
  type TurnId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";

export interface ComputerUseInvocationScope {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  readonly providerSessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
}

export interface ComputerUseInvokeInput {
  readonly scope: ComputerUseInvocationScope;
  readonly operation: ComputerUseOperation;
  readonly input: unknown;
  readonly targetId?: ComputerUseTargetId;
  readonly observationId?: ComputerUseObservationId;
  readonly timeoutMs?: number;
}

export interface ComputerUseStopInput {
  readonly scope: ComputerUseInvocationScope;
  readonly reason: ComputerUseStopReason;
}

export interface ComputerUseStopTurnInput {
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  readonly reason: ComputerUseStopReason;
}

export class ComputerUseBroker extends Context.Service<
  ComputerUseBroker,
  {
    readonly connect: (
      host: ComputerUseVerifiedHost,
    ) => Effect.Effect<Stream.Stream<ComputerUseHostStreamEvent>>;
    readonly respond: (response: ComputerUseHostResponse) => Effect.Effect<void>;
    readonly hostFor: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<Option.Option<ComputerUseVerifiedHost>>;
    readonly invoke: <A = unknown>(
      input: ComputerUseInvokeInput,
      resultSchema?: Schema.ConstraintDecoder<A, never>,
    ) => Effect.Effect<A, ComputerUseBrokerError>;
    readonly stop: (input: ComputerUseStopInput) => Effect.Effect<void>;
    readonly stopTurn: (input: ComputerUseStopTurnInput) => Effect.Effect<void>;
    readonly activeControlFor: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<ComputerUseActiveControl | undefined>;
    readonly stopEnvironment: (
      environmentId: EnvironmentId,
      reason: ComputerUseStopReason,
    ) => Effect.Effect<number>;
  }
>()("t3/computerUse/ComputerUseBroker") {}

interface HostConnection {
  readonly host: ComputerUseVerifiedHost;
  readonly connectionId: ComputerUseConnectionId;
  readonly queue: Queue.Queue<ComputerUseHostStreamEvent>;
}

interface ControlLease {
  readonly leaseId: ComputerUseLeaseId;
  readonly scope: ComputerUseInvocationScope;
  readonly connection: HostConnection;
  readonly lastMutation?: Deferred.Deferred<void>;
}

interface PendingRequest {
  readonly lease: ControlLease;
  readonly operation: ComputerUseOperation;
  readonly deferred: Deferred.Deferred<unknown, ComputerUseBrokerError>;
}

interface BrokerState {
  readonly hosts: ReadonlyMap<EnvironmentId, HostConnection>;
  readonly leases: ReadonlyMap<EnvironmentId, ControlLease>;
  readonly pending: ReadonlyMap<ComputerUseRequestId, PendingRequest>;
  readonly requestSequence: number;
}

const HOST_FAILURE_REASONS = {
  ComputerUsePermissionMissingError: "permission-missing",
  ComputerUseTargetNotFoundError: "target-not-found",
  ComputerUseTargetIdentityChangedError: "target-identity-changed",
  ComputerUseStaleObservationError: "stale-observation",
  ComputerUseUnsupportedOperationError: "unsupported-operation",
  ComputerUsePolicyDeniedError: "policy-denied",
  ComputerUseApprovalRequiredError: "approval-required",
  ComputerUseConfirmationRequiredError: "confirmation-required",
  ComputerUseTargetClosedError: "target-closed",
  ComputerUseLockStateChangedError: "lock-state-changed",
  ComputerUseHumanInputDetectedError: "human-input-detected",
  ComputerUseTakeoverError: "takeover",
  ComputerUseInterruptedError: "interrupted",
  ComputerUseTimeoutError: "timeout",
  ComputerUseMalformedResponseError: "malformed-response",
  ComputerUseHostDisconnectedError: "host-disconnected",
} as const satisfies Readonly<Record<ComputerUseHostFailureTag, ComputerUseHostFailureReason>>;

type RemoteDetailKind = "null" | "array" | "object" | "string" | "number" | "boolean";

const remoteDetailKind = (detail: unknown): RemoteDetailKind => {
  if (detail === null) return "null";
  if (Array.isArray(detail)) return "array";
  switch (typeof detail) {
    case "string":
      return "string";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    default:
      return "object";
  }
};

type RouteDecision =
  | { readonly _tag: "no-host" }
  | { readonly _tag: "busy"; readonly lease: ControlLease }
  | {
      readonly _tag: "route";
      readonly connection: HostConnection;
      readonly lease: ControlLease;
      readonly requestId: ComputerUseRequestId;
      readonly waitForMutation?: Deferred.Deferred<void>;
      readonly completeMutation?: Deferred.Deferred<void>;
    };

const sameScope = (left: ComputerUseInvocationScope, right: ComputerUseInvocationScope): boolean =>
  left.environmentId === right.environmentId &&
  left.threadId === right.threadId &&
  left.turnId === right.turnId &&
  left.providerSessionId === right.providerSessionId &&
  left.providerInstanceId === right.providerInstanceId;

export const make = Effect.gen(function* ComputerUseBrokerMake() {
  const crypto = yield* Crypto.Crypto;
  const state = yield* SynchronizedRef.make<BrokerState>({
    hosts: new Map(),
    leases: new Map(),
    pending: new Map(),
    requestSequence: 0,
  });

  const closeConnection = Effect.fn("ComputerUseBroker.closeConnection")(function* (
    connection: HostConnection,
    disconnected: ReadonlyArray<PendingRequest>,
  ) {
    yield* Effect.forEach(
      disconnected,
      (request) =>
        Deferred.fail(
          request.deferred,
          new ComputerUseStoppedError({
            operation: request.operation,
            ...request.lease.scope,
            leaseId: request.lease.leaseId,
            reason: "host-disconnected",
          }),
        ),
      { discard: true },
    );
    yield* Queue.shutdown(connection.queue);
  });

  const disconnect = Effect.fn("ComputerUseBroker.disconnect")(function* (
    connection: HostConnection,
  ) {
    const disconnected = yield* SynchronizedRef.modify(
      state,
      (current): readonly [ReadonlyArray<PendingRequest>, BrokerState] => {
        if (current.hosts.get(connection.host.environmentId)?.queue !== connection.queue) {
          return [[], current];
        }
        const hosts = new Map(current.hosts);
        hosts.delete(connection.host.environmentId);
        const leases = new Map(current.leases);
        const lease = leases.get(connection.host.environmentId);
        if (lease?.connection.queue === connection.queue)
          leases.delete(connection.host.environmentId);
        const pending = new Map(current.pending);
        const disconnected: PendingRequest[] = [];
        for (const [requestId, request] of pending) {
          if (request.lease.connection.queue !== connection.queue) continue;
          pending.delete(requestId);
          disconnected.push(request);
        }
        return [disconnected, { ...current, hosts, leases, pending }] as const;
      },
    );
    yield* closeConnection(connection, disconnected);
  });

  const acquireConnection = Effect.fn("ComputerUseBroker.acquireConnection")(function* (
    host: ComputerUseVerifiedHost,
  ) {
    const connectionId = ComputerUseConnectionId.make(
      yield* crypto.randomUUIDv4.pipe(Effect.orDie),
    );
    const queue = yield* Queue.unbounded<ComputerUseHostStreamEvent>();
    yield* Queue.offer(queue, { type: "connected", connectionId });
    const connection: HostConnection = { host, connectionId, queue };
    const replaced = yield* SynchronizedRef.modify(state, (current) => {
      const previous = current.hosts.get(host.environmentId);
      const hosts = new Map(current.hosts);
      hosts.set(host.environmentId, connection);
      if (!previous) {
        return [undefined, { ...current, hosts }] as const;
      }
      const leases = new Map(current.leases);
      const lease = leases.get(host.environmentId);
      if (lease?.connection.queue === previous.queue) leases.delete(host.environmentId);
      const pending = new Map(current.pending);
      const disconnected: PendingRequest[] = [];
      for (const [requestId, request] of pending) {
        if (request.lease.connection.queue !== previous.queue) continue;
        pending.delete(requestId);
        disconnected.push(request);
      }
      return [
        { previous, disconnected },
        { ...current, hosts, leases, pending },
      ] as const;
    });
    if (replaced) yield* closeConnection(replaced.previous, replaced.disconnected);
    return connection;
  });

  const connect: ComputerUseBroker["Service"]["connect"] = Effect.fn("ComputerUseBroker.connect")(
    (host) =>
      Effect.succeed(
        Stream.unwrap(
          Effect.acquireRelease(acquireConnection(host), disconnect).pipe(
            Effect.map((connection) => Stream.fromQueue(connection.queue)),
          ),
        ),
      ),
  );

  const respond: ComputerUseBroker["Service"]["respond"] = Effect.fn("ComputerUseBroker.respond")(
    function* (response) {
      const pending = yield* SynchronizedRef.modify(state, (current) => {
        const entry = current.pending.get(response.requestId);
        if (
          !entry ||
          entry.lease.connection.host.hostId !== response.hostId ||
          entry.lease.connection.connectionId !== response.connectionId ||
          entry.lease.leaseId !== response.leaseId
        ) {
          return [undefined, current] as const;
        }
        const next = new Map(current.pending);
        next.delete(response.requestId);
        return [entry, { ...current, pending: next }] as const;
      });
      if (!pending) return;
      if (response.ok) {
        yield* Deferred.succeed(pending.deferred, response.result);
      } else if (response.error) {
        yield* Deferred.fail(
          pending.deferred,
          new ComputerUseHostFailureError({
            operation: pending.operation,
            ...pending.lease.scope,
            leaseId: pending.lease.leaseId,
            reason: HOST_FAILURE_REASONS[response.error._tag],
            remoteTag: response.error._tag,
            remoteMessageLength: response.error.message.length,
            ...(response.error.detail === undefined
              ? {}
              : { remoteDetailKind: remoteDetailKind(response.error.detail) }),
          }),
        );
      } else {
        yield* Deferred.fail(
          pending.deferred,
          new ComputerUseMalformedResponseError({
            operation: pending.operation,
            ...pending.lease.scope,
            leaseId: pending.lease.leaseId,
          }),
        );
      }
    },
  );

  const hostFor: ComputerUseBroker["Service"]["hostFor"] = Effect.fn("ComputerUseBroker.hostFor")(
    (environmentId) =>
      SynchronizedRef.get(state).pipe(
        Effect.map((current) => Option.fromNullishOr(current.hosts.get(environmentId)?.host)),
      ),
  );

  const invoke = Effect.fn("ComputerUseBroker.invoke")(function* <A = unknown>(
    input: Parameters<ComputerUseBroker["Service"]["invoke"]>[0],
    resultSchema?: Schema.ConstraintDecoder<A, never>,
  ): Effect.fn.Return<A, ComputerUseBrokerError> {
    const timeoutMs = input.timeoutMs ?? 15_000;
    const candidateLeaseId = ComputerUseLeaseId.make(yield* crypto.randomUUIDv4.pipe(Effect.orDie));
    const validatedRequest = yield* Schema.decodeUnknownEffect(ComputerUseHostRequest)({
      requestId: ComputerUseRequestId.make("computer-use-validation"),
      leaseId: candidateLeaseId,
      environmentId: input.scope.environmentId,
      operation: input.operation,
      ...(input.targetId === undefined ? {} : { targetId: input.targetId }),
      ...(input.observationId === undefined ? {} : { observationId: input.observationId }),
      input: input.input,
      timeoutMs,
    }).pipe(
      Effect.mapError(
        () =>
          new ComputerUseInvalidRequestError({
            operation: input.operation,
            ...input.scope,
          }),
      ),
    );
    const deferred = yield* Deferred.make<unknown, ComputerUseBrokerError>();
    const mutationCompletion = yield* Deferred.make<void>();
    const route = yield* SynchronizedRef.modify(
      state,
      (current): readonly [RouteDecision, BrokerState] => {
        const connection = current.hosts.get(input.scope.environmentId);
        if (!connection || !connection.host.supportedOperations.includes(input.operation)) {
          return [{ _tag: "no-host" }, current];
        }
        const activeLease = current.leases.get(input.scope.environmentId);
        if (activeLease && !sameScope(activeLease.scope, input.scope)) {
          return [{ _tag: "busy", lease: activeLease }, current];
        }
        const baseLease: ControlLease =
          activeLease ??
          ({
            leaseId: candidateLeaseId,
            scope: input.scope,
            connection,
          } satisfies ControlLease);
        const waitForMutation = input.operation === "act" ? baseLease.lastMutation : undefined;
        const lease: ControlLease =
          input.operation === "act"
            ? { ...baseLease, lastMutation: mutationCompletion }
            : baseLease;
        const requestId = ComputerUseRequestId.make(`computer-use-${current.requestSequence}`);
        const leases = new Map(current.leases);
        leases.set(input.scope.environmentId, lease);
        const pending = new Map(current.pending);
        pending.set(requestId, { lease, operation: input.operation, deferred });
        return [
          {
            _tag: "route",
            connection,
            lease,
            requestId,
            ...(waitForMutation === undefined ? {} : { waitForMutation }),
            ...(input.operation === "act" ? { completeMutation: mutationCompletion } : {}),
          },
          { ...current, leases, pending, requestSequence: current.requestSequence + 1 },
        ];
      },
    );

    if (route._tag === "no-host") {
      return yield* new ComputerUseNoAvailableHostError({
        operation: input.operation,
        ...input.scope,
      });
    }
    if (route._tag === "busy") {
      return yield* new ComputerUseLeaseBusyError({
        operation: input.operation,
        ...input.scope,
        activeThreadId: route.lease.scope.threadId,
        activeTurnId: route.lease.scope.turnId,
      });
    }

    const removePending = SynchronizedRef.update(state, (current) => {
      if (!current.pending.has(route.requestId)) return current;
      const pending = new Map(current.pending);
      pending.delete(route.requestId);
      return { ...current, pending };
    });
    const dispatchAndAwait = Effect.gen(function* () {
      if (route.waitForMutation !== undefined) yield* Deferred.await(route.waitForMutation);
      const current = yield* SynchronizedRef.get(state);
      if (!current.pending.has(route.requestId)) return yield* Deferred.await(deferred);
      const offered = yield* Queue.offer(route.connection.queue, {
        type: "request",
        connectionId: route.connection.connectionId,
        request: {
          ...validatedRequest,
          requestId: route.requestId,
          leaseId: route.lease.leaseId,
        },
      });
      if (!offered) {
        return yield* new ComputerUseNoAvailableHostError({
          operation: input.operation,
          ...input.scope,
        });
      }
      return yield* Deferred.await(deferred);
    });
    const boundedDispatch = dispatchAndAwait.pipe(
      Effect.timeoutOption(timeoutMs),
      Effect.ensuring(removePending),
    );
    const result = yield* route.completeMutation === undefined
      ? boundedDispatch
      : boundedDispatch.pipe(Effect.ensuring(Deferred.succeed(route.completeMutation, undefined)));
    return yield* Option.match(result, {
      onNone: () =>
        Effect.fail(
          new ComputerUseTimeoutError({
            operation: input.operation,
            ...input.scope,
            leaseId: route.lease.leaseId,
            timeoutMs,
          }),
        ),
      onSome: (value) =>
        resultSchema === undefined
          ? Effect.succeed(value as A)
          : Schema.decodeUnknownEffect(resultSchema)(value).pipe(
              Effect.map((decoded) => decoded as A),
              Effect.mapError(
                () =>
                  new ComputerUseMalformedResponseError({
                    operation: input.operation,
                    ...input.scope,
                    leaseId: route.lease.leaseId,
                  }),
              ),
            ),
    });
  });

  const stopMatching = Effect.fn("ComputerUseBroker.stopMatching")(function* (
    matches: (lease: ControlLease) => boolean,
    reason: ComputerUseStopReason,
  ) {
    const stoppedLeases = yield* SynchronizedRef.modify(
      state,
      (
        current,
      ): readonly [
        ReadonlyArray<{
          readonly lease: ControlLease;
          readonly requests: ReadonlyArray<PendingRequest>;
        }>,
        BrokerState,
      ] => {
        const leases = new Map(current.leases);
        const pending = new Map(current.pending);
        const stopped: Array<{
          lease: ControlLease;
          requests: ReadonlyArray<PendingRequest>;
        }> = [];
        for (const [environmentId, activeLease] of current.leases) {
          if (!matches(activeLease)) continue;
          leases.delete(environmentId);
          const requests: PendingRequest[] = [];
          for (const [requestId, request] of pending) {
            if (request.lease.leaseId !== activeLease.leaseId) continue;
            pending.delete(requestId);
            requests.push(request);
          }
          stopped.push({ lease: activeLease, requests });
        }
        return stopped.length === 0 ? [[], current] : [stopped, { ...current, leases, pending }];
      },
    );
    yield* Effect.forEach(
      stoppedLeases,
      (stopped) =>
        Effect.gen(function* () {
          yield* Queue.offer(stopped.lease.connection.queue, {
            type: "cancel",
            connectionId: stopped.lease.connection.connectionId,
            leaseId: stopped.lease.leaseId,
            reason,
          });
          yield* Effect.forEach(
            stopped.requests,
            (request) =>
              Deferred.fail(
                request.deferred,
                new ComputerUseStoppedError({
                  operation: request.operation,
                  ...request.lease.scope,
                  leaseId: request.lease.leaseId,
                  reason,
                }),
              ),
            { discard: true },
          );
        }),
      { discard: true },
    );
    return stoppedLeases.length;
  });

  const stop: ComputerUseBroker["Service"]["stop"] = Effect.fn("ComputerUseBroker.stop")(
    ({ scope, reason }) =>
      stopMatching((lease) => sameScope(lease.scope, scope), reason).pipe(Effect.asVoid),
  );

  const stopTurn: ComputerUseBroker["Service"]["stopTurn"] = Effect.fn(
    "ComputerUseBroker.stopTurn",
  )(({ threadId, turnId, reason }) =>
    stopMatching(
      (lease) => lease.scope.threadId === threadId && lease.scope.turnId === turnId,
      reason,
    ).pipe(Effect.asVoid),
  );

  const activeControlFor: ComputerUseBroker["Service"]["activeControlFor"] = Effect.fn(
    "ComputerUseBroker.activeControlFor",
  )((environmentId) =>
    SynchronizedRef.get(state).pipe(
      Effect.map((current) => {
        const active = current.leases.get(environmentId)?.scope;
        return active === undefined
          ? undefined
          : {
              threadId: active.threadId,
              turnId: active.turnId,
              providerInstanceId: active.providerInstanceId,
            };
      }),
    ),
  );

  const stopEnvironment: ComputerUseBroker["Service"]["stopEnvironment"] = Effect.fn(
    "ComputerUseBroker.stopEnvironment",
  )((environmentId, reason) =>
    stopMatching((lease) => lease.scope.environmentId === environmentId, reason),
  );

  return ComputerUseBroker.of({
    connect,
    respond,
    hostFor,
    invoke,
    stop,
    stopTurn,
    activeControlFor,
    stopEnvironment,
  });
}).pipe(Effect.withSpan("ComputerUseBroker.make"));

let activeComputerUseBroker: ComputerUseBroker["Service"] | undefined;

const makeActive = Effect.acquireRelease(
  make.pipe(
    Effect.tap((broker) =>
      Effect.sync(() => {
        activeComputerUseBroker = broker;
      }),
    ),
  ),
  (broker) =>
    Effect.sync(() => {
      if (activeComputerUseBroker === broker) activeComputerUseBroker = undefined;
    }),
);

export const stopActiveComputerUseTurn = (
  threadId: ThreadId,
  turnId: TurnId,
  reason: ComputerUseStopReason,
): Effect.Effect<void> =>
  activeComputerUseBroker?.stopTurn({ threadId, turnId, reason }) ?? Effect.void;

export const layer = Layer.effect(ComputerUseBroker, makeActive);
