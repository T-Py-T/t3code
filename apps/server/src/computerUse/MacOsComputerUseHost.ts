import * as NodeURL from "node:url";

import {
  ComputerUseHostFailureTag,
  ComputerUseHostId,
  type ComputerUseConnectionId,
  type ComputerUseHostResponse,
  type ComputerUseVerifiedHost,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Data from "effect/Data";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ProcessRunner from "../processRunner.ts";
import { ComputerUseBroker } from "./ComputerUseBroker.ts";

class MacOsComputerUseHostTransportError extends Data.TaggedError(
  "MacOsComputerUseHostTransportError",
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

interface VerifiedHelper {
  readonly path: string;
  readonly subject: string;
  readonly publisher: string;
}

export const macOsComputerUseHelperPathCandidates = (
  config: Pick<ServerConfig.ServerConfig["Service"], "computerUseHelperPath">,
  moduleUrl = import.meta.url,
): ReadonlyArray<string> => {
  if (config.computerUseHelperPath !== undefined) {
    return [config.computerUseHelperPath];
  }

  // The server bundles this module into apps/server/dist/bin.mjs, while focused
  // tests execute it from apps/server/src/computerUse. Keep both layouts so a
  // development build cannot silently lose its native host after bundling.
  return Array.from(
    new Set([
      NodeURL.fileURLToPath(
        new URL("../../../native/computer-use-macos/.build/debug/T3CodeComputerUse", moduleUrl),
      ),
      NodeURL.fileURLToPath(
        new URL("../../../../native/computer-use-macos/.build/debug/T3CodeComputerUse", moduleUrl),
      ),
    ]),
  );
};

const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

export const shouldHashDevelopmentHelper = (
  config: Pick<
    ServerConfig.ServerConfig["Service"],
    "computerUseHelperDevelopment" | "computerUseHelperPath" | "devUrl"
  >,
): boolean =>
  config.computerUseHelperDevelopment === true ||
  (config.devUrl !== undefined && config.computerUseHelperPath === undefined);

const verifyHelper = Effect.fn("MacOsComputerUseHost.verifyHelper")(function* (
  config: ServerConfig.ServerConfig["Service"],
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const crypto = yield* Crypto.Crypto;
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const candidates = macOsComputerUseHelperPathCandidates(config);
  let path: string | undefined;
  for (const candidate of candidates) {
    const exists = yield* fileSystem.exists(candidate).pipe(Effect.orElseSucceed(() => false));
    if (exists) {
      path = candidate;
      break;
    }
  }
  if (path === undefined) {
    return yield* new MacOsComputerUseHostTransportError({
      operation: "resolve",
      detail: "The macOS Computer Use helper is not installed.",
    });
  }
  const stat = yield* fileSystem.stat(path).pipe(
    Effect.mapError(
      (cause) =>
        new MacOsComputerUseHostTransportError({
          operation: "resolve",
          detail: "The macOS Computer Use helper is not installed.",
          cause,
        }),
    ),
  );
  if (stat.type !== "File" || (stat.mode & 0o111) === 0) {
    return yield* new MacOsComputerUseHostTransportError({
      operation: "resolve",
      detail: "The macOS Computer Use helper is not executable.",
    });
  }

  if (shouldHashDevelopmentHelper(config)) {
    const bytes = yield* fileSystem.readFile(path).pipe(
      Effect.mapError(
        (cause) =>
          new MacOsComputerUseHostTransportError({
            operation: "verify",
            detail: "The development helper could not be hashed.",
            cause,
          }),
      ),
    );
    const hash = yield* crypto.digest("SHA-256", bytes).pipe(Effect.map(bytesToHex), Effect.orDie);
    return {
      path,
      subject: `development-sha256:${hash}`,
      publisher: "T3 Code Development",
    } satisfies VerifiedHelper;
  }

  const verified = yield* processRunner
    .run({
      command: "/usr/bin/codesign",
      args: ["--verify", "--strict", "--deep", path],
      timeout: "10 seconds",
      maxOutputBytes: 64 * 1_024,
    })
    .pipe(
      Effect.mapError(
        (cause) =>
          new MacOsComputerUseHostTransportError({
            operation: "verify",
            detail: "The macOS helper signature could not be verified.",
            cause,
          }),
      ),
    );
  if (verified.code !== 0) {
    return yield* new MacOsComputerUseHostTransportError({
      operation: "verify",
      detail: "The macOS helper has an invalid code signature.",
    });
  }
  const description = yield* processRunner
    .run({
      command: "/usr/bin/codesign",
      args: ["-d", "--verbose=4", path],
      timeout: "10 seconds",
      maxOutputBytes: 64 * 1_024,
    })
    .pipe(
      Effect.mapError(
        (cause) =>
          new MacOsComputerUseHostTransportError({
            operation: "verify",
            detail: "The macOS helper signing identity could not be read.",
            cause,
          }),
      ),
    );
  if (description.code !== 0) {
    return yield* new MacOsComputerUseHostTransportError({
      operation: "verify",
      detail: "The macOS helper signing identity is unavailable.",
    });
  }
  const diagnostics = `${description.stdout}\n${description.stderr}`;
  const teamId = /^TeamIdentifier=(.+)$/m.exec(diagnostics)?.[1]?.trim();
  const identifier = /^Identifier=(.+)$/m.exec(diagnostics)?.[1]?.trim();
  if (!teamId || teamId === "not set" || !identifier) {
    return yield* new MacOsComputerUseHostTransportError({
      operation: "verify",
      detail: "The release helper is not signed with a stable T3 Code identity.",
    });
  }
  return { path, subject: identifier, publisher: teamId } satisfies VerifiedHelper;
});

const encodeJson = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

const encodeJsonLine = (value: unknown) =>
  encodeJson(value).pipe(
    Effect.map((line) => new TextEncoder().encode(`${line}\n`)),
    Effect.mapError(
      (cause) =>
        new MacOsComputerUseHostTransportError({
          operation: "write",
          detail: "A Computer Use request could not be encoded for the macOS helper.",
          cause,
        }),
    ),
  );

const decodeHostResponseLine = Schema.decodeUnknownEffect(Schema.fromJsonString(LocalHostResponse));

export const runMacOsComputerUseTransport = <E, R>(
  pumps: Iterable<Effect.Effect<void, E, R>>,
  exit: Effect.Effect<void, E, R>,
): Effect.Effect<void, E, R> =>
  Effect.raceFirst(Effect.all(pumps, { discard: true, concurrency: "unbounded" }), exit);

const run = Effect.scoped(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const hostPlatform = yield* HostProcessPlatform;
    if (config.mode !== "desktop" || hostPlatform !== "darwin") return;
    const broker = yield* ComputerUseBroker;
    const environment = yield* ServerEnvironment.ServerEnvironment;
    const environmentId = yield* environment.getEnvironmentId;
    const helper = yield* verifyHelper(config);
    const host: ComputerUseVerifiedHost = {
      hostId: ComputerUseHostId.make(`macos:${helper.subject}`),
      environmentId,
      platform: "macos",
      protocolVersion: 1,
      supportedOperations: ["status", "listTargets", "observe", "act"],
      verifiedIdentity: {
        subject: helper.subject,
        publisher: helper.publisher,
      },
    };
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner
      .spawn(
        ChildProcess.make(helper.path, [], {
          env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
          extendEnv: false,
        }),
      )
      .pipe(
        Effect.mapError(
          (cause) =>
            new MacOsComputerUseHostTransportError({
              operation: "spawn",
              detail: "The macOS Computer Use helper could not be started.",
              cause,
            }),
        ),
      );
    const writes = yield* Queue.unbounded<Uint8Array>();
    const connectionId = yield* Ref.make<Option.Option<ComputerUseConnectionId>>(Option.none());
    const events = yield* broker.connect(host);
    yield* Effect.logInfo("macOS Computer Use host connected", {
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
          );
          yield* Queue.offer(writes, encoded);
        }),
      ),
    );
    const writer = Stream.fromQueue(writes).pipe(
      Stream.run(child.stdin),
      Effect.mapError(
        (cause) =>
          new MacOsComputerUseHostTransportError({
            operation: "write",
            detail: "The macOS Computer Use helper input stream failed.",
            cause,
          }),
      ),
    );
    const responses = child.stdout.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.runForEach((line) =>
        Effect.gen(function* () {
          const response = yield* decodeHostResponseLine(line).pipe(
            Effect.mapError(
              (cause) =>
                new MacOsComputerUseHostTransportError({
                  operation: "read",
                  detail: "The macOS helper emitted an invalid response.",
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
          new MacOsComputerUseHostTransportError({
            operation: "read",
            detail: "The macOS Computer Use helper response stream failed.",
            cause,
          }),
      ),
    );
    const stderr = child.stderr.pipe(
      Stream.runDrain,
      Effect.mapError(
        (cause) =>
          new MacOsComputerUseHostTransportError({
            operation: "read",
            detail: "The macOS Computer Use helper diagnostic stream failed.",
            cause,
          }),
      ),
    );
    const exit = child.exitCode.pipe(
      Effect.mapError(
        (cause) =>
          new MacOsComputerUseHostTransportError({
            operation: "exit",
            detail: "The macOS Computer Use helper exit status is unavailable.",
            cause,
          }),
      ),
      Effect.flatMap((code) =>
        code === 0
          ? Effect.void
          : Effect.fail(
              new MacOsComputerUseHostTransportError({
                operation: "exit",
                detail: `The macOS Computer Use helper exited with code ${code}.`,
              }),
            ),
      ),
    );

    yield* runMacOsComputerUseTransport([requests, writer, responses, stderr], exit);
  }),
).pipe(
  Effect.catch((cause) =>
    Effect.logWarning("macOS Computer Use host is unavailable", {
      errorTag: cause._tag,
      operation: cause.operation,
      detail: cause.detail,
    }),
  ),
);

export const layer = Layer.effectDiscard(run.pipe(Effect.forkScoped));
