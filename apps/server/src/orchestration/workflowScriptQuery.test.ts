// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { afterAll, assert, describe } from "vite-plus/test";
import { readWorkflowScript, referencedAgentArtifactPaths } from "./workflowScriptQuery.ts";

const root = NodePath.join(NodeOS.homedir(), ".claude", "projects", "__wf_script_test__");
NodeFS.mkdirSync(root, { recursive: true });
const scriptPath = NodePath.join(root, "run.js");
NodeFS.writeFileSync(scriptPath, "export const meta = {};\n");
const outside = NodePath.join(NodeOS.tmpdir(), "wf-outside.js");
NodeFS.writeFileSync(outside, "evil\n");
const link = NodePath.join(root, "sneaky.js");
const atomicWorkspace = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "atomic-workflow-view-"));
const atomicRoot = NodePath.join(atomicWorkspace, ".atomic", "workflows");
const atomicScriptPath = NodePath.join(atomicRoot, "generated-workflow.ts");
NodeFS.mkdirSync(atomicRoot, { recursive: true });
NodeFS.writeFileSync(atomicScriptPath, "export default { name: 'generated-workflow' };\n");
const ompCommandRoot = NodePath.join(atomicWorkspace, ".omp", "commands");
const ompCommandPath = NodePath.join(ompCommandRoot, "generated-workflow.md");
NodeFS.mkdirSync(ompCommandRoot, { recursive: true });
NodeFS.writeFileSync(
  ompCommandPath,
  "---\ndescription: Generated OMP workflow\n---\n\nRun the task workflow for $@.\n",
);
const ompSessionsRoot = NodePath.join(NodeOS.homedir(), ".omp", "agent", "sessions");
NodeFS.mkdirSync(ompSessionsRoot, { recursive: true });
const ompTranscriptRoot = NodeFS.mkdtempSync(
  NodePath.join(ompSessionsRoot, "__t3_transcript_test__-"),
);
const ompTranscriptPath = NodePath.join(ompTranscriptRoot, "child.jsonl");
const unrelatedOmpTranscriptPath = NodePath.join(ompTranscriptRoot, "unrelated.jsonl");
NodeFS.writeFileSync(
  ompTranscriptPath,
  `${JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "OMP_TRANSCRIPT_OK" }] } })}\n`,
);
NodeFS.writeFileSync(unrelatedOmpTranscriptPath, '{"secret":"OTHER_THREAD"}\n');
const escapedAtomicWorkspace = NodeFS.mkdtempSync(
  NodePath.join(NodeOS.tmpdir(), "atomic-workflow-escaped-view-"),
);
const escapedAtomicTarget = NodeFS.mkdtempSync(
  NodePath.join(NodeOS.tmpdir(), "atomic-workflow-escaped-target-"),
);
const escapedAtomicRoot = NodePath.join(escapedAtomicWorkspace, ".atomic", "workflows");
const escapedAtomicScript = NodePath.join(escapedAtomicTarget, "escaped-workflow.ts");
NodeFS.mkdirSync(NodePath.dirname(escapedAtomicRoot), { recursive: true });
NodeFS.writeFileSync(escapedAtomicScript, "export default { escaped: true };\n");
NodeFS.symlinkSync(escapedAtomicTarget, escapedAtomicRoot, "dir");
try {
  NodeFS.symlinkSync(outside, link);
} catch (error) {
  // Tolerate only "already exists" from a prior run — any other failure
  // (EPERM etc.) must fail setup, or the escape test below would pass
  // vacuously on "not-found" without testing containment.
  if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
    throw error;
  }
}
if (!NodeFS.lstatSync(link).isSymbolicLink()) {
  throw new Error("test setup: sneaky.js must be a symlink");
}

afterAll(() => {
  NodeFS.rmSync(root, { recursive: true, force: true });
  NodeFS.rmSync(outside, { force: true });
  NodeFS.rmSync(atomicWorkspace, { recursive: true, force: true });
  NodeFS.rmSync(escapedAtomicWorkspace, { recursive: true, force: true });
  NodeFS.rmSync(escapedAtomicTarget, { recursive: true, force: true });
  NodeFS.rmSync(ompTranscriptRoot, { recursive: true, force: true });
});

describe("readWorkflowScript containment", () => {
  effectIt.effect("derives the artifact allowlist from persisted thread activities", () =>
    Effect.sync(() => {
      assert.deepEqual(
        referencedAgentArtifactPaths([
          { payload: { outputFile: ompTranscriptPath } },
          { payload: { runHandles: { scriptPath: ompCommandPath } } },
          { payload: { outputFile: ompTranscriptPath } },
          { payload: { unrelated: "/tmp/not-an-artifact" } },
        ]),
        [ompTranscriptPath, ompCommandPath],
      );
    }),
  );

  effectIt.effect("serves a real script under the projects root", () =>
    Effect.gen(function* () {
      const result = yield* readWorkflowScript({
        scriptPath,
        allowedArtifactPaths: [scriptPath],
      });
      assert.include(result.contents, "export const meta");
      assert.equal(result.truncated, false);
    }),
  );

  effectIt.effect("serves a TypeScript workflow from the thread's Atomic directory", () =>
    Effect.gen(function* () {
      const result = yield* readWorkflowScript({
        scriptPath: atomicScriptPath,
        workspaceRoot: atomicWorkspace,
        allowedArtifactPaths: [atomicScriptPath],
      });
      assert.include(result.contents, "generated-workflow");
      assert.equal(result.truncated, false);
    }),
  );

  effectIt.effect("serves an Oh My Pi child transcript from the contained session root", () =>
    Effect.gen(function* () {
      const result = yield* readWorkflowScript({
        scriptPath: ompTranscriptPath,
        allowedArtifactPaths: [ompTranscriptPath],
      });
      assert.include(result.contents, "OMP_TRANSCRIPT_OK");
      assert.equal(result.truncated, false);
    }),
  );

  effectIt.effect("serves a generated OMP workflow command from the thread workspace", () =>
    Effect.gen(function* () {
      const result = yield* readWorkflowScript({
        scriptPath: ompCommandPath,
        workspaceRoot: atomicWorkspace,
        allowedArtifactPaths: [ompCommandPath],
      });
      assert.include(result.contents, "Generated OMP workflow");
      assert.equal(result.truncated, false);
    }),
  );

  effectIt.effect("rejects a contained OMP transcript not referenced by the thread", () =>
    Effect.gen(function* () {
      const result = yield* readWorkflowScript({
        scriptPath: unrelatedOmpTranscriptPath,
        allowedArtifactPaths: [ompTranscriptPath],
      }).pipe(
        Effect.flip,
        Effect.map((error) => error.reason),
      );
      assert.equal(result, "outside-root");
    }),
  );

  effectIt.effect("rejects relative and non-js paths", () =>
    Effect.gen(function* () {
      const relative = yield* Effect.exit(
        readWorkflowScript({ scriptPath: "run.js", allowedArtifactPaths: [scriptPath] }),
      );
      assert.equal(relative._tag, "Failure");
      const nonJs = yield* Effect.exit(
        readWorkflowScript({
          scriptPath: scriptPath.replace(".js", ".txt"),
          allowedArtifactPaths: [scriptPath.replace(".js", ".txt")],
        }),
      );
      assert.equal(nonJs._tag, "Failure");
    }),
  );

  effectIt.effect("rejects paths outside the root and symlink escapes", () =>
    Effect.gen(function* () {
      const escaped = yield* Effect.exit(
        readWorkflowScript({ scriptPath: outside, allowedArtifactPaths: [outside] }),
      );
      assert.equal(escaped._tag, "Failure");
      // A symlink INSIDE the root pointing outside must fail specifically on
      // realpath re-containment — a "not-found" would mean the link was
      // never exercised and the assertion proves nothing.
      const sneaky = yield* Effect.exit(
        readWorkflowScript({ scriptPath: link, allowedArtifactPaths: [link] }).pipe(
          Effect.flip,
          Effect.map((error) => error.reason),
        ),
      );
      assert.equal(sneaky._tag, "Success");
      if (sneaky._tag === "Success") {
        assert.equal(sneaky.value, "outside-root");
      }
    }),
  );

  effectIt.effect("rejects an Atomic workflow root symlinked outside its workspace", () =>
    Effect.gen(function* () {
      const escaped = yield* readWorkflowScript({
        scriptPath: escapedAtomicScript,
        workspaceRoot: escapedAtomicWorkspace,
        allowedArtifactPaths: [escapedAtomicScript],
      }).pipe(
        Effect.flip,
        Effect.map((error) => error.reason),
      );
      assert.equal(escaped, "outside-root");
    }),
  );
});
