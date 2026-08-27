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
