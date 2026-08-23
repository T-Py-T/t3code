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
  type ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
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
  makeAtomicRpcProcess,
} from "../atomic/AtomicRpcProcess.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";

const PROVIDER = ProviderDriverKind.make("atomic");
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

interface AtomicSessionContext {
  readonly threadId: ThreadId;
  readonly scope: Scope.Closeable;
  readonly rpc: AtomicRpcProcess;
  session: ProviderSession;
  activeTurnId: TurnId | undefined;
  assistantItemId: RuntimeItemId | undefined;
  reasoningItemId: RuntimeItemId | undefined;
  readonly pendingUi: Map<ApprovalRequestId, PendingUiRequest>;
  turns: Array<{ id: TurnId; items: Array<unknown> }>;
  stopped: boolean;
}

export interface AtomicAdapterOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly instanceId?: ProviderInstanceId;
}

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

function dataText(value: unknown): string | undefined {
  if (isString(value)) return value;
  if (!isRecord(value)) return undefined;
  return field(value, "text") ?? field(value, "content") ?? field(value, "output");
}

function atomicEnvironment(
  settings: AtomicSettings,
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return settings.agentDir
    ? { ...environment, ATOMIC_CODING_AGENT_DIR: settings.agentDir }
    : environment;
}

function sessionArgs(settings: AtomicSettings, title: string | undefined): ReadonlyArray<string> {
  const configured = [...tokenizeCliArgs(settings.launchArgs)];
  const hasTrustFlag = configured.some((arg) => arg === "--approve" || arg === "--no-approve");
  return [
    ...(hasTrustFlag ? [] : ["--no-approve"]),
    ...configured,
    ...(title ? ["--name", title] : []),
  ];
}

export const makeAtomicAdapter = Effect.fn("makeAtomicAdapter")(function* (
  settings: AtomicSettings,
  options?: AtomicAdapterOptions,
) {
  const crypto = yield* Crypto.Crypto;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const serverConfig = yield* ServerConfig;
  const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("atomic");
  const environment = atomicEnvironment(settings, options?.environment ?? process.env);
  const sessions = new Map<ThreadId, AtomicSessionContext>();
  const locks = yield* SynchronizedRef.make(new Map<string, Semaphore.Semaphore>());
  const runtimeEvents = yield* PubSub.unbounded<ProviderRuntimeEvent>();
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const randomId = crypto.randomUUIDv4.pipe(
    Effect.mapError(
      (cause) =>
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "crypto/randomUUIDv4",
          detail: "Failed to generate an Atomic runtime identifier.",
          cause,
        }),
    ),
  );
  const eventStamp = () =>
    Effect.all({ eventId: Effect.map(randomId, EventId.make), createdAt: nowIso });
  const publish = (event: ProviderRuntimeEvent) =>
    PubSub.publish(runtimeEvents, event).pipe(Effect.asVoid);

  const getLock = (threadId: string) =>
    SynchronizedRef.modifyEffect(locks, (current) => {
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
  const withThreadLock = <A, E, R>(threadId: string, effect: Effect.Effect<A, E, R>) =>
    Effect.flatMap(getLock(threadId), (lock) => lock.withPermit(effect));

  const requireSession = (
    threadId: ThreadId,
  ): Effect.Effect<AtomicSessionContext, ProviderAdapterSessionNotFoundError> => {
    const context = sessions.get(threadId);
    return context && !context.stopped
      ? Effect.succeed(context)
      : Effect.fail(new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }));
  };

  const raw = (payload: AtomicRpcEvent, method?: string) => ({
    source: "atomic.rpc" as const,
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
        if (message) {
          yield* publish({
            type: field(event, "notifyType") === "error" ? "runtime.error" : "runtime.warning",
            ...(yield* eventStamp()),
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            threadId: context.threadId,
            ...(context.activeTurnId ? { turnId: context.activeTurnId } : {}),
            payload: {
              message,
              ...(field(event, "notifyType") === "error"
                ? { errorClass: "provider_error" as const }
                : {}),
            },
            raw: raw(event, "extension_ui_request"),
          });
        }
        return;
      }
      if (!["select", "confirm", "input", "editor"].includes(method)) return;
      const requestId = ApprovalRequestId.make(atomicRequestId);
      const questionId = `${atomicRequestId}:answer`;
      const title = field(event, "title") ?? "Atomic needs input";
      const question = field(event, "message") ?? title;
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
              options: optionsForQuestion,
              multiSelect: false,
            },
          ],
        },
        raw: raw(event, "extension_ui_request"),
      });
    });

  const handleEvent = (
    context: AtomicSessionContext,
    event: AtomicRpcEvent,
  ): Effect.Effect<void, ProviderAdapterError> =>
    Effect.gen(function* () {
      const type = field(event, "type");
      if (!type) return;
      if (type === "extension_ui_request") {
        return yield* handleExtensionUi(context, event);
      }
      const turnId = context.activeTurnId;
      if (!turnId) return;
      const source = raw(event, type);
      if (type === "message_start") {
        context.assistantItemId = RuntimeItemId.make(`${turnId}:assistant`);
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
        const delta = update ? field(update, "delta") : undefined;
        if (!delta || (updateType !== "text_delta" && updateType !== "thinking_delta")) return;
        const isThinking = updateType === "thinking_delta";
        if (isThinking && !context.reasoningItemId) {
          context.reasoningItemId = RuntimeItemId.make(`${turnId}:reasoning`);
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
          context.assistantItemId = RuntimeItemId.make(`${turnId}:assistant`);
        }
        yield* publish({
          type: "content.delta",
          ...(yield* eventStamp()),
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: context.threadId,
          turnId,
          itemId: isThinking ? context.reasoningItemId : context.assistantItemId,
          payload: { streamKind: isThinking ? "reasoning_text" : "assistant_text", delta },
          raw: source,
        });
        return;
      }
      if (type === "message_end") {
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
        return;
      }
      if (
        type === "tool_execution_start" ||
        type === "tool_execution_update" ||
        type === "tool_execution_end"
      ) {
        const toolCallId = field(event, "toolCallId") ?? field(event, "id") ?? `${turnId}:tool`;
        const itemId = RuntimeItemId.make(toolCallId);
        const toolName = field(event, "toolName") ?? "Atomic tool";
        const lifecycle =
          type === "tool_execution_start"
            ? "item.started"
            : type === "tool_execution_update"
              ? "item.updated"
              : "item.completed";
        const isError = isBoolean(event.isError) ? event.isError : false;
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
            ...(dataText(event.partialResult ?? event.result)
              ? { detail: dataText(event.partialResult ?? event.result) }
              : {}),
            data: event,
          },
          raw: source,
        });
        return;
      }
      if (type === "agent_end") {
        yield* completeActiveTurn(context, "completed");
        return;
      }
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
      yield* Effect.ignore(Scope.close(context.scope, Exit.void));
      sessions.delete(context.threadId);
      if (emitExit) {
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
    withThreadLock(
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
            issue:
              "Atomic RPC does not expose approval callbacks. Choose Full access for Atomic sessions.",
          });
        }
        const existing = sessions.get(input.threadId);
        if (existing) yield* stopSessionInternal(existing, false);
        const sessionScope = yield* Scope.make();
        let transferred = false;
        return yield* Effect.gen(function* () {
          const cwd = input.cwd ?? serverConfig.cwd;
          const rpc = yield* makeAtomicRpcProcess({
            binaryPath: settings.binaryPath,
            args: sessionArgs(settings, input.title),
            cwd,
            environment,
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
            pendingUi: new Map(),
            turns: [],
            stopped: false,
          };
          yield* rpc.events.pipe(
            Stream.runForEach((event) =>
              handleEvent(context, event).pipe(
                Effect.catch((cause) =>
                  Effect.logWarning("Failed to map an Atomic RPC event.", { cause }),
                ),
              ),
            ),
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
            payload: { message: "Atomic RPC session ready", resume: session.resumeCursor },
          });
          yield* publish({
            type: "session.state.changed",
            ...(yield* eventStamp()),
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            threadId: input.threadId,
            payload: { state: "ready", reason: "Atomic RPC session ready" },
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
            transferred ? Effect.void : Effect.ignore(Scope.close(sessionScope, Exit.void)),
          ),
        );
      }),
    );

  const sendTurn: ProviderAdapterShape<ProviderAdapterError>["sendTurn"] = (input) =>
    withThreadLock(
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
        yield* context.rpc
          .request({
            type: "prompt",
            message: text ?? "Please inspect the attached image.",
            ...(images.length > 0 ? { images } : {}),
            ...(steering ? { streamingBehavior: "steer" } : {}),
          })
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
        return { threadId: input.threadId, turnId, resumeCursor: context.session.resumeCursor };
      }),
    );

  const interruptTurn: ProviderAdapterShape<ProviderAdapterError>["interruptTurn"] = (threadId) =>
    Effect.gen(function* () {
      const context = yield* requireSession(threadId);
      yield* context.rpc.request({ type: "abort" }).pipe(
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
        detail: "Atomic RPC does not expose approval requests.",
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
          detail: `Unknown Atomic UI request: ${requestId}`,
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
      withThreadLock(
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
          detail: "Atomic session rollback is not available in this first integration.",
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
