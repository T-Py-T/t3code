import {
  type ComputerUseAccessLevel,
  type ComputerUseActionRisk,
  type ComputerUseHostId,
  type ComputerUseGrantDuration,
  type ComputerUsePolicyDecision,
  type ComputerUseTarget,
  type EnvironmentId,
  type ProviderInstanceId,
  type RuntimeMode,
  type ThreadId,
  type TurnId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SynchronizedRef from "effect/SynchronizedRef";

export interface ComputerUsePolicyScope {
  readonly environmentId: EnvironmentId;
  readonly hostId: ComputerUseHostId;
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  readonly providerSessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
}

export interface ComputerUsePolicyInput {
  readonly scope: ComputerUsePolicyScope;
  readonly target: ComputerUseTarget;
  readonly access: ComputerUseAccessLevel;
  readonly risk: ComputerUseActionRisk;
  readonly runtimeMode: RuntimeMode;
}

export interface ComputerUseGrantInput {
  readonly scope: ComputerUsePolicyScope;
  readonly target: ComputerUseTarget;
  readonly access: ComputerUseAccessLevel;
  readonly duration: ComputerUseGrantDuration;
}

export interface ComputerUseRevokeInput {
  readonly environmentId: EnvironmentId;
  readonly hostId: ComputerUseHostId;
  readonly stableIdentity: string;
}

interface GrantRecord extends ComputerUseGrantInput {}

const FORBIDDEN_APPLICATION_IDS = new Set([
  "com.apple.terminal",
  "com.t3tools.t3code",
  "com.t3tools.t3code.dev",
  "cmd.exe",
  "microsoft.windowsterminal_8wekyb3d8bbwe",
  "powershell.exe",
  "pwsh.exe",
  "wt.exe",
]);

export class ComputerUsePolicy extends Context.Service<
  ComputerUsePolicy,
  {
    readonly evaluate: (input: ComputerUsePolicyInput) => Effect.Effect<ComputerUsePolicyDecision>;
    readonly grant: (input: ComputerUseGrantInput) => Effect.Effect<void>;
    readonly revoke: (input: ComputerUseRevokeInput) => Effect.Effect<number>;
  }
>()("t3/computerUse/ComputerUsePolicy") {}

export const make = Effect.gen(function* ComputerUsePolicyMake() {
  const grants = yield* SynchronizedRef.make<ReadonlyArray<GrantRecord>>([]);

  const grant: ComputerUsePolicy["Service"]["grant"] = Effect.fn("ComputerUsePolicy.grant")(
    (input) => SynchronizedRef.update(grants, (current) => [...current, input]),
  );

  const revoke: ComputerUsePolicy["Service"]["revoke"] = Effect.fn("ComputerUsePolicy.revoke")(
    (input) =>
      SynchronizedRef.modify(grants, (current) => {
        const retained = current.filter(
          (candidate) =>
            candidate.scope.environmentId !== input.environmentId ||
            candidate.scope.hostId !== input.hostId ||
            candidate.target.stableIdentity !== input.stableIdentity,
        );
        return [current.length - retained.length, retained] as const;
      }),
  );

  const evaluate: ComputerUsePolicy["Service"]["evaluate"] = Effect.fn(
    "ComputerUsePolicy.evaluate",
  )(function* (input) {
    if (FORBIDDEN_APPLICATION_IDS.has(input.target.applicationId.toLowerCase())) {
      return { _tag: "deny", reason: "forbidden-target" } as const;
    }
    if (input.risk === "forbidden") {
      return { _tag: "deny", reason: "forbidden-action" } as const;
    }

    const matchingGrant = yield* SynchronizedRef.modify(grants, (current) => {
      const index = current.findIndex((candidate) => {
        if (
          candidate.scope.environmentId !== input.scope.environmentId ||
          candidate.scope.hostId !== input.scope.hostId ||
          candidate.target.stableIdentity !== input.target.stableIdentity ||
          (candidate.access !== input.access && candidate.access !== "operate")
        ) {
          return false;
        }
        switch (candidate.duration) {
          case "persistent":
            return true;
          case "session":
            return candidate.scope.providerSessionId === input.scope.providerSessionId;
          case "turn":
          case "one-action":
            return (
              candidate.scope.threadId === input.scope.threadId &&
              candidate.scope.turnId === input.scope.turnId &&
              candidate.scope.providerSessionId === input.scope.providerSessionId
            );
        }
      });
      if (index < 0) return [undefined, current] as const;
      const found = current[index];
      if (
        found?.duration !== "one-action" ||
        (input.risk !== "inspect" && input.risk !== "reversible-local")
      ) {
        return [found, current] as const;
      }
      return [found, [...current.slice(0, index), ...current.slice(index + 1)]] as const;
    });

    if (!matchingGrant) {
      return { _tag: "request-app-grant", access: input.access } as const;
    }
    if (input.risk === "external-side-effect" || input.risk === "sensitive-data") {
      return { _tag: "request-action-confirmation", risk: input.risk } as const;
    }
    if (input.risk === "destructive-or-privileged") {
      return { _tag: "require-takeover", risk: input.risk } as const;
    }
    return { _tag: "allow" } as const;
  });

  return ComputerUsePolicy.of({ evaluate, grant, revoke });
});

export const layer = Layer.effect(ComputerUsePolicy, make);
