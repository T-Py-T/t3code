import {
  ComputerUseInvalidRequestError,
  ComputerUseTurnUnavailableError,
  type ComputerUseActionBatch,
  type ComputerUseActionRisk,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as McpServer from "effect/unstable/ai/McpServer";

import type { ComputerUseInvocationScope } from "../../../computerUse/ComputerUseBroker.ts";
import * as ComputerUseToolkit from "../../../computerUse/ComputerUseToolkit.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { ComputerToolkit } from "./tools.ts";

/**
 * Primitive UI actions cannot prove the semantic effect of the control they
 * touch. The server therefore assigns the conservative floor. Provider input
 * may disclose a higher semantic risk, but it can never lower that floor.
 */
export function classifyComputerUseBatch(
  batch: ComputerUseActionBatch,
  declaredRisk?: ComputerUseActionRisk,
): ComputerUseActionRisk {
  let serverFloor: ComputerUseActionRisk = "reversible-local";
  for (const action of batch.actions) {
    switch (action._tag) {
      case "move":
      case "scroll":
      case "selection":
      case "wait":
      case "screenshot-refresh":
        break;
      case "click":
      case "double-click":
      case "secondary-click":
      case "drag":
      case "text-entry":
      case "paste":
      case "keypress":
      case "direct-value":
      case "accessibility-action":
        serverFloor = "external-side-effect";
        break;
    }
  }

  if (declaredRisk === undefined) return serverFloor;
  const riskRank: Record<ComputerUseActionRisk, number> = {
    inspect: 0,
    "reversible-local": 1,
    "external-side-effect": 2,
    "sensitive-data": 3,
    "destructive-or-privileged": 4,
    forbidden: 5,
  };
  return riskRank[declaredRisk] > riskRank[serverFloor] ? declaredRisk : serverFloor;
}

type ComputerUseMcpScope = ComputerUseInvocationScope & {
  readonly runtimeMode: import("@t3tools/contracts").RuntimeMode;
};

export const requireComputerUseScope: Effect.Effect<
  ComputerUseMcpScope,
  | import("@t3tools/contracts").ComputerUseCapabilityUnavailableError
  | ComputerUseTurnUnavailableError,
  McpInvocationContext.McpInvocationContext
> = Effect.gen(function* () {
  const invocation = yield* McpInvocationContext.requireMcpCapability("computer");
  if (invocation.turnId === undefined) {
    return yield* new ComputerUseTurnUnavailableError({
      environmentId: invocation.environmentId,
      threadId: invocation.threadId,
      providerSessionId: invocation.providerSessionId,
      providerInstanceId: invocation.providerInstanceId,
    });
  }
  return {
    environmentId: invocation.environmentId,
    threadId: invocation.threadId,
    turnId: invocation.turnId,
    providerSessionId: invocation.providerSessionId,
    providerInstanceId: invocation.providerInstanceId,
    ...(invocation.workflowRunId === undefined ? {} : { workflowRunId: invocation.workflowRunId }),
    ...(invocation.workflowStageId === undefined
      ? {}
      : { workflowStageId: invocation.workflowStageId }),
    runtimeMode: invocation.runtimeMode ?? "full-access",
  };
});

const AppGrantApproval = Schema.Struct({
  approval: Schema.Literals(["once", "turn", "session", "always"]),
});
const ActionConfirmation = Schema.Struct({ approval: Schema.Literal("approve") });

export const resolvePolicyBoundary = Effect.fn("ComputerToolkit.resolvePolicyBoundary")(function* <
  A,
  E,
  R,
>(
  toolkit: ComputerUseToolkit.ComputerUseToolkit["Service"],
  run: Effect.Effect<ComputerUseToolkit.ComputerUseToolkitOutcome<A>, E, R>,
) {
  const capabilities = yield* McpServer.clientCapabilities;
  let outcome = yield* run;
  while (outcome._tag === "policy" && outcome.approvalId !== undefined) {
    if (capabilities.elicitation === undefined) return outcome;
    const decision = outcome.decision;
    if (decision._tag !== "request-app-grant" && decision._tag !== "request-action-confirmation") {
      return outcome;
    }
    const approvalId = outcome.approvalId;
    const response = yield* (
      decision._tag === "request-app-grant"
        ? McpServer.elicit({
            message: `Allow T3 Computer Use to ${decision.access === "observe" ? "observe" : "operate"} ${outcome.target.displayName}?`,
            schema: AppGrantApproval,
          }).pipe(
            Effect.map(({ approval }) =>
              approval === "always"
                ? ("acceptAlways" as const)
                : approval === "session"
                  ? ("acceptForSession" as const)
                  : approval === "turn"
                    ? ("acceptForTurn" as const)
                    : ("accept" as const),
            ),
          )
        : McpServer.elicit({
            message: `Confirm T3 Computer Use: ${outcome.action?.summary ?? "the requested action"} in ${outcome.target.displayName}.`,
            schema: ActionConfirmation,
          }).pipe(Effect.as("accept" as const))
    ).pipe(
      Effect.catchTag("ElicitationDeclined", () => Effect.succeed("decline" as const)),
      Effect.onInterrupt(() => toolkit.resolveApproval(approvalId, "cancel").pipe(Effect.asVoid)),
    );
    yield* toolkit.resolveApproval(approvalId, response);
    if (response === "decline") return outcome;
    outcome = yield* run;
  }
  return outcome;
});

const resolveTarget = Effect.fn("ComputerToolkit.resolveTarget")(function* (
  toolkit: ComputerUseToolkit.ComputerUseToolkit["Service"],
  scope: ComputerUseMcpScope,
  targetId: import("@t3tools/contracts").ComputerUseTargetId,
  operation: "observe" | "act",
) {
  const listed = yield* toolkit.listTargets({ scope });
  const target = listed.targets.find((candidate) => candidate.targetId === targetId);
  if (target !== undefined) return target;
  return yield* new ComputerUseInvalidRequestError({ operation, ...scope });
});

const handlers = {
  computer_status: () =>
    Effect.gen(function* () {
      const scope = yield* requireComputerUseScope;
      const toolkit = yield* ComputerUseToolkit.ComputerUseToolkit;
      return yield* toolkit.status({ scope });
    }),
  computer_list_targets: (input) =>
    Effect.gen(function* () {
      const scope = yield* requireComputerUseScope;
      const toolkit = yield* ComputerUseToolkit.ComputerUseToolkit;
      return yield* toolkit.listTargets({ scope, ...(input.kind ? { kind: input.kind } : {}) });
    }),
  computer_observe: (input) =>
    Effect.gen(function* () {
      const scope = yield* requireComputerUseScope;
      const toolkit = yield* ComputerUseToolkit.ComputerUseToolkit;
      const target = yield* resolveTarget(toolkit, scope, input.targetId, "observe");
      const outcome = yield* resolvePolicyBoundary(
        toolkit,
        toolkit.observe({
          scope,
          target,
          runtimeMode: scope.runtimeMode,
          ...(input.includeScreenshot === undefined
            ? {}
            : { includeScreenshot: input.includeScreenshot }),
          ...(input.includeAccessibility === undefined
            ? {}
            : { includeAccessibility: input.includeAccessibility }),
        }),
      );
      return outcome._tag === "success" ? outcome.value : outcome;
    }),
  computer_act: (input) =>
    Effect.gen(function* () {
      const scope = yield* requireComputerUseScope;
      const toolkit = yield* ComputerUseToolkit.ComputerUseToolkit;
      const target = yield* resolveTarget(toolkit, scope, input.targetId, "act");
      const batch = { actions: input.actions };
      const outcome = yield* resolvePolicyBoundary(
        toolkit,
        toolkit.act({
          scope,
          target,
          observationId: input.observationId,
          batch,
          risk: classifyComputerUseBatch(batch, input.risk),
          runtimeMode: scope.runtimeMode,
        }),
      );
      return outcome._tag === "success" ? outcome.value : outcome;
    }),
  computer_stop: () =>
    Effect.gen(function* () {
      const scope = yield* requireComputerUseScope;
      const toolkit = yield* ComputerUseToolkit.ComputerUseToolkit;
      yield* toolkit.stop({ scope, reason: "interrupted" });
      return {};
    }),
} satisfies Parameters<typeof ComputerToolkit.toLayer>[0];

export const ComputerToolkitHandlersLive = ComputerToolkit.toLayer(handlers);
