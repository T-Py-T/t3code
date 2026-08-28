import * as NodeURL from "node:url";

import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as ChildProcess from "effect/unstable/process/ChildProcess";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import {
  LocalComputerUseHostTransportError,
  makeLocalComputerUseHostLayer,
  runLocalComputerUseTransport,
  shouldHashDevelopmentHelper,
  type VerifiedLocalComputerUseHelper,
} from "./LocalComputerUseHost.ts";

export { shouldHashDevelopmentHelper };

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

interface MacOsCodeSigningIdentity {
  readonly identifier: string;
  readonly teamId: string;
}

export function parseMacOsCodeSigningIdentity(
  output: string,
): MacOsCodeSigningIdentity | undefined {
  const teamId = /^TeamIdentifier=(.+)$/m.exec(output)?.[1]?.trim();
  const identifier = /^Identifier=(.+)$/m.exec(output)?.[1]?.trim();
  return !teamId || teamId === "not set" || !identifier ? undefined : { identifier, teamId };
}

export function macOsComputerUseSigningIdentityMatches(
  helper: MacOsCodeSigningIdentity,
  host: MacOsCodeSigningIdentity,
): boolean {
  return (
    host.identifier === "com.t3tools.t3code" &&
    helper.identifier === "T3CodeComputerUse" &&
    helper.teamId === host.teamId
  );
}

const readCodeSigningIdentity = Effect.fn("MacOsComputerUseHost.readCodeSigningIdentity")(
  function* (path: string) {
    const processRunner = yield* ProcessRunner.ProcessRunner;
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
            new LocalComputerUseHostTransportError({
              operation: "verify",
              detail: "The macOS code signing identity could not be read.",
              cause,
            }),
        ),
      );
    return description.code === 0
      ? parseMacOsCodeSigningIdentity(`${description.stdout}\n${description.stderr}`)
      : undefined;
  },
);

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
    return yield* new LocalComputerUseHostTransportError({
      operation: "resolve",
      detail: "The macOS Computer Use helper is not installed.",
    });
  }
  const stat = yield* fileSystem.stat(path).pipe(
    Effect.mapError(
      (cause) =>
        new LocalComputerUseHostTransportError({
          operation: "resolve",
          detail: "The macOS Computer Use helper is not installed.",
          cause,
        }),
    ),
  );
  if (stat.type !== "File" || (stat.mode & 0o111) === 0) {
    return yield* new LocalComputerUseHostTransportError({
      operation: "resolve",
      detail: "The macOS Computer Use helper is not executable.",
    });
  }

  if (shouldHashDevelopmentHelper(config)) {
    const bytes = yield* fileSystem.readFile(path).pipe(
      Effect.mapError(
        (cause) =>
          new LocalComputerUseHostTransportError({
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
    } satisfies VerifiedLocalComputerUseHelper;
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
          new LocalComputerUseHostTransportError({
            operation: "verify",
            detail: "The macOS helper signature could not be verified.",
            cause,
          }),
      ),
    );
  if (verified.code !== 0) {
    return yield* new LocalComputerUseHostTransportError({
      operation: "verify",
      detail: "The macOS helper has an invalid code signature.",
    });
  }
  const helperIdentity = yield* readCodeSigningIdentity(path);
  const hostExecutablePath = config.computerUseHostExecutablePath;
  if (!helperIdentity || !hostExecutablePath) {
    return yield* new LocalComputerUseHostTransportError({
      operation: "verify",
      detail: "The macOS helper or desktop host signing identity is unavailable.",
    });
  }
  const hostIdentity = yield* readCodeSigningIdentity(hostExecutablePath);
  if (!hostIdentity || !macOsComputerUseSigningIdentityMatches(helperIdentity, hostIdentity)) {
    return yield* new LocalComputerUseHostTransportError({
      operation: "verify",
      detail: "The macOS helper is not signed by the installed T3 Code desktop team.",
    });
  }
  return {
    path,
    subject: helperIdentity.identifier,
    publisher: helperIdentity.teamId,
  } satisfies VerifiedLocalComputerUseHelper;
});

export const runMacOsComputerUseTransport = runLocalComputerUseTransport;

export const layer = makeLocalComputerUseHostLayer({
  displayName: "macOS",
  hostPlatform: "darwin",
  platform: "macos",
  verifyHelper,
  makeCommand: (helper) =>
    ChildProcess.make(helper.path, [], {
      env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
      extendEnv: false,
    }),
});
