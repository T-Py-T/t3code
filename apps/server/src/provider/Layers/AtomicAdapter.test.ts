// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import {
  ApprovalRequestId,
  AtomicSettings,
  ProviderDriverKind,
  ThreadId,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { assert, describe } from "vite-plus/test";

import { ServerConfig } from "../../config.ts";
import { makeAtomicAdapter } from "./AtomicAdapter.ts";

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockPeer = NodePath.join(__dirname, "../testFixtures/piRpcMockPeer.mjs");
const decodeAtomicSettings = Schema.decodeSync(AtomicSettings);

function writeMockWrapper(): string {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "atomic-adapter-test-"));
  const wrapper = NodePath.join(dir, "mock-atomic.sh");
  NodeFS.writeFileSync(
    wrapper,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(mockPeer)} "$@"\n`,
    "utf8",
  );
  NodeFS.chmodSync(wrapper, 0o755);
  return wrapper;
}

function makeAdapter(options?: { readonly requestTimeout?: Duration.Input }) {
  return makeAtomicAdapter(
    decodeAtomicSettings({ enabled: true, binaryPath: writeMockWrapper() }),
    options,
  ).pipe(
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "atomic-adapter-test-" }).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  );
}

describe("AtomicAdapter", () => {
  it.live("keeps the Pi-derived process alive and completes only after agent_settled", () =>
    Effect.gen(function* () {
      const adapter = yield* makeAdapter();
      const threadId = ThreadId.make("atomic-chat-lifecycle");
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.takeUntil((event) => event.type === "turn.completed"),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("atomic"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId, input: "Reply with PI_RPC_OK", attachments: [] });

      const events = Array.from(yield* Fiber.join(eventsFiber));
      const assistantStarts = events.filter(
        (event) => event.type === "item.started" && event.payload.itemType === "assistant_message",
      );
      assert.lengthOf(
        assistantStarts,
        2,
        "user messages must not become assistant messages, but queued assistant runs must remain visible",
      );
      assert.include(
        events
          .filter((event) => event.type === "content.delta")
          .map((event) => (event.type === "content.delta" ? event.payload.delta : "")),
        "Check the shared Pi event stream.",
      );
      assert.include(
        events
          .filter((event) => event.type === "content.delta")
          .map((event) => (event.type === "content.delta" ? event.payload.delta : "")),
        "PI_RPC_OK",
      );
      assert.include(
        events
          .filter((event) => event.type === "content.delta")
          .map((event) => (event.type === "content.delta" ? event.payload.delta : "")),
        "QUEUED_FOLLOW_UP",
      );
      const toolUpdate = events.find(
        (event) => event.type === "item.updated" && event.payload.itemType === "dynamic_tool_call",
      );
      assert.equal(
        toolUpdate?.type === "item.updated" ? toolUpdate.payload.detail : undefined,
        "partial tool output",
      );
      const usage = events.find((event) => event.type === "thread.token-usage.updated");
      assert.deepInclude(usage?.type === "thread.token-usage.updated" ? usage.payload.usage : {}, {
        usedTokens: 1500,
        totalProcessedTokens: 1900,
        maxTokens: 200000,
        toolUses: 1,
      });
      assert.equal(events.at(-1)?.type, "turn.completed");
    }).pipe(Effect.scoped),
  );

  it.live(
    "renders slash-command feedback and keeps background workflow events after the turn",
    () =>
      Effect.gen(function* () {
        const adapter = yield* makeAdapter();
        const threadId = ThreadId.make("atomic-workflow-lifecycle");
        const cwd = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "atomic-workflow-cwd-"));
        const workflowDir = NodePath.join(cwd, ".atomic", "workflows");
        NodeFS.mkdirSync(workflowDir, { recursive: true });
        const scriptPath = NodePath.join(workflowDir, "classify-and-act.ts");
        NodeFS.writeFileSync(scriptPath, "export default {};\n", "utf8");
        const eventsFiber = yield* adapter.streamEvents.pipe(
          Stream.takeUntil(
            (event) => event.type === "task.completed" && event.payload.taskId === "workflow-run-1",
          ),
          Stream.runCollect,
          Effect.forkChild,
        );

        yield* adapter.startSession({
          threadId,
          provider: ProviderDriverKind.make("atomic"),
          cwd,
          runtimeMode: "full-access",
        });
        yield* adapter.sendTurn({ threadId, input: "/workflow list", attachments: [] });

        const events = Array.from(yield* Fiber.join(eventsFiber));
        assert.isDefined(events.find((event) => event.type === "turn.completed"));
        assert.isDefined(
          events.find(
            (event) =>
              event.type === "content.delta" &&
              event.payload.delta.includes("Workflow classify-and-act started"),
          ),
        );
        const workflowStarted = events.find(
          (event) => event.type === "task.started" && event.payload.taskId === "workflow-run-1",
        );
        assert.lengthOf(
          events.filter(
            (event) => event.type === "task.started" && event.payload.taskId === "workflow-run-1",
          ),
          1,
          "the same lifecycle notice can arrive on both Pi event surfaces",
        );
        assert.equal(
          workflowStarted?.type === "task.started" ? workflowStarted.payload.taskType : undefined,
          "local_workflow",
        );
        assert.equal(
          workflowStarted?.type === "task.started"
            ? workflowStarted.payload.runHandles?.runId
            : undefined,
          "workflow-run-1",
        );
        assert.equal(
          workflowStarted?.type === "task.started"
            ? workflowStarted.payload.runHandles?.scriptPath
            : undefined,
          scriptPath,
        );
        const stageStarted = events.find(
          (event) =>
            event.type === "task.started" && event.payload.taskId === "workflow-run-1:wf:classify",
        );
        assert.equal(
          stageStarted?.type === "task.started" ? stageStarted.payload.parentAgentId : undefined,
          "workflow-run-1",
        );
        assert.equal(
          stageStarted?.type === "task.started" ? stageStarted.payload.phaseIndex : undefined,
          0,
        );
        assert.equal(
          stageStarted?.type === "task.started" ? stageStarted.payload.phaseTitle : undefined,
          "Stage 1",
        );
        assert.equal(
          stageStarted?.type === "task.started" ? stageStarted.payload.timelineBypass : undefined,
          true,
        );
        assert.isDefined(
          events.find(
            (event) =>
              event.type === "task.completed" &&
              event.payload.taskId === "workflow-run-1:wf:classify" &&
              event.payload.parentAgentId === "workflow-run-1" &&
              event.payload.phaseIndex === 0,
          ),
        );
        const parallelStage = events.find(
          (event) =>
            event.type === "task.started" && event.payload.taskId === "workflow-run-1:wf:inspect",
        );
        assert.isDefined(parallelStage, "Atomic stage identity must survive the adapter");
        assert.equal(
          parallelStage?.type === "task.started" ? parallelStage.payload.phaseIndex : undefined,
          0,
          "independent roots belong to the same workflow layer",
        );
        const dependentStage = events.find(
          (event) =>
            event.type === "task.started" &&
            event.payload.taskId === "workflow-run-1:wf:synthesize",
        );
        assert.deepEqual(
          dependentStage?.type === "task.started"
            ? (dependentStage.payload as unknown as Record<string, unknown>).dependsOnTaskIds
            : undefined,
          ["workflow-run-1:wf:classify", "workflow-run-1:wf:inspect"],
        );
        assert.equal(
          dependentStage?.type === "task.started" ? dependentStage.payload.phaseIndex : undefined,
          1,
        );
        const awaitingInput = events.find(
          (event) =>
            event.type === "task.progress" &&
            event.payload.taskId === "workflow-run-1:wf:approve" &&
            event.payload.status === "waiting",
        );
        assert.equal(
          awaitingInput?.type === "task.progress" ? awaitingInput.payload.summary : undefined,
          "Approve the synthesized result?",
        );
        const completed = events.find(
          (event) => event.type === "task.completed" && event.payload.taskId === "workflow-run-1",
        );
        assert.lengthOf(
          events.filter(
            (event) => event.type === "task.completed" && event.payload.taskId === "workflow-run-1",
          ),
          1,
        );
        assert.equal(
          completed?.type === "task.completed" ? completed.payload.summary : undefined,
          "WORKFLOW_OK",
        );
      }).pipe(Effect.scoped),
  );

  it.live("treats an extension load failure as recoverable when Pi keeps running", () =>
    Effect.gen(function* () {
      const adapter = yield* makeAdapter();
      const threadId = ThreadId.make("atomic-recoverable-extension-error");
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.takeUntil((event) => event.type === "turn.completed"),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("atomic"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId,
        input: "/t3-recoverable-extension-error",
        attachments: [],
      });

      const events = Array.from(yield* Fiber.join(eventsFiber));
      assert.isUndefined(events.find((event) => event.type === "runtime.error"));
      assert.isDefined(events.find((event) => event.type === "runtime.warning"));
      assert.isDefined(
        events.find(
          (event) =>
            event.type === "content.delta" &&
            event.payload.delta === "RECOVERED_AFTER_EXTENSION_ERROR",
        ),
      );
      assert.equal(events.at(-1)?.type, "turn.completed");
    }).pipe(Effect.scoped),
  );

  it.live("fails a turn when the final Pi assistant outcome is an error", () =>
    Effect.gen(function* () {
      const adapter = yield* makeAdapter();
      const threadId = ThreadId.make("atomic-terminal-assistant-error");
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.takeUntil((event) => event.type === "turn.completed"),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("atomic"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId,
        input: "/t3-terminal-assistant-error",
        attachments: [],
      });

      const events = Array.from(yield* Fiber.join(eventsFiber));
      assert.equal(
        events.find((event) => event.type === "runtime.error")?.payload.message,
        "The model request failed permanently.",
      );
      const completed = events.at(-1);
      assert.equal(completed?.type, "turn.completed");
      assert.equal(
        completed?.type === "turn.completed" ? completed.payload.state : undefined,
        "failed",
      );
    }).pipe(Effect.scoped),
  );

  it.live("keeps an interactive prompt alive beyond the ordinary RPC deadline", () =>
    Effect.gen(function* () {
      const adapter = yield* makeAdapter({ requestTimeout: Duration.millis(30) });
      const threadId = ThreadId.make("atomic-long-lived-ui-request");
      const requestFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.type === "user-input.requested"),
        Stream.runHead,
        Effect.forkChild,
      );
      const completedFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.type === "turn.completed"),
        Stream.runHead,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("atomic"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      const sendFiber = yield* adapter
        .sendTurn({ threadId, input: "/t3-ui-wait", attachments: [] })
        .pipe(Effect.forkChild);
      const requested = yield* Fiber.join(requestFiber).pipe(Effect.map(Option.getOrThrow));
      if (requested.type !== "user-input.requested") {
        return assert.fail("Expected an Atomic user-input request.");
      }
      assert.equal(
        requested.payload.questions[0]?.question,
        "Edit this value before the workflow continues.",
      );
      assert.equal(requested.payload.questions[0]?.defaultValue, "ORIGINAL_WORKFLOW_VALUE");

      // Deliberately cross the ordinary command deadline before the user answers.
      yield* Effect.sleep(Duration.millis(80));
      yield* adapter.respondToUserInput(threadId, ApprovalRequestId.make(requested.requestId), {
        "ui-editor-1:answer": "EDITED_WORKFLOW_VALUE",
      });
      yield* Fiber.join(sendFiber);
      const completed = yield* Fiber.join(completedFiber).pipe(Effect.map(Option.getOrThrow));
      assert.equal(completed.type, "turn.completed");
    }).pipe(Effect.scoped),
  );
});
