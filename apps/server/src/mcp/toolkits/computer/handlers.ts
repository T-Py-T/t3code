import {
  ComputerUseInvalidRequestError,
  ComputerUseTurnUnavailableError,
  type ComputerUseActionBatch,
  type ComputerUseActionRisk,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { ComputerUseInvocationScope } from "../../../computerUse/ComputerUseBroker.ts";
import * as ComputerUseToolkit from "../../../computerUse/ComputerUseToolkit.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { ComputerToolkit } from "./tools.ts";

/**
 * Primitive UI actions cannot prove the semantic effect of the control they
 * touch. The server therefore assigns the conservative floor; provider input
 * never supplies or lowers its own risk classification.
 */
export function classifyComputerUseBatch(batch: ComputerUseActionBatch): ComputerUseActionRisk {
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
        return "external-side-effect";
    }
  }
  return "reversible-local";
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
    runtimeMode: invocation.runtimeMode ?? "full-access",
  };
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
      const outcome = yield* toolkit.observe({
        scope,
        target,
        runtimeMode: scope.runtimeMode,
        ...(input.includeScreenshot === undefined
          ? {}
          : { includeScreenshot: input.includeScreenshot }),
        ...(input.includeAccessibility === undefined
          ? {}
          : { includeAccessibility: input.includeAccessibility }),
      });
      return outcome._tag === "success" ? outcome.value : outcome;
    }),
  computer_act: (input) =>
    Effect.gen(function* () {
      const scope = yield* requireComputerUseScope;
      const toolkit = yield* ComputerUseToolkit.ComputerUseToolkit;
      const target = yield* resolveTarget(toolkit, scope, input.targetId, "act");
      const batch = { actions: input.actions };
      const outcome = yield* toolkit.act({
        scope,
        target,
        observationId: input.observationId,
        batch,
        risk: classifyComputerUseBatch(batch),
        runtimeMode: scope.runtimeMode,
      });
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
