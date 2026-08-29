import {
  ORCHESTRATION_WS_METHODS,
  type OrchestrationGetWorkflowScriptInput,
  type OrchestrationGetWorkflowScriptResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Atom } from "effect/unstable/reactivity";

import { request } from "../rpc/client.ts";
import {
  createEnvironmentQueryAtomFamily,
  createEnvironmentRpcQueryAtomFamily,
} from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";

export function mergeAgentTranscriptResult(
  previous: OrchestrationGetWorkflowScriptResult | undefined,
  update: OrchestrationGetWorkflowScriptResult,
): OrchestrationGetWorkflowScriptResult {
  if (previous?.cursor === undefined || update.cursor === undefined || update.reset !== false) {
    return update;
  }
  return {
    ...update,
    contents: previous.contents + update.contents,
  };
}

export function createOrchestrationEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    turnDiff: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:turn-diff",
      tag: ORCHESTRATION_WS_METHODS.getTurnDiff,
    }),
    workflowScript: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:workflow-script",
      tag: ORCHESTRATION_WS_METHODS.getWorkflowScript,
      // Scripts are immutable per run: cache generously.
      staleTimeMs: 300_000,
      idleTtlMs: 300_000,
    }),
    agentTranscript: createEnvironmentQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:agent-transcript",
      execute: (
        input: OrchestrationGetWorkflowScriptInput,
        previous: OrchestrationGetWorkflowScriptResult | undefined,
      ) =>
        request(ORCHESTRATION_WS_METHODS.getWorkflowScript, {
          ...input,
          ...(previous?.cursor === undefined ? {} : { cursor: previous.cursor }),
        }).pipe(Effect.map((update) => mergeAgentTranscriptResult(previous, update))),
      staleTimeMs: 1_000,
      idleTtlMs: 30_000,
      refreshIntervalMs: 2_000,
    }),
    fullThreadDiff: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:full-thread-diff",
      tag: ORCHESTRATION_WS_METHODS.getFullThreadDiff,
    }),
    threadSearch: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:thread-search",
      tag: ORCHESTRATION_WS_METHODS.searchThreads,
      staleTimeMs: 30_000,
      idleTtlMs: 60_000,
    }),
    archivedShellSnapshot: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:archived-shell-snapshot",
      tag: ORCHESTRATION_WS_METHODS.getArchivedShellSnapshot,
    }),
  };
}
