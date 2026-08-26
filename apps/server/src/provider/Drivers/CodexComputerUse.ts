import type { ServerProvider } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

const CLIENT_PATH_SEGMENTS = [
  "computer-use",
  "Codex Computer Use.app",
  "Contents",
  "SharedSupport",
  "SkyComputerUseClient.app",
  "Contents",
  "MacOS",
  "SkyComputerUseClient",
] as const;

export type CodexComputerUse =
  | { readonly _tag: "Disabled" }
  | { readonly _tag: "Unavailable"; readonly clientPath: string }
  | { readonly _tag: "Available"; readonly clientPath: string };

const encodeConfigString = Schema.encodeSync(Schema.fromJsonString(Schema.String));

/** Finds the signed Computer Use MCP client shipped in the selected shared CODEX_HOME. */
export const resolveCodexComputerUse = Effect.fn("resolveCodexComputerUse")(function* (input: {
  readonly enabled: boolean;
  readonly sharedHomePath: string;
}): Effect.fn.Return<CodexComputerUse, never, FileSystem.FileSystem | Path.Path> {
  if (!input.enabled) return { _tag: "Disabled" };

  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const clientPath = path.join(input.sharedHomePath, ...CLIENT_PATH_SEGMENTS);
  const available = yield* fileSystem.exists(clientPath).pipe(Effect.orElseSucceed(() => false));
  return available ? { _tag: "Available", clientPath } : { _tag: "Unavailable", clientPath };
});

/** Produces session-local Codex overrides without mutating the user's config.toml. */
export function codexComputerUseAppServerArgs(
  computerUse: CodexComputerUse,
): ReadonlyArray<string> {
  if (computerUse._tag !== "Available") return [];
  return [
    "-c",
    `mcp_servers.computer-use.command=${encodeConfigString(computerUse.clientPath)}`,
    "-c",
    'mcp_servers.computer-use.args=["mcp"]',
    "-c",
    "mcp_servers.computer-use.enabled=true",
  ];
}

/** Surfaces a missing installation without making ordinary Codex chat unavailable. */
export function annotateCodexComputerUseAvailability(
  provider: ServerProvider,
  computerUse: CodexComputerUse,
): ServerProvider {
  if (computerUse._tag !== "Unavailable" || provider.status !== "ready") return provider;
  return {
    ...provider,
    status: "warning",
    message:
      "T3-managed Computer Use is enabled, but the Codex Computer Use client was not found in this provider's CODEX_HOME.",
  };
}
