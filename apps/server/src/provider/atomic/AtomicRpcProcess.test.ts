/**
 * Guards the RPC timeout budgets. Atomic does network work before answering its
 * first command (OAuth refresh, model-catalog fetch), so a cold start measured
 * ~28s against a fast connection while warm starts land near 0.7s. The first
 * command therefore gets a much larger budget than steady-state commands.
 */
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { assert, describe } from "vite-plus/test";

import { makeAtomicRpcProcess } from "./AtomicRpcProcess.ts";

// Mock Atomic: answers every command after `delayMs`, standing in for a runtime
// whose first reply is slow. Launched through a shell wrapper because
// makeAtomicRpcProcess always prepends `--mode rpc`, which node itself rejects.
const writeMockAtomic = (delayMs: number) => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "atomic-rpc-test-"));
  const script = NodePath.join(dir, "mock-atomic.mjs");
  NodeFS.writeFileSync(
    script,
    `let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk.toString("utf8");
  let i;
  while ((i = buf.indexOf("\\n")) !== -1) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const command = JSON.parse(line);
    setTimeout(() => {
      process.stdout.write(
        JSON.stringify({ id: command.id, type: "response", command: command.type, success: true }) + "\\n",
      );
    }, ${delayMs});
  }
});
`,
    "utf8",
  );
  const wrapper = NodePath.join(dir, "mock-atomic.sh");
  NodeFS.writeFileSync(wrapper, `#!/bin/sh\nexec ${process.execPath} ${script}\n`, "utf8");
  NodeFS.chmodSync(wrapper, 0o755);
  return wrapper;
};

const REPLY_DELAY = 300;

describe("AtomicRpcProcess", () => {
  it.live("gives the first command the startup budget, not the steady-state one", () =>
    Effect.gen(function* () {
      // The steady-state budget is far too small for the mock's reply delay, so
      // a success here can only come from the startup budget.
      const rpc = yield* makeAtomicRpcProcess({
        binaryPath: writeMockAtomic(REPLY_DELAY),
        startupTimeout: Duration.seconds(10),
        requestTimeout: Duration.millis(20),
      });
      const response = yield* rpc.request({ type: "get_state" });
      assert.strictEqual(response.success, true);
      assert.strictEqual(response.command, "get_state");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("falls back to the steady-state budget once Atomic has answered", () =>
    Effect.gen(function* () {
      const rpc = yield* makeAtomicRpcProcess({
        binaryPath: writeMockAtomic(REPLY_DELAY),
        startupTimeout: Duration.seconds(10),
        requestTimeout: Duration.millis(20),
      });
      yield* rpc.request({ type: "get_state" });
      // Same reply delay, now measured against the steady-state budget.
      const result = yield* rpc.request({ type: "get_state" }).pipe(Effect.result);
      assert.strictEqual(result._tag, "Failure");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("honors an explicit per-request timeout over both budgets", () =>
    Effect.gen(function* () {
      const rpc = yield* makeAtomicRpcProcess({
        binaryPath: writeMockAtomic(REPLY_DELAY),
        startupTimeout: Duration.seconds(10),
        requestTimeout: Duration.seconds(10),
      });
      const result = yield* rpc
        .request({ type: "get_state" }, Duration.millis(20))
        .pipe(Effect.result);
      assert.strictEqual(result._tag, "Failure");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
