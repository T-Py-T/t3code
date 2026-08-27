import { expect, it } from "@effect/vitest";
import {
  ComputerUseHistoryEntryId,
  ComputerUseHostId,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type ComputerUseHistoryEntry,
} from "@t3tools/contracts";

import { historyEntryToActivityCommand } from "./ComputerUseProjection.ts";

const entry: ComputerUseHistoryEntry = {
  entryId: ComputerUseHistoryEntryId.make("history-1"),
  environmentId: EnvironmentId.make("environment-1"),
  hostId: ComputerUseHostId.make("host-1"),
  threadId: ThreadId.make("thread-1"),
  turnId: TurnId.make("turn-1"),
  providerInstanceId: ProviderInstanceId.make("atomic"),
  operation: "act",
  target: {
    kind: "application",
    displayName: "TextEdit",
    applicationId: "com.apple.TextEdit",
    stableIdentity: "macos:com.apple.TextEdit:APPLE",
  },
  risk: "reversible-local",
  state: "acting",
  summary: "Acting in TextEdit.",
  createdAt: "2026-08-27T20:00:00.000Z",
};

it("projects Computer Use metadata into a canonical thread activity", () => {
  expect(historyEntryToActivityCommand(entry)).toMatchObject({
    type: "thread.activity.append",
    threadId: "thread-1",
    activity: {
      tone: "tool",
      kind: "computer-use.acting",
      summary: "Acting in TextEdit.",
      turnId: "turn-1",
      payload: {
        state: "acting",
        operation: "act",
        providerInstanceId: "atomic",
        target: { displayName: "TextEdit" },
      },
    },
  });
});

it("does not project environment-only audit rows into an unrelated thread", () => {
  expect(historyEntryToActivityCommand({ ...entry, threadId: undefined, turnId: undefined })).toBe(
    null,
  );
});
