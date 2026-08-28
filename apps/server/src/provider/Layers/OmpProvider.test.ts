// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { OmpSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { assert, describe } from "vite-plus/test";

import { checkOmpProviderStatus } from "./OmpProvider.ts";

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockPeer = NodePath.join(__dirname, "../testFixtures/ompRpcMockPeer.mjs");
const decodeOmpSettings = Schema.decodeSync(OmpSettings);

function writeMockWrapper(expectedAgentDir: string, version = "18.0.9"): string {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "omp-provider-test-"));
  const wrapper = NodePath.join(dir, "mock-omp.sh");
  NodeFS.writeFileSync(
    wrapper,
    `#!/bin/sh
if [ "$PI_CODING_AGENT_DIR" != ${JSON.stringify(expectedAgentDir)} ]; then
  exit 32
fi
if [ "$1" = "--version" ]; then
  printf 'omp/${version}\n'
  exit 0
fi
case " $* " in
  *" --no-extensions "*) ;;
  *) exit 33 ;;
esac
case " $* " in
  *" --approval-mode write "*) ;;
  *) exit 34 ;;
esac
exec ${JSON.stringify(process.execPath)} ${JSON.stringify(mockPeer)} "$@"
`,
    "utf8",
  );
  NodeFS.chmodSync(wrapper, 0o755);
  return wrapper;
}

describe("OmpProvider", () => {
  it.effect("negotiates RPC v2 and exposes OMP models, commands, and skills", () =>
    Effect.gen(function* () {
      const expectedAgentDir = NodePath.join(NodeOS.homedir(), ".omp-provider-review");
      const snapshot = yield* checkOmpProviderStatus(
        decodeOmpSettings({
          enabled: true,
          binaryPath: writeMockWrapper(expectedAgentDir),
          agentDir: "~/.omp-provider-review",
        }),
        process.cwd(),
      );

      assert.equal(snapshot.displayName, "Oh My Pi");
      assert.equal(snapshot.version, "18.0.9");
      assert.equal(snapshot.status, "ready");
      assert.deepEqual(
        snapshot.models.map((model) => model.slug),
        ["openai-codex/gpt-5.6-sol"],
      );
      assert.deepInclude(snapshot.slashCommands, {
        name: "plan",
        description: "Create an implementation plan",
        input: { hint: "goal" },
      });
      assert.deepInclude(
        snapshot.slashCommands.find((command) => command.name === "follow-up"),
        {
          name: "follow-up",
          input: { hint: "message" },
        },
      );
      assert.deepInclude(snapshot.skills, {
        name: "review",
        description: "Review the current branch",
        path: "omp://skill/review",
        enabled: true,
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects releases older than the supported RPC v2 workflow baseline", () =>
    Effect.gen(function* () {
      const expectedAgentDir = NodePath.join(NodeOS.homedir(), ".omp-provider-old-version");
      const snapshot = yield* checkOmpProviderStatus(
        decodeOmpSettings({
          enabled: true,
          binaryPath: writeMockWrapper(expectedAgentDir, "18.0.7"),
          agentDir: "~/.omp-provider-old-version",
        }),
        process.cwd(),
      );

      assert.equal(snapshot.version, "18.0.7");
      assert.equal(snapshot.status, "error");
      assert.match(snapshot.message ?? "", /Upgrade to 18\.0\.8 or newer/u);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
