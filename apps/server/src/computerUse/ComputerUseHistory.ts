import {
  COMPUTER_USE_HISTORY_MAX_ENTRIES,
  COMPUTER_USE_HISTORY_MAX_QUERY_ENTRIES,
  COMPUTER_USE_HISTORY_RETENTION_DAYS,
  ComputerUseHistoryEntryId,
  ComputerUseHistoryEntryList,
  type ComputerUseActionRisk,
  type ComputerUseHistoryEntry,
  type ComputerUseHistoryState,
  type ComputerUseHostId,
  type ComputerUseHistoryOperation,
  type ComputerUseTarget,
  type EnvironmentId,
  type ProviderInstanceId,
  type ThreadId,
  type TurnId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";

import { writeFileStringAtomically } from "../atomicWrite.ts";
import * as ServerConfig from "../config.ts";

const RETENTION_MS = COMPUTER_USE_HISTORY_RETENTION_DAYS * 24 * 60 * 60 * 1_000;
const HISTORY_STRING_MAX_LENGTH = 512;

export interface ComputerUseHistoryAppendInput {
  readonly environmentId: EnvironmentId;
  readonly hostId?: ComputerUseHostId;
  readonly threadId?: ThreadId;
  readonly turnId?: TurnId;
  readonly providerInstanceId?: ProviderInstanceId;
  readonly operation?: ComputerUseHistoryOperation;
  readonly target?: ComputerUseTarget;
  readonly risk?: ComputerUseActionRisk;
  readonly state: ComputerUseHistoryState;
  readonly summary: string;
  readonly resultTag?: string;
}

interface HistoryState {
  readonly entries: ReadonlyArray<ComputerUseHistoryEntry>;
  readonly sequence: number;
}

export interface ComputerUseHistoryPersistence {
  readonly load: Effect.Effect<ReadonlyArray<ComputerUseHistoryEntry>>;
  readonly save: (entries: ReadonlyArray<ComputerUseHistoryEntry>) => Effect.Effect<void>;
}

export class ComputerUseHistory extends Context.Service<
  ComputerUseHistory,
  {
    readonly append: (
      input: ComputerUseHistoryAppendInput,
    ) => Effect.Effect<ComputerUseHistoryEntry>;
    readonly list: (
      environmentId: EnvironmentId,
      limit?: number,
    ) => Effect.Effect<ReadonlyArray<ComputerUseHistoryEntry>>;
    readonly clear: (environmentId: EnvironmentId) => Effect.Effect<number>;
    readonly changes: Stream.Stream<ComputerUseHistoryEntry>;
    readonly projectionChanges: Stream.Stream<ComputerUseHistoryEntry>;
  }
>()("t3/computerUse/ComputerUseHistory") {}

const retainedEntries = (
  entries: ReadonlyArray<ComputerUseHistoryEntry>,
  nowMillis: number,
): ReadonlyArray<ComputerUseHistoryEntry> => {
  const cutoff = nowMillis - RETENTION_MS;
  return entries
    .filter((entry) => {
      const createdAt = Date.parse(entry.createdAt);
      return Number.isFinite(createdAt) && createdAt >= cutoff && createdAt <= nowMillis + 60_000;
    })
    .slice(-COMPUTER_USE_HISTORY_MAX_ENTRIES);
};

const bounded = (value: string): string => value.slice(0, HISTORY_STRING_MAX_LENGTH);

const toHistoryTarget = (target: ComputerUseTarget) => ({
  kind: target.kind,
  displayName: bounded(target.displayName),
  applicationId: bounded(target.applicationId),
  stableIdentity: bounded(target.stableIdentity),
});

export const makeWithPersistence = (persistence?: ComputerUseHistoryPersistence) =>
  Effect.gen(function* ComputerUseHistoryMake() {
    const nowMillis = yield* Clock.currentTimeMillis;
    const restored = retainedEntries(persistence ? yield* persistence.load : [], nowMillis);
    const state = yield* SynchronizedRef.make<HistoryState>({
      entries: restored,
      sequence: restored.length,
    });
    const changes = yield* PubSub.unbounded<ComputerUseHistoryEntry>();

    const append: ComputerUseHistory["Service"]["append"] = Effect.fn("ComputerUseHistory.append")(
      (input) =>
        SynchronizedRef.modifyEffect(state, (current) =>
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis;
            const entry = ComputerUseHistoryEntryId.make(
              `computer-use-history-${now}-${current.sequence}`,
            );
            const nextEntry: ComputerUseHistoryEntry = {
              entryId: entry,
              environmentId: input.environmentId,
              ...(input.hostId === undefined ? {} : { hostId: input.hostId }),
              ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
              ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
              ...(input.providerInstanceId === undefined
                ? {}
                : { providerInstanceId: input.providerInstanceId }),
              ...(input.operation === undefined ? {} : { operation: input.operation }),
              ...(input.target === undefined ? {} : { target: toHistoryTarget(input.target) }),
              ...(input.risk === undefined ? {} : { risk: input.risk }),
              state: input.state,
              summary: bounded(input.summary),
              ...(input.resultTag === undefined ? {} : { resultTag: bounded(input.resultTag) }),
              createdAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
            };
            const entries = retainedEntries([...current.entries, nextEntry], now);
            if (persistence) yield* persistence.save(entries);
            yield* PubSub.publish(changes, nextEntry);
            return [nextEntry, { entries, sequence: current.sequence + 1 }] as const;
          }),
        ),
    );

    const list: ComputerUseHistory["Service"]["list"] = Effect.fn("ComputerUseHistory.list")(
      (environmentId, limit = COMPUTER_USE_HISTORY_MAX_QUERY_ENTRIES) =>
        SynchronizedRef.get(state).pipe(
          Effect.map((current) =>
            current.entries
              .filter((entry) => entry.environmentId === environmentId)
              .slice(-Math.min(limit, COMPUTER_USE_HISTORY_MAX_QUERY_ENTRIES))
              .reverse(),
          ),
        ),
    );

    const clear: ComputerUseHistory["Service"]["clear"] = Effect.fn("ComputerUseHistory.clear")(
      (environmentId) =>
        SynchronizedRef.modifyEffect(state, (current) =>
          Effect.gen(function* () {
            const entries = current.entries.filter(
              (entry) => entry.environmentId !== environmentId,
            );
            const deleted = current.entries.length - entries.length;
            if (deleted > 0 && persistence) yield* persistence.save(entries);
            return [deleted, { ...current, entries }] as const;
          }),
        ),
    );

    const projectionChanges = Stream.unwrapScoped(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(changes);
        const snapshot = yield* SynchronizedRef.get(state);
        return Stream.concat(Stream.fromIterable(snapshot.entries), Stream.fromQueue(subscription));
      }),
    );

    return ComputerUseHistory.of({
      append,
      list,
      clear,
      changes: Stream.fromPubSub(changes),
      projectionChanges,
    });
  });

export const make = makeWithPersistence();

const makeFilePersistence = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { computerUseHistoryPath } = yield* ServerConfig.ServerConfig;
  const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(ComputerUseHistoryEntryList));
  const encode = Schema.encodeUnknownEffect(Schema.fromJsonString(ComputerUseHistoryEntryList));
  const load = fs.exists(computerUseHistoryPath).pipe(
    Effect.flatMap((exists) =>
      exists
        ? fs.readFileString(computerUseHistoryPath).pipe(Effect.flatMap(decode))
        : Effect.succeed([]),
    ),
    Effect.catchCause((cause) =>
      Effect.logWarning("Could not load Computer Use history; starting empty.", { cause }).pipe(
        Effect.as([]),
      ),
    ),
  );
  const save = (entries: ReadonlyArray<ComputerUseHistoryEntry>) =>
    encode(entries).pipe(
      Effect.flatMap((contents) =>
        writeFileStringAtomically({ filePath: computerUseHistoryPath, contents: `${contents}\n` }),
      ),
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.catchCause((cause) =>
        Effect.logError("Could not persist Computer Use history.", { cause }).pipe(
          Effect.andThen(Effect.failCause(cause)),
        ),
      ),
      Effect.orDie,
    );
  return { load, save } satisfies ComputerUseHistoryPersistence;
});

export const layer = Layer.effect(
  ComputerUseHistory,
  Effect.flatMap(makeFilePersistence, makeWithPersistence),
);
