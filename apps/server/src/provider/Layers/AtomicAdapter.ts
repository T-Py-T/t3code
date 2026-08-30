import {
  ApprovalRequestId,
  type AtomicSettings,
  ComputerUseApprovalId,
  EventId,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderSession,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderItemId,
  RuntimeItemId,
  RuntimeRequestId,
  RuntimeTaskId,
  type ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as SynchronizedRef from "effect/SynchronizedRef";
import * as Semaphore from "effect/Semaphore";
import { ChildProcessSpawner } from "effect/unstable/process";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import * as ComputerUsePolicy from "../../computerUse/ComputerUsePolicy.ts";
import { ServerConfig } from "../../config.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import { expandHomePath } from "../../pathExpansion.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import {
  type AtomicRpcEvent,
  type AtomicRpcProcess,
  atomicRpcEventSequence,
  makeAtomicRpcProcess,
} from "../atomic/AtomicRpcProcess.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import { T3_COMPUTER_USE_PI_EXTENSION_SOURCE } from "../pi/PiComputerUseExtension.ts";

const RESUME_VERSION = 1 as const;
const UnknownRecord = Schema.Record(Schema.String, Schema.Unknown);
const isRecord = Schema.is(UnknownRecord);
const isString = Schema.is(Schema.String);
const isBoolean = Schema.is(Schema.Boolean);
const isStringArray = Schema.is(Schema.Array(Schema.String));
const OmpTodoStatus = Schema.Literals([
  "pending",
  "in_progress",
  "completed",
  "abandoned",
  "blocked",
]);
const OmpTodoItem = Schema.Struct({
  content: Schema.String,
  status: OmpTodoStatus,
  blocker: Schema.optional(Schema.String),
});
const OmpTodoPhase = Schema.Struct({
  name: Schema.String,
  tasks: Schema.Array(OmpTodoItem),
});
const AtomicStateData = Schema.Struct({
  model: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        provider: Schema.String,
        id: Schema.String,
      }),
    ),
  ),
  thinkingLevel: Schema.optional(Schema.String),
  sessionFile: Schema.optional(Schema.String),
  sessionId: Schema.optional(Schema.String),
  isStreaming: Schema.optional(Schema.Boolean),
  todoPhases: Schema.optional(Schema.Array(OmpTodoPhase)),
});
const decodeState = Schema.decodeUnknownOption(AtomicStateData);
const AtomicResumeCursor = Schema.Struct({
  schemaVersion: Schema.Literal(RESUME_VERSION),
  sessionFile: Schema.optional(Schema.String),
  sessionId: Schema.optional(Schema.String),
});
const decodeResumeCursor = Schema.decodeUnknownOption(AtomicResumeCursor);

type PendingUiRequest =
  | {
      readonly _tag: "input";
      readonly atomicRequestId: string;
      readonly method: string;
      readonly questionId: string;
    }
  | {
      readonly _tag: "computer-approval";
      readonly atomicRequestId: string;
      readonly approvalId: ComputerUseApprovalId;
      readonly labels: Readonly<Partial<Record<ProviderApprovalDecision, string>>>;
    }
  | {
      readonly _tag: "workflow-input";
      readonly runId: string;
      readonly stageId: string;
      readonly promptId: string;
      readonly promptKind: string;
      readonly questionId: string;
      readonly submittedAnswers?: Readonly<Record<string, string | ReadonlyArray<string>>>;
    };

const COMPUTER_USE_APPROVAL_TITLE =
  /^T3 Computer Use \[([^\]]+)]\s+(.+?) :: ([a-z-]+)(?: -- (.+))?$/;
const T3_WORKFLOW_ACTION_CUSTOM_TYPE = "t3:workflow-action";

function workflowActionCommand(
  actionId: string,
  request: Readonly<Record<string, unknown>>,
): string {
  const encoded = Buffer.from(JSON.stringify({ actionId, request }), "utf8").toString("base64url");
  return `/t3-workflow-action ${encoded}`;
}

const computerUseApprovalDetail = (
  appName: string,
  kind: string,
  actionSummary?: string,
): string => {
  if (actionSummary) return `${actionSummary} in ${appName}.`;
  switch (kind) {
    case "observe":
      return `Allow T3 Computer Use to inspect ${appName}?`;
    case "operate":
      return `Allow T3 Computer Use to interact with ${appName}?`;
    case "external-side-effect":
      return `Confirm an external side effect in ${appName}.`;
    case "sensitive-data":
      return `Confirm sensitive data use in ${appName}.`;
    default:
      return `T3 Computer Use is requesting access to ${appName}.`;
  }
};

const computerUseApprovalDecision = (label: string): ProviderApprovalDecision | undefined => {
  switch (label) {
    case "Allow once":
    case "Confirm action":
      return "accept";
    case "Allow for this turn":
      return "acceptForTurn";
    case "Allow for this session":
      return "acceptForSession";
    case "Always allow on this computer":
      return "acceptAlways";
    case "Deny":
      return "decline";
    default:
      return undefined;
  }
};

interface AtomicWorkflowStageContext {
  readonly id: string;
  readonly index: number;
  readonly kind: "stage" | "tool";
  name: string;
  parentIds: ReadonlyArray<string>;
  awaitingInput: boolean;
  status?: string;
}

interface AtomicWorkflowRunContext {
  name: string;
  scriptPath: string | undefined;
  status?: string;
  readonly stages: Map<string, AtomicWorkflowStageContext>;
}

interface OmpSubagentContext {
  readonly id: string;
  agent: string;
  description: string | undefined;
  sessionFile: string | undefined;
  parentToolCallId: string | undefined;
  index: number | undefined;
  model: string | undefined;
  task: string | undefined;
}

interface AtomicSessionContext {
  readonly threadId: ThreadId;
  readonly cwd: string;
  readonly scope: Scope.Closeable;
  readonly rpc: AtomicRpcProcess;
  session: ProviderSession;
  activeTurnId: TurnId | undefined;
  assistantItemId: RuntimeItemId | undefined;
  reasoningItemId: RuntimeItemId | undefined;
  messageSequence: number;
  assistantText: string;
  reasoningText: string;
  pendingAssistantError: string | undefined;
  sawAgentActivity: boolean;
  promptInFlightTurnId: TurnId | undefined;
  suppressAgentEventsUntilNextTurn: boolean;
  readonly pendingUi: Map<ApprovalRequestId, PendingUiRequest>;
  readonly workflowRuns: Map<string, AtomicWorkflowRunContext>;
  readonly workflowLifecycleSignatures: Map<string, string>;
  readonly privateComputerUseToolCalls: Map<string, string>;
  readonly ompSubagents: Map<string, OmpSubagentContext>;
  readonly ompSettledSubagentIds: Set<string>;
  readonly ompTodoStatuses: Map<string, typeof OmpTodoStatus.Type>;
  readonly ompTodoRunGeneration: string;
  ompTodoRunSequence: number;
  ompTodoRunId: string | undefined;
  ompTodoPlanSignature: string | undefined;
  ompTodoCompletedTurnId: TurnId | undefined;
  readonly ompTodoDescriptions: Map<string, string>;
  ompTodoRootState: "idle" | "running" | "completed";
  ompWorkflowScriptPath: string | undefined;
  ompPublishedWorkflowScriptPath: string | undefined;
  readonly mappedEventSequence: SubscriptionRef.SubscriptionRef<number>;
  turns: Array<{ id: TurnId; items: Array<unknown> }>;
  stopped: boolean;
}

export interface PiCompatibleAdapterOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly instanceId?: ProviderInstanceId;
  /** Internal process budget override. Primarily used by focused adapter tests. */
  readonly startupTimeout?: Duration.Input;
  /** Internal process budget override. Primarily used by focused adapter tests. */
  readonly requestTimeout?: Duration.Input;
}

export interface PiCompatibleSettings {
  readonly binaryPath: string;
  readonly agentDir: string;
  readonly trustProjectResources: boolean;
  readonly launchArgs: string;
  readonly approvalMode?: "always-ask" | "write" | "yolo";
}

export interface PiCompatibleAdapterDefinition {
  readonly provider: ProviderDriverKind;
  readonly displayName: string;
  readonly agentDirEnvironmentVariable: "ATOMIC_CODING_AGENT_DIR" | "PI_CODING_AGENT_DIR";
  readonly rawSource: "atomic.rpc" | "pi.rpc" | "omp.rpc";
  readonly protocolVersion?: 2;
  readonly cliFlavor?: "pi" | "omp";
}

export type AtomicAdapterOptions = PiCompatibleAdapterOptions;

function parseModelSlug(
  slug: string | undefined,
): { provider: string; modelId: string } | undefined {
  const value = slug?.trim();
  if (!value) return undefined;
  const separator = value.indexOf("/");
  if (separator <= 0 || separator === value.length - 1) return undefined;
  return { provider: value.slice(0, separator), modelId: value.slice(separator + 1) };
}

function field(record: Readonly<Record<string, unknown>>, name: string): string | undefined {
  const value = record[name];
  return isString(value) && value.trim().length > 0 ? value : undefined;
}

function stringField(record: Readonly<Record<string, unknown>>, name: string): string | undefined {
  const value = record[name];
  return isString(value) ? value : undefined;
}

const PRIVATE_COMPUTER_USE_TOOL_PREFIXES = ["computer_", "preview_"] as const;
const PRIVATE_COMPUTER_USE_EVENT_TYPES = new Set([
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
]);

export function sanitizePiComputerUseEvent(
  event: AtomicRpcEvent,
  privateToolCalls: ReadonlyMap<string, string> = new Map(),
): AtomicRpcEvent {
  const type = field(event, "type");
  const toolCallId = field(event, "toolCallId") ?? field(event, "id");
  const toolName =
    field(event, "toolName") ??
    (toolCallId === undefined ? undefined : privateToolCalls.get(toolCallId));
  if (
    !type ||
    !PRIVATE_COMPUTER_USE_EVENT_TYPES.has(type) ||
    !toolName ||
    !PRIVATE_COMPUTER_USE_TOOL_PREFIXES.some((prefix) => toolName.startsWith(prefix))
  ) {
    return event;
  }
  const boundedToolCallId = field(event, "toolCallId")?.slice(0, 512);
  const boundedId = field(event, "id")?.slice(0, 512);
  return {
    type,
    ...(boundedToolCallId === undefined ? {} : { toolCallId: boundedToolCallId }),
    ...(boundedId === undefined ? {} : { id: boundedId }),
    toolName: toolName.slice(0, 512),
    ...(isBoolean(event.isError) ? { isError: event.isError } : {}),
  };
}

function workflowStageTaskId(runId: string, stageId: string): string {
  return `${runId}:wf:${stageId}`;
}

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  const number = nonNegativeNumber(value);
  return number === undefined ? undefined : Math.trunc(number);
}

function atomicSessionUsage(data: unknown) {
  if (!isRecord(data)) return undefined;
  const tokens = isRecord(data.tokens) ? data.tokens : undefined;
  const contextUsage = isRecord(data.contextUsage) ? data.contextUsage : undefined;
  const usedTokens = nonNegativeNumber(contextUsage?.tokens) ?? nonNegativeNumber(tokens?.total);
  if (usedTokens === undefined) return undefined;
  const maxTokens = nonNegativeNumber(contextUsage?.contextWindow);
  const inputTokens = nonNegativeNumber(tokens?.input);
  const cachedInputTokens = nonNegativeNumber(tokens?.cacheRead);
  const outputTokens = nonNegativeNumber(tokens?.output);
  const totalProcessedTokens = nonNegativeNumber(tokens?.total);
  const toolUses = nonNegativeNumber(data.toolCalls);
  return {
    usedTokens,
    ...(maxTokens !== undefined && maxTokens > 0 ? { maxTokens } : {}),
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(totalProcessedTokens === undefined ? {} : { totalProcessedTokens }),
    ...(toolUses === undefined ? {} : { toolUses }),
  };
}

function workflowStageDepth(
  run: AtomicWorkflowRunContext,
  stage: AtomicWorkflowStageContext,
  visiting: ReadonlySet<string> = new Set(),
  depths: Map<string, number> = new Map(),
): number {
  const cached = depths.get(stage.id);
  if (cached !== undefined) return cached;
  if (stage.parentIds.length === 0 || visiting.has(stage.id)) return 0;
  const nextVisiting = new Set(visiting).add(stage.id);
  const depth =
    1 +
    Math.max(
      ...stage.parentIds.map((parentId) => {
        const parent = run.stages.get(parentId);
        return parent ? workflowStageDepth(run, parent, nextVisiting, depths) : 0;
      }),
    );
  depths.set(stage.id, depth);
  return depth;
}

function workflowTerminalTaskStatus(
  status: string | undefined,
): "completed" | "failed" | "stopped" | undefined {
  if (status === "completed") return "completed";
  if (status === "failed" || status === "blocked") return "failed";
  if (
    status === "cancelled" ||
    status === "interrupted" ||
    status === "quit" ||
    status === "stopped"
  ) {
    return "stopped";
  }
  return undefined;
}

function workflowStageLinkage(
  runId: string,
  run: AtomicWorkflowRunContext,
  stage: AtomicWorkflowStageContext,
) {
  const phaseIndex = workflowStageDepth(run, stage);
  return {
    taskType: "local_agent" as const,
    workflowName: run.name,
    workflowStageId: stage.id,
    title: stage.name,
    role:
      stage.kind === "tool"
        ? "workflow tool"
        : stage.awaitingInput
          ? "human input"
          : "workflow stage",
    parentAgentId: runId,
    dependsOnTaskIds: stage.parentIds.map((parentId) =>
      RuntimeTaskId.make(workflowStageTaskId(runId, parentId)),
    ),
    agentIndex: stage.index,
    phaseIndex,
    phaseTitle: `Stage ${phaseIndex + 1}`,
    timelineBypass: true,
  } as const;
}

function dataText(value: unknown): string | undefined {
  if (isString(value)) return value;
  if (Array.isArray(value)) {
    const text = value
      .map(dataText)
      .filter((entry): entry is string => entry !== undefined)
      .join("");
    return text.length > 0 ? text : undefined;
  }
  if (!isRecord(value)) return undefined;
  return (
    stringField(value, "text") ??
    stringField(value, "thinking") ??
    dataText(value.content) ??
    dataText(value.output) ??
    dataText(value.result)
  );
}

function messageContent(message: Readonly<Record<string, unknown>>, blockType: string): string {
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter((block): block is Readonly<Record<string, unknown>> => isRecord(block))
    .filter((block) => field(block, "type") === blockType)
    .map((block) =>
      blockType === "thinking"
        ? (stringField(block, "thinking") ?? stringField(block, "text") ?? "")
        : (stringField(block, "text") ?? ""),
    )
    .join("");
}

function visibleMessageText(message: Readonly<Record<string, unknown>>): string | undefined {
  const text = dataText(message.content);
  if (!text) return undefined;
  // Atomic's terminal chat surfaces sometimes include ANSI styling. T3 owns
  // presentation, so retain the content while removing terminal escapes.
  // eslint-disable-next-line no-control-regex -- ANSI CSI begins with ESC.
  const clean = text.replace(/\u001B\[[0-?]*[ -/]*[@-~]/gu, "").trim();
  return clean.length > 0 ? clean : undefined;
}

function piCompatibleEnvironment(
  settings: PiCompatibleSettings,
  definition: PiCompatibleAdapterDefinition,
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return settings.agentDir
    ? {
        ...environment,
        [definition.agentDirEnvironmentVariable]: expandHomePath(settings.agentDir),
      }
    : environment;
}

function sessionArgs(
  settings: PiCompatibleSettings,
  definition: PiCompatibleAdapterDefinition,
  runtimeMode: "approval-required" | "auto-accept-edits" | "auto" | "full-access",
  title: string | undefined,
): ReadonlyArray<string> {
  const configured = [...tokenizeCliArgs(settings.launchArgs)];
  if (definition.cliFlavor === "omp") {
    const hasApprovalFlag = configured.some(
      (arg) => arg === "--approval-mode" || arg === "--auto-approve" || arg === "--yolo",
    );
    const hasExtensionTrustFlag = configured.some((arg) => arg === "--no-extensions");
    const approvalMode =
      runtimeMode === "approval-required" ? "always-ask" : (settings.approvalMode ?? "write");
    return [
      ...(settings.trustProjectResources || hasExtensionTrustFlag ? [] : ["--no-extensions"]),
      ...(hasApprovalFlag ? [] : ["--approval-mode", approvalMode]),
      ...configured,
    ];
  }
  const hasTrustFlag = configured.some((arg) => arg === "--approve" || arg === "--no-approve");
  return [
    ...(hasTrustFlag ? [] : [settings.trustProjectResources ? "--approve" : "--no-approve"]),
    ...configured,
    ...(title ? ["--name", title] : []),
  ];
}

export const makePiCompatibleAdapter = Effect.fn("makePiCompatibleAdapter")(function* (
  settings: PiCompatibleSettings,
  definition: PiCompatibleAdapterDefinition,
  options?: PiCompatibleAdapterOptions,
) {
  const PROVIDER = definition.provider;
  const crypto = yield* Crypto.Crypto;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const serverConfig = yield* ServerConfig;
  const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make(PROVIDER);
  const environment = piCompatibleEnvironment(
    settings,
    definition,
    options?.environment ?? process.env,
  );
  const sessions = new Map<ThreadId, AtomicSessionContext>();
  const turnLocks = yield* SynchronizedRef.make(new Map<string, Semaphore.Semaphore>());
  const lifecycleLocks = yield* SynchronizedRef.make(new Map<string, Semaphore.Semaphore>());
  const runtimeEvents = yield* PubSub.unbounded<ProviderRuntimeEvent>();
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const randomId = crypto.randomUUIDv4.pipe(
    Effect.mapError(
      (cause) =>
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "crypto/randomUUIDv4",
          detail: `Failed to generate a ${definition.displayName} runtime identifier.`,
          cause,
        }),
    ),
  );
  const eventStamp = () =>
    Effect.all({ eventId: Effect.map(randomId, EventId.make), createdAt: nowIso });
  const publish = (event: ProviderRuntimeEvent) =>
    PubSub.publish(runtimeEvents, event).pipe(Effect.asVoid);

  const awaitMappedEvents = (context: AtomicSessionContext, target: number) =>
    SubscriptionRef.changes(context.mappedEventSequence).pipe(
      Stream.filter((sequence) => sequence >= target),
      Stream.runHead,
      Effect.asVoid,
      Effect.timeout(Duration.seconds(5)),
      Effect.catch(() =>
        Effect.logWarning(`Timed out draining ${definition.displayName} events through ${target}.`),
      ),
    );

  const getLock = (
    lockStore: SynchronizedRef.SynchronizedRef<Map<string, Semaphore.Semaphore>>,
    threadId: string,
  ) =>
    SynchronizedRef.modifyEffect(lockStore, (current) => {
      const existing = current.get(threadId);
      if (existing) return Effect.succeed([existing, current] as const);
      return Semaphore.make(1).pipe(
        Effect.map((semaphore) => {
          const next = new Map(current);
          next.set(threadId, semaphore);
          return [semaphore, next] as const;
        }),
      );
    });
  const withLock = <A, E, R>(
    lockStore: SynchronizedRef.SynchronizedRef<Map<string, Semaphore.Semaphore>>,
    threadId: string,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.flatMap(getLock(lockStore, threadId), (lock) => lock.withPermit(effect));
  const withTurnLock = <A, E, R>(threadId: string, effect: Effect.Effect<A, E, R>) =>
    withLock(turnLocks, threadId, effect);
  const withLifecycleLock = <A, E, R>(threadId: string, effect: Effect.Effect<A, E, R>) =>
    withLock(lifecycleLocks, threadId, effect);

  const requireSession = (
    threadId: ThreadId,
  ): Effect.Effect<AtomicSessionContext, ProviderAdapterSessionNotFoundError> => {
    const context = sessions.get(threadId);
    return context && !context.stopped
      ? Effect.succeed(context)
      : Effect.fail(new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }));
  };

  const raw = (payload: AtomicRpcEvent, method?: string) => ({
    source: definition.rawSource,
    ...(method ? { method } : {}),
    payload,
  });

  const completeActiveTurn = (
    context: AtomicSessionContext,
    state: "completed" | "failed" | "interrupted" | "cancelled",
    errorMessage?: string,
  ) =>
    Effect.gen(function* () {
      const turnId = context.activeTurnId;
      if (!turnId) return;
      const { activeTurnId: _activeTurnId, ...rest } = context.session;
      context.activeTurnId = undefined;
      context.assistantItemId = undefined;
      context.reasoningItemId = undefined;
      context.assistantText = "";
      context.reasoningText = "";
      context.pendingAssistantError = undefined;
      context.sawAgentActivity = false;
      context.session = { ...rest, status: "ready", updatedAt: yield* nowIso };
      yield* publish({
        type: "turn.completed",
        ...(yield* eventStamp()),
        provider: PROVIDER,
        providerInstanceId: boundInstanceId,
        threadId: context.threadId,
        turnId,
        payload: { state, ...(errorMessage ? { errorMessage } : {}), stopReason: state },
      });
    });

  const settleActiveProviderTurn = (
    context: AtomicSessionContext,
    turnId: TurnId,
    source: ReturnType<typeof raw>,
  ) =>
    Effect.gen(function* () {
      const statsResult = yield* context.rpc
        .request({ type: "get_session_stats" })
        .pipe(Effect.result);
      if (statsResult._tag === "Success") {
        const usage = atomicSessionUsage(statsResult.success.data);
        if (usage) {
          yield* publish({
            type: "thread.token-usage.updated",
            ...(yield* eventStamp()),
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            threadId: context.threadId,
            turnId,
            payload: { usage },
            raw: source,
          });
        }
      }
      yield* resolveAbandonedUiRequests(context);
      const terminalError = context.pendingAssistantError;
      if (terminalError) {
        yield* publish({
          type: "runtime.error",
          ...(yield* eventStamp()),
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: context.threadId,
          turnId,
          payload: { message: terminalError, class: "provider_error" },
          raw: source,
        });
        yield* completeActiveTurn(context, "failed", terminalError);
      } else {
        yield* completeActiveTurn(context, "completed");
      }
    });

  const ompSubagentLinkage = (subagent: OmpSubagentContext) => ({
    taskType: "omp_subagent" as const,
    title: subagent.description ?? subagent.task ?? subagent.agent,
    role: subagent.agent,
    ...(subagent.model ? { model: subagent.model } : {}),
    ...(subagent.parentToolCallId ? { toolUseId: subagent.parentToolCallId } : {}),
    ...(subagent.index === undefined ? {} : { agentIndex: subagent.index }),
    ...(subagent.sessionFile
      ? {
          outputFile: subagent.sessionFile,
          runHandles: {
            runId: subagent.id,
            transcriptDir: path.dirname(subagent.sessionFile),
          },
        }
      : { runHandles: { runId: subagent.id } }),
    timelineBypass: true as const,
  });

  const handleOmpSubagentEvent = (context: AtomicSessionContext, event: AtomicRpcEvent) =>
    Effect.gen(function* () {
      const type = field(event, "type");
      if (definition.cliFlavor !== "omp" || !type?.startsWith("subagent_")) return false;
      if (context.stopped || context.suppressAgentEventsUntilNextTurn) return true;
      const payload = isRecord(event.payload) ? event.payload : undefined;
      if (!payload) return true;
      const source = raw(event, type);

      if (type === "subagent_lifecycle") {
        const id = field(payload, "id");
        const status = field(payload, "status");
        if (!id || !status) return true;
        const existing = context.ompSubagents.get(id);
        const subagent: OmpSubagentContext = {
          id,
          agent: field(payload, "agent") ?? existing?.agent ?? "OMP subagent",
          description: field(payload, "description") ?? existing?.description,
          sessionFile: field(payload, "sessionFile") ?? existing?.sessionFile,
          parentToolCallId: field(payload, "parentToolCallId") ?? existing?.parentToolCallId,
          index: nonNegativeInteger(payload.index) ?? existing?.index,
          model: existing?.model,
          task: existing?.task,
        };
        const taskId = RuntimeTaskId.make(id);
        if (status === "started") {
          context.ompSettledSubagentIds.delete(id);
          context.ompSubagents.set(id, subagent);
          yield* publish({
            type: "task.started",
            ...(yield* eventStamp()),
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            threadId: context.threadId,
            ...(context.activeTurnId ? { turnId: context.activeTurnId } : {}),
            payload: {
              taskId,
              description: subagent.description ?? `Running ${subagent.agent}`,
              ...ompSubagentLinkage(subagent),
            },
            raw: source,
          });
          return true;
        }
        if (context.ompSettledSubagentIds.has(id) && existing === undefined) return true;
        context.ompSettledSubagentIds.add(id);
        context.ompSubagents.delete(id);
        yield* publish({
          type: "task.completed",
          ...(yield* eventStamp()),
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: context.threadId,
          ...(context.activeTurnId ? { turnId: context.activeTurnId } : {}),
          payload: {
            taskId,
            status:
              status === "completed" ? "completed" : status === "aborted" ? "stopped" : "failed",
            summary:
              status === "completed"
                ? `${subagent.agent} completed.`
                : status === "aborted"
                  ? `${subagent.agent} was stopped.`
                  : `${subagent.agent} failed.`,
            ...ompSubagentLinkage(subagent),
          },
          raw: source,
        });
        return true;
      }

      if (type === "subagent_progress") {
        const progress = isRecord(payload.progress) ? payload.progress : undefined;
        const id = progress ? field(progress, "id") : undefined;
        if (!id || !progress) return true;
        if (context.ompSettledSubagentIds.has(id)) return true;
        const existing = context.ompSubagents.get(id) ?? {
          id,
          agent: field(payload, "agent") ?? field(progress, "agent") ?? "OMP subagent",
          description: undefined,
          sessionFile: undefined,
          parentToolCallId: undefined,
          index: undefined,
          model: undefined,
          task: undefined,
        };
        existing.agent = field(payload, "agent") ?? field(progress, "agent") ?? existing.agent;
        existing.description = field(progress, "description") ?? existing.description;
        existing.sessionFile = field(payload, "sessionFile") ?? existing.sessionFile;
        existing.parentToolCallId = field(payload, "parentToolCallId") ?? existing.parentToolCallId;
        existing.index = nonNegativeInteger(payload.index) ?? existing.index;
        existing.model = field(progress, "resolvedModel") ?? existing.model;
        existing.task = field(payload, "task") ?? field(progress, "task") ?? existing.task;
        context.ompSubagents.set(id, existing);
        const recentOutput = isStringArray(progress.recentOutput)
          ? progress.recentOutput.findLast((line) => line.trim().length > 0)
          : undefined;
        const currentTool = field(progress, "currentTool");
        const description =
          recentOutput ??
          field(progress, "lastIntent") ??
          existing.task ??
          existing.description ??
          `Running ${existing.agent}`;
        yield* publish({
          type: "task.progress",
          ...(yield* eventStamp()),
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: context.threadId,
          ...(context.activeTurnId ? { turnId: context.activeTurnId } : {}),
          payload: {
            taskId: RuntimeTaskId.make(id),
            description,
            ...(recentOutput ? { summary: recentOutput } : {}),
            ...(currentTool ? { lastToolName: currentTool } : {}),
            usage: {
              tokens: nonNegativeInteger(progress.tokens) ?? 0,
              contextTokens: nonNegativeNumber(progress.contextTokens) ?? 0,
              contextWindow: nonNegativeNumber(progress.contextWindow) ?? 0,
              cost: nonNegativeNumber(progress.cost) ?? 0,
              durationMs: nonNegativeInteger(progress.durationMs) ?? 0,
              toolCount: nonNegativeInteger(progress.toolCount) ?? 0,
            },
            typedUsage: {
              totalTokens: nonNegativeInteger(progress.tokens) ?? 0,
              toolUses: nonNegativeInteger(progress.toolCount) ?? 0,
              durationMs: nonNegativeInteger(progress.durationMs) ?? 0,
            },
            status: field(progress, "status") === "pending" ? "pending" : "running",
            ...ompSubagentLinkage(existing),
          },
          raw: source,
        });
        return true;
      }

      if (type === "subagent_event") {
        const id = field(payload, "id");
        const childEvent = isRecord(payload.event) ? payload.event : undefined;
        const existing = id ? context.ompSubagents.get(id) : undefined;
        if (!id || !childEvent || !existing) return true;
        const childType = field(childEvent, "type");
        const childMessage = isRecord(childEvent.message) ? childEvent.message : undefined;
        const summary =
          childType === "message_end" && childMessage
            ? visibleMessageText(childMessage)
            : childType?.startsWith("tool_execution")
              ? field(childEvent, "toolName")
              : undefined;
        if (!summary) return true;
        yield* publish({
          type: "task.progress",
          ...(yield* eventStamp()),
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: context.threadId,
          ...(context.activeTurnId ? { turnId: context.activeTurnId } : {}),
          payload: {
            taskId: RuntimeTaskId.make(id),
            description: summary,
            summary,
            ...(childType?.startsWith("tool_execution") ? { lastToolName: summary } : {}),
            status: "running",
            ...ompSubagentLinkage(existing),
          },
          raw: source,
        });
        return true;
      }
      return true;
    });

  const stopOmpSubagentProjection = (context: AtomicSessionContext, summary: string) =>
    Effect.gen(function* () {
      if (definition.cliFlavor !== "omp") return;
      for (const [id, subagent] of context.ompSubagents) {
        yield* publish({
          type: "task.completed",
          ...(yield* eventStamp()),
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: context.threadId,
          ...(context.activeTurnId ? { turnId: context.activeTurnId } : {}),
          payload: {
            taskId: RuntimeTaskId.make(id),
            status: "stopped",
            summary,
            ...ompSubagentLinkage(subagent),
          },
        });
        context.ompSettledSubagentIds.add(id);
      }
      context.ompSubagents.clear();
    });

  const stopOmpTodoProjection = (context: AtomicSessionContext, summary: string) =>
    Effect.gen(function* () {
      if (definition.cliFlavor !== "omp") return;
      for (const [taskId, description] of context.ompTodoDescriptions) {
        const status = context.ompTodoStatuses.get(taskId);
        if (status === "completed" || status === "abandoned") continue;
        yield* publish({
          type: "task.completed",
          ...(yield* eventStamp()),
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: context.threadId,
          ...(context.activeTurnId ? { turnId: context.activeTurnId } : {}),
          payload: {
            taskId: RuntimeTaskId.make(taskId),
            status: "stopped",
            summary: `${description} was stopped.`,
          },
        });
      }
      context.ompTodoStatuses.clear();
      context.ompTodoDescriptions.clear();
      if (!context.ompTodoRunId || context.ompTodoRootState !== "running") return;
      context.ompTodoRootState = "completed";
      context.ompTodoCompletedTurnId = context.activeTurnId;
      yield* publish({
        type: "task.completed",
        ...(yield* eventStamp()),
        provider: PROVIDER,
        providerInstanceId: boundInstanceId,
        threadId: context.threadId,
        ...(context.activeTurnId ? { turnId: context.activeTurnId } : {}),
        payload: {
          taskId: RuntimeTaskId.make(context.ompTodoRunId),
          status: "stopped",
          summary,
          taskType: "local_workflow",
          workflowName: "Oh My Pi plan",
          title: "Oh My Pi plan",
        },
      });
    });

  const syncOmpTodos = (
    context: AtomicSessionContext,
    source: ReturnType<typeof raw>,
    knownPhases?: ReadonlyArray<typeof OmpTodoPhase.Type>,
  ) =>
    Effect.gen(function* () {
      if (definition.cliFlavor !== "omp") return;
      let phases = knownPhases;
      if (phases === undefined) {
        const response = yield* context.rpc.request({ type: "get_state" }).pipe(Effect.result);
        if (response._tag === "Failure") return;
        phases = Option.getOrUndefined(decodeState(response.success.data))?.todoPhases;
      }
      if (!phases) return;

      const stopProjectedTodo = (taskId: string, description: string) =>
        Effect.flatMap(eventStamp(), (stamp) =>
          publish({
            type: "task.completed",
            ...stamp,
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            threadId: context.threadId,
            ...(context.activeTurnId ? { turnId: context.activeTurnId } : {}),
            payload: {
              taskId: RuntimeTaskId.make(taskId),
              status: "stopped",
              summary: `${description} was removed from the Oh My Pi plan.`,
            },
            raw: source,
          }),
        );

      if (phases.length === 0) {
        for (const [taskId, description] of context.ompTodoDescriptions) {
          const status = context.ompTodoStatuses.get(taskId);
          if (status !== "completed" && status !== "abandoned") {
            yield* stopProjectedTodo(taskId, description);
          }
        }
        context.ompTodoStatuses.clear();
        context.ompTodoDescriptions.clear();
        if (context.ompTodoRunId && context.ompTodoRootState === "running") {
          const runId = context.ompTodoRunId;
          context.ompTodoRootState = "completed";
          context.ompTodoCompletedTurnId = context.activeTurnId;
          yield* publish({
            type: "task.completed",
            ...(yield* eventStamp()),
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            threadId: context.threadId,
            ...(context.activeTurnId ? { turnId: context.activeTurnId } : {}),
            payload: {
              taskId: RuntimeTaskId.make(runId),
              status: "stopped",
              summary: "Oh My Pi plan was cleared.",
              taskType: "local_workflow",
              workflowName: "Oh My Pi plan",
              title: "Oh My Pi plan",
            },
            raw: source,
          });
        }
        return;
      }

      const hasNonTerminalTask = phases.some((phase) =>
        phase.tasks.some((task) => task.status !== "completed" && task.status !== "abandoned"),
      );
      const signaturePart = (value: string) => `${value.length}:${value}`;
      const planSignature = phases
        .map(
          (phase) =>
            `${signaturePart(phase.name)}${phase.tasks
              .map((task) => signaturePart(task.content))
              .join("")}`,
        )
        .join("");
      const sourceType = field(source.payload, "type");
      const isTodoMutation =
        sourceType === "tool_execution_end" && field(source.payload, "toolName") === "todo";
      if (
        context.ompTodoRunId === undefined ||
        (context.ompTodoRootState === "completed" &&
          (hasNonTerminalTask ||
            planSignature !== context.ompTodoPlanSignature ||
            (isTodoMutation && context.activeTurnId !== context.ompTodoCompletedTurnId)))
      ) {
        context.ompTodoRunSequence += 1;
        const baseRunId = `omp-plan:${context.threadId}:${context.ompTodoRunGeneration}`;
        context.ompTodoRunId =
          context.ompTodoRunSequence === 1
            ? baseRunId
            : `${baseRunId}:${context.ompTodoRunSequence}`;
        context.ompTodoStatuses.clear();
        context.ompTodoDescriptions.clear();
        context.ompTodoRootState = "idle";
        context.ompTodoCompletedTurnId = undefined;
        context.ompPublishedWorkflowScriptPath = undefined;
      }
      context.ompTodoPlanSignature = planSignature;
      const runId = context.ompTodoRunId;
      const rootTaskId = RuntimeTaskId.make(runId);
      const workflowName = "Oh My Pi plan";
      const workflowRunHandles = {
        runId,
        ...(context.ompWorkflowScriptPath ? { scriptPath: context.ompWorkflowScriptPath } : {}),
      };
      const phaseLinks = phases.map((phase, index) => ({
        index,
        title: phase.name.trim() || `Phase ${index + 1}`,
      }));
      if (context.ompTodoRootState === "idle") {
        context.ompTodoRootState = "running";
        yield* publish({
          type: "task.started",
          ...(yield* eventStamp()),
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: context.threadId,
          ...(context.activeTurnId ? { turnId: context.activeTurnId } : {}),
          payload: {
            taskId: rootTaskId,
            description: "Executing the Oh My Pi plan",
            taskType: "local_workflow",
            workflowName,
            title: workflowName,
            phases: phaseLinks,
            runHandles: workflowRunHandles,
          },
          raw: source,
        });
        context.ompPublishedWorkflowScriptPath = context.ompWorkflowScriptPath;
      }
      if (
        context.ompWorkflowScriptPath !== undefined &&
        context.ompPublishedWorkflowScriptPath !== context.ompWorkflowScriptPath &&
        context.ompTodoRootState === "running"
      ) {
        yield* publish({
          type: "task.progress",
          ...(yield* eventStamp()),
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: context.threadId,
          ...(context.activeTurnId ? { turnId: context.activeTurnId } : {}),
          payload: {
            taskId: rootTaskId,
            description: "Generated an Oh My Pi workflow command",
            status: "running",
            taskType: "local_workflow",
            workflowName,
            title: workflowName,
            phases: phaseLinks,
            runHandles: workflowRunHandles,
          },
          raw: source,
        });
        context.ompPublishedWorkflowScriptPath = context.ompWorkflowScriptPath;
      }

      const allTaskIds: RuntimeTaskId[] = [];
      let flatIndex = 0;
      let previousTaskId: RuntimeTaskId | undefined;
      for (const [phaseIndex, phase] of phases.entries()) {
        const phaseTitle = phase.name.trim() || `Phase ${phaseIndex + 1}`;
        for (const task of phase.tasks) {
          const taskId = RuntimeTaskId.make(`${runId}:todo:${flatIndex}`);
          allTaskIds.push(taskId);
          const priorDescription = context.ompTodoDescriptions.get(taskId);
          if (priorDescription !== undefined && priorDescription !== task.content) {
            const replacedStatus = context.ompTodoStatuses.get(taskId);
            if (replacedStatus !== "completed" && replacedStatus !== "abandoned") {
              yield* stopProjectedTodo(taskId, priorDescription);
            }
            context.ompTodoStatuses.delete(taskId);
          }
          context.ompTodoDescriptions.set(taskId, task.content);
          const priorStatus = context.ompTodoStatuses.get(taskId);
          const linkage = {
            taskType: "local_agent" as const,
            workflowName,
            workflowStageId: `todo:${flatIndex}`,
            title: task.content,
            role: "workflow task",
            parentAgentId: runId,
            ...(previousTaskId ? { dependsOnTaskIds: [previousTaskId] } : {}),
            agentIndex: flatIndex,
            phaseIndex,
            phaseTitle,
            phases: phaseLinks,
            runHandles: { runId },
            timelineBypass: true as const,
          };
          if (priorStatus === undefined) {
            yield* publish({
              type: "task.started",
              ...(yield* eventStamp()),
              provider: PROVIDER,
              providerInstanceId: boundInstanceId,
              threadId: context.threadId,
              ...(context.activeTurnId ? { turnId: context.activeTurnId } : {}),
              payload: {
                taskId,
                description: task.content,
                ...linkage,
              },
              raw: source,
            });
          }
          if (priorStatus !== task.status) {
            if (task.status === "completed" || task.status === "abandoned") {
              yield* publish({
                type: "task.completed",
                ...(yield* eventStamp()),
                provider: PROVIDER,
                providerInstanceId: boundInstanceId,
                threadId: context.threadId,
                ...(context.activeTurnId ? { turnId: context.activeTurnId } : {}),
                payload: {
                  taskId,
                  status: task.status === "completed" ? "completed" : "stopped",
                  summary:
                    task.status === "completed"
                      ? `${task.content} completed.`
                      : `${task.content} was abandoned.`,
                  ...linkage,
                },
                raw: source,
              });
            } else {
              const runtimeStatus =
                task.status === "in_progress"
                  ? "running"
                  : task.status === "blocked"
                    ? "waiting"
                    : "pending";
              const description =
                task.status === "blocked" && task.blocker?.trim()
                  ? `${task.content}: ${task.blocker.trim()}`
                  : task.content;
              yield* publish({
                type: "task.progress",
                ...(yield* eventStamp()),
                provider: PROVIDER,
                providerInstanceId: boundInstanceId,
                threadId: context.threadId,
                ...(context.activeTurnId ? { turnId: context.activeTurnId } : {}),
                payload: {
                  taskId,
                  description,
                  ...(task.blocker?.trim() ? { summary: task.blocker.trim() } : {}),
                  status: runtimeStatus,
                  ...linkage,
                },
                raw: source,
              });
            }
            context.ompTodoStatuses.set(taskId, task.status);
          }
          previousTaskId = taskId;
          flatIndex += 1;
        }
      }

      const currentTaskIds = new Set<string>(allTaskIds);
      for (const [taskId, description] of context.ompTodoDescriptions) {
        if (currentTaskIds.has(taskId)) continue;
        const removedStatus = context.ompTodoStatuses.get(taskId);
        if (removedStatus !== "completed" && removedStatus !== "abandoned") {
          yield* stopProjectedTodo(taskId, description);
        }
        context.ompTodoStatuses.delete(taskId);
        context.ompTodoDescriptions.delete(taskId);
      }

      const allTerminal =
        allTaskIds.length > 0 &&
        allTaskIds.every((taskId) => {
          const status = context.ompTodoStatuses.get(taskId);
          return status === "completed" || status === "abandoned";
        });
      if (allTerminal && context.ompTodoRootState === "running") {
        context.ompTodoRootState = "completed";
        context.ompTodoCompletedTurnId = context.activeTurnId;
        yield* publish({
          type: "task.completed",
          ...(yield* eventStamp()),
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: context.threadId,
          ...(context.activeTurnId ? { turnId: context.activeTurnId } : {}),
          payload: {
            taskId: rootTaskId,
            status: "completed",
            summary: "Oh My Pi plan completed.",
            taskType: "local_workflow",
            workflowName,
            title: workflowName,
            phases: phaseLinks,
            runHandles: workflowRunHandles,
          },
          raw: source,
        });
      }
    });

  const handleExtensionUi = (
    context: AtomicSessionContext,
    event: AtomicRpcEvent,
  ): Effect.Effect<void, ProviderAdapterError> =>
    Effect.gen(function* () {
      const atomicRequestId = field(event, "id");
      const method = field(event, "method");
      if (!atomicRequestId || !method) return;
      if (method === "notify") {
        const message = field(event, "message");
        const notifyType = field(event, "notifyType") ?? "info";
        // Informational notices are terminal UI chrome in Pi (for example
        // "Obsidian: 2 vaults discovered"), not warnings in a chat transcript.
        if (message && notifyType !== "info") {
          yield* publish({
            type: "runtime.warning",
            ...(yield* eventStamp()),
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            threadId: context.threadId,
            ...(context.activeTurnId ? { turnId: context.activeTurnId } : {}),
            payload: {
              message,
              detail: { kind: "extension_notification", notifyType },
            },
            raw: raw(event, "extension_ui_request"),
          });
        }
        return;
      }
      if (!["select", "confirm", "input", "editor"].includes(method)) return;
      const requestId = ApprovalRequestId.make(atomicRequestId);
      const title = field(event, "title") ?? `${definition.displayName} needs input`;
      const selectOptions = isStringArray(event.options) ? event.options : [];
      const computerUseApproval =
        method === "select" ? title.match(COMPUTER_USE_APPROVAL_TITLE) : null;
      if (computerUseApproval) {
        const approvalId = ComputerUseApprovalId.make(computerUseApproval[1] ?? "");
        const appName = computerUseApproval[2] ?? "Computer target";
        const approvalKind = computerUseApproval[3] ?? "access";
        const actionSummary = computerUseApproval[4];
        const options = selectOptions.flatMap((label) => {
          const decision = computerUseApprovalDecision(label);
          return decision === undefined ? [] : [{ decision, label }];
        });
        const labels = Object.fromEntries(
          options.map((option) => [option.decision, option.label]),
        ) as Partial<Record<ProviderApprovalDecision, string>>;
        context.pendingUi.set(requestId, {
          _tag: "computer-approval",
          atomicRequestId,
          approvalId,
          labels,
        });
        yield* publish({
          type: "request.opened",
          ...(yield* eventStamp()),
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: context.threadId,
          ...(context.activeTurnId ? { turnId: context.activeTurnId } : {}),
          requestId: RuntimeRequestId.make(requestId),
          payload: {
            requestType: "mcp_elicitation_approval",
            appName,
            detail: computerUseApprovalDetail(appName, approvalKind, actionSummary),
            options,
            computerUseApproval: true,
          },
          raw: raw(event, "extension_ui_request"),
        });
        return;
      }
      const questionId = `${atomicRequestId}:answer`;
      const question = field(event, "message") ?? title;
      const defaultValue = stringField(event, "prefill") ?? stringField(event, "initialValue");
      const optionsForQuestion =
        method === "confirm"
          ? [
              { label: "Yes", description: "Confirm this action." },
              { label: "No", description: "Decline this action." },
            ]
          : method === "select"
            ? selectOptions.map((label) => ({ label, description: `Choose ${label}.` }))
            : [
                {
                  label: "Enter a custom answer",
                  description: "Use the custom response field for your answer.",
                },
              ];
      context.pendingUi.set(requestId, { _tag: "input", atomicRequestId, method, questionId });
      yield* publish({
        type: "user-input.requested",
        ...(yield* eventStamp()),
        provider: PROVIDER,
        providerInstanceId: boundInstanceId,
        threadId: context.threadId,
        ...(context.activeTurnId ? { turnId: context.activeTurnId } : {}),
        requestId: RuntimeRequestId.make(requestId),
        payload: {
          questions: [
            {
              id: questionId,
              header: title,
              question,
              ...(defaultValue === undefined ? {} : { defaultValue }),
              options: optionsForQuestion,
              multiSelect: false,
            },
          ],
        },
        raw: raw(event, "extension_ui_request"),
      });
    });

  const startProviderTurn = (context: AtomicSessionContext) =>
    Effect.gen(function* () {
      if (context.activeTurnId) return context.activeTurnId;
      const turnId = TurnId.make(yield* randomId);
      context.activeTurnId = turnId;
      context.session = {
        ...context.session,
        status: "running",
        activeTurnId: turnId,
        updatedAt: yield* nowIso,
      };
      context.turns.push({ id: turnId, items: [] });
      yield* publish({
        type: "turn.started",
        ...(yield* eventStamp()),
        provider: PROVIDER,
        providerInstanceId: boundInstanceId,
        threadId: context.threadId,
        turnId,
        payload: {},
      });
      return turnId;
    });

  const resolveAbandonedUiRequests = (
    context: AtomicSessionContext,
    includeWorkflowInputs = false,
  ) =>
    Effect.gen(function* () {
      for (const [requestId, pending] of context.pendingUi) {
        if (pending._tag === "workflow-input" && !includeWorkflowInputs) continue;
        if (pending._tag === "computer-approval") {
          yield* ComputerUsePolicy.resolveActiveComputerUseApproval(pending.approvalId, "cancel");
          yield* publish({
            type: "request.resolved",
            ...(yield* eventStamp()),
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            threadId: context.threadId,
            ...(context.activeTurnId ? { turnId: context.activeTurnId } : {}),
            requestId: RuntimeRequestId.make(requestId),
            payload: { requestType: "mcp_elicitation_approval", decision: "cancel" },
          });
        } else {
          yield* publish({
            type: "user-input.resolved",
            ...(yield* eventStamp()),
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            threadId: context.threadId,
            ...(context.activeTurnId ? { turnId: context.activeTurnId } : {}),
            requestId: RuntimeRequestId.make(requestId),
            payload: { answers: {} },
          });
        }
        context.pendingUi.delete(requestId);
      }
    });

  const openWorkflowPrompt = (
    context: AtomicSessionContext,
    input: {
      readonly runId: string;
      readonly workflowName: string;
      readonly stageId: string;
      readonly stageName: string;
      readonly prompt: Readonly<Record<string, unknown>>;
    },
    event: AtomicRpcEvent,
  ) =>
    Effect.gen(function* () {
      const promptId = field(input.prompt, "id");
      if (!promptId) return;
      const requestId = ApprovalRequestId.make(`workflow:${input.runId}:${promptId}`);
      if (context.pendingUi.has(requestId)) return;
      const promptKind = field(input.prompt, "kind") ?? "input";
      const questionId = `${requestId}:answer`;
      const options = isStringArray(input.prompt.options)
        ? input.prompt.options.map((label) => ({ label, description: `Choose ${label}.` }))
        : promptKind === "confirm"
          ? [
              { label: "Yes", description: "Continue the workflow." },
              { label: "No", description: "Decline and stop this workflow path." },
            ]
          : [
              {
                label: "Enter a custom answer",
                description: "Provide the value this workflow stage needs.",
              },
            ];
      context.pendingUi.set(requestId, {
        _tag: "workflow-input",
        runId: input.runId,
        stageId: input.stageId,
        promptId,
        promptKind,
        questionId,
      });
      yield* publish({
        type: "user-input.requested",
        ...(yield* eventStamp()),
        provider: PROVIDER,
        providerInstanceId: boundInstanceId,
        threadId: context.threadId,
        ...(context.activeTurnId ? { turnId: context.activeTurnId } : {}),
        requestId: RuntimeRequestId.make(requestId),
        payload: {
          questions: [
            {
              id: questionId,
              header: input.workflowName,
              question:
                field(input.prompt, "message") ??
                `${input.stageName} is waiting for your response.`,
              options,
              multiSelect: false,
            },
          ],
        },
        raw: raw(event, T3_WORKFLOW_ACTION_CUSTOM_TYPE),
      });
    });

  const resolveWorkflowPrompt = (
    context: AtomicSessionContext,
    runId: string,
    stageId: string | undefined,
    answers: Readonly<Record<string, string | ReadonlyArray<string>>> = {},
  ) =>
    Effect.gen(function* () {
      for (const [requestId, pending] of context.pendingUi) {
        if (
          pending._tag !== "workflow-input" ||
          pending.runId !== runId ||
          (stageId !== undefined && pending.stageId !== stageId)
        ) {
          continue;
        }
        context.pendingUi.delete(requestId);
        yield* publish({
          type: "user-input.resolved",
          ...(yield* eventStamp()),
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: context.threadId,
          ...(context.activeTurnId ? { turnId: context.activeTurnId } : {}),
          requestId: RuntimeRequestId.make(requestId),
          payload: { answers },
        });
      }
    });

  const syncWorkflowToolStatus = (
    context: AtomicSessionContext,
    runId: string,
    workflowName: string,
    runStatus: string | undefined,
    tools: ReadonlyArray<unknown>,
    event: AtomicRpcEvent,
  ) =>
    Effect.gen(function* () {
      let workflowRun = context.workflowRuns.get(runId);
      if (!workflowRun) {
        workflowRun = { name: workflowName, scriptPath: undefined, stages: new Map() };
        context.workflowRuns.set(runId, workflowRun);
      } else {
        workflowRun.name = workflowName;
      }
      if (runStatus) workflowRun.status = runStatus;
      const source = raw(event, T3_WORKFLOW_ACTION_CUSTOM_TYPE);
      for (const candidate of tools) {
        if (!isRecord(candidate) || field(candidate, "kind") !== "tool") continue;
        const toolId = field(candidate, "id");
        const toolName = field(candidate, "name");
        const status = field(candidate, "status");
        if (!toolId || !toolName || !status) continue;
        const parentIds = isStringArray(candidate.parentIds) ? candidate.parentIds : [];
        let tool = workflowRun.stages.get(toolId);
        if (!tool) {
          const executionOrder = nonNegativeNumber(candidate.executionOrder);
          tool = {
            id: toolId,
            index: executionOrder === undefined ? workflowRun.stages.size : executionOrder - 1,
            kind: "tool",
            name: toolName,
            parentIds,
            awaitingInput: false,
          };
          workflowRun.stages.set(toolId, tool);
        } else {
          tool.name = toolName;
          tool.parentIds = parentIds;
        }
        if (tool.status === status) continue;
        const previousStatus = tool.status;
        tool.status = status;
        const taskId = RuntimeTaskId.make(workflowStageTaskId(runId, tool.id));
        const linkage = workflowStageLinkage(runId, workflowRun, tool);
        if (previousStatus === undefined) {
          yield* publish({
            type: "task.started",
            ...(yield* eventStamp()),
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            threadId: context.threadId,
            ...(context.activeTurnId ? { turnId: context.activeTurnId } : {}),
            payload: {
              taskId,
              description: `Running ${tool.name}`,
              ...linkage,
            },
            raw: source,
          });
        }
        const terminalStatus = workflowTerminalTaskStatus(status);
        if (terminalStatus) {
          yield* publish({
            type: "task.completed",
            ...(yield* eventStamp()),
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            threadId: context.threadId,
            ...(context.activeTurnId ? { turnId: context.activeTurnId } : {}),
            payload: {
              taskId,
              status: terminalStatus,
              ...(field(candidate, "resultSummary")
                ? { summary: field(candidate, "resultSummary") }
                : {}),
              ...linkage,
            },
            raw: source,
          });
          continue;
        }
        yield* publish({
          type: "task.updated",
          ...(yield* eventStamp()),
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: context.threadId,
          ...(context.activeTurnId ? { turnId: context.activeTurnId } : {}),
          payload: {
            taskId,
            status:
              status === "awaiting_input" ? "waiting" : status === "paused" ? "idle" : "running",
            description: `${tool.name} ${status.replaceAll("_", " ")}`,
            ...linkage,
          },
          raw: source,
        });
      }
    });

  const handleWorkflowActionResult = (context: AtomicSessionContext, event: AtomicRpcEvent) =>
    Effect.gen(function* () {
      const message = isRecord(event.message) ? event.message : undefined;
      if (!message || field(message, "customType") !== T3_WORKFLOW_ACTION_CUSTOM_TYPE) return false;
      const envelope = isRecord(message.details) ? message.details : undefined;
      const request = envelope && isRecord(envelope.request) ? envelope.request : undefined;
      const result = envelope && isRecord(envelope.result) ? envelope.result : undefined;
      if (!request || !result) return true;
      const action = field(request, "action");
      if (action === "status") {
        const detail = isRecord(result.detail) ? result.detail : undefined;
        const runId = detail ? field(detail, "runId") : undefined;
        const workflowName = detail ? field(detail, "name") : undefined;
        const stages = detail && Array.isArray(detail.stages) ? detail.stages : [];
        if (runId && workflowName) {
          yield* syncWorkflowToolStatus(
            context,
            runId,
            workflowName,
            field(detail!, "status"),
            detail && Array.isArray(detail.tools) ? detail.tools : [],
            event,
          );
          for (const candidate of stages) {
            if (!isRecord(candidate) || !isRecord(candidate.pendingPrompt)) continue;
            const stageId = field(candidate, "id");
            if (!stageId) continue;
            yield* openWorkflowPrompt(
              context,
              {
                runId,
                workflowName,
                stageId,
                stageName: field(candidate, "name") ?? stageId,
                prompt: candidate.pendingPrompt,
              },
              event,
            );
          }
        }
        return true;
      }
      if (action === "send") {
        const runId = field(request, "runId");
        const stageId = field(request, "stageId");
        const promptId = field(request, "promptId");
        if (!runId || !stageId || !promptId) return true;
        const pending = Array.from(context.pendingUi.values()).find(
          (entry) =>
            entry._tag === "workflow-input" &&
            entry.runId === runId &&
            entry.stageId === stageId &&
            entry.promptId === promptId,
        );
        if (field(result, "status") === "ok") {
          yield* resolveWorkflowPrompt(
            context,
            runId,
            stageId,
            pending?._tag === "workflow-input" ? pending.submittedAnswers : {},
          );
        } else {
          yield* publish({
            type: "runtime.warning",
            ...(yield* eventStamp()),
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            threadId: context.threadId,
            ...(context.activeTurnId ? { turnId: context.activeTurnId } : {}),
            payload: {
              message:
                field(result, "error") ??
                field(result, "message") ??
                `${definition.displayName} could not answer the workflow prompt.`,
              detail: { kind: "workflow_control" },
            },
            raw: raw(event, T3_WORKFLOW_ACTION_CUSTOM_TYPE),
          });
        }
        return true;
      }
      if (field(result, "status") === "failed") {
        yield* publish({
          type: "runtime.warning",
          ...(yield* eventStamp()),
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: context.threadId,
          ...(context.activeTurnId ? { turnId: context.activeTurnId } : {}),
          payload: {
            message: field(result, "error") ?? `${definition.displayName} workflow control failed.`,
            detail: { kind: "workflow_control" },
          },
          raw: raw(event, T3_WORKFLOW_ACTION_CUSTOM_TYPE),
        });
      }
      return true;
    });

  const requestWorkflowStatus = (context: AtomicSessionContext, runId: string) =>
    Effect.gen(function* () {
      if (PROVIDER !== "atomic") return;
      const actionId = yield* randomId;
      yield* context.rpc
        .request(
          {
            type: "prompt",
            message: workflowActionCommand(actionId, { action: "status", runId }),
          },
          Duration.seconds(30),
        )
        .pipe(
          Effect.catch((cause) =>
            eventStamp().pipe(
              Effect.flatMap((stamp) =>
                publish({
                  type: "runtime.warning",
                  ...stamp,
                  provider: PROVIDER,
                  providerInstanceId: boundInstanceId,
                  threadId: context.threadId,
                  ...(context.activeTurnId ? { turnId: context.activeTurnId } : {}),
                  payload: {
                    message: `${definition.displayName} workflow details could not be refreshed: ${cause.message}`,
                    detail: { kind: "workflow_control" },
                  },
                }),
              ),
            ),
          ),
        );
    });

  const handleWorkflowEntry = (context: AtomicSessionContext, event: AtomicRpcEvent) =>
    Effect.gen(function* () {
      const entry = isRecord(event.entry)
        ? event.entry
        : isRecord(event.message)
          ? event.message
          : undefined;
      if (!entry) return false;
      const customType = field(entry, "customType");
      let data = isRecord(entry.data)
        ? entry.data
        : isRecord(entry.details)
          ? entry.details
          : entry;
      let entryType =
        customType ??
        (field(entry, "type")?.startsWith("workflow.") ? field(entry, "type") : undefined);
      if (customType === "workflows:lifecycle-notice") {
        const kind = field(data, "kind");
        const scope = field(data, "scope");
        entryType =
          kind === "started"
            ? `workflow.${scope}.start`
            : kind === "awaiting_input"
              ? `workflow.${scope}.waiting`
              : kind === "paused"
                ? `workflow.${scope}.paused`
                : kind === "resumed"
                  ? `workflow.${scope}.resumed`
                  : ["completed", "failed", "blocked", "quit"].includes(kind ?? "")
                    ? `workflow.${scope}.end`
                    : undefined;
        data = { ...data, ...(field(data, "status") ? {} : { status: kind }) };
      }
      if (!entryType?.startsWith("workflow.")) return false;
      const runId = field(data, "runId");
      if (!runId) return true;
      const stageId = field(data, "stageId");
      const lifecycleTarget = `${runId}:${stageId ?? "run"}`;
      const lifecycleSignature = [
        entryType,
        field(data, "status") ?? "",
        field(data, "promptMessage") ?? "",
        dataText(data.result) ?? "",
      ].join("\u0000");
      if (context.workflowLifecycleSignatures.get(lifecycleTarget) === lifecycleSignature) {
        return true;
      }
      context.workflowLifecycleSignatures.set(lifecycleTarget, lifecycleSignature);
      const isRunEntry = entryType === "workflow.run.start" || entryType === "workflow.run.end";
      const eventWorkflowName =
        field(data, "workflowName") ?? (isRunEntry ? field(data, "name") : undefined);
      let workflowRun = context.workflowRuns.get(runId);
      if (!workflowRun) {
        workflowRun = {
          name: eventWorkflowName ?? `${definition.displayName} workflow`,
          scriptPath: undefined,
          stages: new Map(),
        };
        context.workflowRuns.set(runId, workflowRun);
      } else if (eventWorkflowName) {
        workflowRun.name = eventWorkflowName;
      }
      const workflowName = workflowRun.name;
      if (workflowRun.scriptPath === undefined && /^[a-zA-Z0-9._-]+$/u.test(workflowName)) {
        for (const extension of ["ts", "js"] as const) {
          const candidate = path.resolve(
            context.session.cwd!,
            ".atomic",
            "workflows",
            `${workflowName}.${extension}`,
          );
          if (yield* fileSystem.exists(candidate).pipe(Effect.orElseSucceed(() => false))) {
            workflowRun.scriptPath = candidate;
            break;
          }
        }
      }
      let stage: AtomicWorkflowStageContext | undefined;
      if (stageId) {
        const eventStageName = field(data, "stageName") ?? field(data, "name");
        const eventParentIds = isStringArray(data.parentIds) ? data.parentIds : undefined;
        const replayKey = field(data, "replayKey");
        stage = workflowRun.stages.get(stageId);
        if (!stage) {
          stage = {
            id: stageId,
            index: workflowRun.stages.size,
            kind: "stage",
            name: eventStageName ?? stageId,
            parentIds: eventParentIds ?? [],
            awaitingInput:
              replayKey?.startsWith("prompt:") === true || entryType === "workflow.stage.waiting",
          };
          workflowRun.stages.set(stageId, stage);
        } else {
          if (eventStageName) stage.name = eventStageName;
          if (eventParentIds) stage.parentIds = eventParentIds;
          if (replayKey?.startsWith("prompt:") === true || entryType === "workflow.stage.waiting") {
            stage.awaitingInput = true;
          }
        }
      }
      if (stage && (entryType === "workflow.stage.resumed" || entryType === "workflow.stage.end")) {
        stage.awaitingInput = false;
      }
      const stageName = stage?.name;
      const source = raw(event, field(event, "type") ?? "workflow_lifecycle");
      const taskId = RuntimeTaskId.make(stage ? workflowStageTaskId(runId, stage.id) : runId);
      const linkage = stage
        ? ({
            ...workflowStageLinkage(runId, workflowRun, stage),
            ...(field(data, "model") ? { model: field(data, "model") } : {}),
          } as const)
        : ({
            taskType: "local_workflow",
            workflowName,
            title: workflowName,
            runHandles: {
              runId,
              ...(workflowRun.scriptPath ? { scriptPath: workflowRun.scriptPath } : {}),
            },
          } as const);

      if (entryType === "workflow.run.start" || entryType === "workflow.stage.start") {
        if (entryType === "workflow.run.start") workflowRun.status = "running";
        if (entryType === "workflow.stage.start" && stage) {
          stage.status = stage.awaitingInput ? "awaiting_input" : "running";
        }
        yield* publish({
          type: "task.started",
          ...(yield* eventStamp()),
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: context.threadId,
          ...(context.activeTurnId ? { turnId: context.activeTurnId } : {}),
          payload: {
            taskId,
            description:
              entryType === "workflow.run.start"
                ? `Running ${workflowName}`
                : `Running ${stageName ?? "workflow stage"}`,
            ...linkage,
          },
          raw: source,
        });
        if (entryType === "workflow.stage.start" && stage?.awaitingInput) {
          yield* publish({
            type: "task.updated",
            ...(yield* eventStamp()),
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            threadId: context.threadId,
            ...(context.activeTurnId ? { turnId: context.activeTurnId } : {}),
            payload: {
              taskId,
              status: "waiting",
              description: `Awaiting input for ${stage.name}`,
              ...linkage,
            },
            raw: source,
          });
          yield* requestWorkflowStatus(context, runId);
        }
        return true;
      }

      if (entryType === "workflow.stage.end" || entryType === "workflow.run.end") {
        yield* resolveWorkflowPrompt(
          context,
          runId,
          entryType === "workflow.stage.end" ? stageId : undefined,
        );
        const status = field(data, "status");
        const terminalStatus = workflowTerminalTaskStatus(status) ?? "completed";
        if (entryType === "workflow.run.end") workflowRun.status = terminalStatus;
        if (entryType === "workflow.stage.end" && stage) stage.status = terminalStatus;
        const summary =
          dataText(data.result) ?? field(data, "summary") ?? field(data, "error") ?? undefined;
        yield* publish({
          type: "task.completed",
          ...(yield* eventStamp()),
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: context.threadId,
          ...(context.activeTurnId ? { turnId: context.activeTurnId } : {}),
          payload: {
            taskId,
            status: terminalStatus,
            ...(summary ? { summary } : {}),
            ...linkage,
          },
          raw: source,
        });
        if (entryType === "workflow.run.end") {
          yield* requestWorkflowStatus(context, runId);
        }
        return true;
      }
      if (entryType === "workflow.stage.waiting" || entryType === "workflow.run.waiting") {
        if (stage) stage.status = "awaiting_input";
        if (entryType === "workflow.run.waiting") workflowRun.status = "awaiting_input";
        const prompt =
          field(data, "promptMessage") ?? `Awaiting input for ${stage?.name ?? workflowName}`;
        const promptId = field(data, "promptId");
        if (stage && promptId) {
          yield* openWorkflowPrompt(
            context,
            {
              runId,
              workflowName,
              stageId: stage.id,
              stageName: stage.name,
              prompt: {
                id: promptId,
                kind: field(data, "promptKind") ?? "input",
                message: prompt,
                ...(isStringArray(data.promptOptions) ? { options: data.promptOptions } : {}),
              },
            },
            event,
          );
        } else if (stage) {
          yield* requestWorkflowStatus(context, runId);
        }
        yield* publish({
          type: "task.progress",
          ...(yield* eventStamp()),
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: context.threadId,
          ...(context.activeTurnId ? { turnId: context.activeTurnId } : {}),
          payload: {
            taskId,
            status: "waiting",
            description: prompt,
            summary: prompt,
            ...linkage,
          },
          raw: source,
        });
        return true;
      }
      if (
        entryType === "workflow.stage.paused" ||
        entryType === "workflow.run.paused" ||
        entryType === "workflow.stage.resumed" ||
        entryType === "workflow.run.resumed"
      ) {
        const resumed = entryType.endsWith(".resumed");
        if (stage) stage.status = resumed ? "running" : "paused";
        if (!stage) workflowRun.status = resumed ? "running" : "paused";
        yield* publish({
          type: "task.updated",
          ...(yield* eventStamp()),
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: context.threadId,
          ...(context.activeTurnId ? { turnId: context.activeTurnId } : {}),
          payload: {
            taskId,
            status: resumed ? "running" : "idle",
            description: `${stageName ?? workflowName} ${resumed ? "resumed" : "paused"}`,
            ...linkage,
          },
          raw: source,
        });
        return true;
      }
      return true;
    });

  const handleEvent = (
    context: AtomicSessionContext,
    event: AtomicRpcEvent,
  ): Effect.Effect<void, ProviderAdapterError> =>
    Effect.gen(function* () {
      const type = field(event, "type");
      if (!type) return;
      if (yield* handleOmpSubagentEvent(context, event)) return;
      if (type === "extension_ui_request") {
        if (context.suppressAgentEventsUntilNextTurn) return;
        return yield* handleExtensionUi(context, event);
      }
      if (type === "message_end" && (yield* handleWorkflowActionResult(context, event))) return;
      if (type === "entry_appended" && (yield* handleWorkflowEntry(context, event))) return;
      if (type === "message_end") {
        yield* handleWorkflowEntry(context, event);
      }
      if (context.suppressAgentEventsUntilNextTurn) return;
      if (type === "extension_error") {
        yield* publish({
          // Pi treats extension loading as best-effort: one incompatible
          // extension can fail while the agent and every other extension keep
          // running. Preserve that recoverability in T3. Transport failures
          // and assistant message errors still use runtime.error below.
          type: "runtime.warning",
          ...(yield* eventStamp()),
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: context.threadId,
          ...(context.activeTurnId ? { turnId: context.activeTurnId } : {}),
          payload: {
            message:
              field(event, "error") ??
              field(event, "message") ??
              `${definition.displayName} extension failed.`,
            detail: {
              kind: "extension_error",
              ...(field(event, "extensionPath")
                ? { extensionPath: field(event, "extensionPath") }
                : {}),
            },
          },
          raw: raw(event, type),
        });
        return;
      }
      if (type === "auto_retry_start" || type === "summarization_retry_scheduled") {
        const attempt = nonNegativeNumber(event.attempt);
        const maxAttempts = nonNegativeNumber(event.maxAttempts);
        const delayMs = nonNegativeNumber(event.delayMs);
        yield* publish({
          type: "runtime.warning",
          ...(yield* eventStamp()),
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: context.threadId,
          ...(context.activeTurnId ? { turnId: context.activeTurnId } : {}),
          payload: {
            message: `${definition.displayName} is retrying${attempt === undefined ? "" : ` (attempt ${attempt}${maxAttempts === undefined ? "" : ` of ${maxAttempts}`})`}${delayMs === undefined ? "." : ` in ${Math.ceil(delayMs / 1000)}s.`}`,
            detail: event,
          },
          raw: raw(event, type),
        });
        return;
      }
      if (type === "auto_retry_end") {
        if (event.success === false) {
          yield* publish({
            type: "runtime.warning",
            ...(yield* eventStamp()),
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            threadId: context.threadId,
            ...(context.activeTurnId ? { turnId: context.activeTurnId } : {}),
            payload: {
              message:
                field(event, "finalError") ?? `${definition.displayName} exhausted its retries.`,
              detail: event,
            },
            raw: raw(event, type),
          });
        }
        return;
      }
      if (type === "agent_start") {
        context.sawAgentActivity = true;
        yield* startProviderTurn(context);
        return;
      }
      const turnId = context.activeTurnId;
      if (!turnId) return;
      const source = raw(event, type);
      if (type === "command_output") {
        const text = field(event, "text");
        if (!text) return;
        context.messageSequence += 1;
        const itemId = RuntimeItemId.make(`${turnId}:command:${context.messageSequence}`);
        yield* publish({
          type: "item.started",
          ...(yield* eventStamp()),
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: context.threadId,
          turnId,
          itemId,
          payload: { itemType: "assistant_message", status: "inProgress" },
          raw: source,
        });
        yield* publish({
          type: "content.delta",
          ...(yield* eventStamp()),
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: context.threadId,
          turnId,
          itemId,
          payload: { streamKind: "assistant_text", delta: text },
          raw: source,
        });
        yield* publish({
          type: "item.completed",
          ...(yield* eventStamp()),
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: context.threadId,
          turnId,
          itemId,
          payload: { itemType: "assistant_message", status: "completed" },
          raw: source,
        });
        return;
      }
      if (type === "prompt_result" && event.agentInvoked === false) {
        yield* settleActiveProviderTurn(context, turnId, source);
        return;
      }
      if (type === "message_start") {
        const message = isRecord(event.message) ? event.message : undefined;
        if (message && field(message, "role") !== "assistant") return;
        context.sawAgentActivity = true;
        context.messageSequence += 1;
        context.assistantItemId = RuntimeItemId.make(
          `${turnId}:assistant:${context.messageSequence}`,
        );
        context.reasoningItemId = undefined;
        context.assistantText = "";
        context.reasoningText = "";
        yield* publish({
          type: "item.started",
          ...(yield* eventStamp()),
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: context.threadId,
          turnId,
          itemId: context.assistantItemId,
          payload: { itemType: "assistant_message", status: "inProgress" },
          raw: source,
        });
        return;
      }
      if (type === "message_update") {
        const update = isRecord(event.assistantMessageEvent)
          ? event.assistantMessageEvent
          : undefined;
        const updateType = update ? field(update, "type") : undefined;
        if (updateType === "error") {
          const error = update && isRecord(update.error) ? update.error : undefined;
          context.pendingAssistantError =
            (update && field(update, "error")) ??
            (error && field(error, "errorMessage")) ??
            `${definition.displayName} assistant stream failed.`;
          return;
        }
        const delta = update ? stringField(update, "delta") : undefined;
        if (
          delta === undefined ||
          (updateType !== "text_delta" && updateType !== "thinking_delta")
        ) {
          return;
        }
        const isThinking = updateType === "thinking_delta";
        if (isThinking && !context.reasoningItemId) {
          context.reasoningItemId = RuntimeItemId.make(
            `${turnId}:reasoning:${context.messageSequence}`,
          );
          yield* publish({
            type: "item.started",
            ...(yield* eventStamp()),
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            threadId: context.threadId,
            turnId,
            itemId: context.reasoningItemId,
            payload: { itemType: "reasoning", status: "inProgress" },
            raw: source,
          });
        }
        if (!isThinking && !context.assistantItemId) {
          context.messageSequence += 1;
          context.assistantItemId = RuntimeItemId.make(
            `${turnId}:assistant:${context.messageSequence}`,
          );
          yield* publish({
            type: "item.started",
            ...(yield* eventStamp()),
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            threadId: context.threadId,
            turnId,
            itemId: context.assistantItemId,
            payload: { itemType: "assistant_message", status: "inProgress" },
            raw: source,
          });
        }
        const itemId = isThinking ? context.reasoningItemId : context.assistantItemId;
        if (!itemId) return;
        if (isThinking) context.reasoningText += delta;
        else context.assistantText += delta;
        yield* publish({
          type: "content.delta",
          ...(yield* eventStamp()),
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: context.threadId,
          turnId,
          itemId,
          payload: { streamKind: isThinking ? "reasoning_text" : "assistant_text", delta },
          raw: source,
        });
        return;
      }
      if (type === "message_end") {
        const message = isRecord(event.message) ? event.message : undefined;
        const role = message ? field(message, "role") : undefined;
        if (role === "custom" && message) {
          if (isBoolean(message.display) && !message.display) return;
          const text = visibleMessageText(message);
          if (!text) return;
          context.messageSequence += 1;
          const itemId = RuntimeItemId.make(`${turnId}:custom:${context.messageSequence}`);
          yield* publish({
            type: "item.started",
            ...(yield* eventStamp()),
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            threadId: context.threadId,
            turnId,
            itemId,
            payload: { itemType: "assistant_message", status: "inProgress" },
            raw: source,
          });
          yield* publish({
            type: "content.delta",
            ...(yield* eventStamp()),
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            threadId: context.threadId,
            turnId,
            itemId,
            payload: { streamKind: "assistant_text", delta: text },
            raw: source,
          });
          yield* publish({
            type: "item.completed",
            ...(yield* eventStamp()),
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            threadId: context.threadId,
            turnId,
            itemId,
            payload: { itemType: "assistant_message", status: "completed" },
            raw: source,
          });
          return;
        }
        if (role !== undefined && role !== "assistant") return;
        if (message) {
          const stopReason = field(message, "stopReason");
          if (stopReason === "error") {
            context.pendingAssistantError =
              field(message, "errorMessage") ??
              context.pendingAssistantError ??
              `${definition.displayName} assistant stream failed.`;
          } else if (stopReason !== "aborted") {
            // Pi may recover from one failed model/tool-extension cycle and
            // continue the same agent turn. Only the last assistant outcome at
            // agent_settled is terminal for T3's thread lifecycle.
            context.pendingAssistantError = undefined;
          }
          const authoritativeReasoning = messageContent(message, "thinking");
          const authoritativeText = messageContent(message, "text");
          for (const [itemId, streamKind, current, final] of [
            [
              context.reasoningItemId,
              "reasoning_text",
              context.reasoningText,
              authoritativeReasoning,
            ],
            [context.assistantItemId, "assistant_text", context.assistantText, authoritativeText],
          ] as const) {
            if (!itemId || final.length <= current.length || !final.startsWith(current)) continue;
            yield* publish({
              type: "content.delta",
              ...(yield* eventStamp()),
              provider: PROVIDER,
              providerInstanceId: boundInstanceId,
              threadId: context.threadId,
              turnId,
              itemId,
              payload: { streamKind, delta: final.slice(current.length) },
              raw: source,
            });
          }
        }
        for (const [itemId, itemType] of [
          [context.reasoningItemId, "reasoning"],
          [context.assistantItemId, "assistant_message"],
        ] as const) {
          if (!itemId) continue;
          yield* publish({
            type: "item.completed",
            ...(yield* eventStamp()),
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            threadId: context.threadId,
            turnId,
            itemId,
            payload: { itemType, status: "completed" },
            raw: source,
          });
        }
        context.assistantItemId = undefined;
        context.reasoningItemId = undefined;
        context.assistantText = "";
        context.reasoningText = "";
        return;
      }
      if (
        type === "tool_execution_start" ||
        type === "tool_execution_update" ||
        type === "tool_execution_end"
      ) {
        const eventToolCallId = field(event, "toolCallId") ?? field(event, "id");
        const eventToolName = field(event, "toolName");
        if (
          eventToolCallId &&
          eventToolName &&
          PRIVATE_COMPUTER_USE_TOOL_PREFIXES.some((prefix) => eventToolName.startsWith(prefix))
        ) {
          context.privateComputerUseToolCalls.set(eventToolCallId, eventToolName);
        }
        const persistedEvent = sanitizePiComputerUseEvent(
          event,
          context.privateComputerUseToolCalls,
        );
        if (type === "tool_execution_end" && eventToolCallId) {
          context.privateComputerUseToolCalls.delete(eventToolCallId);
        }
        const toolCallId =
          field(persistedEvent, "toolCallId") ?? field(persistedEvent, "id") ?? `${turnId}:tool`;
        const itemId = RuntimeItemId.make(toolCallId);
        const toolName = field(persistedEvent, "toolName") ?? `${definition.displayName} tool`;
        let capturedOmpWorkflowCommand = false;
        if (
          definition.cliFlavor === "omp" &&
          type === "tool_execution_end" &&
          toolName === "write"
        ) {
          const args = isRecord(persistedEvent.args) ? persistedEvent.args : undefined;
          const writtenPath = args ? field(args, "path") : undefined;
          if (writtenPath) {
            const workflowCommandsRoot = path.resolve(context.cwd, ".omp", "commands");
            const candidate = path.resolve(context.cwd, writtenPath);
            if (
              path.extname(candidate).toLowerCase() === ".md" &&
              candidate.startsWith(`${workflowCommandsRoot}${path.sep}`)
            ) {
              context.ompWorkflowScriptPath = candidate;
              capturedOmpWorkflowCommand = true;
            }
          }
        }
        const lifecycle =
          type === "tool_execution_start"
            ? "item.started"
            : type === "tool_execution_update"
              ? "item.updated"
              : "item.completed";
        const isError = isBoolean(persistedEvent.isError) ? persistedEvent.isError : false;
        const detail = dataText(persistedEvent.partialResult ?? persistedEvent.result);
        const persistedSource = raw(persistedEvent, type);
        yield* publish({
          type: lifecycle,
          ...(yield* eventStamp()),
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: context.threadId,
          turnId,
          itemId,
          providerRefs: { providerItemId: ProviderItemId.make(toolCallId) },
          payload: {
            itemType: "dynamic_tool_call",
            status:
              lifecycle === "item.completed" ? (isError ? "failed" : "completed") : "inProgress",
            title: toolName,
            ...(detail ? { detail } : {}),
            data: persistedEvent,
          },
          raw: persistedSource,
        });
        if (
          definition.cliFlavor === "omp" &&
          type === "tool_execution_end" &&
          toolName === "todo"
        ) {
          yield* syncOmpTodos(context, persistedSource);
        } else if (capturedOmpWorkflowCommand) {
          yield* syncOmpTodos(context, persistedSource);
        }
        return;
      }
      if (type === "agent_settled") {
        yield* settleActiveProviderTurn(context, turnId, source);
        return;
      }
      // agent_end is the end of one low-level Pi run. Atomic may still retry,
      // compact, or deliver queued workflow follow-ups; agent_settled is the
      // only terminal lifecycle signal.
      if (type === "agent_end") {
        if (definition.cliFlavor !== "omp" || event.isTerminal === false) return;
        yield* syncOmpTodos(context, source);
        if (context.ompSubagents.size > 0) {
          return;
        }
        yield* settleActiveProviderTurn(context, turnId, source);
        return;
      }
      if (
        type === "compaction_start" ||
        type === "compaction_end" ||
        type === "auto_compaction_start" ||
        type === "auto_compaction_end"
      ) {
        const isStart = type === "compaction_start" || type === "auto_compaction_start";
        const itemId = RuntimeItemId.make(`${turnId}:compaction`);
        yield* publish({
          type: isStart ? "item.started" : "item.completed",
          ...(yield* eventStamp()),
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: context.threadId,
          turnId,
          itemId,
          payload: {
            itemType: "context_compaction",
            status: isStart ? "inProgress" : "completed",
          },
          raw: source,
        });
      }
    });

  const stopActiveWorkflowTasks = (context: AtomicSessionContext) =>
    Effect.gen(function* () {
      for (const [runId, workflowRun] of context.workflowRuns) {
        for (const stage of workflowRun.stages.values()) {
          if (workflowTerminalTaskStatus(stage.status)) continue;
          stage.status = "stopped";
          yield* publish({
            type: "task.completed",
            ...(yield* eventStamp()),
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            threadId: context.threadId,
            ...(context.activeTurnId ? { turnId: context.activeTurnId } : {}),
            payload: {
              taskId: RuntimeTaskId.make(workflowStageTaskId(runId, stage.id)),
              status: "stopped",
              summary: "Provider session closed.",
              ...workflowStageLinkage(runId, workflowRun, stage),
            },
          });
        }
        if (workflowTerminalTaskStatus(workflowRun.status)) continue;
        workflowRun.status = "stopped";
        yield* publish({
          type: "task.completed",
          ...(yield* eventStamp()),
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: context.threadId,
          ...(context.activeTurnId ? { turnId: context.activeTurnId } : {}),
          payload: {
            taskId: RuntimeTaskId.make(runId),
            status: "stopped",
            summary: "Provider session closed.",
            taskType: "local_workflow",
            workflowName: workflowRun.name,
            title: workflowRun.name,
            runHandles: {
              runId,
              ...(workflowRun.scriptPath ? { scriptPath: workflowRun.scriptPath } : {}),
            },
          },
        });
      }
    });

  const stopSessionInternal = (context: AtomicSessionContext, emitExit: boolean) =>
    Effect.gen(function* () {
      if (context.stopped) return;
      context.stopped = true;
      yield* context.rpc.kill;
      yield* resolveAbandonedUiRequests(context, true);
      yield* stopActiveWorkflowTasks(context);
      yield* stopOmpTodoProjection(context, "Oh My Pi plan stopped with the provider session.");
      yield* stopOmpSubagentProjection(
        context,
        "Oh My Pi child stopped with the provider session.",
      );
      yield* completeActiveTurn(context, "interrupted", "Session stopped.");
      yield* Effect.ignore(Scope.close(context.scope, Exit.void));
      const ownsSession = sessions.get(context.threadId) === context;
      if (ownsSession) sessions.delete(context.threadId);
      if (emitExit && ownsSession) {
        yield* publish({
          type: "session.exited",
          ...(yield* eventStamp()),
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: context.threadId,
          payload: { exitKind: "graceful" },
        });
      }
    });

  const startSession: ProviderAdapterShape<ProviderAdapterError>["startSession"] = (input) =>
    withLifecycleLock(
      input.threadId,
      Effect.gen(function* () {
        if (input.provider !== undefined && input.provider !== PROVIDER) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
          });
        }
        const supportsOmpApprovals =
          definition.cliFlavor === "omp" && input.runtimeMode === "approval-required";
        if (input.runtimeMode !== "full-access" && !supportsOmpApprovals) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: `${definition.displayName} cannot honor the selected runtime mode. Choose Approval required or Full access for Oh My Pi sessions.`,
          });
        }
        const existing = sessions.get(input.threadId);
        if (existing) yield* stopSessionInternal(existing, false);
        const sessionScope = yield* Scope.make();
        let transferred = false;
        return yield* Effect.gen(function* () {
          const cwd = input.cwd ?? serverConfig.cwd;
          const mcpSession = McpProviderSession.readMcpProviderSession(input.threadId);
          const processLaunch = yield* Effect.gen(function* () {
            if (mcpSession === undefined) {
              return {
                args: sessionArgs(settings, definition, input.runtimeMode, input.title),
                environment,
              };
            }
            const extensionPath = yield* fileSystem
              .makeTempFileScoped({ prefix: "t3-computer-use-", suffix: ".mjs" })
              .pipe(Effect.provideService(Scope.Scope, sessionScope));
            yield* fileSystem.writeFileString(extensionPath, T3_COMPUTER_USE_PI_EXTENSION_SOURCE);
            yield* fileSystem.chmod(extensionPath, 0o600);
            return {
              args: [
                ...sessionArgs(settings, definition, input.runtimeMode, input.title),
                "--extension",
                extensionPath,
              ],
              environment: {
                ...environment,
                T3CODE_MCP_ENDPOINT: mcpSession.endpoint,
                T3CODE_MCP_AUTHORIZATION: mcpSession.authorizationHeader,
                T3CODE_MCP_CAPABILITIES: Array.from(mcpSession.capabilities).sort().join(","),
              },
            };
          }).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterProcessError({
                  provider: PROVIDER,
                  threadId: input.threadId,
                  detail: `Failed to prepare the private ${definition.displayName} Computer Use extension.`,
                  cause,
                }),
            ),
          );
          const rpc = yield* makeAtomicRpcProcess({
            binaryPath: settings.binaryPath,
            runtimeName: definition.displayName,
            args: processLaunch.args,
            cwd,
            environment: processLaunch.environment,
            ...(options?.startupTimeout === undefined
              ? {}
              : { startupTimeout: options.startupTimeout }),
            ...(options?.requestTimeout === undefined
              ? {}
              : { requestTimeout: options.requestTimeout }),
          }).pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
            Effect.provideService(FileSystem.FileSystem, fileSystem),
            Effect.provideService(Path.Path, path),
            Effect.provideService(Scope.Scope, sessionScope),
            Effect.mapError(
              (cause) =>
                new ProviderAdapterProcessError({
                  provider: PROVIDER,
                  threadId: input.threadId,
                  detail: cause.message,
                  cause,
                }),
            ),
          );
          if (definition.protocolVersion !== undefined) {
            yield* rpc
              .request({
                type: "negotiate_protocol",
                protocolVersion: definition.protocolVersion,
              })
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new ProviderAdapterRequestError({
                      provider: PROVIDER,
                      method: "negotiate_protocol",
                      detail: cause.message,
                      cause,
                    }),
                ),
              );
          }
          const resume = Option.getOrUndefined(decodeResumeCursor(input.resumeCursor));
          if (resume?.sessionFile) {
            yield* rpc.request({ type: "switch_session", sessionPath: resume.sessionFile }).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterRequestError({
                    provider: PROVIDER,
                    method: "switch_session",
                    detail: cause.message,
                    cause,
                  }),
              ),
            );
          }
          if (definition.cliFlavor === "omp" && input.title?.trim()) {
            yield* rpc.request({ type: "set_session_name", name: input.title.trim() }).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterRequestError({
                    provider: PROVIDER,
                    method: "set_session_name",
                    detail: cause.message,
                    cause,
                  }),
              ),
            );
          }
          const initialOmpSubagents = new Map<string, OmpSubagentContext>();
          if (definition.cliFlavor === "omp") {
            yield* rpc.request({ type: "set_subagent_subscription", level: "events" }).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterRequestError({
                    provider: PROVIDER,
                    method: "set_subagent_subscription",
                    detail: cause.message,
                    cause,
                  }),
              ),
            );
          }
          const selection =
            input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;
          const model = parseModelSlug(selection?.model);
          if (model) {
            yield* rpc.request({ type: "set_model", ...model }).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterRequestError({
                    provider: PROVIDER,
                    method: "set_model",
                    detail: cause.message,
                    cause,
                  }),
              ),
            );
          }
          const thinkingLevel = getModelSelectionStringOptionValue(selection, "reasoningEffort");
          if (thinkingLevel) {
            yield* rpc.request({ type: "set_thinking_level", level: thinkingLevel }).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterRequestError({
                    provider: PROVIDER,
                    method: "set_thinking_level",
                    detail: cause.message,
                    cause,
                  }),
              ),
            );
          }
          const stateResponse = yield* rpc.request({ type: "get_state" }).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "get_state",
                  detail: cause.message,
                  cause,
                }),
            ),
          );
          const state = Option.getOrUndefined(decodeState(stateResponse.data));
          const now = yield* nowIso;
          const selectedModel = state?.model
            ? `${state.model.provider}/${state.model.id}`
            : selection?.model;
          const session: ProviderSession = {
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            status: "ready",
            runtimeMode: input.runtimeMode,
            cwd,
            ...(selectedModel ? { model: selectedModel } : {}),
            threadId: input.threadId,
            resumeCursor: {
              schemaVersion: RESUME_VERSION,
              ...(state?.sessionFile ? { sessionFile: state.sessionFile } : {}),
              ...(state?.sessionId ? { sessionId: state.sessionId } : {}),
            },
            createdAt: now,
            updatedAt: now,
          };
          const mappedEventSequence = yield* SubscriptionRef.make(
            stateResponse.precedingEventSequence,
          );
          const context: AtomicSessionContext = {
            threadId: input.threadId,
            cwd,
            scope: sessionScope,
            rpc,
            session,
            activeTurnId: undefined,
            assistantItemId: undefined,
            reasoningItemId: undefined,
            messageSequence: 0,
            assistantText: "",
            reasoningText: "",
            pendingAssistantError: undefined,
            sawAgentActivity: false,
            promptInFlightTurnId: undefined,
            suppressAgentEventsUntilNextTurn: false,
            pendingUi: new Map(),
            workflowRuns: new Map(),
            workflowLifecycleSignatures: new Map(),
            privateComputerUseToolCalls: new Map(),
            ompSubagents: initialOmpSubagents,
            ompSettledSubagentIds: new Set(),
            ompTodoStatuses: new Map(),
            ompTodoRunGeneration: definition.cliFlavor === "omp" ? yield* randomId : "",
            ompTodoRunSequence: 0,
            ompTodoRunId: undefined,
            ompTodoPlanSignature: undefined,
            ompTodoCompletedTurnId: undefined,
            ompTodoDescriptions: new Map(),
            ompTodoRootState: "idle",
            ompWorkflowScriptPath: undefined,
            ompPublishedWorkflowScriptPath: undefined,
            // The event consumer is attached after the initialization RPCs.
            // Treat everything observed before get_state's response as the
            // baseline; those startup frames cannot belong to a T3 turn.
            mappedEventSequence,
            turns: [],
            stopped: false,
          };
          yield* rpc.events.pipe(
            Stream.runForEach((event) => {
              const sequence = atomicRpcEventSequence(event);
              return handleEvent(context, event).pipe(
                Effect.catch((cause) =>
                  Effect.logWarning(`Failed to map a ${definition.displayName} RPC event.`, {
                    cause,
                  }),
                ),
                Effect.tap(() =>
                  sequence === undefined
                    ? Effect.void
                    : SubscriptionRef.set(context.mappedEventSequence, sequence),
                ),
              );
            }),
            Effect.forkIn(sessionScope),
          );
          return yield* Effect.gen(function* () {
            sessions.set(input.threadId, context);
            transferred = true;
            yield* publish({
              type: "session.started",
              ...(yield* eventStamp()),
              provider: PROVIDER,
              providerInstanceId: boundInstanceId,
              threadId: input.threadId,
              payload: {
                message: `${definition.displayName} RPC session ready`,
                resume: session.resumeCursor,
              },
            });
            yield* publish({
              type: "session.state.changed",
              ...(yield* eventStamp()),
              provider: PROVIDER,
              providerInstanceId: boundInstanceId,
              threadId: input.threadId,
              payload: {
                state: "ready",
                reason: `${definition.displayName} RPC session ready`,
              },
            });
            yield* publish({
              type: "thread.started",
              ...(yield* eventStamp()),
              provider: PROVIDER,
              providerInstanceId: boundInstanceId,
              threadId: input.threadId,
              payload: { providerThreadId: state?.sessionId },
            });
            if (definition.cliFlavor === "omp") {
              const subagentsResponse = yield* rpc.request({ type: "get_subagents" }).pipe(
                Effect.mapError(
                  (cause) =>
                    new ProviderAdapterRequestError({
                      provider: PROVIDER,
                      method: "get_subagents",
                      detail: cause.message,
                      cause,
                    }),
                ),
              );
              yield* awaitMappedEvents(context, subagentsResponse.precedingEventSequence);
              const subagentsData = isRecord(subagentsResponse.data)
                ? subagentsResponse.data
                : undefined;
              if (Array.isArray(subagentsData?.subagents)) {
                for (const value of subagentsData.subagents) {
                  if (!isRecord(value)) continue;
                  const id = field(value, "id");
                  const status = field(value, "status");
                  if (
                    !id ||
                    context.ompSubagents.has(id) ||
                    context.ompSettledSubagentIds.has(id) ||
                    status === "completed" ||
                    status === "failed" ||
                    status === "aborted"
                  ) {
                    continue;
                  }
                  const progress = isRecord(value.progress) ? value.progress : undefined;
                  initialOmpSubagents.set(id, {
                    id,
                    agent: field(value, "agent") ?? "OMP subagent",
                    description: field(value, "description"),
                    sessionFile: field(value, "sessionFile"),
                    parentToolCallId: field(value, "parentToolCallId"),
                    index: nonNegativeInteger(value.index),
                    model: progress ? field(progress, "resolvedModel") : undefined,
                    task: field(value, "task"),
                  });
                }
              }
              for (const subagent of initialOmpSubagents.values()) {
                context.ompSubagents.set(subagent.id, subagent);
                yield* publish({
                  type: "task.started",
                  ...(yield* eventStamp()),
                  provider: PROVIDER,
                  providerInstanceId: boundInstanceId,
                  threadId: input.threadId,
                  payload: {
                    taskId: RuntimeTaskId.make(subagent.id),
                    description: subagent.description ?? `Running ${subagent.agent}`,
                    ...ompSubagentLinkage(subagent),
                  },
                });
              }
              yield* syncOmpTodos(
                context,
                raw({ type: "get_state" }, "get_state"),
                state?.todoPhases,
              );
            }
            return session;
          }).pipe(Effect.tapError(() => stopSessionInternal(context, true).pipe(Effect.ignore)));
        }).pipe(
          Effect.ensuring(
            Effect.suspend(() =>
              transferred ? Effect.void : Effect.ignore(Scope.close(sessionScope, Exit.void)),
            ),
          ),
        );
      }),
    );

  const sendTurn: ProviderAdapterShape<ProviderAdapterError>["sendTurn"] = (input) =>
    withTurnLock(
      input.threadId,
      Effect.gen(function* () {
        const context = yield* requireSession(input.threadId);
        const text = input.input?.trim();
        const images = yield* Effect.forEach(input.attachments ?? [], (attachment) =>
          Effect.gen(function* () {
            const attachmentPath = resolveAttachmentPath({
              attachmentsDir: serverConfig.attachmentsDir,
              attachment,
            });
            if (!attachmentPath) {
              return yield* new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "prompt",
                detail: `Invalid attachment id '${attachment.id}'.`,
              });
            }
            const bytes = yield* fileSystem.readFile(attachmentPath).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterRequestError({
                    provider: PROVIDER,
                    method: "prompt",
                    detail: cause.message,
                    cause,
                  }),
              ),
            );
            return {
              type: "image",
              data: Buffer.from(bytes).toString("base64"),
              mimeType: attachment.mimeType,
            };
          }),
        );
        if (!text && images.length === 0) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "Turn requires non-empty text or attachments.",
          });
        }
        const ompQueueCommand =
          definition.cliFlavor === "omp" && text
            ? /^\/(follow-up|steer)\s+([\s\S]+)$/iu.exec(text)
            : null;
        const explicitStreamingBehavior =
          ompQueueCommand?.[1] === "follow-up"
            ? "followUp"
            : ompQueueCommand?.[1] === "steer"
              ? "steer"
              : undefined;
        const promptText = ompQueueCommand?.[2]?.trim() || text;
        if (explicitStreamingBehavior !== undefined && context.activeTurnId === undefined) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: `/${ompQueueCommand?.[1]} requires an active Oh My Pi turn.`,
          });
        }
        const selection =
          input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;
        const selectedModel = parseModelSlug(selection?.model);
        if (selectedModel && selection?.model !== context.session.model) {
          yield* context.rpc.request({ type: "set_model", ...selectedModel }).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "set_model",
                  detail: cause.message,
                  cause,
                }),
            ),
          );
        }
        const thinkingLevel = getModelSelectionStringOptionValue(selection, "reasoningEffort");
        if (thinkingLevel) {
          yield* context.rpc.request({ type: "set_thinking_level", level: thinkingLevel }).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "set_thinking_level",
                  detail: cause.message,
                  cause,
                }),
            ),
          );
        }
        const steering = context.activeTurnId !== undefined;
        const turnId = context.activeTurnId ?? TurnId.make(yield* randomId);
        if (!steering) {
          context.activeTurnId = turnId;
          context.pendingAssistantError = undefined;
          context.sawAgentActivity = false;
          context.session = {
            ...context.session,
            status: "running",
            activeTurnId: turnId,
            updatedAt: yield* nowIso,
            ...(selection?.model ? { model: selection.model } : {}),
          };
          context.turns.push({
            id: turnId,
            items: [{ input: text, attachments: input.attachments }],
          });
          yield* publish({
            type: "turn.started",
            ...(yield* eventStamp()),
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            threadId: input.threadId,
            turnId,
            payload: {
              ...(selection?.model ? { model: selection.model } : {}),
              ...(thinkingLevel ? { effort: thinkingLevel } : {}),
            },
          });
        }
        context.promptInFlightTurnId = turnId;
        context.suppressAgentEventsUntilNextTurn = false;
        return yield* Effect.gen(function* () {
          const promptResponse = yield* context.rpc
            .request(
              {
                type: "prompt",
                message: promptText ?? "Please inspect the attached image.",
                ...(images.length > 0 ? { images } : {}),
                ...(steering ? { streamingBehavior: explicitStreamingBehavior ?? "steer" } : {}),
              },
              Duration.infinity,
            )
            .pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterRequestError({
                    provider: PROVIDER,
                    method: "prompt",
                    detail: cause.message,
                    cause,
                  }),
              ),
            );
          // Atomic writes custom/workflow events before the prompt response,
          // but the transport and adapter consume on separate fibers. Drain
          // those already-read events before deciding an extension-only turn
          // was idle.
          yield* awaitMappedEvents(context, promptResponse.precedingEventSequence);
          // Dialogs with provider-side timeouts resolve without a separate RPC
          // callback. Once the owning prompt has returned, any remaining cards
          // are stale and must not leave T3 permanently awaiting input.
          yield* resolveAbandonedUiRequests(context);
          if (!steering && context.activeTurnId === turnId && !context.sawAgentActivity) {
            const stateResponse = yield* context.rpc.request({ type: "get_state" }).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterRequestError({
                    provider: PROVIDER,
                    method: "get_state",
                    detail: cause.message,
                    cause,
                  }),
              ),
            );
            // get_state may report idle immediately after Pi has emitted
            // agent_settled while the adapter fiber is still mapping that
            // event. Drain everything already observed by the transport before
            // using the extension-only fallback, or a genuine terminal error
            // can be overwritten by a synthetic successful completion.
            yield* awaitMappedEvents(context, stateResponse.precedingEventSequence);
            if (context.activeTurnId !== turnId) {
              return {
                threadId: input.threadId,
                turnId,
                resumeCursor: context.session.resumeCursor,
              };
            }
            const state = Option.getOrUndefined(decodeState(stateResponse.data));
            if (state?.isStreaming === undefined) {
              return yield* new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "get_state",
                detail: `${definition.displayName} RPC state did not report whether the session is streaming.`,
              });
            }
            // Extension commands such as `/workflow list` can emit custom chat
            // messages without ever starting a Pi agent run. Their prompt
            // response is accepted and get_state reports idle, so settle the T3
            // turn explicitly instead of waiting for an agent event that will
            // never arrive.
            if (state.isStreaming === false) {
              yield* completeActiveTurn(context, "completed");
            }
          }
          return { threadId: input.threadId, turnId, resumeCursor: context.session.resumeCursor };
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              if (context.promptInFlightTurnId !== turnId) return;
              context.promptInFlightTurnId = undefined;
            }),
          ),
          Effect.tapError((cause) =>
            context.stopped
              ? Effect.void
              : Effect.gen(function* () {
                  yield* completeActiveTurn(context, "failed", cause.message);
                  yield* stopSessionInternal(context, false);
                }),
          ),
        );
      }),
    );

  const interruptTurn: ProviderAdapterShape<ProviderAdapterError>["interruptTurn"] = (threadId) =>
    Effect.gen(function* () {
      const context = yield* requireSession(threadId);
      const promptInFlightTurnId = context.promptInFlightTurnId;
      const response = yield* context.rpc.request({ type: "abort" }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "abort",
              detail: cause.message,
              cause,
            }),
        ),
      );
      yield* awaitMappedEvents(context, response.precedingEventSequence);
      if (
        promptInFlightTurnId !== undefined &&
        context.promptInFlightTurnId === promptInFlightTurnId
      ) {
        // Keep suppressing unscoped Pi agent events even after the interrupted
        // prompt response arrives. Some runtimes flush buffered events after
        // that response; the next explicit T3 turn is the safe reset point.
        context.suppressAgentEventsUntilNextTurn = true;
      }
      yield* resolveAbandonedUiRequests(context);
      yield* stopOmpTodoProjection(context, "Oh My Pi plan was interrupted.");
      yield* stopOmpSubagentProjection(context, "Oh My Pi child was interrupted.");
      yield* completeActiveTurn(context, "interrupted");
    });

  const respondToRequest: ProviderAdapterShape<ProviderAdapterError>["respondToRequest"] = (
    threadId,
    requestId,
    decision,
  ) =>
    Effect.gen(function* () {
      const context = yield* requireSession(threadId);
      const pending = context.pendingUi.get(requestId);
      if (!pending || pending._tag !== "computer-approval") {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "respondToRequest",
          detail: `Unknown ${definition.displayName} Computer Use approval: ${requestId}`,
        });
      }
      const resolved = yield* ComputerUsePolicy.resolveActiveComputerUseApproval(
        pending.approvalId,
        decision,
      );
      if (!resolved) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "respondToRequest",
          detail: `Stale T3 Computer Use approval: ${pending.approvalId}`,
        });
      }
      const value = pending.labels[decision];
      yield* context.rpc
        .notify({
          type: "extension_ui_response",
          id: pending.atomicRequestId,
          ...(decision === "cancel" || value === undefined ? { cancelled: true } : { value }),
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "extension_ui_response",
                detail: cause.message,
                cause,
              }),
          ),
        );
      context.pendingUi.delete(requestId);
      yield* publish({
        type: "request.resolved",
        ...(yield* eventStamp()),
        provider: PROVIDER,
        providerInstanceId: boundInstanceId,
        threadId,
        ...(context.activeTurnId ? { turnId: context.activeTurnId } : {}),
        requestId: RuntimeRequestId.make(requestId),
        payload: { requestType: "mcp_elicitation_approval", decision },
      });
    });

  const respondToUserInput: ProviderAdapterShape<ProviderAdapterError>["respondToUserInput"] = (
    threadId,
    requestId,
    answers,
  ) =>
    Effect.gen(function* () {
      const context = yield* requireSession(threadId);
      const pending = context.pendingUi.get(requestId);
      if (!pending) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "extension_ui_response",
          detail: `Unknown ${definition.displayName} UI request: ${requestId}`,
        });
      }
      if (pending._tag === "workflow-input") {
        const answer = answers[pending.questionId];
        const submittedAnswer = isString(answer)
          ? answer
          : isStringArray(answer)
            ? answer
            : undefined;
        const value = isString(submittedAnswer) ? submittedAnswer : submittedAnswer?.[0];
        if (submittedAnswer === undefined || value === undefined) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "respondToUserInput",
            issue: "Atomic workflow responses require an answer.",
          });
        }
        const response = pending.promptKind === "confirm" ? value.toLowerCase() === "yes" : value;
        const submittedAnswers = { [pending.questionId]: submittedAnswer };
        context.pendingUi.set(requestId, { ...pending, submittedAnswers });
        const actionId = yield* randomId;
        const workflowResponse = yield* context.rpc
          .request(
            {
              type: "prompt",
              message: workflowActionCommand(actionId, {
                action: "send",
                runId: pending.runId,
                stageId: pending.stageId,
                promptId: pending.promptId,
                response,
                delivery: "answer",
              }),
            },
            Duration.seconds(30),
          )
          .pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "workflow/send",
                  detail: cause.message,
                  cause,
                }),
            ),
          );
        yield* awaitMappedEvents(context, workflowResponse.precedingEventSequence);
        if (context.pendingUi.has(requestId)) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "workflow/send",
            detail: `${definition.displayName} did not accept the workflow response.`,
          });
        }
        return;
      }
      if (pending._tag !== "input") {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "extension_ui_response",
          detail: `Computer Use approvals must use the approval response controls: ${requestId}`,
        });
      }
      const answer = answers[pending.questionId];
      const value = isString(answer) ? answer : isStringArray(answer) ? answer[0] : undefined;
      const response =
        pending.method === "confirm"
          ? value === undefined
            ? { cancelled: true }
            : { confirmed: value.toLowerCase() === "yes" }
          : value === undefined
            ? { cancelled: true }
            : { value };
      yield* context.rpc
        .notify({
          type: "extension_ui_response",
          id: pending.atomicRequestId,
          ...response,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "extension_ui_response",
                detail: cause.message,
                cause,
              }),
          ),
        );
      context.pendingUi.delete(requestId);
      yield* publish({
        type: "user-input.resolved",
        ...(yield* eventStamp()),
        provider: PROVIDER,
        providerInstanceId: boundInstanceId,
        threadId,
        ...(context.activeTurnId ? { turnId: context.activeTurnId } : {}),
        requestId: RuntimeRequestId.make(requestId),
        payload: { answers },
      });
    });

  const adapter: ProviderAdapterShape<ProviderAdapterError> = {
    provider: PROVIDER,
    capabilities: { sessionModelSwitch: "in-session" },
    startSession,
    sendTurn,
    interruptTurn,
    respondToRequest,
    respondToUserInput,
    stopSession: (threadId) =>
      withLifecycleLock(
        threadId,
        Effect.flatMap(requireSession(threadId), (context) => stopSessionInternal(context, true)),
      ),
    listSessions: () => Effect.sync(() => Array.from(sessions.values(), ({ session }) => session)),
    hasSession: (threadId) =>
      Effect.sync(() => {
        const context = sessions.get(threadId);
        return context !== undefined && !context.stopped;
      }),
    readThread: (threadId) =>
      Effect.map(requireSession(threadId), (context) => ({ threadId, turns: context.turns })),
    rollbackThread: (threadId, numTurns) =>
      Effect.gen(function* () {
        yield* requireSession(threadId);
        if (!Number.isInteger(numTurns) || numTurns < 1) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "rollbackThread",
            issue: "numTurns must be an integer >= 1.",
          });
        }
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "fork",
          detail: `${definition.displayName} session rollback is not available in this first integration.`,
        });
      }),
    stopAll: () =>
      Effect.forEach(
        Array.from(sessions.values()),
        (context) => stopSessionInternal(context, true),
        {
          discard: true,
        },
      ),
    streamEvents: Stream.fromPubSub(runtimeEvents),
  };
  return adapter;
});

const ATOMIC_ADAPTER_DEFINITION: PiCompatibleAdapterDefinition = {
  provider: ProviderDriverKind.make("atomic"),
  displayName: "Atomic",
  agentDirEnvironmentVariable: "ATOMIC_CODING_AGENT_DIR",
  rawSource: "atomic.rpc",
};

export function makeAtomicAdapter(settings: AtomicSettings, options?: AtomicAdapterOptions) {
  return makePiCompatibleAdapter(settings, ATOMIC_ADAPTER_DEFINITION, options);
}
