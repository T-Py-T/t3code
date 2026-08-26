// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { PiSettings, ProviderDriverKind, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { assert, describe } from "vite-plus/test";

import { ServerConfig } from "../../config.ts";
import { makePiAdapter } from "./PiAdapter.ts";

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockPeer = NodePath.join(__dirname, "../testFixtures/piRpcMockPeer.mjs");
const decodePiSettings = Schema.decodeSync(PiSettings);

function writeMockWrapper(): string {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "pi-adapter-test-"));
  const wrapper = NodePath.join(dir, "mock-pi.sh");
  NodeFS.writeFileSync(
    wrapper,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(mockPeer)} "$@"\n`,
    "utf8",
  );
  NodeFS.chmodSync(wrapper, 0o755);
  return wrapper;
}

describe("PiAdapter", () => {
  it.live("uses the shared Pi lifecycle for thinking, tools, queued runs, and completion", () =>
    Effect.gen(function* () {
      const adapter = yield* makePiAdapter(
        decodePiSettings({ enabled: true, binaryPath: writeMockWrapper() }),
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
});
