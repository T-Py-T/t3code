import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  COMPUTER_USE_HISTORY_MAX_ENTRIES,
  COMPUTER_USE_HISTORY_MAX_QUERY_ENTRIES,
  ComputerUseHostId,
  ComputerUseTargetId,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type ComputerUseTarget,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as ComputerUseHistory from "./ComputerUseHistory.ts";

const environmentId = EnvironmentId.make("environment-1");
const target: ComputerUseTarget = {
  targetId: ComputerUseTargetId.make("target-textedit"),
  kind: "application",
  displayName: "TextEdit",
  applicationId: "com.apple.TextEdit",
  stableIdentity: "macos:com.apple.TextEdit:APPLE",
};

const appendInput = {
  environmentId,
  hostId: ComputerUseHostId.make("host-1"),
  threadId: ThreadId.make("thread-1"),
  turnId: TurnId.make("turn-1"),
  providerInstanceId: ProviderInstanceId.make("atomic"),
  operation: "act" as const,
  target,
  risk: "reversible-local" as const,
  state: "completed" as const,
  summary: "Completed 1 action in TextEdit.",
  resultTag: "success",
};

it.effect("keeps newest-first bounded metadata and deletes it by environment", () =>
  Effect.gen(function* () {
    const history = yield* ComputerUseHistory.make;
    for (let index = 0; index < COMPUTER_USE_HISTORY_MAX_ENTRIES + 2; index += 1) {
      yield* history.append({ ...appendInput, summary: `Completed action batch ${index}.` });
    }

    const entries = yield* history.list(environmentId, COMPUTER_USE_HISTORY_MAX_ENTRIES);
    expect(entries).toHaveLength(COMPUTER_USE_HISTORY_MAX_QUERY_ENTRIES);
    expect(entries[0]?.summary).toBe(
      `Completed action batch ${COMPUTER_USE_HISTORY_MAX_ENTRIES + 1}.`,
    );
    expect(yield* history.clear(environmentId)).toBe(COMPUTER_USE_HISTORY_MAX_ENTRIES);
    expect(yield* history.list(environmentId)).toEqual([]);
  }),
);

it.effect("persists only redacted metadata and restores it", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "computer-use-history-" });
      const configLayer = ServerConfig.layerTest(process.cwd(), baseDir).pipe(
        Layer.provide(NodeServices.layer),
      );
      const historyLayer = ComputerUseHistory.layer.pipe(
        Layer.provide(configLayer),
        Layer.provide(NodeServices.layer),
      );
      const services = yield* Layer.build(historyLayer);
      const history = yield* ComputerUseHistory.ComputerUseHistory.pipe(Effect.provide(services));
      yield* history.append(appendInput);

      const { computerUseHistoryPath } = yield* ServerConfig.ServerConfig.pipe(
        Effect.provide(configLayer),
      );
      const persisted = yield* fs.readFileString(computerUseHistoryPath);
      expect(persisted).toContain("Completed 1 action in TextEdit.");
      expect(persisted).not.toContain("typed-secret");
      expect(persisted).not.toContain("screenshot");
      expect(persisted).not.toContain("accessibility");

      const restoredServices = yield* Layer.build(historyLayer);
      const restored = yield* ComputerUseHistory.ComputerUseHistory.pipe(
        Effect.provide(restoredServices),
      );
      expect(yield* restored.list(environmentId)).toHaveLength(1);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("does not publish history that failed to persist", () =>
  Effect.gen(function* () {
    const history = yield* ComputerUseHistory.makeWithPersistence({
      load: Effect.succeed([]),
      save: () => Effect.die("persistence unavailable"),
    });
    const appendExit = yield* history.append(appendInput).pipe(Effect.exit);

    expect(appendExit._tag).toBe("Failure");
    expect(yield* history.list(environmentId)).toEqual([]);
  }),
);

it.effect("replays restored history to the durable projection stream", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const source = yield* ComputerUseHistory.make;
      const restoredEntry = yield* source.append(appendInput);
      const restored = yield* ComputerUseHistory.makeWithPersistence({
        load: Effect.succeed([restoredEntry]),
        save: () => Effect.void,
      });

      const replayed = yield* restored.projectionChanges.pipe(Stream.take(1), Stream.runCollect);
      expect([...replayed]).toEqual([restoredEntry]);
    }),
  ),
);

it.effect("streams newly appended history from an empty durable projection stream", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const history = yield* ComputerUseHistory.make;
      const replay = yield* history.projectionChanges.pipe(
        Stream.take(1),
        Stream.runCollect,
        Effect.forkScoped,
      );
      const appended = yield* history.append(appendInput);

      expect([...(yield* Fiber.join(replay))]).toEqual([appended]);
    }),
  ),
);

it.effect("keeps the durable projection stream alive for the acquired history layer", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "computer-use-history-" });
      const configLayer = ServerConfig.layerTest(process.cwd(), baseDir).pipe(
        Layer.provide(NodeServices.layer),
      );
      const services = yield* Layer.build(
        ComputerUseHistory.layer.pipe(
          Layer.provide(configLayer),
          Layer.provide(NodeServices.layer),
        ),
      );
      const history = yield* ComputerUseHistory.ComputerUseHistory.pipe(Effect.provide(services));
      const replay = yield* history.projectionChanges.pipe(
        Stream.take(1),
        Stream.runCollect,
        Effect.forkScoped,
      );
      const appended = yield* history.append(appendInput);

      expect([...(yield* Fiber.join(replay))]).toEqual([appended]);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);
