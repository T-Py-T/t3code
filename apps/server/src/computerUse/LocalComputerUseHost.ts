import {
  ComputerUseHostFailureTag,
  ComputerUseHostId,
  ComputerUseHostStatus,
  type ComputerUseConnectionId,
  type ComputerUseHostResponse,
  type ComputerUsePlatform,
  type ComputerUseVerifiedHost,
  type EnvironmentId,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ProcessRunner from "../processRunner.ts";
import { ComputerUseBroker } from "./ComputerUseBroker.ts";

export class LocalComputerUseHostTransportError extends Data.TaggedError(
  "LocalComputerUseHostTransportError",
)<{
  readonly operation: "resolve" | "verify" | "spawn" | "read" | "write" | "exit";
  readonly detail: string;
  readonly cause?: unknown;
}> {}

const LocalHostResponse = Schema.Union([
  Schema.Struct({
    requestId: Schema.String,
    leaseId: Schema.String,
    ok: Schema.Literal(true),
    result: Schema.Unknown,
    error: Schema.optional(Schema.Never),
  }),
  Schema.Struct({
    requestId: Schema.String,
    leaseId: Schema.String,
    ok: Schema.Literal(false),
    result: Schema.optional(Schema.Never),
    error: Schema.Struct({
      _tag: ComputerUseHostFailureTag,
      message: Schema.String,
      detail: Schema.optional(Schema.Unknown),
    }),
  }),
]);

export interface VerifiedLocalComputerUseHelper {
  readonly path: string;
  readonly subject: string;
  readonly publisher: string;
}

interface LocalComputerUseHostOptions<R> {
  readonly displayName: string;
  readonly hostPlatform: "darwin" | "win32";
  readonly platform: ComputerUsePlatform;
  readonly verifyHelper: (
    config: ServerConfig.ServerConfig["Service"],
  ) => Effect.Effect<VerifiedLocalComputerUseHelper, LocalComputerUseHostTransportError, R>;
  readonly makeCommand: (helper: VerifiedLocalComputerUseHelper) => ChildProcess.Command;
  readonly probeStatus: (
    helper: VerifiedLocalComputerUseHelper,
    environmentId: EnvironmentId,
  ) => Effect.Effect<ComputerUseHostStatus, LocalComputerUseHostTransportError, R>;
}

export const shouldHashDevelopmentHelper = (
  config: Pick<
    ServerConfig.ServerConfig["Service"],
    "computerUseHelperDevelopment" | "computerUseHelperPath" | "devUrl"
  >,
): boolean =>
  config.computerUseHelperDevelopment === true ||
  (config.devUrl !== undefined && config.computerUseHelperPath === undefined);

const encodeJson = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

const encodeJsonLine = (value: unknown, displayName: string) =>
  encodeJson(value).pipe(
    Effect.map((line) => new TextEncoder().encode(`${line}\n`)),
    Effect.mapError(
      (cause) =>
        new LocalComputerUseHostTransportError({
          operation: "write",
          detail: `A Computer Use request could not be encoded for the ${displayName} helper.`,
          cause,
        }),
    ),
  );

const decodeHostResponseLine = Schema.decodeUnknownEffect(Schema.fromJsonString(LocalHostResponse));
const decodeHostStatus = Schema.decodeUnknownEffect(ComputerUseHostStatus);

export const probeLocalComputerUseHostStatus = Effect.fn("LocalComputerUseHost.probeStatus")(
  function* (input: Omit<ProcessRunner.ProcessRunInput, "stdin">, environmentId: EnvironmentId) {
    const processRunner = yield* ProcessRunner.ProcessRunner;
    const stdin = yield* encodeJson({
      type: "request",
      request: {
        requestId: "computer-use-status-probe",
        leaseId: "computer-use-status-probe",
        environmentId,
        operation: "status",
        input: {},
        timeoutMs: 5_000,
      },
    }).pipe(
      Effect.mapError(
        (cause) =>
          new LocalComputerUseHostTransportError({
            operation: "write",
            detail: "The Computer Use status probe could not be encoded.",
            cause,
          }),
      ),
    );
    const output = yield* processRunner.run({ ...input, stdin: `${stdin}\n` }).pipe(
      Effect.mapError(
        (cause) =>
          new LocalComputerUseHostTransportError({
            operation: "spawn",
            detail: "The Computer Use status probe could not be completed.",
            cause,
          }),
      ),
    );
    if (output.code !== 0) {
      return yield* new LocalComputerUseHostTransportError({
        operation: "exit",
        detail: "The Computer Use status probe exited unsuccessfully.",
      });
    }
    const response = yield* decodeHostResponseLine(output.stdout.trim()).pipe(
      Effect.mapError(
        (cause) =>
          new LocalComputerUseHostTransportError({
            operation: "read",
            detail: "The Computer Use status probe emitted an invalid response.",
            cause,
          }),
      ),
    );
    if (!response.ok) {
      return yield* new LocalComputerUseHostTransportError({
        operation: "read",
        detail: "The Computer Use helper could not report its permission status.",
      });
    }
    return yield* decodeHostStatus(response.result).pipe(
      Effect.mapError(
        (cause) =>
          new LocalComputerUseHostTransportError({
            operation: "read",
            detail: "The Computer Use helper reported an invalid permission status.",
            cause,
          }),
      ),
    );
  },
);

export const runLocalComputerUseTransport = <E, R>(
  pumps: Iterable<Effect.Effect<void, E, R>>,
  exit: Effect.Effect<void, E, R>,
): Effect.Effect<void, E, R> =>
  Effect.raceFirst(Effect.all(pumps, { discard: true, concurrency: "unbounded" }), exit);

export const makeLocalComputerUseHostLayer = <R>(options: LocalComputerUseHostOptions<R>) => {
  const run = Effect.scoped(
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const hostPlatform = yield* HostProcessPlatform;
      if (config.mode !== "desktop" || hostPlatform !== options.hostPlatform) return;
      const broker = yield* ComputerUseBroker;
      const environment = yield* ServerEnvironment.ServerEnvironment;
      const environmentId = yield* environment.getEnvironmentId;
      const helper = yield* options.verifyHelper(config);
      const initialStatus = yield* options.probeStatus(helper, environmentId).pipe(
        Effect.tapError((cause) =>
          Effect.logWarning(`${options.displayName} Computer Use status is unavailable`, {
            operation: cause.operation,
            detail: cause.detail,
          }),
        ),
        Effect.option,
      );
      const host: ComputerUseVerifiedHost = {
        hostId: ComputerUseHostId.make(`${options.platform}:${helper.subject}`),
        environmentId,
        platform: options.platform,
        protocolVersion: 1,
        supportedOperations: ["status", "listTargets", "observe", "act"],
        verifiedIdentity: {
          subject: helper.subject,
          publisher: helper.publisher,
        },
      };
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const child = yield* spawner.spawn(options.makeCommand(helper)).pipe(
        Effect.mapError(
          (cause) =>
            new LocalComputerUseHostTransportError({
              operation: "spawn",
              detail: `The ${options.displayName} Computer Use helper could not be started.`,
              cause,
            }),
        ),
      );
      const writes = yield* Queue.unbounded<Uint8Array>();
      const connectionId = yield* Ref.make<Option.Option<ComputerUseConnectionId>>(Option.none());
      const events = yield* broker.connect(host, Option.getOrUndefined(initialStatus));
      yield* Effect.logInfo(`${options.displayName} Computer Use host connected`, {
        hostId: host.hostId,
        platform: host.platform,
      });

      const requests = events.pipe(
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            if (event.type === "connected") {
              yield* Ref.set(connectionId, Option.some(event.connectionId));
              return;
            }
            const encoded = yield* encodeJsonLine(
              event.type === "request"
                ? { type: "request", request: event.request }
                : { type: "cancel", leaseId: event.leaseId, reason: event.reason },
              options.displayName,
            );
            yield* Queue.offer(writes, encoded);
          }),
        ),
      );
      const writer = Stream.fromQueue(writes).pipe(
        Stream.run(child.stdin),
        Effect.mapError(
          (cause) =>
            new LocalComputerUseHostTransportError({
              operation: "write",
              detail: `The ${options.displayName} Computer Use helper input stream failed.`,
              cause,
            }),
        ),
      );
      const responses = child.stdout.pipe(
        Stream.decodeText(),
        Stream.splitLines,
        Stream.runForEach((line) =>
          Effect.gen(function* () {
            if (line.trim().length === 0) return;
            const response = yield* decodeHostResponseLine(line).pipe(
              Effect.mapError(
                (cause) =>
                  new LocalComputerUseHostTransportError({
                    operation: "read",
                    detail: `The ${options.displayName} helper emitted an invalid response.`,
                    cause,
                  }),
              ),
            );
            const activeConnection = yield* Ref.get(connectionId);
            if (Option.isNone(activeConnection)) return;
            yield* broker.respond({
              ...response,
              hostId: host.hostId,
              connectionId: activeConnection.value,
            } as ComputerUseHostResponse);
          }),
        ),
        Effect.mapError(
          (cause) =>
            new LocalComputerUseHostTransportError({
              operation: "read",
              detail: `The ${options.displayName} Computer Use helper response stream failed.`,
              cause,
            }),
        ),
      );
      const stderr = child.stderr.pipe(
        Stream.runDrain,
        Effect.mapError(
          (cause) =>
            new LocalComputerUseHostTransportError({
              operation: "read",
              detail: `The ${options.displayName} Computer Use helper diagnostic stream failed.`,
              cause,
            }),
        ),
      );
      const exit = child.exitCode.pipe(
        Effect.mapError(
          (cause) =>
            new LocalComputerUseHostTransportError({
              operation: "exit",
              detail: `The ${options.displayName} Computer Use helper exit status is unavailable.`,
              cause,
            }),
        ),
        Effect.flatMap((code) =>
          code === 0
            ? Effect.void
            : Effect.fail(
                new LocalComputerUseHostTransportError({
                  operation: "exit",
                  detail: `The ${options.displayName} Computer Use helper exited with code ${code}.`,
                }),
              ),
        ),
      );

      yield* runLocalComputerUseTransport([requests, writer, responses, stderr], exit);
    }),
  ).pipe(
    Effect.catch((cause) =>
      Effect.logWarning(`${options.displayName} Computer Use host is unavailable`, {
        errorTag: cause._tag,
        operation: cause.operation,
        detail: cause.detail,
      }),
    ),
  );

  return Layer.effectDiscard(run.pipe(Effect.forkScoped));
};
