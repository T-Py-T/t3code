import { expect, it } from "@effect/vitest";
import {
  ComputerUseHostId,
  ComputerUseRequestIdentity,
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
const accessibilityPromptTarget: ComputerUseTarget = {
  targetId: ComputerUseTargetId.make("target-accessibility-prompt"),
  kind: "application",
  displayName: "Accessibility Access",
  applicationId: "com.apple.accessibility.universalAccessAuthWarn",
  stableIdentity: "macos:com.apple.accessibility.universalAccessAuthWarn:APPLE",
};
const thirdPartyTerminalTarget: ComputerUseTarget = {
  targetId: ComputerUseTargetId.make("target-third-party-terminal"),
  kind: "application",
  displayName: "Ghostty",
  applicationId: "com.mitchellh.ghostty",
  stableIdentity: "macos:com.mitchellh.ghostty:TEAM",
};
const developmentT3Target: ComputerUseTarget = {
  targetId: ComputerUseTargetId.make("target-t3-development"),
  kind: "application",
  displayName: "T3 Code (Dev)",
  applicationId: "com.t3tools.t3code.dev.t3codecomputeruse",
  stableIdentity: "macos:com.t3tools.t3code.dev.t3codecomputeruse:development",
};
const firstAction = {
  requestIdentity: ComputerUseRequestIdentity.make("request-identity-1"),
  summary: "Click at (30, 40)",
} as const;
const secondAction = {
  requestIdentity: ComputerUseRequestIdentity.make("request-identity-2"),
  summary: "Click at (50, 60)",
} as const;

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

it.effect("denies macOS privacy prompts even when the caller understates the action risk", () =>
  Effect.gen(function* () {
    const policy = yield* ComputerUsePolicy.make;

    expect(
      yield* policy.evaluate({
        scope,
        target: accessibilityPromptTarget,
        access: "operate",
        risk: "reversible-local",
        runtimeMode: "full-access",
      }),
    ).toEqual({ _tag: "deny", reason: "forbidden-target" });
  }),
);

it.effect("denies third-party terminal targets", () =>
  Effect.gen(function* () {
    const policy = yield* ComputerUsePolicy.make;

    expect(
      yield* policy.evaluate({
        scope,
        target: thirdPartyTerminalTarget,
        access: "operate",
        risk: "reversible-local",
        runtimeMode: "full-access",
      }),
    ).toEqual({ _tag: "deny", reason: "forbidden-target" });
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

it.effect("keeps persistent grants unchanged when saving fails", () =>
  Effect.gen(function* () {
    const persisted = { scope, target, access: "operate", duration: "persistent" } as const;
    const policy = yield* ComputerUsePolicy.makeWithPersistence({
      load: Effect.succeed([persisted]),
      save: () => Effect.die("persistence unavailable"),
    });
    const revokeExit = yield* policy
      .revoke({
        environmentId: scope.environmentId,
        hostId: scope.hostId,
        stableIdentity: target.stableIdentity,
      })
      .pipe(Effect.exit);

    expect(revokeExit._tag).toBe("Failure");
    expect(yield* policy.listPersistent(environmentId)).toHaveLength(1);
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
        action: firstAction,
      }),
    ).toEqual({ _tag: "request-action-confirmation", risk: "external-side-effect" });
    expect(
      yield* policy.evaluate({
        scope,
        target,
        access: "operate",
        risk: "sensitive-data",
        runtimeMode: "full-access",
        action: firstAction,
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

    const input: ComputerUsePolicy.ComputerUsePolicyInput = {
      scope,
      target,
      access: "operate",
      risk: "external-side-effect",
      runtimeMode: "full-access",
      action: firstAction,
    };
    const decision = {
      _tag: "request-action-confirmation",
      risk: "external-side-effect",
    } as const;
    expect(yield* policy.evaluate(input)).toEqual(decision);
    const approvalId = yield* policy.requestApproval({ input, decision });
    yield* policy.resolveApproval({ approvalId, decision: "accept" });
    expect(yield* policy.evaluate(input)).toEqual({ _tag: "allow" });
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

it.effect("limits turn approval to the approved turn", () =>
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
    yield* policy.resolveApproval({ approvalId, decision: "acceptForTurn" });

    expect(yield* policy.evaluate(input)).toEqual({ _tag: "allow" });
    expect(
      yield* policy.evaluate({
        ...input,
        scope: { ...scope, turnId: TurnId.make("turn-2") },
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
      action: firstAction,
    };
    const decision = {
      _tag: "request-action-confirmation",
      risk: "external-side-effect",
    } as const;
    expect(yield* policy.evaluate(input)).toEqual(decision);

    const approvalId = yield* policy.requestApproval({
      input,
      decision: { _tag: "request-action-confirmation", risk: "external-side-effect" },
    });
    expect(yield* policy.resolveApproval({ approvalId, decision: "accept" })).toBe(true);
    expect(yield* policy.evaluate(input)).toEqual({ _tag: "allow" });
    expect(yield* policy.evaluate(input)).toEqual(decision);
  }),
);

it.effect("binds confirmation to the exact requested action", () =>
  Effect.gen(function* () {
    const policy = yield* ComputerUsePolicy.make;
    yield* policy.grant({ scope, target, access: "operate", duration: "turn" });
    const input: ComputerUsePolicy.ComputerUsePolicyInput = {
      scope,
      target,
      access: "operate",
      risk: "external-side-effect",
      runtimeMode: "full-access",
      action: firstAction,
    };
    const decision = {
      _tag: "request-action-confirmation",
      risk: "external-side-effect",
    } as const;
    expect(yield* policy.evaluate(input)).toEqual(decision);
    const approvalId = yield* policy.requestApproval({ input, decision });
    yield* policy.resolveApproval({ approvalId, decision: "accept" });

    expect(yield* policy.evaluate({ ...input, action: secondAction })).toEqual(decision);
    expect(yield* policy.evaluate(input)).toEqual({ _tag: "allow" });
  }),
);

it.effect("pauses future target access until the user explicitly resumes it", () =>
  Effect.gen(function* () {
    const policy = yield* ComputerUsePolicy.make;
    yield* policy.grant({ scope, target, access: "operate", duration: "session" });
    yield* policy.pause(environmentId);

    expect(yield* policy.isPaused(environmentId)).toBe(true);
    expect(
      yield* policy.evaluate({
        scope,
        target,
        access: "operate",
        risk: "reversible-local",
        runtimeMode: "full-access",
      }),
    ).toEqual({ _tag: "deny", reason: "paused" });
    expect(yield* policy.resume(environmentId)).toBe(true);
    expect(yield* policy.resume(environmentId)).toBe(false);
    expect(yield* policy.isPaused(environmentId)).toBe(false);
    expect(
      yield* policy.evaluate({
        scope,
        target,
        access: "operate",
        risk: "reversible-local",
        runtimeMode: "full-access",
      }),
    ).toEqual({ _tag: "allow" });
  }),
);

it.effect("purges turn and thread-scoped grants, confirmations, and approvals", () =>
  Effect.gen(function* () {
    const policy = yield* ComputerUsePolicy.make;
    const input: ComputerUsePolicy.ComputerUsePolicyInput = {
      scope,
      target,
      access: "operate",
      risk: "external-side-effect",
      runtimeMode: "full-access",
      action: firstAction,
    };
    const reversibleInput: ComputerUsePolicy.ComputerUsePolicyInput = {
      scope,
      target,
      access: "operate",
      risk: "reversible-local",
      runtimeMode: "full-access",
    };
    yield* policy.grant({ scope, target, access: "operate", duration: "turn" });
    const confirmationId = yield* policy.requestApproval({
      input,
      decision: { _tag: "request-action-confirmation", risk: "external-side-effect" },
    });
    yield* policy.resolveApproval({ approvalId: confirmationId, decision: "accept" });
    const pendingId = yield* policy.requestApproval({
      input,
      decision: { _tag: "request-app-grant", access: "operate" },
    });

    yield* policy.finishTurn(scope.threadId, scope.turnId);

    expect(yield* policy.resolveApproval({ approvalId: pendingId, decision: "accept" })).toBe(
      false,
    );
    expect(yield* policy.evaluate(input)).toEqual({
      _tag: "request-app-grant",
      access: "operate",
    });

    yield* policy.grant({ scope, target, access: "operate", duration: "session" });
    expect(yield* policy.evaluate(reversibleInput)).toEqual({ _tag: "allow" });
    yield* policy.finishThread(scope.threadId);
    expect(yield* policy.evaluate(reversibleInput)).toEqual({
      _tag: "request-app-grant",
      access: "operate",
    });

    yield* policy.grant({ scope, target, access: "operate", duration: "persistent" });
    yield* policy.finishThread(scope.threadId);
    expect(yield* policy.evaluate(reversibleInput)).toEqual({ _tag: "allow" });
  }),
);
