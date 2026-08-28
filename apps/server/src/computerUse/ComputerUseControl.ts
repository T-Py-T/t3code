import type {
  ComputerUseActiveControl,
  EnvironmentId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SynchronizedRef from "effect/SynchronizedRef";

import type { ComputerUseInvocationScope } from "./ComputerUseBroker.ts";

export class ComputerUseControl extends Context.Service<
  ComputerUseControl,
  {
    readonly claim: (
      scope: ComputerUseInvocationScope,
    ) => Effect.Effect<ComputerUseInvocationScope | undefined>;
    readonly activeFor: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<ComputerUseActiveControl | undefined>;
    readonly release: (scope: ComputerUseInvocationScope) => Effect.Effect<void>;
    readonly releaseTurn: (threadId: ThreadId, turnId: TurnId) => Effect.Effect<void>;
    readonly releaseThread: (threadId: ThreadId) => Effect.Effect<void>;
    readonly releaseEnvironment: (environmentId: EnvironmentId) => Effect.Effect<void>;
  }
>()("t3/computerUse/ComputerUseControl") {}

const sameOwner = (left: ComputerUseInvocationScope, right: ComputerUseInvocationScope) =>
  left.environmentId === right.environmentId &&
  left.threadId === right.threadId &&
  left.turnId === right.turnId &&
  left.providerSessionId === right.providerSessionId;

export const make = Effect.gen(function* ComputerUseControlMake() {
  const controls = yield* SynchronizedRef.make(
    new Map<EnvironmentId, ComputerUseInvocationScope>(),
  );

  const claim: ComputerUseControl["Service"]["claim"] = Effect.fn("ComputerUseControl.claim")(
    (scope) =>
      SynchronizedRef.modify(controls, (current) => {
        const active = current.get(scope.environmentId);
        if (active && !sameOwner(active, scope)) return [active, current] as const;
        if (active) return [undefined, current] as const;
        const next = new Map(current);
        next.set(scope.environmentId, scope);
        return [undefined, next] as const;
      }),
  );

  const releaseMatching = (matches: (scope: ComputerUseInvocationScope) => boolean) =>
    SynchronizedRef.update(controls, (current) => {
      if (![...current.values()].some(matches)) return current;
      return new Map([...current].filter(([, scope]) => !matches(scope)));
    });

  return ComputerUseControl.of({
    claim,
    activeFor: (environmentId) =>
      SynchronizedRef.get(controls).pipe(
        Effect.map((current) => {
          const active = current.get(environmentId);
          return active === undefined
            ? undefined
            : {
                threadId: active.threadId,
                turnId: active.turnId,
                providerInstanceId: active.providerInstanceId,
              };
        }),
      ),
    release: (scope) => releaseMatching((active) => sameOwner(active, scope)),
    releaseTurn: (threadId, turnId) =>
      releaseMatching((active) => active.threadId === threadId && active.turnId === turnId),
    releaseThread: (threadId) => releaseMatching((active) => active.threadId === threadId),
    releaseEnvironment: (environmentId) =>
      releaseMatching((active) => active.environmentId === environmentId),
  });
});

let activeComputerUseControl: ComputerUseControl["Service"] | undefined;

const makeActive = Effect.acquireRelease(
  make.pipe(
    Effect.tap((control) =>
      Effect.sync(() => {
        activeComputerUseControl = control;
      }),
    ),
  ),
  (control) =>
    Effect.sync(() => {
      if (activeComputerUseControl === control) activeComputerUseControl = undefined;
    }),
);

export const releaseActiveComputerUseTurn = (threadId: ThreadId, turnId: TurnId) =>
  activeComputerUseControl?.releaseTurn(threadId, turnId) ?? Effect.void;

export const releaseActiveComputerUseThread = (threadId: ThreadId) =>
  activeComputerUseControl?.releaseThread(threadId) ?? Effect.void;

export const layer = Layer.effect(ComputerUseControl, makeActive);
