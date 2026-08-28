/**
 * Optional acceptance check against a real Oh My Pi install.
 *
 * Enable discovery with:
 * T3_OMP_BINARY_PATH=/path/to/omp vp test run OmpCliProbe
 *
 * Add T3_OMP_LIVE_TURN=1 to send a small prompt using the user's configured
 * OMP credentials and verify T3's adapter-level streaming and settlement.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { OmpSettings, ProviderDriverKind, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { assert, describe } from "vite-plus/test";

import { ServerConfig } from "../../config.ts";
import { makeOmpAdapter } from "./OmpAdapter.ts";
import { checkOmpProviderStatus } from "./OmpProvider.ts";

const binaryPath = process.env.T3_OMP_BINARY_PATH;
const decodeOmpSettings = Schema.decodeSync(OmpSettings);

describe.runIf(binaryPath !== undefined)("OMP CLI probe", () => {
  const settings = decodeOmpSettings({ enabled: true, binaryPath });

  it.effect("discovers the real OMP RPC surface", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkOmpProviderStatus(settings, process.cwd());

      assert.equal(snapshot.status, "ready");
      assert.match(snapshot.version ?? "", /^18\./u);
      assert.isAbove(snapshot.models.length, 0);
      assert.includeMembers(
        snapshot.slashCommands.map((command) => command.name),
        ["computer", "todo", "handoff", "jobs"],
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live.skipIf(process.env.T3_OMP_LIVE_TURN !== "1")(
    "streams and settles a real model-backed turn through the T3 adapter",
    () =>
      Effect.gen(function* () {
        const adapter = yield* makeOmpAdapter(settings);
        const threadId = ThreadId.make("omp-live-probe");
        const eventsFiber = yield* adapter.streamEvents.pipe(
          Stream.takeUntil((event) => event.type === "turn.completed"),
          Stream.runCollect,
          Effect.forkChild,
        );

        yield* adapter.startSession({
          threadId,
          provider: ProviderDriverKind.make("omp"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
          title: "T3 OMP live probe",
        });
        yield* adapter.sendTurn({
          threadId,
          input: "Reply with exactly OMP_T3_ADAPTER_OK and do not use tools.",
          attachments: [],
        });

        const events = Array.from(yield* Fiber.join(eventsFiber));
        const text = events
          .flatMap((event) => (event.type === "content.delta" ? [event.payload.delta] : []))
          .join("");
        const terminal = events.findLast((event) => event.type === "turn.completed");

        assert.include(text, "OMP_T3_ADAPTER_OK");
        assert.deepInclude(terminal?.type === "turn.completed" ? terminal.payload : {}, {
          state: "completed",
        });
      }).pipe(
        Effect.scoped,
        Effect.provide(
          ServerConfig.layerTest(process.cwd(), { prefix: "omp-cli-probe-" }).pipe(
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
  );

  it.live.skipIf(process.env.T3_OMP_LIVE_WORKFLOW !== "1")(
    "projects a real phased todo and detached OMP child through Agents events",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const cwd = yield* fileSystem.makeTempDirectoryScoped();
        const workflowSettings = decodeOmpSettings({
          enabled: true,
          binaryPath,
          approvalMode: "yolo",
          launchArgs: "--no-skills --no-rules",
        });
        const adapter = yield* makeOmpAdapter(workflowSettings);
        const threadId = ThreadId.make("omp-live-workflow-probe");
        const eventsFiber = yield* adapter.streamEvents.pipe(
          Stream.takeUntil((event) => event.type === "turn.completed"),
          Stream.runCollect,
          Effect.forkChild,
        );

        yield* adapter.startSession({
          threadId,
          provider: ProviderDriverKind.make("omp"),
          cwd,
          runtimeMode: "full-access",
          title: "T3 OMP workflow probe",
        });
        yield* adapter.sendTurn({
          threadId,
          input: [
            "Use the todo tool to create two phases named Research and Verify, with one task in each phase.",
            "Start the Research task, then use the task tool to launch one detached researcher child whose only assignment is to reply OMP_CHILD_OK without using tools.",
            "Wait for that child to finish, mark both todo tasks completed, and reply exactly OMP_WORKFLOW_OK.",
            "Do not read or modify files.",
          ].join(" "),
          attachments: [],
        });

        const events = Array.from(yield* Fiber.join(eventsFiber));
        const text = events
          .flatMap((event) => (event.type === "content.delta" ? [event.payload.delta] : []))
          .join("");
        const workflowStarted = events.some(
          (event) => event.type === "task.started" && event.payload.taskType === "local_workflow",
        );
        const workflowCompleted = events.some(
          (event) => event.type === "task.completed" && event.payload.taskType === "local_workflow",
        );
        const childStarted = events.some(
          (event) => event.type === "task.started" && event.payload.taskType === "omp_subagent",
        );
        const childCompleted = events.some(
          (event) => event.type === "task.completed" && event.payload.taskType === "omp_subagent",
        );

        assert.include(text, "OMP_WORKFLOW_OK");
        assert.equal(workflowStarted, true);
        assert.equal(workflowCompleted, true);
        assert.equal(childStarted, true);
        assert.equal(childCompleted, true);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          ServerConfig.layerTest(process.cwd(), { prefix: "omp-cli-workflow-probe-" }).pipe(
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    180_000,
  );
});
