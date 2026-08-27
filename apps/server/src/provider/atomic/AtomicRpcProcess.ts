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

const eventSequences = new WeakMap<object, number>();

/** Ordered transport cursor attached out-of-band so it never pollutes raw provider data. */
export function atomicRpcEventSequence(event: AtomicRpcEvent): number | undefined {
  return eventSequences.get(event);
}

const isAtomicRpcResponse = Schema.is(AtomicRpcResponse);
const isAtomicRpcEvent = Schema.is(AtomicRpcEvent);
const encodeJsonString = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

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

  yield* handle.stdout.pipe(
    Stream.pipeThroughChannel(Ndjson.decode({ ignoreEmptyLines: true })),
    Stream.runForEach((value) => {
      if (isAtomicRpcResponse(value)) {
        settled = true;
        const deferred = value.id ? pending.get(value.id) : undefined;
        if (!deferred) return Effect.void;
        pending.delete(value.id!);
        return value.success
          ? Deferred.succeed(deferred, {
              ...value,
              precedingEventSequence: eventSequence,
            }).pipe(Effect.asVoid)
          : Deferred.fail(
              deferred,
              new AtomicRpcError({
                runtimeName,
                binaryPath: options.binaryPath,
                operation: value.command,
                detail: value.error ?? `${runtimeName} returned an unsuccessful response.`,
              }),
            ).pipe(Effect.asVoid);
      }
      if (!isAtomicRpcEvent(value)) {
        return Effect.logWarning(`Ignored malformed ${runtimeName} RPC frame.`);
      }
      eventSequence += 1;
      eventSequences.set(value, eventSequence);
      return PubSub.publish(events, value).pipe(Effect.asVoid);
    }),
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
