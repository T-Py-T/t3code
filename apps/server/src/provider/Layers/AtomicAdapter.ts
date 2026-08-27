import {
  ApprovalRequestId,
  type AtomicSettings,
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
import * as SynchronizedRef from "effect/SynchronizedRef";
import * as Semaphore from "effect/Semaphore";
import { ChildProcessSpawner } from "effect/unstable/process";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
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
});
const decodeState = Schema.decodeUnknownOption(AtomicStateData);
const AtomicResumeCursor = Schema.Struct({
  schemaVersion: Schema.Literal(RESUME_VERSION),
  sessionFile: Schema.optional(Schema.String),
  sessionId: Schema.optional(Schema.String),
});
const decodeResumeCursor = Schema.decodeUnknownOption(AtomicResumeCursor);

interface PendingUiRequest {
  readonly atomicRequestId: string;
  readonly method: string;
  readonly questionId: string;
}

interface AtomicWorkflowStageContext {
  readonly id: string;
  readonly index: number;
  name: string;
  parentIds: ReadonlyArray<string>;
  awaitingInput: boolean;
}

interface AtomicWorkflowRunContext {
  name: string;
  scriptPath: string | undefined;
  readonly stages: Map<string, AtomicWorkflowStageContext>;
}

interface AtomicSessionContext {
  readonly threadId: ThreadId;
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
  mappedEventSequence: number;
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
}

export interface PiCompatibleAdapterDefinition {
  readonly provider: ProviderDriverKind;
  readonly displayName: string;
  readonly agentDirEnvironmentVariable: "ATOMIC_CODING_AGENT_DIR" | "PI_CODING_AGENT_DIR";
  readonly rawSource: "atomic.rpc" | "pi.rpc";
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

function omitComputerUseScreenshotBytes(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(omitComputerUseScreenshotBytes);
  if (!isRecord(value)) return value;
  if (value.type === "image") {
    const { data: _data, base64: _base64, ...metadata } = value;
    return metadata;
  }
  const sanitized: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (key === "base64") continue;
    sanitized[key] = omitComputerUseScreenshotBytes(nested);
  }
  return sanitized;
}

/** Screenshot bytes belong only on the live provider transport, never in T3's event log. */
export function sanitizePiComputerUseEvent(event: AtomicRpcEvent): AtomicRpcEvent {
  const type = field(event, "type");
  const toolName = field(event, "toolName");
  if (!type?.startsWith("tool_execution_") || !toolName?.startsWith("computer_")) return event;
  return omitComputerUseScreenshotBytes(event) as AtomicRpcEvent;
}

function workflowStageTaskId(runId: string, stageId: string): string {
  return `${runId}:wf:${stageId}`;
}

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
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
  title: string | undefined,
): ReadonlyArray<string> {
  const configured = [...tokenizeCliArgs(settings.launchArgs)];
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

  const awaitMappedEvents = (context: AtomicSessionContext, target: number) => {
    const wait = (): Effect.Effect<void> =>
      context.mappedEventSequence >= target
        ? Effect.void
        : Effect.sleep(Duration.millis(1)).pipe(Effect.flatMap(wait));
    return wait().pipe(
      Effect.timeout(Duration.seconds(5)),
      Effect.catch(() =>
        Effect.logWarning(`Timed out draining ${definition.displayName} events through ${target}.`),
      ),
    );
  };

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
      const questionId = `${atomicRequestId}:answer`;
      const title = field(event, "title") ?? `${definition.displayName} needs input`;
      const question = field(event, "message") ?? title;
      const defaultValue = stringField(event, "prefill") ?? stringField(event, "initialValue");
      const selectOptions = isStringArray(event.options) ? event.options : [];
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
      context.pendingUi.set(requestId, { atomicRequestId, method, questionId });
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

  const resolveAbandonedUiRequests = (context: AtomicSessionContext) =>
    Effect.gen(function* () {
      for (const requestId of context.pendingUi.keys()) {
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
      context.pendingUi.clear();
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
      const phaseIndex = stage ? workflowStageDepth(workflowRun, stage) : undefined;
      const linkage = stage
        ? ({
            taskType: "local_agent",
            workflowName,
            workflowStageId: stage.id,
            title: stage.name,
            role: stage.awaitingInput ? "human input" : "workflow stage",
            ...(field(data, "model") ? { model: field(data, "model") } : {}),
            parentAgentId: runId,
            dependsOnTaskIds: stage.parentIds.map((parentId) =>
              RuntimeTaskId.make(workflowStageTaskId(runId, parentId)),
            ),
            agentIndex: stage.index,
            phaseIndex,
            phaseTitle: `Stage ${phaseIndex! + 1}`,
            timelineBypass: true,
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
        }
        return true;
      }

      if (entryType === "workflow.stage.end" || entryType === "workflow.run.end") {
        const status = field(data, "status");
        const terminalStatus =
          status === "failed" || status === "blocked"
            ? "failed"
            : status === "cancelled" || status === "interrupted" || status === "quit"
              ? "stopped"
              : "completed";
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
        return true;
      }
      if (entryType === "workflow.stage.waiting" || entryType === "workflow.run.waiting") {
        const prompt =
          field(data, "promptMessage") ?? `Awaiting input for ${stage?.name ?? workflowName}`;
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
      if (type === "extension_ui_request") {
        if (context.suppressAgentEventsUntilNextTurn) return;
        return yield* handleExtensionUi(context, event);
      }
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
        const persistedEvent = sanitizePiComputerUseEvent(event);
        const toolCallId =
          field(persistedEvent, "toolCallId") ?? field(persistedEvent, "id") ?? `${turnId}:tool`;
        const itemId = RuntimeItemId.make(toolCallId);
        const toolName = field(persistedEvent, "toolName") ?? `${definition.displayName} tool`;
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
        return;
      }
      if (type === "agent_settled") {
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
        return;
      }
      // agent_end is the end of one low-level Pi run. Atomic may still retry,
      // compact, or deliver queued workflow follow-ups; agent_settled is the
      // only terminal lifecycle signal.
      if (type === "agent_end") return;
      if (type === "compaction_start" || type === "compaction_end") {
        const itemId = RuntimeItemId.make(`${turnId}:compaction`);
        yield* publish({
          type: type === "compaction_start" ? "item.started" : "item.completed",
          ...(yield* eventStamp()),
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: context.threadId,
          turnId,
          itemId,
          payload: {
            itemType: "context_compaction",
            status: type === "compaction_start" ? "inProgress" : "completed",
          },
          raw: source,
        });
      }
    });

  const stopSessionInternal = (context: AtomicSessionContext, emitExit: boolean) =>
    Effect.gen(function* () {
      if (context.stopped) return;
      context.stopped = true;
      yield* context.rpc.kill;
      yield* resolveAbandonedUiRequests(context);
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
        if (input.runtimeMode !== "full-access") {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: `${definition.displayName} RPC does not expose approval callbacks. Choose Full access for ${definition.displayName} sessions.`,
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
              return { args: sessionArgs(settings, input.title), environment };
            }
            const extensionPath = yield* fileSystem
              .makeTempFileScoped({ prefix: "t3-computer-use-", suffix: ".mjs" })
              .pipe(Effect.provideService(Scope.Scope, sessionScope));
            yield* fileSystem.writeFileString(extensionPath, T3_COMPUTER_USE_PI_EXTENSION_SOURCE);
            yield* fileSystem.chmod(extensionPath, 0o600);
            return {
              args: [...sessionArgs(settings, input.title), "--extension", extensionPath],
              environment: {
                ...environment,
                T3CODE_MCP_ENDPOINT: mcpSession.endpoint,
                T3CODE_MCP_AUTHORIZATION: mcpSession.authorizationHeader,
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
          const context: AtomicSessionContext = {
            threadId: input.threadId,
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
            mappedEventSequence: 0,
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
                  Effect.sync(() => {
                    if (sequence !== undefined) context.mappedEventSequence = sequence;
                  }),
                ),
              );
            }),
            Effect.forkIn(sessionScope),
          );
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
          return session;
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
                message: text ?? "Please inspect the attached image.",
                ...(images.length > 0 ? { images } : {}),
                ...(steering ? { streamingBehavior: "steer" } : {}),
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
      yield* completeActiveTurn(context, "interrupted");
    });

  const respondToRequest = (
    _threadId: ThreadId,
    _requestId: ApprovalRequestId,
    _decision: ProviderApprovalDecision,
  ): Effect.Effect<void, ProviderAdapterError> =>
    Effect.fail(
      new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "respondToRequest",
        detail: `${definition.displayName} RPC does not expose approval requests.`,
      }),
    );

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
