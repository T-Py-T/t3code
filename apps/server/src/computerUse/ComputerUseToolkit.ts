import {
  ComputerUseActResult,
  ComputerUseHostStatus,
  ComputerUseNoAvailableHostError,
  ComputerUseObservation,
  ComputerUseStatus,
  ComputerUseTargetList,
  type ComputerUseActionBatch,
  type ComputerUseActionRisk,
  type ComputerUseApprovalId,
  type ComputerUseBrokerError,
  type ComputerUseObservationId,
  type ComputerUsePolicyDecision,
  type ComputerUseStatus as ComputerUseStatusValue,
  type ComputerUseTarget,
  type ComputerUseTargetKind,
  type ComputerUseTargetList as ComputerUseTargetListValue,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  ComputerUseBroker,
  type ComputerUseInvocationScope,
  type ComputerUseStopInput,
} from "./ComputerUseBroker.ts";
import { ComputerUsePolicy } from "./ComputerUsePolicy.ts";

export interface ComputerUsePolicyBoundary {
  readonly _tag: "policy";
  readonly approvalId?: ComputerUseApprovalId;
  readonly decision: ComputerUsePolicyDecision;
  readonly target: ComputerUseTarget;
  readonly risk: ComputerUseActionRisk;
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
  }
>()("t3/computerUse/ComputerUseToolkit") {}

const targetIdentityMatches = (expected: ComputerUseTarget, actual: ComputerUseTarget): boolean =>
  expected.targetId === actual.targetId &&
  expected.applicationId === actual.applicationId &&
  expected.stableIdentity === actual.stableIdentity;

export const make = Effect.gen(function* ComputerUseToolkitMake() {
  const broker = yield* ComputerUseBroker;
  const policy = yield* ComputerUsePolicy;

  const requireHost = Effect.fn("ComputerUseToolkit.requireHost")(function* (
    scope: ComputerUseInvocationScope,
    operation: "status" | "listTargets" | "observe" | "act",
  ) {
    const available = yield* broker.hostFor(scope.environmentId);
    if (Option.isSome(available)) return available.value;
    return yield* new ComputerUseNoAvailableHostError({ operation, ...scope });
  });

  const status: ComputerUseToolkit["Service"]["status"] = Effect.fn("ComputerUseToolkit.status")(
    function* ({ scope }) {
      const host = yield* requireHost(scope, "status");
      const hostStatus = yield* broker.invoke(
        { scope, operation: "status", input: {} },
        ComputerUseHostStatus,
      );
      return ComputerUseStatus.make({ host, status: hostStatus });
    },
  );

  const listTargets: ComputerUseToolkit["Service"]["listTargets"] = Effect.fn(
    "ComputerUseToolkit.listTargets",
  )(function* ({ scope, kind }) {
    yield* requireHost(scope, "listTargets");
    return yield* broker.invoke(
      {
        scope,
        operation: "listTargets",
        input: kind === undefined ? {} : { kind },
      },
      ComputerUseTargetList,
    );
  });

  const observe: ComputerUseToolkit["Service"]["observe"] = Effect.fn("ComputerUseToolkit.observe")(
    function* (input) {
      const host = yield* requireHost(input.scope, "observe");
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
        return {
          _tag: "policy",
          ...(approvalId === undefined ? {} : { approvalId }),
          decision,
          target: input.target,
          risk: "inspect",
        } as const;
      }
      const value = yield* broker.invoke(
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
      );
      if (!targetIdentityMatches(input.target, value.target)) {
        return {
          _tag: "policy",
          decision: { _tag: "deny", reason: "identity-changed" },
          target: input.target,
          risk: "inspect",
        } as const;
      }
      return { _tag: "success", value } as const;
    },
  );

  const act: ComputerUseToolkit["Service"]["act"] = Effect.fn("ComputerUseToolkit.act")(
    function* (input) {
      const host = yield* requireHost(input.scope, "act");
      const decision = yield* policy.evaluate({
        scope: { ...input.scope, hostId: host.hostId },
        target: input.target,
        access: "operate",
        risk: input.risk,
        runtimeMode: input.runtimeMode,
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
                },
                decision,
              })
            : undefined;
        return {
          _tag: "policy",
          ...(approvalId === undefined ? {} : { approvalId }),
          decision,
          target: input.target,
          risk: input.risk,
        } as const;
      }
      const resultSchema = ComputerUseActResult.check(
        Schema.makeFilter(
          (result) =>
            result.completedActions <= input.batch.actions.length ||
            "completedActions cannot exceed the submitted action count.",
        ),
      );
      const value = yield* broker.invoke(
        {
          scope: input.scope,
          operation: "act",
          targetId: input.target.targetId,
          observationId: input.observationId,
          input: input.batch,
        },
        resultSchema,
      );
      if (!targetIdentityMatches(input.target, value.observation.target)) {
        return {
          _tag: "policy",
          decision: { _tag: "deny", reason: "identity-changed" },
          target: input.target,
          risk: input.risk,
        } as const;
      }
      return { _tag: "success", value } as const;
    },
  );

  return ComputerUseToolkit.of({ status, listTargets, observe, act, stop: broker.stop });
});

export const layer = Layer.effect(ComputerUseToolkit, make);
