import {
  CommandId,
  EventId,
  type ComputerUseHistoryEntry,
  type OrchestrationCommand,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
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

const run = Effect.gen(function* ComputerUseProjectionRun() {
  const history = yield* ComputerUseHistory;
  const orchestration = yield* OrchestrationEngineService;
  yield* history.changes.pipe(
    Stream.runForEach((entry) => {
      const command = historyEntryToActivityCommand(entry);
      return command === null ? Effect.void : orchestration.dispatch(command).pipe(Effect.asVoid);
    }),
    Effect.catchCause((cause) =>
      Effect.logError("Computer Use activity projection stopped.", { cause }),
    ),
  );
});

export const layer = Layer.effectDiscard(run.pipe(Effect.forkScoped));
