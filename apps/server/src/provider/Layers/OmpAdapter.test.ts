// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import {
  ApprovalRequestId,
  OmpSettings,
  ProviderDriverKind,
  RuntimeTaskId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { assert, describe } from "vite-plus/test";

import { ServerConfig } from "../../config.ts";
import { makeOmpAdapter } from "./OmpAdapter.ts";

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockPeer = NodePath.join(__dirname, "../testFixtures/ompAdapterRpcMockPeer.mjs");
const decodeOmpSettings = Schema.decodeSync(OmpSettings);

function writeMockWrapper(
  capturePath?: string,
  expectedSessionTitle?: string,
  expectedResumePath?: string,
  failSubagents = false,
): string {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "omp-adapter-test-"));
  const wrapper = NodePath.join(dir, "mock-omp.sh");
  NodeFS.writeFileSync(
    wrapper,
    `#!/bin/sh
${capturePath ? `printf '%s\n' "$@" > ${JSON.stringify(capturePath)}\n` : ""}
${expectedSessionTitle ? `export OMP_EXPECT_SESSION_TITLE=${JSON.stringify(expectedSessionTitle)}\n` : ""}
${expectedResumePath ? `export OMP_EXPECT_RESUME_PATH=${JSON.stringify(expectedResumePath)}\n` : ""}
${failSubagents ? "export OMP_FAIL_SUBAGENTS=1\n" : ""}
exec ${JSON.stringify(process.execPath)} ${JSON.stringify(mockPeer)} "$@"
`,
    "utf8",
  );
  NodeFS.chmodSync(wrapper, 0o755);
  return wrapper;
}

function makeAdapter(binaryPath: string) {
  return makeOmpAdapter(decodeOmpSettings({ enabled: true, binaryPath })).pipe(
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "omp-adapter-test-" }).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  );
}

describe("OmpAdapter", () => {
  it.live("launches untrusted sessions with RPC v2 and governed approval flags", () =>
    Effect.gen(function* () {
      const capturePath = NodePath.join(
        NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "omp-launch-capture-")),
        "args.txt",
      );
      const expectedSessionTitle = "Named OMP thread";
      const adapter = yield* makeAdapter(writeMockWrapper(capturePath, expectedSessionTitle));
      const threadId = ThreadId.make("omp-approval-launch");

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("omp"),
        cwd: process.cwd(),
        runtimeMode: "approval-required",
        title: expectedSessionTitle,
      });

      const args = NodeFS.readFileSync(capturePath, "utf8").trim().split("\n");
      assert.include(args, "--mode");
      assert.include(args, "rpc");
      assert.include(args, "--no-extensions");
      assert.notInclude(args, "--name");
      const approvalFlag = args.indexOf("--approval-mode");
      assert.isAtLeast(approvalFlag, 0);
      assert.equal(args[approvalFlag + 1], "always-ask");
    }).pipe(Effect.scoped),
  );

  it.live("switches to a resumed session before naming it and restoring active children", () =>
    Effect.gen(function* () {
      const expectedSessionTitle = "Resumed OMP thread";
      const expectedResumePath = "/tmp/resumed-omp-session.jsonl";
      const adapter = yield* makeAdapter(
        writeMockWrapper(undefined, expectedSessionTitle, expectedResumePath),
      );
      const threadId = ThreadId.make("omp-resume-order");
      const restoredChildFiber = yield* adapter.streamEvents.pipe(
        Stream.filter(
          (event) => event.type === "task.started" && event.payload.taskId === "omp-resumed-child",
        ),
        Stream.runHead,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("omp"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        title: expectedSessionTitle,
        resumeCursor: { schemaVersion: 1, sessionFile: expectedResumePath },
      });
      const restoredChild = yield* Fiber.join(restoredChildFiber).pipe(
        Effect.map(Option.getOrThrow),
      );

      assert.deepInclude(session.resumeCursor as Record<string, unknown>, {
        sessionFile: expectedResumePath,
      });
      assert.equal(restoredChild.type, "task.started");
      if (restoredChild.type === "task.started") {
        assert.deepInclude(restoredChild.payload, {
          taskId: RuntimeTaskId.make("omp-resumed-child"),
          taskType: "omp_subagent",
          role: "researcher",
          model: "openai-codex/gpt-5.6-sol:high",
        });
      }
    }).pipe(Effect.scoped),
  );

  it.live("removes the provider session when post-launch restoration fails", () =>
    Effect.gen(function* () {
      const adapter = yield* makeAdapter(writeMockWrapper(undefined, undefined, undefined, true));
      const threadId = ThreadId.make("omp-failed-restoration");

      const result = yield* adapter
        .startSession({
          threadId,
          provider: ProviderDriverKind.make("omp"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
        })
        .pipe(Effect.result);

      assert.equal(result._tag, "Failure");
      assert.equal(yield* adapter.hasSession(threadId), false);
    }).pipe(Effect.scoped),
  );

  it.live("waits for detached subagents and the resumed parent terminal cycle", () =>
    Effect.gen(function* () {
      const adapter = yield* makeAdapter(writeMockWrapper());
      const threadId = ThreadId.make("omp-detached-settlement");
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.takeUntil((event) => event.type === "turn.completed"),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("omp"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId, input: "Run the detached test", attachments: [] });

      const events = Array.from(yield* Fiber.join(eventsFiber));
      const taskStartedIndex = events.findIndex(
        (event) => event.type === "task.started" && event.payload.taskId === "omp-child-1",
      );
      const childTranscriptIndex = events.findIndex(
        (event) =>
          event.type === "task.progress" && event.payload.summary === "CHILD_TRANSCRIPT_VISIBLE",
      );
      const taskCompletedIndex = events.findIndex(
        (event) => event.type === "task.completed" && event.payload.taskId === "omp-child-1",
      );
      const resumedParentIndex = events.findIndex(
        (event) =>
          event.type === "content.delta" && event.payload.delta === "PARENT_RESUMED_AFTER_CHILD",
      );
      const turnCompletedIndex = events.findIndex((event) => event.type === "turn.completed");
      const workflowStartedIndex = events.findIndex(
        (event) => event.type === "task.started" && event.payload.taskType === "local_workflow",
      );
      const workflowTaskId =
        workflowStartedIndex >= 0 && events[workflowStartedIndex]?.type === "task.started"
          ? events[workflowStartedIndex].payload.taskId
          : undefined;
      const workflowCompletedIndex = events.findIndex(
        (event) => event.type === "task.completed" && event.payload.taskId === workflowTaskId,
      );
      const generatedWorkflowCode = events.find(
        (event) =>
          event.type === "item.completed" &&
          event.payload.itemType === "dynamic_tool_call" &&
          JSON.stringify(event.payload.data).includes("detached-validation.md"),
      );
      const compactionStartedIndex = events.findIndex(
        (event) => event.type === "item.started" && event.payload.itemType === "context_compaction",
      );
      const compactionCompletedIndex = events.findIndex(
        (event) =>
          event.type === "item.completed" && event.payload.itemType === "context_compaction",
      );

      assert.isAtLeast(taskStartedIndex, 0);
      assert.isAbove(childTranscriptIndex, taskStartedIndex);
      assert.isAbove(taskCompletedIndex, childTranscriptIndex);
      assert.isAbove(resumedParentIndex, taskCompletedIndex);
      assert.isAbove(turnCompletedIndex, resumedParentIndex);
      assert.isAtLeast(workflowStartedIndex, 0);
      assert.isAbove(workflowCompletedIndex, workflowStartedIndex);
      assert.isBelow(workflowCompletedIndex, turnCompletedIndex);
      assert.isDefined(generatedWorkflowCode);
      assert.isDefined(
        events.find(
          (event) =>
            (event.type === "task.progress" || event.type === "task.completed") &&
            event.payload.taskId === workflowTaskId &&
            event.payload.runHandles?.scriptPath ===
              NodePath.join(process.cwd(), ".omp", "commands", "detached-validation.md"),
        ),
      );
      assert.isAtLeast(compactionStartedIndex, 0);
      assert.isAbove(compactionCompletedIndex, compactionStartedIndex);
      const started = events[taskStartedIndex];
      assert.deepInclude(started?.type === "task.started" ? started.payload : {}, {
        taskType: "omp_subagent",
        role: "researcher",
        outputFile: "/tmp/omp-child-1/session.jsonl",
        timelineBypass: true,
      });
      const progress = events.find(
        (event) => event.type === "task.progress" && event.payload.taskId === "omp-child-1",
      );
      assert.deepInclude(progress?.type === "task.progress" ? progress.payload : {}, {
        typedUsage: { totalTokens: 123, toolUses: 1, durationMs: 25 },
      });
    }).pipe(Effect.scoped),
  );

  it.live("shows local slash-command output and completes without an agent run", () =>
    Effect.gen(function* () {
      const adapter = yield* makeAdapter(writeMockWrapper());
      const threadId = ThreadId.make("omp-local-command");
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.takeUntil((event) => event.type === "turn.completed"),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("omp"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId, input: "/computer status", attachments: [] });

      const events = Array.from(yield* Fiber.join(eventsFiber));
      assert.include(
        events.flatMap((event) => (event.type === "content.delta" ? [event.payload.delta] : [])),
        "OMP_COMPUTER_STATUS_OK",
      );
      assert.equal(events.at(-1)?.type, "turn.completed");
    }).pipe(Effect.scoped),
  );

  it.live("surfaces OMP extension approvals and resumes after the answer", () =>
    Effect.gen(function* () {
      const adapter = yield* makeAdapter(writeMockWrapper());
      const threadId = ThreadId.make("omp-extension-approval");
      const requestedFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.type === "user-input.requested"),
        Stream.runHead,
        Effect.forkChild,
      );
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.takeUntil((event) => event.type === "turn.completed"),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("omp"),
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      const sendFiber = yield* adapter
        .sendTurn({ threadId, input: "/approval-test", attachments: [] })
        .pipe(Effect.forkChild);

      const requested = yield* Fiber.join(requestedFiber).pipe(Effect.map(Option.getOrThrow));
      if (requested.type !== "user-input.requested" || requested.requestId === undefined) {
        return assert.fail("Expected an OMP approval request.");
      }
      const questionId = requested.payload.questions[0]?.id;
      assert.isString(questionId);
      assert.equal(requested.payload.questions[0]?.question, "Continue the OMP action?");

      yield* adapter.respondToUserInput(threadId, ApprovalRequestId.make(requested.requestId), {
        [questionId!]: "Yes",
      });
      yield* Fiber.join(sendFiber);

      const events = Array.from(yield* Fiber.join(eventsFiber));
      assert.include(
        events.flatMap((event) => (event.type === "content.delta" ? [event.payload.delta] : [])),
        "OMP_APPROVAL_ACCEPTED",
      );
      assert.isDefined(
        events.find(
          (event) =>
            event.type === "user-input.resolved" && event.requestId === requested.requestId,
        ),
      );
      assert.equal(events.at(-1)?.type, "turn.completed");
    }).pipe(Effect.scoped),
  );

  it.live("steers a running OMP turn without opening a second turn", () =>
    Effect.gen(function* () {
      const adapter = yield* makeAdapter(writeMockWrapper());
      const threadId = ThreadId.make("omp-steering");
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.takeUntil((event) => event.type === "turn.completed"),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("omp"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      const first = yield* adapter.sendTurn({
        threadId,
        input: "/steer-test",
        attachments: [],
      });
      const steered = yield* adapter.sendTurn({
        threadId,
        input: "Please change direction",
        attachments: [],
      });

      const events = Array.from(yield* Fiber.join(eventsFiber));
      assert.equal(steered.turnId, first.turnId);
      assert.lengthOf(
        events.filter((event) => event.type === "turn.started"),
        1,
      );
      assert.include(
        events.flatMap((event) => (event.type === "content.delta" ? [event.payload.delta] : [])),
        "OMP_STEERED_OK",
      );
    }).pipe(Effect.scoped),
  );

  it.live("queues an explicit OMP follow-up on the active turn", () =>
    Effect.gen(function* () {
      const adapter = yield* makeAdapter(writeMockWrapper());
      const threadId = ThreadId.make("omp-follow-up");
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.takeUntil((event) => event.type === "turn.completed"),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("omp"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      const first = yield* adapter.sendTurn({
        threadId,
        input: "/steer-test",
        attachments: [],
      });
      const followedUp = yield* adapter.sendTurn({
        threadId,
        input: "/follow-up Continue after this turn",
        attachments: [],
      });

      const events = Array.from(yield* Fiber.join(eventsFiber));
      assert.equal(followedUp.turnId, first.turnId);
      assert.include(
        events.flatMap((event) => (event.type === "content.delta" ? [event.payload.delta] : [])),
        "OMP_FOLLOW_UP_OK",
      );
    }).pipe(Effect.scoped),
  );

  it.live("interrupts an active OMP turn and settles it as interrupted", () =>
    Effect.gen(function* () {
      const adapter = yield* makeAdapter(writeMockWrapper());
      const threadId = ThreadId.make("omp-interrupt");
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.takeUntil((event) => event.type === "turn.completed"),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("omp"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId, input: "/interrupt-test", attachments: [] });
      yield* adapter.interruptTurn(threadId);

      const events = Array.from(yield* Fiber.join(eventsFiber));
      const terminal = events.findLast((event) => event.type === "turn.completed");
      assert.deepInclude(terminal?.type === "turn.completed" ? terminal.payload : {}, {
        state: "interrupted",
        stopReason: "interrupted",
      });
    }).pipe(Effect.scoped),
  );

  it.live("settles projected OMP workflows and children when interrupted", () =>
    Effect.gen(function* () {
      const adapter = yield* makeAdapter(writeMockWrapper());
      const threadId = ThreadId.make("omp-interrupt-workflow");
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.takeUntil((event) => event.type === "turn.completed"),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("omp"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId,
        input: "/interrupt-workflow-test",
        attachments: [],
      });
      yield* adapter.interruptTurn(threadId);

      const events = Array.from(yield* Fiber.join(eventsFiber));
      const stoppedTaskIds = events.flatMap((event) =>
        event.type === "task.completed" && event.payload.status === "stopped"
          ? [event.payload.taskId]
          : [],
      );
      const workflowTaskId = events
        .flatMap((event) =>
          event.type === "task.started" && event.payload.taskType === "local_workflow"
            ? [event.payload.taskId]
            : [],
        )
        .at(0);
      const workflowChildTaskId = events
        .flatMap((event) =>
          event.type === "task.started" && event.payload.taskType === "local_agent"
            ? [event.payload.taskId]
            : [],
        )
        .at(0);
      assert.include(stoppedTaskIds, RuntimeTaskId.make("omp-interrupt-child"));
      assert.isDefined(workflowTaskId);
      assert.isDefined(workflowChildTaskId);
      assert.include(stoppedTaskIds, workflowTaskId);
      assert.include(stoppedTaskIds, workflowChildTaskId);
      assert.deepInclude(
        events.findLast((event) => event.type === "turn.completed")?.payload ?? {},
        { state: "interrupted", stopReason: "interrupted" },
      );
    }).pipe(Effect.scoped),
  );

  it.live("creates a distinct workflow run for a later OMP todo plan", () =>
    Effect.gen(function* () {
      const adapter = yield* makeAdapter(writeMockWrapper());
      const threadId = ThreadId.make("omp-consecutive-plans");
      let completedTurns = 0;
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.takeUntil((event) => {
          if (event.type === "turn.completed") completedTurns += 1;
          return completedTurns === 2;
        }),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("omp"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      const firstCompleted = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.type === "turn.completed"),
        Stream.runHead,
        Effect.forkChild,
      );
      yield* adapter.sendTurn({ threadId, input: "/first-plan", attachments: [] });
      yield* Fiber.join(firstCompleted);
      yield* adapter.sendTurn({ threadId, input: "/second-plan", attachments: [] });

      const events = Array.from(yield* Fiber.join(eventsFiber));
      const workflowStartIds = events.flatMap((event) =>
        event.type === "task.started" && event.payload.taskType === "local_workflow"
          ? [event.payload.taskId]
          : [],
      );
      const workflowCompletionIds = events.flatMap((event) =>
        event.type === "task.completed" && event.payload.taskType === "local_workflow"
          ? [event.payload.taskId]
          : [],
      );

      assert.lengthOf(workflowStartIds, 2);
      assert.notEqual(workflowStartIds[0], workflowStartIds[1]);
      assert.deepEqual(workflowCompletionIds, workflowStartIds);
    }).pipe(Effect.scoped),
  );

  it.live("keeps workflow identities distinct after the provider session restarts", () =>
    Effect.gen(function* () {
      const adapter = yield* makeAdapter(writeMockWrapper());
      const threadId = ThreadId.make("omp-restarted-plan");
      const workflowStartsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter(
          (event) => event.type === "task.started" && event.payload.taskType === "local_workflow",
        ),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild,
      );

      const runPlan = () =>
        Effect.gen(function* () {
          const completedFiber = yield* adapter.streamEvents.pipe(
            Stream.filter((event) => event.type === "turn.completed"),
            Stream.runHead,
            Effect.forkChild,
          );
          yield* adapter.startSession({
            threadId,
            provider: ProviderDriverKind.make("omp"),
            cwd: process.cwd(),
            runtimeMode: "full-access",
          });
          yield* adapter.sendTurn({ threadId, input: "/first-plan", attachments: [] });
          yield* Fiber.join(completedFiber);
        });

      yield* runPlan();
      yield* adapter.stopSession(threadId);
      yield* runPlan();

      const workflowStarts = Array.from(yield* Fiber.join(workflowStartsFiber));
      const workflowStartIds = workflowStarts.flatMap((event) =>
        event.type === "task.started" ? [event.payload.taskId] : [],
      );
      assert.lengthOf(workflowStartIds, 2);
      assert.notEqual(workflowStartIds[0], workflowStartIds[1]);
    }).pipe(Effect.scoped),
  );

  it.live("settles workflow tasks removed from an OMP todo plan", () =>
    Effect.gen(function* () {
      const adapter = yield* makeAdapter(writeMockWrapper());
      const threadId = ThreadId.make("omp-removed-plan-task");
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.takeUntil((event) => event.type === "turn.completed"),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("omp"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId, input: "/removed-plan", attachments: [] });

      const events = Array.from(yield* Fiber.join(eventsFiber));
      const rootTaskId = events
        .flatMap((event) =>
          event.type === "task.started" && event.payload.taskType === "local_workflow"
            ? [event.payload.taskId]
            : [],
        )
        .at(0);
      const taskId = events
        .flatMap((event) =>
          event.type === "task.started" && event.payload.taskType === "local_agent"
            ? [event.payload.taskId]
            : [],
        )
        .at(0);
      assert.isDefined(rootTaskId);
      assert.isDefined(taskId);
      assert.isDefined(
        events.find((event) => event.type === "task.started" && event.payload.taskId === taskId),
      );
      assert.deepInclude(
        events.find((event) => event.type === "task.completed" && event.payload.taskId === taskId)
          ?.payload ?? {},
        { taskId, status: "stopped" },
      );
      assert.deepInclude(
        events.find(
          (event) => event.type === "task.completed" && event.payload.taskId === rootTaskId,
        )?.payload ?? {},
        { taskId: rootTaskId, status: "stopped" },
      );
    }).pipe(Effect.scoped),
  );
});
