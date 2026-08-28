import {
  CommandId,
  EventId,
  type ComputerUseHistoryEntry,
  type OrchestrationCommand,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ComputerUseHistory } from "./ComputerUseHistory.ts";

const toneFor = (entry: ComputerUseHistoryEntry) => {
  switch (entry.state) {
    case "waiting-approval":
      return "approval" as const;
    case "failed":
      return "error" as const;
    case "observing":
    case "acting":
    case "completed":
      return "tool" as const;
    default:
      return "info" as const;
  }
};

export const historyEntryToActivityCommand = (
  entry: ComputerUseHistoryEntry,
): OrchestrationCommand | null => {
  if (entry.threadId === undefined) return null;
  return {
    type: "thread.activity.append",
    commandId: CommandId.make(`server:computer-use:${entry.entryId}`),
    threadId: entry.threadId,
    activity: {
      id: EventId.make(`computer-use:${entry.entryId}`),
      tone: toneFor(entry),
      kind: `computer-use.${entry.state}`,
      summary: entry.summary,
      payload: {
        historyEntryId: entry.entryId,
        state: entry.state,
        ...(entry.hostId === undefined ? {} : { hostId: entry.hostId }),
        ...(entry.operation === undefined ? {} : { operation: entry.operation }),
        ...(entry.target === undefined ? {} : { target: entry.target }),
        ...(entry.risk === undefined ? {} : { risk: entry.risk }),
        ...(entry.providerInstanceId === undefined
          ? {}
          : { providerInstanceId: entry.providerInstanceId }),
        ...(entry.resultTag === undefined ? {} : { resultTag: entry.resultTag }),
      },
      turnId: entry.turnId ?? null,
      createdAt: entry.createdAt,
    },
    createdAt: entry.createdAt,
  };
};

export const projectComputerUseHistoryChanges = <E>(
  changes: Stream.Stream<ComputerUseHistoryEntry>,
  dispatch: (command: OrchestrationCommand) => Effect.Effect<unknown, E>,
  retryDelayMs = 1_000,
): Effect.Effect<void> =>
  changes.pipe(
    Stream.runForEach((entry) => {
      const command = historyEntryToActivityCommand(entry);
      if (command === null) return Effect.void;
      return Effect.suspend(() => dispatch(command)).pipe(
        Effect.asVoid,
        Effect.tapCause((cause) =>
          Effect.logError("Could not project a Computer Use history entry.", {
            historyEntryId: entry.entryId,
            cause,
          }),
        ),
        Effect.retry(Schedule.spaced(retryDelayMs)),
      );
    }),
  );

const run = Effect.gen(function* ComputerUseProjectionRun() {
  const history = yield* ComputerUseHistory;
  const orchestration = yield* OrchestrationEngineService;
  yield* projectComputerUseHistoryChanges(history.projectionChanges, orchestration.dispatch).pipe(
    Effect.catchCause((cause) =>
      Effect.logError("Computer Use activity projection stopped.", { cause }),
    ),
  );
});

export const layer = Layer.effectDiscard(run.pipe(Effect.forkScoped));
