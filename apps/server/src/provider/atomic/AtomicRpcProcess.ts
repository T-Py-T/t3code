import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as Ndjson from "effect/unstable/encoding/Ndjson";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

const AtomicRpcResponse = Schema.Struct({
  id: Schema.optional(Schema.String),
  type: Schema.Literal("response"),
  command: Schema.String,
  success: Schema.Boolean,
  data: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.String),
});
type AtomicRpcWireResponse = typeof AtomicRpcResponse.Type;
export type AtomicRpcResponse = AtomicRpcWireResponse & {
  /** Number of unsolicited events read before this response frame. */
  readonly precedingEventSequence: number;
};

const AtomicRpcEvent = Schema.Record(Schema.String, Schema.Unknown);
export type AtomicRpcEvent = typeof AtomicRpcEvent.Type;

const RpcChunkFrame = Schema.Struct({
  type: Schema.Literal("rpc_chunk"),
  chunkId: Schema.String,
  index: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  count: Schema.Int.check(Schema.isGreaterThan(0)),
  byteLength: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  data: Schema.String,
});
type RpcChunkFrame = typeof RpcChunkFrame.Type;

const RpcReadyFrame = Schema.Struct({
  type: Schema.Literal("ready"),
  maxReassembledFrameBytes: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
});

const eventSequences = new WeakMap<object, number>();

/** Ordered transport cursor attached out-of-band so it never pollutes raw provider data. */
export function atomicRpcEventSequence(event: AtomicRpcEvent): number | undefined {
  return eventSequences.get(event);
}

const isAtomicRpcResponse = Schema.is(AtomicRpcResponse);
const isAtomicRpcEvent = Schema.is(AtomicRpcEvent);
const isRpcChunkFrame = Schema.is(RpcChunkFrame);
const isRpcReadyFrame = Schema.is(RpcReadyFrame);
const encodeJsonString = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const decodeJsonString = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

export class AtomicRpcError extends Schema.TaggedErrorClass<AtomicRpcError>()("AtomicRpcError", {
  runtimeName: Schema.String,
  binaryPath: Schema.String,
  operation: Schema.String,
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `${this.runtimeName} RPC ${this.operation} failed: ${this.detail}`;
  }
}

export interface AtomicRpcProcess {
  readonly request: (
    command: Readonly<Record<string, unknown>>,
    timeout?: Duration.Input,
  ) => Effect.Effect<AtomicRpcResponse, AtomicRpcError>;
  readonly notify: (
    command: Readonly<Record<string, unknown>>,
  ) => Effect.Effect<void, AtomicRpcError>;
  readonly events: Stream.Stream<AtomicRpcEvent>;
  readonly kill: Effect.Effect<void>;
}

export interface AtomicRpcProcessOptions {
  readonly binaryPath: string;
  readonly runtimeName?: string;
  readonly args?: ReadonlyArray<string>;
  readonly cwd?: string;
  readonly environment?: NodeJS.ProcessEnv;
  /** Budget for commands issued before the first response, which pay the startup network cost. */
  readonly startupTimeout?: Duration.Input;
  /** Budget for every command after the runtime has answered once. */
  readonly requestTimeout?: Duration.Input;
}

const DEFAULT_REQUEST_TIMEOUT = Duration.seconds(15);
const MAX_RPC_REASSEMBLED_FRAME_BYTES = 64 * 1024 * 1024;
// OMP v18 emits at most 256 chunks for its 64 MiB reassembly budget. Keep the
// shared transport deliberately more permissive for other Pi-compatible
// runtimes while still preventing attacker-controlled, unbounded chunk arrays.
const MAX_RPC_CHUNK_COUNT = 65_536;
// Atomic performs network work before it sends its first response: it
// refreshes OAuth credentials and fetches the model catalog, rewriting
// auth.json and models-store.json. Measured cold start is ~28s against a
// fast connection and warm start ~0.7s, so the first round trip gets a much
// larger budget than steady-state commands. Corporate proxies make the cold
// case slower still.
const STARTUP_REQUEST_TIMEOUT = Duration.seconds(90);

export const makeAtomicRpcProcess = Effect.fn("makeAtomicRpcProcess")(function* (
  options: AtomicRpcProcessOptions,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const runtimeName = options.runtimeName ?? "Atomic";
  const environment = options.environment ?? process.env;
  const startupTimeout = options.startupTimeout ?? STARTUP_REQUEST_TIMEOUT;
  const requestTimeout = options.requestTimeout ?? DEFAULT_REQUEST_TIMEOUT;
  const args = ["--mode", "rpc", ...(options.args ?? [])];
  const spawnCommand = yield* resolveSpawnCommand(options.binaryPath, args, { env: environment });
  const command = ChildProcess.make(spawnCommand.command, spawnCommand.args, {
    ...(options.cwd ? { cwd: options.cwd } : {}),
    env: environment,
    shell: spawnCommand.shell,
    stdin: { stream: "pipe", endOnDone: false },
    stdout: "pipe",
    stderr: "pipe",
    killSignal: "SIGTERM",
    forceKillAfter: Duration.seconds(2),
  });
  const handle = yield* Effect.acquireRelease(
    spawner.spawn(command).pipe(
      Effect.mapError(
        (cause) =>
          new AtomicRpcError({
            runtimeName,
            binaryPath: options.binaryPath,
            operation: "spawn",
            detail: `Could not start ${runtimeName} from '${options.binaryPath}'.`,
            cause,
          }),
      ),
    ),
    (child) => child.kill().pipe(Effect.ignore),
  );
  const events = yield* PubSub.unbounded<AtomicRpcEvent>();
  const pending = new Map<string, Deferred.Deferred<AtomicRpcResponse, AtomicRpcError>>();
  const writeMutex = yield* Semaphore.make(1);
  let requestSequence = 0;
  let eventSequence = 0;
  let terminalError: AtomicRpcError | undefined;
  let maxReassembledFrameBytes = MAX_RPC_REASSEMBLED_FRAME_BYTES;
  let chunkAssembly:
    | {
        readonly chunkId: string;
        readonly count: number;
        readonly byteLength: number;
        readonly chunks: Array<Uint8Array>;
        nextIndex: number;
        receivedBytes: number;
      }
    | undefined;
  // False until Atomic sends its first response, i.e. until startup network
  // work has finished. Gates which timeout `request` applies.
  let settled = false;

  const write = (value: Readonly<Record<string, unknown>>) =>
    Effect.suspend(() =>
      terminalError
        ? Effect.fail(terminalError)
        : writeMutex.withPermits(1)(
            encodeJsonString(value).pipe(
              Effect.mapError(
                (cause) =>
                  new AtomicRpcError({
                    runtimeName,
                    binaryPath: options.binaryPath,
                    operation: typeof value.type === "string" ? value.type : "write",
                    detail: `Could not encode a ${runtimeName} RPC command.`,
                    cause,
                  }),
              ),
              Effect.flatMap((encoded) =>
                Stream.run(Stream.encodeText(Stream.make(`${encoded}\n`)), handle.stdin).pipe(
                  Effect.mapError(
                    (cause) =>
                      new AtomicRpcError({
                        runtimeName,
                        binaryPath: options.binaryPath,
                        operation: typeof value.type === "string" ? value.type : "write",
                        detail: `Could not write to ${runtimeName} stdin.`,
                        cause,
                      }),
                  ),
                ),
              ),
              Effect.asVoid,
            ),
          ),
    );

  const failPending = (cause?: unknown) =>
    Effect.gen(function* () {
      terminalError ??= new AtomicRpcError({
        runtimeName,
        binaryPath: options.binaryPath,
        operation: "read",
        detail: `${runtimeName} RPC output closed or could not be decoded.`,
        ...(cause === undefined ? {} : { cause }),
      });
      if (pending.size === 0) return;
      for (const deferred of pending.values()) {
        yield* Deferred.fail(deferred, terminalError);
      }
      pending.clear();
    });

  const invalidFrame = (detail: string) => {
    const error = new AtomicRpcError({
      runtimeName,
      binaryPath: options.binaryPath,
      operation: "read",
      detail,
    });
    terminalError = error;
    return failPending(error).pipe(Effect.andThen(Effect.fail(error)));
  };

  const dispatchFrame = (value: unknown): Effect.Effect<void, AtomicRpcError> =>
    Effect.gen(function* () {
      if (isAtomicRpcResponse(value)) {
        if (chunkAssembly) {
          return yield* invalidFrame(
            `Received an RPC response before chunk sequence '${chunkAssembly.chunkId}' completed.`,
          );
        }
        settled = true;
        const deferred = value.id ? pending.get(value.id) : undefined;
        if (!deferred) return;
        pending.delete(value.id!);
        if (value.success) {
          yield* Deferred.succeed(deferred, {
            ...value,
            precedingEventSequence: eventSequence,
          });
          return;
        }
        yield* Deferred.fail(
          deferred,
          new AtomicRpcError({
            runtimeName,
            binaryPath: options.binaryPath,
            operation: value.command,
            detail: value.error ?? `${runtimeName} returned an unsuccessful response.`,
          }),
        );
        return;
      }

      if (isRpcChunkFrame(value)) {
        if (value.count > MAX_RPC_CHUNK_COUNT) {
          return yield* invalidFrame(
            `RPC chunk sequence '${value.chunkId}' exceeds the ${MAX_RPC_CHUNK_COUNT}-chunk limit.`,
          );
        }
        if (value.byteLength > maxReassembledFrameBytes) {
          return yield* invalidFrame(
            `RPC chunk sequence '${value.chunkId}' exceeds the ${maxReassembledFrameBytes}-byte reassembly limit.`,
          );
        }
        if (!chunkAssembly) {
          if (value.index !== 0) {
            return yield* invalidFrame(
              `RPC chunk sequence '${value.chunkId}' started at index ${value.index}.`,
            );
          }
          chunkAssembly = {
            chunkId: value.chunkId,
            count: value.count,
            byteLength: value.byteLength,
            chunks: [],
            nextIndex: 0,
            receivedBytes: 0,
          };
        }
        const assembly = chunkAssembly;
        if (
          value.chunkId !== assembly.chunkId ||
          value.count !== assembly.count ||
          value.byteLength !== assembly.byteLength ||
          value.index !== assembly.nextIndex
        ) {
          return yield* invalidFrame(
            `RPC chunk sequence '${assembly.chunkId}' was interrupted or arrived out of order.`,
          );
        }
        const bytes = Buffer.from(value.data, "base64");
        if (bytes.toString("base64") !== value.data) {
          return yield* invalidFrame(
            `RPC chunk ${value.index} for '${value.chunkId}' is not canonical base64.`,
          );
        }
        assembly.chunks.push(bytes);
        assembly.nextIndex += 1;
        assembly.receivedBytes += bytes.byteLength;
        if (
          assembly.receivedBytes > assembly.byteLength ||
          assembly.receivedBytes > maxReassembledFrameBytes
        ) {
          return yield* invalidFrame(
            `RPC chunk sequence '${value.chunkId}' exceeded its declared byte length.`,
          );
        }
        if (assembly.nextIndex < assembly.count) return;
        chunkAssembly = undefined;
        if (assembly.receivedBytes !== assembly.byteLength) {
          return yield* invalidFrame(
            `RPC chunk sequence '${value.chunkId}' declared ${assembly.byteLength} bytes but produced ${assembly.receivedBytes}.`,
          );
        }
        const payloadBytes = Buffer.concat(assembly.chunks);
        const payloadText = yield* Effect.try({
          try: () => new TextDecoder("utf-8", { fatal: true }).decode(payloadBytes),
          catch: (cause) =>
            new AtomicRpcError({
              runtimeName,
              binaryPath: options.binaryPath,
              operation: "read",
              detail: `RPC chunk sequence '${value.chunkId}' is not valid UTF-8.`,
              cause,
            }),
        });
        const payload = yield* decodeJsonString(payloadText).pipe(
          Effect.mapError(
            (cause) =>
              new AtomicRpcError({
                runtimeName,
                binaryPath: options.binaryPath,
                operation: "read",
                detail: `RPC chunk sequence '${value.chunkId}' is not valid JSON.`,
                cause,
              }),
          ),
        );
        yield* dispatchFrame(payload);
        return;
      }

      if (chunkAssembly) {
        return yield* invalidFrame(
          `RPC frame interrupted chunk sequence '${chunkAssembly.chunkId}'.`,
        );
      }
      if (!isAtomicRpcEvent(value)) {
        yield* Effect.logWarning(`Ignored malformed ${runtimeName} RPC frame.`);
        return;
      }
      if (isRpcReadyFrame(value) && value.maxReassembledFrameBytes !== undefined) {
        maxReassembledFrameBytes = Math.min(
          value.maxReassembledFrameBytes,
          MAX_RPC_REASSEMBLED_FRAME_BYTES,
        );
      }
      eventSequence += 1;
      eventSequences.set(value, eventSequence);
      yield* PubSub.publish(events, value);
    });

  yield* handle.stdout.pipe(
    Stream.pipeThroughChannel(Ndjson.decode({ ignoreEmptyLines: true })),
    Stream.runForEach(dispatchFrame),
    Effect.catchCause((cause) => failPending(cause)),
    // A clean EOF is just as terminal as a decode failure. Without this
    // finalizer, requests wait for their full timeout after the child exits.
    Effect.ensuring(failPending()),
    Effect.forkScoped,
  );
  yield* handle.stderr.pipe(Stream.runDrain, Effect.ignore, Effect.forkScoped);

  const notify: AtomicRpcProcess["notify"] = write;
  const request: AtomicRpcProcess["request"] = (input, timeout) =>
    Effect.gen(function* () {
      if (terminalError) return yield* terminalError;
      const effectiveTimeout = timeout ?? (settled ? requestTimeout : startupTimeout);
      const id = `t3-${++requestSequence}`;
      const deferred = yield* Deferred.make<AtomicRpcResponse, AtomicRpcError>();
      pending.set(id, deferred);
      const response = yield* Effect.gen(function* () {
        yield* write({ ...input, id });
        return yield* Deferred.await(deferred);
      }).pipe(
        // The deadline covers both the stdin write and the response wait. A
        // dead child can otherwise leave a pipe write suspended forever.
        Effect.timeoutOption(effectiveTimeout),
        Effect.ensuring(Effect.sync(() => pending.delete(id))),
      );
      if (Option.isNone(response)) {
        return yield* new AtomicRpcError({
          runtimeName,
          binaryPath: options.binaryPath,
          operation: typeof input.type === "string" ? input.type : "request",
          detail: `Timed out after ${Duration.toMillis(effectiveTimeout)}ms.`,
        });
      }
      return response.value;
    });

  return {
    request,
    notify,
    events: Stream.fromPubSub(events),
    kill: handle.kill().pipe(Effect.ignore),
  } satisfies AtomicRpcProcess;
});
