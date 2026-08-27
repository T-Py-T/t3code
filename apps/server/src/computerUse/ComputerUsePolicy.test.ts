import { expect, it } from "@effect/vitest";
import {
  ComputerUseHostId,
  ComputerUseTargetId,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type ComputerUseTarget,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as ComputerUsePolicy from "./ComputerUsePolicy.ts";

const environmentId = EnvironmentId.make("environment-1");
const scope: ComputerUsePolicy.ComputerUsePolicyScope = {
  environmentId,
  hostId: ComputerUseHostId.make("host-1"),
  threadId: ThreadId.make("thread-1"),
  turnId: TurnId.make("turn-1"),
  providerSessionId: "provider-session-1",
  providerInstanceId: ProviderInstanceId.make("codex"),
};
const target: ComputerUseTarget = {
  targetId: ComputerUseTargetId.make("target-text-edit"),
  kind: "application",
  displayName: "TextEdit",
  applicationId: "com.apple.TextEdit",
  stableIdentity: "macos:com.apple.TextEdit:APPLE",
};
const terminalTarget: ComputerUseTarget = {
  targetId: ComputerUseTargetId.make("target-terminal"),
  kind: "application",
  displayName: "Terminal",
  applicationId: "com.apple.Terminal",
  stableIdentity: "macos:com.apple.Terminal:APPLE",
};
const developmentT3Target: ComputerUseTarget = {
  targetId: ComputerUseTargetId.make("target-t3-development"),
  kind: "application",
  displayName: "T3 Code (Dev)",
  applicationId: "com.t3tools.t3code.dev.t3codecomputeruse",
  stableIdentity: "macos:com.t3tools.t3code.dev.t3codecomputeruse:development",
};

it.effect("denies forbidden targets even when the provider is in full-access mode", () =>
  Effect.gen(function* () {
    const policy = yield* ComputerUsePolicy.make;

    const decision = yield* policy.evaluate({
      scope,
      target,
      access: "operate",
      risk: "forbidden",
      runtimeMode: "full-access",
    });

    expect(decision).toEqual({
      _tag: "deny",
      reason: "forbidden-action",
    });
  }),
);

it.effect("keeps observation and operation grants separate", () =>
  Effect.gen(function* () {
    const policy = yield* ComputerUsePolicy.make;
    yield* policy.grant({
      scope,
      target,
      access: "observe",
      duration: "turn",
    });

    expect(
      yield* policy.evaluate({
        scope,
        target,
        access: "observe",
        risk: "inspect",
        runtimeMode: "full-access",
      }),
    ).toEqual({ _tag: "allow" });

    expect(
      yield* policy.evaluate({
        scope,
        target,
        access: "operate",
        risk: "reversible-local",
        runtimeMode: "full-access",
      }),
    ).toEqual({ _tag: "request-app-grant", access: "operate" });
  }),
);

it.effect("denies terminal targets even when the caller understates the action risk", () =>
  Effect.gen(function* () {
    const policy = yield* ComputerUsePolicy.make;
    yield* policy.grant({
      scope,
      target: terminalTarget,
      access: "operate",
      duration: "persistent",
    });

    const decision = yield* policy.evaluate({
      scope,
      target: terminalTarget,
      access: "operate",
      risk: "reversible-local",
      runtimeMode: "full-access",
    });

    expect(decision).toEqual({ _tag: "deny", reason: "forbidden-target" });
  }),
);

it.effect("denies every T3 bundle variant, including development builds", () =>
  Effect.gen(function* () {
    const policy = yield* ComputerUsePolicy.make;
    yield* policy.grant({
      scope,
      target: developmentT3Target,
      access: "operate",
      duration: "persistent",
    });

    expect(
      yield* policy.evaluate({
        scope,
        target: developmentT3Target,
        access: "operate",
        risk: "reversible-local",
        runtimeMode: "full-access",
      }),
    ).toEqual({ _tag: "deny", reason: "forbidden-target" });
  }),
);

it.effect("revokes a persistent target grant without affecting other identities", () =>
  Effect.gen(function* () {
    const policy = yield* ComputerUsePolicy.make;
    yield* policy.grant({
      scope,
      target,
      access: "operate",
      duration: "persistent",
    });

    expect(
      yield* policy.evaluate({
        scope,
        target,
        access: "operate",
        risk: "reversible-local",
        runtimeMode: "full-access",
      }),
    ).toEqual({ _tag: "allow" });

    expect(
      yield* policy.revoke({
        environmentId: scope.environmentId,
        hostId: scope.hostId,
        stableIdentity: target.stableIdentity,
      }),
    ).toBe(1);

    expect(
      yield* policy.evaluate({
        scope,
        target,
        access: "operate",
        risk: "reversible-local",
        runtimeMode: "full-access",
      }),
    ).toEqual({ _tag: "request-app-grant", access: "operate" });
  }),
);

it.effect("lists only persistent grants as user-visible summaries", () =>
  Effect.gen(function* () {
    const policy = yield* ComputerUsePolicy.make;
    yield* policy.grant({ scope, target, access: "observe", duration: "session" });
    yield* policy.grant({ scope, target, access: "operate", duration: "persistent" });

    expect(yield* policy.listPersistent(scope.environmentId)).toEqual([
      {
        environmentId: scope.environmentId,
        hostId: scope.hostId,
        target,
        access: "operate",
      },
    ]);
  }),
);

it.effect("does not let an app grant satisfy action confirmation or takeover", () =>
  Effect.gen(function* () {
    const policy = yield* ComputerUsePolicy.make;
    yield* policy.grant({ scope, target, access: "operate", duration: "persistent" });

    expect(
      yield* policy.evaluate({
        scope,
        target,
        access: "operate",
        risk: "external-side-effect",
        runtimeMode: "full-access",
      }),
    ).toEqual({ _tag: "request-action-confirmation", risk: "external-side-effect" });
    expect(
      yield* policy.evaluate({
        scope,
        target,
        access: "operate",
        risk: "sensitive-data",
        runtimeMode: "full-access",
      }),
    ).toEqual({ _tag: "request-action-confirmation", risk: "sensitive-data" });
    expect(
      yield* policy.evaluate({
        scope,
        target,
        access: "operate",
        risk: "destructive-or-privileged",
        runtimeMode: "full-access",
      }),
    ).toEqual({ _tag: "require-takeover", risk: "destructive-or-privileged" });
  }),
);

it.effect("consumes a one-action grant only when an action is actually allowed", () =>
  Effect.gen(function* () {
    const policy = yield* ComputerUsePolicy.make;
    yield* policy.grant({ scope, target, access: "operate", duration: "one-action" });

    expect(
      yield* policy.evaluate({
        scope,
        target,
        access: "operate",
        risk: "external-side-effect",
        runtimeMode: "full-access",
      }),
    ).toEqual({ _tag: "request-action-confirmation", risk: "external-side-effect" });
    expect(
      yield* policy.evaluate({
        scope,
        target,
        access: "operate",
        risk: "reversible-local",
        runtimeMode: "full-access",
      }),
    ).toEqual({ _tag: "allow" });
    expect(
      yield* policy.evaluate({
        scope,
        target,
        access: "operate",
        risk: "reversible-local",
        runtimeMode: "full-access",
      }),
    ).toEqual({ _tag: "request-app-grant", access: "operate" });
  }),
);

it.effect("binds persistent grants to the verified host and stable target identity", () =>
  Effect.gen(function* () {
    const policy = yield* ComputerUsePolicy.make;
    yield* policy.grant({ scope, target, access: "operate", duration: "persistent" });

    expect(
      yield* policy.evaluate({
        scope: { ...scope, hostId: ComputerUseHostId.make("host-2") },
        target,
        access: "operate",
        risk: "reversible-local",
        runtimeMode: "full-access",
      }),
    ).toEqual({ _tag: "request-app-grant", access: "operate" });
    expect(
      yield* policy.evaluate({
        scope,
        target: { ...target, stableIdentity: `${target.stableIdentity}:changed` },
        access: "operate",
        risk: "reversible-local",
        runtimeMode: "full-access",
      }),
    ).toEqual({ _tag: "request-app-grant", access: "operate" });
  }),
);

it.effect("turns an approved app-access request into the selected grant duration", () =>
  Effect.gen(function* () {
    const policy = yield* ComputerUsePolicy.make;
    const input: ComputerUsePolicy.ComputerUsePolicyInput = {
      scope,
      target,
      access: "operate",
      risk: "reversible-local",
      runtimeMode: "full-access",
    };

    const approvalId = yield* policy.requestApproval({
      input,
      decision: { _tag: "request-app-grant", access: "operate" },
    });
    expect(yield* policy.resolveApproval({ approvalId, decision: "acceptForSession" })).toBe(true);
    expect(yield* policy.evaluate(input)).toEqual({ _tag: "allow" });
    expect(
      yield* policy.evaluate({
        ...input,
        scope: { ...scope, providerSessionId: "another-provider-session" },
      }),
    ).toEqual({ _tag: "request-app-grant", access: "operate" });
  }),
);

it.effect("consumes a user-confirmed external side effect exactly once", () =>
  Effect.gen(function* () {
    const policy = yield* ComputerUsePolicy.make;
    yield* policy.grant({ scope, target, access: "operate", duration: "turn" });
    const input: ComputerUsePolicy.ComputerUsePolicyInput = {
      scope,
      target,
      access: "operate",
      risk: "external-side-effect",
      runtimeMode: "full-access",
    };
    const decision = yield* policy.evaluate(input);
    expect(decision).toEqual({
      _tag: "request-action-confirmation",
      risk: "external-side-effect",
    });

    const approvalId = yield* policy.requestApproval({
      input,
      decision: { _tag: "request-action-confirmation", risk: "external-side-effect" },
    });
    expect(yield* policy.resolveApproval({ approvalId, decision: "accept" })).toBe(true);
    expect(yield* policy.evaluate(input)).toEqual({ _tag: "allow" });
    expect(yield* policy.evaluate(input)).toEqual(decision);
  }),
);
