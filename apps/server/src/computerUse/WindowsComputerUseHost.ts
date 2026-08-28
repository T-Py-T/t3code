import * as NodeURL from "node:url";

import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/unstable/process/ChildProcess";

import { HostProcessArchitecture } from "@t3tools/shared/hostProcess";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import {
  LocalComputerUseHostTransportError,
  makeLocalComputerUseHostLayer,
  shouldHashDevelopmentHelper,
  type VerifiedLocalComputerUseHelper,
} from "./LocalComputerUseHost.ts";

const WindowsAuthenticodeIdentity = Schema.Struct({
  Status: Schema.String,
  Subject: Schema.NullOr(Schema.String),
  Thumbprint: Schema.NullOr(Schema.String),
});

const decodeWindowsAuthenticodeIdentity = Schema.decodeUnknownOption(
  Schema.fromJsonString(WindowsAuthenticodeIdentity),
);

export const windowsComputerUseHelperPathCandidates = (
  config: Pick<ServerConfig.ServerConfig["Service"], "computerUseHelperPath">,
  architecture: NodeJS.Architecture,
  moduleUrl = import.meta.url,
): ReadonlyArray<string> => {
  if (config.computerUseHelperPath !== undefined) {
    return [config.computerUseHelperPath];
  }

  const preferredRuntime = architecture === "arm64" ? "win-arm64" : "win-x64";
  const fallbackRuntime = preferredRuntime === "win-arm64" ? "win-x64" : "win-arm64";
  const moduleRelativeRoots = ["../../../", "../../../../"] as const;

  return Array.from(
    new Set(
      [preferredRuntime, fallbackRuntime].flatMap((runtime) =>
        moduleRelativeRoots.map((root) =>
          NodeURL.fileURLToPath(
            new URL(
              `${root}native/computer-use-windows/publish/${runtime}/T3CodeComputerUse.exe`,
              moduleUrl,
            ),
          ),
        ),
      ),
    ),
  );
};

export function parseWindowsAuthenticodeIdentity(
  output: string,
): Pick<VerifiedLocalComputerUseHelper, "subject" | "publisher"> | undefined {
  return Option.match(decodeWindowsAuthenticodeIdentity(output), {
    onNone: () => undefined,
    onSome: (identity) => {
      const publisher = identity.Subject?.trim();
      const thumbprint = identity.Thumbprint?.replaceAll(/\s/g, "").toUpperCase();
      if (identity.Status !== "Valid" || !publisher || !thumbprint) return undefined;
      return {
        subject: `authenticode:${thumbprint}`,
        publisher,
      };
    },
  });
}

const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

const verifyHelper = Effect.fn("WindowsComputerUseHost.verifyHelper")(function* (
  config: ServerConfig.ServerConfig["Service"],
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const crypto = yield* Crypto.Crypto;
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const architecture = yield* HostProcessArchitecture;
  const candidates = windowsComputerUseHelperPathCandidates(config, architecture);
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
      detail: "The Windows Computer Use helper is not installed.",
    });
  }
  const stat = yield* fileSystem.stat(path).pipe(
    Effect.mapError(
      (cause) =>
        new LocalComputerUseHostTransportError({
          operation: "resolve",
          detail: "The Windows Computer Use helper is not installed.",
          cause,
        }),
    ),
  );
  if (stat.type !== "File") {
    return yield* new LocalComputerUseHostTransportError({
      operation: "resolve",
      detail: "The Windows Computer Use helper is not an executable file.",
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

  const signature = yield* processRunner
    .run({
      command: "powershell.exe",
      args: [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        [
          "$signature = Get-AuthenticodeSignature -LiteralPath $args[0]",
          "$certificate = $signature.SignerCertificate",
          "[pscustomobject]@{ Status = [string]$signature.Status; Subject = $certificate.Subject; Thumbprint = $certificate.Thumbprint } | ConvertTo-Json -Compress",
        ].join("; "),
        path,
      ],
      timeout: "10 seconds",
      maxOutputBytes: 64 * 1_024,
    })
    .pipe(
      Effect.mapError(
        (cause) =>
          new LocalComputerUseHostTransportError({
            operation: "verify",
            detail: "The Windows helper Authenticode identity could not be read.",
            cause,
          }),
      ),
    );
  const identity = signature.code === 0 ? parseWindowsAuthenticodeIdentity(signature.stdout) : null;
  if (identity === null || identity === undefined) {
    return yield* new LocalComputerUseHostTransportError({
      operation: "verify",
      detail: "The Windows helper does not have a valid Authenticode signature.",
    });
  }
  return { path, ...identity } satisfies VerifiedLocalComputerUseHelper;
});

export const layer = makeLocalComputerUseHostLayer({
  displayName: "Windows",
  hostPlatform: "win32",
  platform: "windows",
  verifyHelper,
  makeCommand: (helper) => ChildProcess.make(helper.path, [], { extendEnv: true }),
});
