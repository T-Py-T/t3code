import {
  ComputerUseActResult,
  ComputerUseHostStatus,
  ComputerUseNoAvailableHostError,
  ComputerUseObservation,
  ComputerUseStatus,
  ComputerUseTargetList,
  ComputerUseRequestIdentity,
  type ComputerUseActionBatch,
  type ComputerUseActionDescriptor,
  type ComputerUseAccessLevel,
  type ComputerUseActionRisk,
  type ComputerUseApprovalId,
  type ComputerUseBrokerError,
  type ComputerUseObservationId,
  type ComputerUseHistoryOperation,
  type ComputerUseHostId,
  type ComputerUsePolicyDecision,
  type ProviderApprovalDecision,
  type ComputerUseStatus as ComputerUseStatusValue,
  type ComputerUseTarget,
  type ComputerUseTargetKind,
  type ComputerUseTargetList as ComputerUseTargetListValue,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  ComputerUseBroker,
  type ComputerUseInvocationScope,
  type ComputerUseStopInput,
} from "./ComputerUseBroker.ts";
import { ComputerUseControl } from "./ComputerUseControl.ts";
import { ComputerUsePolicy } from "./ComputerUsePolicy.ts";
import { ComputerUseHistory } from "./ComputerUseHistory.ts";

const encodeUnknownJsonString = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

export interface ComputerUsePolicyBoundary {
  readonly _tag: "policy";
  readonly approvalId?: ComputerUseApprovalId;
  readonly decision: ComputerUsePolicyDecision;
  readonly target: ComputerUseTarget;
  readonly risk: ComputerUseActionRisk;
  readonly action?: ComputerUseActionDescriptor;
}

export type ComputerUseToolkitOutcome<A> =
  | { readonly _tag: "success"; readonly value: A }
  | ComputerUsePolicyBoundary;

export interface ComputerUseStatusInput {
  readonly scope: ComputerUseInvocationScope;
}

export interface ComputerUseListTargetsInput {
  readonly scope: ComputerUseInvocationScope;
  readonly kind?: ComputerUseTargetKind;
}

export interface ComputerUseObserveInput {
  readonly scope: ComputerUseInvocationScope;
  readonly target: ComputerUseTarget;
  readonly runtimeMode: RuntimeMode;
  readonly includeScreenshot?: boolean;
  readonly includeAccessibility?: boolean;
}

export interface ComputerUseActInput {
  readonly scope: ComputerUseInvocationScope;
  readonly target: ComputerUseTarget;
  readonly observationId: ComputerUseObservationId;
  readonly batch: ComputerUseActionBatch;
  readonly risk: ComputerUseActionRisk;
  readonly runtimeMode: RuntimeMode;
}

export interface ComputerUseGovernedInput {
  readonly scope: ComputerUseInvocationScope;
  readonly hostId: ComputerUseHostId;
  readonly operation: ComputerUseHistoryOperation;
  readonly target: ComputerUseTarget;
  readonly access: ComputerUseAccessLevel;
  readonly risk: ComputerUseActionRisk;
  readonly runtimeMode: RuntimeMode;
  readonly action?: ComputerUseActionDescriptor;
  readonly requestedSummary: string;
  readonly activeSummary: string;
  readonly completedSummary: string;
}

export class ComputerUseToolkit extends Context.Service<
  ComputerUseToolkit,
  {
    readonly status: (
      input: ComputerUseStatusInput,
    ) => Effect.Effect<ComputerUseStatusValue, ComputerUseBrokerError>;
    readonly listTargets: (
      input: ComputerUseListTargetsInput,
    ) => Effect.Effect<ComputerUseTargetListValue, ComputerUseBrokerError>;
    readonly observe: (
      input: ComputerUseObserveInput,
    ) => Effect.Effect<ComputerUseToolkitOutcome<ComputerUseObservation>, ComputerUseBrokerError>;
    readonly act: (
      input: ComputerUseActInput,
    ) => Effect.Effect<ComputerUseToolkitOutcome<ComputerUseActResult>, ComputerUseBrokerError>;
    readonly stop: (input: ComputerUseStopInput) => Effect.Effect<void>;
    readonly resolveApproval: (
      approvalId: ComputerUseApprovalId,
      decision: ProviderApprovalDecision,
    ) => Effect.Effect<boolean>;
    readonly executeGoverned: <A, E, R>(
      input: ComputerUseGovernedInput,
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<ComputerUseToolkitOutcome<A>, E, R>;
  }
>()("t3/computerUse/ComputerUseToolkit") {}

const targetIdentityMatches = (expected: ComputerUseTarget, actual: ComputerUseTarget): boolean =>
  expected.targetId === actual.targetId &&
  expected.applicationId === actual.applicationId &&
  expected.stableIdentity === actual.stableIdentity;

const historyStateForBrokerError = (
  error: ComputerUseBrokerError,
): "failed" | "paused" | "stopped" | "taken-over" => {
  if (error._tag !== "ComputerUseStoppedError") return "failed";
  if (error.reason === "interrupted") return "paused";
  if (error.reason === "takeover") return "taken-over";
  return "stopped";
};

const describeActionBatch = (batch: ComputerUseActionBatch): string =>
  batch.actions
    .map((action) => {
      switch (action._tag) {
        case "click":
          return `Click at (${action.x}, ${action.y})`;
        case "double-click":
          return `Double-click at (${action.x}, ${action.y})`;
        case "secondary-click":
          return `Secondary-click at (${action.x}, ${action.y})`;
        case "move":
          return `Move the pointer to (${action.x}, ${action.y})`;
        case "drag":
          return `Drag from (${action.from.x}, ${action.from.y}) to (${action.to.x}, ${action.to.y})`;
        case "scroll":
          return `Scroll by (${action.deltaX}, ${action.deltaY})`;
        case "text-entry":
          return `Enter text (${action.text.length} characters)`;
        case "paste":
          return `Paste text (${action.text.length} characters)`;
        case "keypress":
          return action.key.length === 1 ? "Press one character key" : "Press a named key";
        case "selection":
          return `Select characters ${action.start}-${action.end}`;
        case "direct-value":
          return `Set a value (${action.value.length} characters)`;
        case "accessibility-action":
          return "Perform an accessibility action";
        case "wait":
          return `Wait ${action.durationMs}ms`;
        case "screenshot-refresh":
          return "Refresh the screenshot";
      }
    })
    .join("; ")
    .slice(0, 512);

export const make = Effect.gen(function* ComputerUseToolkitMake() {
  const broker = yield* ComputerUseBroker;
  const control = yield* ComputerUseControl;
  const policy = yield* ComputerUsePolicy;
  const history = yield* ComputerUseHistory;
  const crypto = yield* Crypto.Crypto;

  const actionDescriptor = Effect.fn("ComputerUseToolkit.actionDescriptor")(function* (
    input: ComputerUseActInput,
  ) {
    const digest = yield* crypto
      .digest(
        "SHA-256",
        new TextEncoder().encode(
          encodeUnknownJsonString({
            target: input.target.stableIdentity,
            observationId: input.observationId,
            actions: input.batch.actions,
          }),
        ),
      )
      .pipe(Effect.orDie);
    return {
      requestIdentity: ComputerUseRequestIdentity.make(Encoding.encodeHex(digest)),
      summary: describeActionBatch(input.batch),
    } satisfies ComputerUseActionDescriptor;
  });

  const appendHistory = (
    scope: ComputerUseInvocationScope,
    input: Omit<
      Parameters<ComputerUseHistory["Service"]["append"]>[0],
      "environmentId" | "threadId" | "turnId" | "providerInstanceId"
    >,
  ) =>
    history.append({
      environmentId: scope.environmentId,
      threadId: scope.threadId,
      turnId: scope.turnId,
      providerInstanceId: scope.providerInstanceId,
      ...input,
    });

  const requireHost = Effect.fn("ComputerUseToolkit.requireHost")(function* (
    scope: ComputerUseInvocationScope,
    operation: "status" | "listTargets" | "observe" | "act",
  ) {
    const available = yield* broker.hostFor(scope.environmentId);
    if (Option.isSome(available)) return available.value;
    yield* appendHistory(scope, {
      operation,
      state: "failed",
      summary: "No verified Computer Use host was available.",
      resultTag: "no-available-host",
    });
    return yield* new ComputerUseNoAvailableHostError({ operation, ...scope });
  });

  const claimControl = Effect.fn("ComputerUseToolkit.claimControl")(function* (
    scope: ComputerUseInvocationScope,
    input: {
      readonly hostId: ComputerUseHostId;
      readonly operation: ComputerUseHistoryOperation;
      readonly target: ComputerUseTarget;
      readonly risk: ComputerUseActionRisk;
      readonly action?: ComputerUseActionDescriptor;
    },
  ) {
    const occupied = yield* control.claim(scope);
    if (occupied === undefined) return undefined;
    const decision = { _tag: "require-takeover", risk: input.risk } as const;
    yield* appendHistory(scope, {
      hostId: input.hostId,
      operation: input.operation,
      target: input.target,
      risk: input.risk,
      state: "failed",
      summary: `Computer Use is controlled by another agent turn.`,
      resultTag: decision._tag,
    });
    return {
      _tag: "policy",
      decision,
      target: input.target,
      risk: input.risk,
      ...(input.action === undefined ? {} : { action: input.action }),
    } satisfies ComputerUsePolicyBoundary;
  });

  const status: ComputerUseToolkit["Service"]["status"] = Effect.fn("ComputerUseToolkit.status")(
    function* ({ scope }) {
      const host = yield* requireHost(scope, "status");
      yield* appendHistory(scope, {
        hostId: host.hostId,
        operation: "status",
        state: "requested",
        summary: "Checked the Computer Use host status.",
      });
      const hostStatus = yield* broker
        .invoke({ scope, operation: "status", input: {} }, ComputerUseHostStatus)
        .pipe(
          Effect.tapError((error) =>
            appendHistory(scope, {
              hostId: host.hostId,
              operation: "status",
              state: "failed",
              summary: "Computer Use host status could not be read.",
              resultTag: error._tag,
            }),
          ),
        );
      yield* appendHistory(scope, {
        hostId: host.hostId,
        operation: "status",
        state: "completed",
        summary: "Computer Use host status is available.",
        resultTag: "success",
      });
      return ComputerUseStatus.make({ host, status: hostStatus });
    },
  );

  const listTargets: ComputerUseToolkit["Service"]["listTargets"] = Effect.fn(
    "ComputerUseToolkit.listTargets",
  )(function* ({ scope, kind }) {
    const host = yield* requireHost(scope, "listTargets");
    yield* appendHistory(scope, {
      hostId: host.hostId,
      operation: "listTargets",
      state: "requested",
      summary: kind ? `Looked for ${kind} targets.` : "Looked for available application targets.",
    });
    const result = yield* broker
      .invoke(
        {
          scope,
          operation: "listTargets",
          input: kind === undefined ? {} : { kind },
        },
        ComputerUseTargetList,
      )
      .pipe(
        Effect.tapError((error) =>
          appendHistory(scope, {
            hostId: host.hostId,
            operation: "listTargets",
            state: "failed",
            summary: "Available Computer Use targets could not be listed.",
            resultTag: error._tag,
          }),
        ),
      );
    yield* appendHistory(scope, {
      hostId: host.hostId,
      operation: "listTargets",
      state: "completed",
      summary: `Found ${result.targets.length} available target${result.targets.length === 1 ? "" : "s"}.`,
      resultTag: "success",
    });
    return result;
  });

  const observe: ComputerUseToolkit["Service"]["observe"] = Effect.fn("ComputerUseToolkit.observe")(
    function* (input) {
      const host = yield* requireHost(input.scope, "observe");
      yield* appendHistory(input.scope, {
        hostId: host.hostId,
        operation: "observe",
        target: input.target,
        risk: "inspect",
        state: "requested",
        summary: `Requested observation of ${input.target.displayName}.`,
      });
      const decision = yield* policy.evaluate({
        scope: { ...input.scope, hostId: host.hostId },
        target: input.target,
        access: "observe",
        risk: "inspect",
        runtimeMode: input.runtimeMode,
      });
      if (decision._tag !== "allow") {
        const approvalId =
          decision._tag === "request-app-grant"
            ? yield* policy.requestApproval({
                input: {
                  scope: { ...input.scope, hostId: host.hostId },
                  target: input.target,
                  access: "observe",
                  risk: "inspect",
                  runtimeMode: input.runtimeMode,
                },
                decision,
              })
            : undefined;
        const paused = decision._tag === "deny" && decision.reason === "paused";
        yield* appendHistory(input.scope, {
          hostId: host.hostId,
          operation: "observe",
          target: input.target,
          risk: "inspect",
          state:
            decision._tag === "request-app-grant"
              ? "waiting-approval"
              : paused
                ? "paused"
                : "failed",
          summary:
            decision._tag === "request-app-grant"
              ? `Waiting for permission to observe ${input.target.displayName}.`
              : paused
                ? `Computer Use is paused before observing ${input.target.displayName}.`
                : `Observation of ${input.target.displayName} was blocked by policy.`,
          resultTag: decision._tag,
        });
        return {
          _tag: "policy",
          ...(approvalId === undefined ? {} : { approvalId }),
          decision,
          target: input.target,
          risk: "inspect",
        } as const;
      }
      const occupied = yield* claimControl(input.scope, {
        hostId: host.hostId,
        operation: "observe",
        target: input.target,
        risk: "inspect",
      });
      if (occupied !== undefined) return occupied;
      yield* appendHistory(input.scope, {
        hostId: host.hostId,
        operation: "observe",
        target: input.target,
        risk: "inspect",
        state: "observing",
        summary: `Observing ${input.target.displayName}.`,
      });
      const value = yield* broker
        .invoke(
          {
            scope: input.scope,
            operation: "observe",
            targetId: input.target.targetId,
            input: {
              ...(input.includeScreenshot === undefined
                ? {}
                : { includeScreenshot: input.includeScreenshot }),
              ...(input.includeAccessibility === undefined
                ? {}
                : { includeAccessibility: input.includeAccessibility }),
            },
          },
          ComputerUseObservation,
        )
        .pipe(
          Effect.tapError((error) =>
            appendHistory(input.scope, {
              hostId: host.hostId,
              operation: "observe",
              target: input.target,
              risk: "inspect",
              state: historyStateForBrokerError(error),
              summary: `Observation of ${input.target.displayName} failed.`,
              resultTag: error._tag,
            }),
          ),
        );
      if (!targetIdentityMatches(input.target, value.target)) {
        yield* appendHistory(input.scope, {
          hostId: host.hostId,
          operation: "observe",
          target: input.target,
          risk: "inspect",
          state: "failed",
          summary: `${input.target.displayName} changed identity before observation completed.`,
          resultTag: "identity-changed",
        });
        return {
          _tag: "policy",
          decision: { _tag: "deny", reason: "identity-changed" },
          target: input.target,
          risk: "inspect",
        } as const;
      }
      yield* appendHistory(input.scope, {
        hostId: host.hostId,
        operation: "observe",
        target: input.target,
        risk: "inspect",
        state: "completed",
        summary: `Observed ${input.target.displayName}.`,
        resultTag: "success",
      });
      return { _tag: "success", value } as const;
    },
  );

  const executeGoverned: ComputerUseToolkit["Service"]["executeGoverned"] = Effect.fn(
    "ComputerUseToolkit.executeGoverned",
  )(function* (input, effect) {
    yield* appendHistory(input.scope, {
      hostId: input.hostId,
      operation: input.operation,
      target: input.target,
      risk: input.risk,
      state: "requested",
      summary: input.requestedSummary,
    });
    const decision = yield* policy.evaluate({
      scope: { ...input.scope, hostId: input.hostId },
      target: input.target,
      access: input.access,
      risk: input.risk,
      runtimeMode: input.runtimeMode,
      ...(input.action === undefined ? {} : { action: input.action }),
    });
    if (decision._tag !== "allow") {
      const approvalId =
        decision._tag === "request-app-grant" || decision._tag === "request-action-confirmation"
          ? yield* policy.requestApproval({
              input: {
                scope: { ...input.scope, hostId: input.hostId },
                target: input.target,
                access: input.access,
                risk: input.risk,
                runtimeMode: input.runtimeMode,
                ...(input.action === undefined ? {} : { action: input.action }),
              },
              decision,
            })
          : undefined;
      const waiting =
        decision._tag === "request-app-grant" || decision._tag === "request-action-confirmation";
      const paused = decision._tag === "deny" && decision.reason === "paused";
      yield* appendHistory(input.scope, {
        hostId: input.hostId,
        operation: input.operation,
        target: input.target,
        risk: input.risk,
        state: waiting ? "waiting-approval" : paused ? "paused" : "failed",
        summary: waiting
          ? `Waiting for approval: ${input.action?.summary ?? input.requestedSummary}`
          : input.requestedSummary,
        resultTag: decision._tag,
      });
      return {
        _tag: "policy",
        ...(approvalId === undefined ? {} : { approvalId }),
        decision,
        target: input.target,
        risk: input.risk,
        ...(input.action === undefined ? {} : { action: input.action }),
      } as const;
    }
    const occupied = yield* claimControl(input.scope, {
      hostId: input.hostId,
      operation: input.operation,
      target: input.target,
      risk: input.risk,
      ...(input.action === undefined ? {} : { action: input.action }),
    });
    if (occupied !== undefined) return occupied;
    yield* appendHistory(input.scope, {
      hostId: input.hostId,
      operation: input.operation,
      target: input.target,
      risk: input.risk,
      state: input.access === "observe" ? "observing" : "acting",
      summary: input.activeSummary,
    });
    const value = yield* effect.pipe(
      Effect.tapError((error) =>
        appendHistory(input.scope, {
          hostId: input.hostId,
          operation: input.operation,
          target: input.target,
          risk: input.risk,
          state: "failed",
          summary: input.activeSummary,
          resultTag:
            typeof error === "object" && error !== null && "_tag" in error
              ? String(error._tag)
              : "error",
        }),
      ),
    );
    yield* appendHistory(input.scope, {
      hostId: input.hostId,
      operation: input.operation,
      target: input.target,
      risk: input.risk,
      state: "completed",
      summary: input.completedSummary,
      resultTag: "success",
    });
    return { _tag: "success", value } as const;
  });

  const act: ComputerUseToolkit["Service"]["act"] = Effect.fn("ComputerUseToolkit.act")(
    function* (input) {
      const host = yield* requireHost(input.scope, "act");
      const action = yield* actionDescriptor(input);
      yield* appendHistory(input.scope, {
        hostId: host.hostId,
        operation: "act",
        target: input.target,
        risk: input.risk,
        state: "requested",
        summary: `Requested ${input.batch.actions.length} action${input.batch.actions.length === 1 ? "" : "s"} in ${input.target.displayName}.`,
      });
      const decision = yield* policy.evaluate({
        scope: { ...input.scope, hostId: host.hostId },
        target: input.target,
        access: "operate",
        risk: input.risk,
        runtimeMode: input.runtimeMode,
        action,
      });
      if (decision._tag !== "allow") {
        const approvalId =
          decision._tag === "request-app-grant" || decision._tag === "request-action-confirmation"
            ? yield* policy.requestApproval({
                input: {
                  scope: { ...input.scope, hostId: host.hostId },
                  target: input.target,
                  access: "operate",
                  risk: input.risk,
                  runtimeMode: input.runtimeMode,
                  action,
                },
                decision,
              })
            : undefined;
        const waiting =
          decision._tag === "request-app-grant" || decision._tag === "request-action-confirmation";
        const paused = decision._tag === "deny" && decision.reason === "paused";
        yield* appendHistory(input.scope, {
          hostId: host.hostId,
          operation: "act",
          target: input.target,
          risk: input.risk,
          state: waiting ? "waiting-approval" : paused ? "paused" : "failed",
          summary: waiting
            ? `Waiting for approval to act in ${input.target.displayName}.`
            : paused
              ? `Computer Use is paused before acting in ${input.target.displayName}.`
              : `Actions in ${input.target.displayName} were blocked by policy.`,
          resultTag: decision._tag,
        });
        return {
          _tag: "policy",
          ...(approvalId === undefined ? {} : { approvalId }),
          decision,
          target: input.target,
          risk: input.risk,
          action,
        } as const;
      }
      const occupied = yield* claimControl(input.scope, {
        hostId: host.hostId,
        operation: "act",
        target: input.target,
        risk: input.risk,
        action,
      });
      if (occupied !== undefined) return occupied;
      yield* appendHistory(input.scope, {
        hostId: host.hostId,
        operation: "act",
        target: input.target,
        risk: input.risk,
        state: "acting",
        summary: `Acting in ${input.target.displayName}.`,
      });
      const resultSchema = ComputerUseActResult.check(
        Schema.makeFilter(
          (result) =>
            result.completedActions <= input.batch.actions.length ||
            "completedActions cannot exceed the submitted action count.",
        ),
      );
      const value = yield* broker
        .invoke(
          {
            scope: input.scope,
            operation: "act",
            targetId: input.target.targetId,
            observationId: input.observationId,
            input: input.batch,
          },
          resultSchema,
        )
        .pipe(
          Effect.tapError((error) =>
            appendHistory(input.scope, {
              hostId: host.hostId,
              operation: "act",
              target: input.target,
              risk: input.risk,
              state: historyStateForBrokerError(error),
              summary: `Actions in ${input.target.displayName} failed.`,
              resultTag: error._tag,
            }),
          ),
        );
      if (!targetIdentityMatches(input.target, value.observation.target)) {
        yield* appendHistory(input.scope, {
          hostId: host.hostId,
          operation: "act",
          target: input.target,
          risk: input.risk,
          state: "failed",
          summary: `${input.target.displayName} changed identity before the action completed.`,
          resultTag: "identity-changed",
        });
        return {
          _tag: "policy",
          decision: { _tag: "deny", reason: "identity-changed" },
          target: input.target,
          risk: input.risk,
        } as const;
      }
      yield* appendHistory(input.scope, {
        hostId: host.hostId,
        operation: "act",
        target: input.target,
        risk: input.risk,
        state: "completed",
        summary: `Completed ${value.completedActions} action${value.completedActions === 1 ? "" : "s"} in ${input.target.displayName}.`,
        resultTag: "success",
      });
      return { _tag: "success", value } as const;
    },
  );

  return ComputerUseToolkit.of({
    status,
    listTargets,
    observe,
    act,
    stop: (input) => broker.stop(input).pipe(Effect.ensuring(control.release(input.scope))),
    resolveApproval: (approvalId, decision) => policy.resolveApproval({ approvalId, decision }),
    executeGoverned,
  });
});

export const layer = Layer.effect(ComputerUseToolkit, make);
