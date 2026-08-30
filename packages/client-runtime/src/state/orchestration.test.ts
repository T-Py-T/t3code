import { assert, it } from "@effect/vitest";
import type { OrchestrationGetWorkflowScriptResult } from "@t3tools/contracts";

import { mergeAgentTranscriptResult } from "./orchestration.ts";

const initial = {
  scriptPath: "/tmp/child.jsonl",
  contents: "first\n",
  truncated: false,
  cursor: { offset: 6, version: "first-version" },
  reset: true,
} satisfies OrchestrationGetWorkflowScriptResult;

it("appends incremental agent transcript results", () => {
  const update = {
    scriptPath: initial.scriptPath,
    contents: "second\n",
    truncated: false,
    cursor: { offset: 13, version: "second-version" },
    reset: false,
  } satisfies OrchestrationGetWorkflowScriptResult;

  assert.deepStrictEqual(mergeAgentTranscriptResult(initial, update), {
    ...update,
    contents: "first\nsecond\n",
  });
});

it("replaces agent transcripts after resets and legacy responses", () => {
  const reset = {
    ...initial,
    contents: "replacement\n",
    cursor: { offset: 12, version: "replacement-version" },
  } satisfies OrchestrationGetWorkflowScriptResult;
  const legacy = {
    scriptPath: initial.scriptPath,
    contents: "legacy full response\n",
    truncated: false,
  } satisfies OrchestrationGetWorkflowScriptResult;

  assert.deepStrictEqual(mergeAgentTranscriptResult(initial, reset), reset);
  assert.deepStrictEqual(mergeAgentTranscriptResult(initial, legacy), legacy);
});
