// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import {
  EnvironmentId,
  PiSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { assert, describe } from "vite-plus/test";

import { ServerConfig } from "../../config.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import { makePiAdapter } from "./PiAdapter.ts";

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockPeer = NodePath.join(__dirname, "../testFixtures/piRpcMockPeer.mjs");
const decodePiSettings = Schema.decodeSync(PiSettings);

function writeMockWrapper(expectedTrustFlag?: "--approve" | "--no-approve"): string {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "pi-adapter-test-"));
  const wrapper = NodePath.join(dir, "mock-pi.sh");
  NodeFS.writeFileSync(
    wrapper,
    `#!/bin/sh
${expectedTrustFlag === undefined ? "" : `case " $* " in\n  *" ${expectedTrustFlag} "*) ;;\n  *) exit 33 ;;\nesac\n`}exec ${JSON.stringify(process.execPath)} ${JSON.stringify(mockPeer)} "$@"
`,
    "utf8",
  );
  NodeFS.chmodSync(wrapper, 0o755);
  return wrapper;
}

function writeCapturingMockWrapper(capturePath: string): string {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "pi-adapter-mcp-test-"));
  const wrapper = NodePath.join(dir, "mock-pi.sh");
  NodeFS.writeFileSync(
    wrapper,
    `#!/bin/sh
printf '%s\n' "$T3CODE_MCP_ENDPOINT" "$T3CODE_MCP_AUTHORIZATION" > ${JSON.stringify(capturePath)}
printf '%s\n' "$@" >> ${JSON.stringify(capturePath)}
exec ${JSON.stringify(process.execPath)} ${JSON.stringify(mockPeer)} "$@"
`,
    "utf8",
  );
  NodeFS.chmodSync(wrapper, 0o755);
  return wrapper;
}

describe("PiAdapter", () => {
  it.live("attaches the private T3 Computer Use extension to bare Pi sessions", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("pi-computer-use-extension");
      const capturePath = NodePath.join(
        NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "pi-adapter-mcp-capture-")),
        "launch.txt",
      );
      McpProviderSession.setMcpProviderSession({
        environmentId: EnvironmentId.make("environment-1"),
        threadId,
        providerSessionId: "provider-session-1",
        providerInstanceId: ProviderInstanceId.make("pi"),
        endpoint: "http://127.0.0.1:43123/mcp",
        authorizationHeader: "Bearer test-session-token",
      });

      const adapter = yield* makePiAdapter(
        decodePiSettings({ enabled: true, binaryPath: writeCapturingMockWrapper(capturePath) }),
      ).pipe(
        Effect.provide(
          ServerConfig.layerTest(process.cwd(), { prefix: "pi-adapter-mcp-test-" }).pipe(
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      );

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("pi"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      const launch = NodeFS.readFileSync(capturePath, "utf8").trim().split("\n");
      assert.equal(launch[0], "http://127.0.0.1:43123/mcp");
      assert.equal(launch[1], "Bearer test-session-token");
      const extensionFlag = launch.indexOf("--extension");
      assert.isAtLeast(extensionFlag, 2);
      const extensionPath = launch[extensionFlag + 1];
      assert.isString(extensionPath);
      assert.isTrue(NodeFS.existsSync(extensionPath!));
      assert.include(NodeFS.readFileSync(extensionPath!, "utf8"), "computer_status");
      assert.include(NodeFS.readFileSync(extensionPath!, "utf8"), "t3-workflow-action");

      yield* adapter.stopSession(threadId);
      assert.isFalse(NodeFS.existsSync(extensionPath!));
      McpProviderSession.clearMcpProviderSession(threadId);
    }).pipe(Effect.scoped),
  );

  it.live("uses the shared Pi lifecycle for thinking, tools, queued runs, and completion", () =>
    Effect.gen(function* () {
      const adapter = yield* makePiAdapter(
        decodePiSettings({ enabled: true, binaryPath: writeMockWrapper("--no-approve") }),
      ).pipe(
        Effect.provide(
          ServerConfig.layerTest(process.cwd(), { prefix: "pi-adapter-test-" }).pipe(
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      );
      const threadId = ThreadId.make("pi-chat-lifecycle");
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.takeUntil((event) => event.type === "turn.completed"),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("pi"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId, input: "Reply with PI_RPC_OK", attachments: [] });

      const events = Array.from(yield* Fiber.join(eventsFiber));
      assert.equal(events.at(-1)?.type, "turn.completed");
      assert.isDefined(
        events.find(
          (event) => event.type === "content.delta" && event.payload.delta === "PI_RPC_OK",
        ),
      );
      assert.isDefined(
        events.find(
          (event) => event.type === "content.delta" && event.payload.delta === "QUEUED_FOLLOW_UP",
        ),
      );
      assert.isTrue(events.every((event) => event.provider === "pi"));
      const raw = events.find((event) => event.raw)?.raw;
      assert.equal(raw?.source, "pi.rpc");
    }).pipe(Effect.scoped),
  );

  it.live("passes explicit project trust when the provider setting enables it", () =>
    Effect.gen(function* () {
      const adapter = yield* makePiAdapter(
        decodePiSettings({
          enabled: true,
          binaryPath: writeMockWrapper("--approve"),
          trustProjectResources: true,
        }),
      ).pipe(
        Effect.provide(
          ServerConfig.layerTest(process.cwd(), { prefix: "pi-adapter-trust-test-" }).pipe(
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      );
      const threadId = ThreadId.make("pi-project-trust");

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("pi"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      assert.isTrue(yield* adapter.hasSession(threadId));
      yield* adapter.stopSession(threadId);
    }).pipe(Effect.scoped),
  );
});
