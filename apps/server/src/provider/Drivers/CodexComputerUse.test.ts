import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  annotateCodexComputerUseAvailability,
  codexComputerUseAppServerArgs,
  resolveCodexComputerUse,
} from "./CodexComputerUse.ts";

const readyProvider: ServerProvider = {
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  displayName: "Codex",
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-08-26T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
  continuation: { groupKey: "codex:home:/tmp/codex" },
};

describe("CodexComputerUse", () => {
  it.effect("stays disabled without probing the installation", () =>
    Effect.gen(function* () {
      const computerUse = yield* resolveCodexComputerUse({
        enabled: false,
        sharedHomePath: "/missing",
      });

      expect(computerUse).toEqual({ _tag: "Disabled" });
      expect(codexComputerUseAppServerArgs(computerUse)).toEqual([]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("attaches the client from the shared CODEX_HOME with TOML-safe arguments", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const sharedHomePath = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3code-computer-use-",
      });
      const clientPath = path.join(
        sharedHomePath,
        "computer-use",
        "Codex Computer Use.app",
        "Contents",
        "SharedSupport",
        "SkyComputerUseClient.app",
        "Contents",
        "MacOS",
        "SkyComputerUseClient",
      );
      yield* fileSystem.makeDirectory(path.dirname(clientPath), { recursive: true });
      yield* fileSystem.writeFileString(clientPath, "client");

      const computerUse = yield* resolveCodexComputerUse({ enabled: true, sharedHomePath });

      expect(computerUse).toEqual({ _tag: "Available", clientPath });
      expect(codexComputerUseAppServerArgs(computerUse)).toEqual([
        "-c",
        `mcp_servers.computer-use.command="${clientPath}"`,
        "-c",
        'mcp_servers.computer-use.args=["mcp"]',
        "-c",
        "mcp_servers.computer-use.enabled=true",
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("warns when enabled but unavailable without hiding a stronger provider error", () =>
    Effect.gen(function* () {
      const computerUse = yield* resolveCodexComputerUse({
        enabled: true,
        sharedHomePath: "/missing",
      });
      const warning = annotateCodexComputerUseAvailability(readyProvider, computerUse);
      const providerError = annotateCodexComputerUseAvailability(
        { ...readyProvider, status: "error", message: "Codex is unavailable." },
        computerUse,
      );

      expect(warning.status).toBe("warning");
      expect(warning.message).toContain("Computer Use bridge is enabled");
      expect(providerError).toMatchObject({ status: "error", message: "Codex is unavailable." });
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
