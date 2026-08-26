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

export class AtomicRpcError extends Schema.TaggedErrorClass<AtomicRpcError>()("AtomicRpcError", {
  operation: Schema.String,
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `Atomic RPC ${this.operation} failed: ${this.detail}`;
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
  /** Budget for the first command, which pays Atomic's startup network cost. */
  readonly startupTimeout?: Duration.Input;
  /** Budget for every command after Atomic has answered once. */
  readonly requestTimeout?: Duration.Input;
}

const DEFAULT_REQUEST_TIMEOUT = Duration.seconds(15);
// Atomic performs network work before it answers its first command: it
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
  // False until Atomic answers its first command, i.e. until startup network
  // work has finished. Gates which timeout `request` applies.
  let settled = false;

  const write = (value: Readonly<Record<string, unknown>>) =>
    writeMutex.withPermits(1)(
      Stream.run(Stream.encodeText(Stream.make(`${JSON.stringify(value)}\n`)), handle.stdin).pipe(
        Effect.mapError(
          (cause) =>
            new AtomicRpcError({
              operation: typeof value.type === "string" ? value.type : "write",
              detail: `Could not write to ${runtimeName} stdin.`,
              cause,
            }),
        ),
        Effect.asVoid,
      ),
    );

  const failPending = (cause?: unknown) =>
    Effect.gen(function* () {
      if (pending.size === 0) return;
      const error = new AtomicRpcError({
        operation: "read",
        detail: `${runtimeName} RPC output closed or could not be decoded.`,
        ...(cause === undefined ? {} : { cause }),
      });
      for (const deferred of pending.values()) {
        yield* Deferred.fail(deferred, error);
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
