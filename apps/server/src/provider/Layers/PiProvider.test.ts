// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { PiSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { assert, describe } from "vite-plus/test";

import { checkPiProviderStatus } from "./PiProvider.ts";

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockPeer = NodePath.join(__dirname, "../testFixtures/piRpcMockPeer.mjs");
const decodePiSettings = Schema.decodeSync(PiSettings);

function writeMockWrapper(version: string): string {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "pi-provider-test-"));
  const wrapper = NodePath.join(dir, "mock-pi.sh");
  NodeFS.writeFileSync(
    wrapper,
    `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf '${version}\\n'
  exit 0
fi
exec ${JSON.stringify(process.execPath)} ${JSON.stringify(mockPeer)} "$@"
`,
    "utf8",
  );
  NodeFS.chmodSync(wrapper, 0o755);
  return wrapper;
}

describe("PiProvider", () => {
  it.effect("keeps the compatible 0.84.1 shim range selectable with an upgrade advisory", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkPiProviderStatus(
        decodePiSettings({ enabled: true, binaryPath: writeMockWrapper("0.84.1") }),
        process.cwd(),
      );
      assert.equal(snapshot.displayName, "Pi");
      assert.equal(snapshot.version, "0.84.1");
      assert.equal(snapshot.status, "ready");
      assert.deepEqual(
        snapshot.models.map((model) => model.slug),
        ["openai-codex/gpt-5.4"],
      );
      assert.match(snapshot.message ?? "", /0\.84\.3/u);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
