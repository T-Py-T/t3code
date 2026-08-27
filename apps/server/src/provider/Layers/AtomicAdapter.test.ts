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
  ComputerUseHostId,
  ComputerUseTargetId,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
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
import * as ComputerUsePolicy from "../../computerUse/ComputerUsePolicy.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import { makeAtomicAdapter, sanitizePiComputerUseEvent } from "./AtomicAdapter.ts";

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

function writeCapturingMockWrapper(capturePath: string): string {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "atomic-adapter-mcp-test-"));
  const wrapper = NodePath.join(dir, "mock-atomic.sh");
  NodeFS.writeFileSync(
    wrapper,
    `#!/bin/sh\nprintf '%s\\n' "$T3CODE_MCP_ENDPOINT" "$T3CODE_MCP_AUTHORIZATION" > ${JSON.stringify(capturePath)}\nprintf '%s\\n' "$@" >> ${JSON.stringify(capturePath)}\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(mockPeer)} "$@"\n`,
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
  it("removes screenshots from persisted Pi/Atomic tool events", () => {
    const sanitized = sanitizePiComputerUseEvent({
      type: "tool_execution_end",
      toolName: "computer_observe",
      args: { targetId: "target-1" },
      result: {
        content: [{ type: "image", mimeType: "image/png", data: "SCREENSHOT_SENTINEL" }],
        details: {
          observationId: "observation-1",
          screenshot: { mimeType: "image/png", base64: "SCREENSHOT_SENTINEL" },
        },
      },
    });

    assert.notInclude(JSON.stringify(sanitized), "SCREENSHOT_SENTINEL");
    assert.equal(sanitized.toolName, "computer_observe");
    assert.deepEqual(sanitized.args, { targetId: "target-1" });
    assert.equal(
      (sanitized.result as { details?: { observationId?: string } }).details?.observationId,
      "observation-1",
    );
  });

  it.live("attaches the private T3 Computer Use extension to Pi-compatible sessions", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("atomic-computer-use-extension");
      const capturePath = NodePath.join(
        NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "atomic-adapter-mcp-capture-")),
        "launch.txt",
      );
      const binaryPath = writeCapturingMockWrapper(capturePath);
      McpProviderSession.setMcpProviderSession({
        environmentId: EnvironmentId.make("environment-1"),
        threadId,
        providerSessionId: "provider-session-1",
        providerInstanceId: ProviderInstanceId.make("atomic"),
        endpoint: "http://127.0.0.1:43123/mcp",
        authorizationHeader: "Bearer test-session-token",
      });

      const adapter = yield* makeAtomicAdapter(
        decodeAtomicSettings({ enabled: true, binaryPath }),
      ).pipe(
        Effect.provide(
          ServerConfig.layerTest(process.cwd(), { prefix: "atomic-adapter-mcp-test-" }).pipe(
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      );

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("atomic"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      const launch = NodeFS.readFileSync(capturePath, "utf8").trim().split("\n");
      assert.equal(launch[0], "http://127.0.0.1:43123/mcp");
      assert.equal(launch[1], "Bearer test-session-token");
      const extensionFlag = launch.indexOf("--extension");
      assert.isAtLeast(extensionFlag, 2);
      const extensionPath = launch[extensionFlag + 1];
      assert.isString(extensionPath);
      assert.isTrue(NodeFS.existsSync(extensionPath!));
      assert.include(NodeFS.readFileSync(extensionPath!, "utf8"), "computer_status");

      yield* adapter.stopSession(threadId);
      assert.isFalse(NodeFS.existsSync(extensionPath!));
      McpProviderSession.clearMcpProviderSession(threadId);
    }).pipe(Effect.scoped),
  );

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
        assert.isDefined(
          events.find(
            (event) =>
              event.type === "task.progress" &&
              event.payload.taskId === "workflow-run-1" &&
              event.payload.status === "waiting" &&
              event.payload.summary === "Provide workflow inputs.",
          ),
        );
        const resumedStage = events.find(
          (event) =>
            event.type === "task.updated" &&
            event.payload.taskId === "workflow-run-1:wf:approve" &&
            event.payload.status === "running",
        );
        assert.equal(
          resumedStage?.type === "task.updated" ? resumedStage.payload.role : undefined,
          "workflow stage",
        );
        const completedStage = events.find(
          (event) =>
            event.type === "task.completed" && event.payload.taskId === "workflow-run-1:wf:approve",
        );
        assert.equal(
          completedStage?.type === "task.completed" ? completedStage.payload.role : undefined,
          "workflow stage",
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
      if (requested.requestId === undefined) {
        return assert.fail("Expected the Atomic user-input request to have an id.");
      }

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

  it.live("projects T3 Computer Use access as an approval and resumes only after acceptance", () =>
    Effect.gen(function* () {
      const policy = yield* ComputerUsePolicy.ComputerUsePolicy;
      const policyInput: ComputerUsePolicy.ComputerUsePolicyInput = {
        scope: {
          environmentId: EnvironmentId.make("environment-computer-approval"),
          hostId: ComputerUseHostId.make("host-computer-approval"),
          threadId: ThreadId.make("atomic-computer-approval"),
          turnId: TurnId.make("turn-computer-approval"),
          providerSessionId: "provider-session-computer-approval",
          providerInstanceId: ProviderInstanceId.make("atomic"),
        },
        target: {
          targetId: ComputerUseTargetId.make("target-textedit"),
          kind: "application",
          displayName: "TextEdit",
          applicationId: "com.apple.TextEdit",
          stableIdentity: "macos:com.apple.TextEdit:APPLE",
        },
        access: "observe",
        risk: "inspect",
        runtimeMode: "full-access",
      };
      const approvalId = yield* policy.requestApproval({
        input: policyInput,
        decision: { _tag: "request-app-grant", access: "observe" },
      });
      assert.equal(approvalId, "computer-use-approval-0");

      const adapter = yield* makeAdapter();
      const threadId = policyInput.scope.threadId;
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.takeUntil((event) => event.type === "turn.completed"),
        Stream.runCollect,
        Effect.forkChild,
      );
      const requestedFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.type === "request.opened"),
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
        .sendTurn({ threadId, input: "/t3-computer-approval", attachments: [] })
        .pipe(Effect.forkChild);
      const requested = yield* Fiber.join(requestedFiber).pipe(Effect.map(Option.getOrThrow));
      assert.equal(requested.type, "request.opened");
      if (requested.type !== "request.opened" || requested.requestId === undefined) {
        return assert.fail("Expected a Computer Use approval request.");
      }
      assert.equal(requested.payload.requestType, "mcp_elicitation_approval");
      assert.equal(requested.payload.appName, "TextEdit");
      assert.deepEqual(requested.payload.options, [
        { decision: "accept", label: "Allow once" },
        { decision: "acceptForSession", label: "Allow for this session" },
        { decision: "acceptAlways", label: "Always allow on this computer" },
        { decision: "decline", label: "Deny" },
      ]);

      yield* adapter.respondToRequest(
        threadId,
        ApprovalRequestId.make(requested.requestId),
        "accept",
      );
      yield* Fiber.join(sendFiber);
      const events = Array.from(yield* Fiber.join(eventsFiber));
      assert.isDefined(
        events.find(
          (event) => event.type === "request.resolved" && event.payload.decision === "accept",
        ),
      );
      assert.deepEqual(yield* policy.evaluate(policyInput), { _tag: "allow" });
    }).pipe(
      Effect.scoped,
      Effect.provide(
        ComputerUsePolicy.layer.pipe(
          Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "computer-policy-test-" })),
          Layer.provide(NodeServices.layer),
        ),
      ),
    ),
  );

  it.live("stops a session while its prompt request is awaiting user input", () =>
    Effect.gen(function* () {
      const adapter = yield* makeAdapter();
      const threadId = ThreadId.make("atomic-stop-awaiting-input");
      const requestedFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.type === "user-input.requested"),
        Stream.runHead,
        Effect.forkChild,
      );
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.takeUntil((event) => event.type === "session.exited"),
        Stream.runCollect,
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
      yield* Fiber.join(requestedFiber).pipe(Effect.map(Option.getOrThrow));

      yield* adapter.stopSession(threadId);

      const sendResult = yield* Fiber.join(sendFiber).pipe(Effect.result);
      const events = Array.from(yield* Fiber.join(eventsFiber));
      assert.equal(sendResult._tag, "Failure");
      assert.isFalse(yield* adapter.hasSession(threadId));
      assert.isDefined(
        events.find(
          (event) => event.type === "turn.completed" && event.payload.state === "interrupted",
        ),
      );
      assert.isDefined(events.find((event) => event.type === "user-input.resolved"));
      assert.equal(events.at(-1)?.type, "session.exited");
    }).pipe(Effect.scoped),
  );

  it.live("fails and retires a session when the prompt request is rejected", () =>
    Effect.gen(function* () {
      const adapter = yield* makeAdapter();
      const threadId = ThreadId.make("atomic-prompt-rejected");
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
      const result = yield* adapter
        .sendTurn({ threadId, input: "/t3-prompt-rejected", attachments: [] })
        .pipe(Effect.result);

      const events = Array.from(yield* Fiber.join(eventsFiber));
      assert.equal(result._tag, "Failure");
      assert.isFalse(yield* adapter.hasSession(threadId));
      assert.isDefined(
        events.find((event) => event.type === "turn.completed" && event.payload.state === "failed"),
      );
    }).pipe(Effect.scoped),
  );

  it.live("fails and retires a session when post-prompt state recovery fails", () =>
    Effect.gen(function* () {
      const adapter = yield* makeAdapter();
      const threadId = ThreadId.make("atomic-state-rejected");
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
      const result = yield* adapter
        .sendTurn({ threadId, input: "/t3-state-rejected", attachments: [] })
        .pipe(Effect.result);

      const events = Array.from(yield* Fiber.join(eventsFiber));
      assert.equal(result._tag, "Failure");
      assert.isFalse(yield* adapter.hasSession(threadId));
      assert.isDefined(
        events.find((event) => event.type === "turn.completed" && event.payload.state === "failed"),
      );
    }).pipe(Effect.scoped),
  );

  it.live("fails and retires a session when post-prompt state omits streaming status", () =>
    Effect.gen(function* () {
      const adapter = yield* makeAdapter();
      const threadId = ThreadId.make("atomic-state-missing-stream");
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
      const result = yield* adapter
        .sendTurn({ threadId, input: "/t3-state-missing-stream", attachments: [] })
        .pipe(Effect.result);

      const events = Array.from(yield* Fiber.join(eventsFiber));
      assert.equal(result._tag, "Failure");
      assert.isFalse(yield* adapter.hasSession(threadId));
      assert.isDefined(
        events.find((event) => event.type === "turn.completed" && event.payload.state === "failed"),
      );
    }).pipe(Effect.scoped),
  );

  it.live("does not attribute late events to a new turn after interrupting a prompt", () =>
    Effect.gen(function* () {
      const adapter = yield* makeAdapter();
      const threadId = ThreadId.make("atomic-interrupt-inflight");
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.takeUntil(
          (event) =>
            event.type === "task.started" &&
            event.payload.taskId === "interrupt-marker-after-response",
        ),
        Stream.runCollect,
        Effect.forkChild,
      );
      const interruptReadyFiber = yield* adapter.streamEvents.pipe(
        Stream.filter(
          (event) => event.type === "user-input.requested" && event.requestId === "interrupt-ready",
        ),
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
        .sendTurn({ threadId, input: "/t3-interrupt-inflight", attachments: [] })
        .pipe(Effect.forkChild);
      yield* Fiber.join(interruptReadyFiber);
      yield* adapter.interruptTurn(threadId);
      yield* Fiber.join(sendFiber);

      const events = Array.from(yield* Fiber.join(eventsFiber));
      assert.lengthOf(
        events.filter((event) => event.type === "turn.started"),
        1,
        "late agent_start must not create a phantom turn",
      );
      assert.notInclude(
        events
          .filter((event) => event.type === "content.delta")
          .map((event) => (event.type === "content.delta" ? event.payload.delta : "")),
        "LATE_AFTER_ABORT",
      );
      assert.notInclude(
        events
          .filter((event) => event.type === "content.delta")
          .map((event) => (event.type === "content.delta" ? event.payload.delta : "")),
        "LATE_AFTER_RESPONSE",
      );
      assert.lengthOf(
        events.filter(
          (event) => event.type === "turn.completed" && event.payload.state === "interrupted",
        ),
        1,
      );

      const nextTurnEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.takeUntil((event) => event.type === "turn.completed"),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* adapter.sendTurn({ threadId, input: "next turn", attachments: [] });
      const nextTurnEvents = Array.from(yield* Fiber.join(nextTurnEventsFiber));
      assert.include(
        nextTurnEvents
          .filter((event) => event.type === "content.delta")
          .map((event) => (event.type === "content.delta" ? event.payload.delta : "")),
        "PI_RPC_OK",
        "a real next turn must reset interrupted-event suppression",
      );
    }).pipe(Effect.scoped),
  );

  it.live("drains acknowledged tool events before completing an interruption", () =>
    Effect.gen(function* () {
      const adapter = yield* makeAdapter();
      const threadId = ThreadId.make("atomic-abort-drain");
      const toolStartedFiber = yield* adapter.streamEvents.pipe(
        Stream.filter(
          (event) =>
            event.type === "item.started" &&
            event.payload.itemType === "dynamic_tool_call" &&
            event.itemId === "abort-tool-1",
        ),
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
        provider: ProviderDriverKind.make("atomic"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId, input: "/t3-abort-drain", attachments: [] });
      yield* Fiber.join(toolStartedFiber).pipe(Effect.map(Option.getOrThrow));
      yield* adapter.interruptTurn(threadId);

      const events = Array.from(yield* Fiber.join(eventsFiber));
      const toolCompletedIndex = events.findIndex(
        (event) =>
          event.type === "item.completed" &&
          event.payload.itemType === "dynamic_tool_call" &&
          event.itemId === "abort-tool-1",
      );
      const turnCompletedIndex = events.findIndex((event) => event.type === "turn.completed");
      assert.isAtLeast(toolCompletedIndex, 0);
      assert.isTrue(toolCompletedIndex < turnCompletedIndex);
      assert.equal(
        events[turnCompletedIndex]?.type === "turn.completed"
          ? events[turnCompletedIndex].payload.state
          : undefined,
        "interrupted",
      );
    }).pipe(Effect.scoped),
  );
});
