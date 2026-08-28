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
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
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

const writeMockAtomicScript = (source: string) => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "atomic-rpc-test-"));
  const script = NodePath.join(dir, "mock-atomic.mjs");
  NodeFS.writeFileSync(script, source, "utf8");
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

  it.live("fails pending requests immediately when stdout closes cleanly", () =>
    Effect.gen(function* () {
      const rpc = yield* makeAtomicRpcProcess({
        binaryPath: writeMockAtomicScript(
          `process.stdin.once("data", () => setTimeout(() => process.exit(0), 50));\nsetInterval(() => {}, 1000);\n`,
        ),
        runtimeName: "Pi",
        startupTimeout: Duration.seconds(10),
      });
      const result = yield* rpc
        .request({ type: "get_state" })
        // The budget includes spawning the mock Node process. Under the normal
        // parallel suite load, process startup alone can exceed 500ms. Two
        // seconds still proves EOF beats the 10-second RPC request timeout.
        .pipe(Effect.timeout(Duration.seconds(2)), Effect.result);
      assert.strictEqual(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.strictEqual(result.failure._tag, "AtomicRpcError");
        if (result.failure._tag === "AtomicRpcError") {
          assert.strictEqual(result.failure.operation, "read");
          assert.strictEqual(result.failure.runtimeName, "Pi");
          assert.match(result.failure.message, /^Pi RPC read failed:/u);
        }
      }

      const afterEof = yield* rpc
        .request({ type: "get_state" })
        .pipe(Effect.timeout(Duration.seconds(1)), Effect.result);
      assert.strictEqual(afterEof._tag, "Failure");
      if (afterEof._tag === "Failure") {
        assert.strictEqual(afterEof.failure._tag, "AtomicRpcError");
        if (afterEof.failure._tag === "AtomicRpcError") {
          assert.strictEqual(afterEof.failure.operation, "read");
        }
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("reassembles negotiated RPC v2 chunks into one provider event", () =>
    Effect.gen(function* () {
      const rpc = yield* makeAtomicRpcProcess({
        binaryPath: writeMockAtomicScript(`
const payload = Buffer.from(JSON.stringify({
  type: "extension_ui_request",
  id: "large-ui",
  method: "notify",
  message: "${"x".repeat(256)}🌍",
}), "utf8");
const count = 5;
process.stdout.write(JSON.stringify({
  type: "ready",
  protocolVersion: 1,
  supportedProtocolVersions: [1, 2],
  maxFrameBytes: 1024,
  maxReassembledFrameBytes: 1024 * 1024,
}) + "\\n");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let index;
  while ((index = buffer.indexOf("\\n")) !== -1) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;
    const command = JSON.parse(line);
    process.stdout.write(JSON.stringify({
      id: command.id,
      type: "response",
      command: command.type,
      success: true,
      data: { protocolVersion: 2 },
    }) + "\\n");
    if (command.type !== "negotiate_protocol") continue;
    const chunkSize = Math.ceil(payload.length / count);
    for (let chunkIndex = 0; chunkIndex < count; chunkIndex += 1) {
      const start = chunkIndex * chunkSize;
      const end = Math.min(start + chunkSize, payload.length);
      process.stdout.write(JSON.stringify({
        type: "rpc_chunk",
        chunkId: "large-ui-event",
        index: chunkIndex,
        count,
        byteLength: payload.length,
        data: payload.subarray(start, end).toString("base64"),
      }) + "\\n");
    }
  }
});
`),
        runtimeName: "OMP",
      });
      const eventFiber = yield* rpc.events.pipe(
        Stream.filter((event) => event.type === "extension_ui_request"),
        Stream.runHead,
        Effect.forkChild,
      );

      yield* rpc.request({ type: "negotiate_protocol", protocolVersion: 2 });
      const event = yield* Fiber.join(eventFiber).pipe(Effect.timeout(Duration.seconds(2)));

      assert.equal(event._tag, "Some");
      if (event._tag === "None") return;
      assert.equal(event.value.id, "large-ui");
      assert.equal(event.value.method, "notify");
      assert.match(String(event.value.message), /🌍$/u);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("rejects an unbounded RPC v2 chunk count before allocating assembly state", () =>
    Effect.gen(function* () {
      const rpc = yield* makeAtomicRpcProcess({
        binaryPath: writeMockAtomicScript(`
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  const newline = buffer.indexOf("\\n");
  if (newline === -1) return;
  const command = JSON.parse(buffer.slice(0, newline));
  process.stdout.write(JSON.stringify({
    type: "rpc_chunk",
    chunkId: "unbounded-count",
    index: 0,
    count: 1000000,
    byteLength: 1,
    data: "eA==",
  }) + "\\n");
  setTimeout(() => process.stdout.write(JSON.stringify({
    id: command.id,
    type: "response",
    command: command.type,
    success: true,
  }) + "\\n"), 50);
});
setInterval(() => {}, 1000);
`),
        runtimeName: "OMP",
      });

      const result = yield* rpc
        .request({ type: "get_state" })
        .pipe(Effect.timeout(Duration.seconds(2)), Effect.result);

      assert.strictEqual(result._tag, "Failure");
      if (result._tag === "Failure" && result.failure._tag === "AtomicRpcError") {
        assert.strictEqual(result.failure.operation, "read");
        assert.match(result.failure.message, /65536-chunk limit/u);
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("does not let a ready frame raise the absolute reassembly limit", () =>
    Effect.gen(function* () {
      const rpc = yield* makeAtomicRpcProcess({
        binaryPath: writeMockAtomicScript(`
process.stdout.write(JSON.stringify({
  type: "ready",
  maxReassembledFrameBytes: Number.MAX_SAFE_INTEGER,
}) + "\\n");
process.stdin.once("data", (chunk) => {
  const command = JSON.parse(chunk.toString("utf8").trim());
  process.stdout.write(JSON.stringify({
    type: "rpc_chunk",
    chunkId: "oversized-ready",
    index: 0,
    count: 2,
    byteLength: 67108865,
    data: "eA==",
  }) + "\\n");
  setTimeout(() => process.stdout.write(JSON.stringify({
    id: command.id,
    type: "response",
    command: command.type,
    success: true,
  }) + "\\n"), 50);
});
setInterval(() => {}, 1000);
`),
        runtimeName: "OMP",
      });

      const result = yield* rpc
        .request({ type: "get_state" })
        .pipe(Effect.timeout(Duration.seconds(2)), Effect.result);

      assert.strictEqual(result._tag, "Failure");
      if (result._tag === "Failure" && result.failure._tag === "AtomicRpcError") {
        assert.strictEqual(result.failure.operation, "read");
        assert.match(result.failure.message, /67108864-byte reassembly limit/u);
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
