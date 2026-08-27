import type { ComputerUseControlState } from "@t3tools/contracts";
import {
  ComputerUseHostId,
  ComputerUseTargetId,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { visitElements } from "../../test/reactElementTree";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";

const atoms = vi.hoisted(() => ({
  controlState: Symbol("computerUseControlState"),
  history: Symbol("computerUseHistory"),
  clearHistory: Symbol("clearComputerUseHistory"),
  pause: Symbol("pauseComputerUse"),
  resume: Symbol("resumeComputerUse"),
  revoke: Symbol("revokeComputerUsePersistentGrant"),
  stop: Symbol("stopComputerUse"),
}));

const commands = vi.hoisted(() => ({
  clearHistory: vi.fn(),
  pause: vi.fn(),
  resume: vi.fn(),
  revoke: vi.fn(),
  stop: vi.fn(),
}));

const query = vi.hoisted(() => ({
  data: null as ComputerUseControlState | null,
  error: null as string | null,
  isPending: false,
  refresh: vi.fn(),
}));

const historyQuery = vi.hoisted(() => ({
  data: null as import("@t3tools/contracts").ComputerUseHistoryResult | null,
  error: null as string | null,
  isPending: false,
  refresh: vi.fn(),
}));

const environmentId = EnvironmentId.make("environment-1");
const hostId = ComputerUseHostId.make("signed-host-1");

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useCallback: reactHookHarness.useCallback,
    useMemo: reactHookHarness.useMemo,
    useState: reactHookHarness.useState,
  };
});

vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});

vi.mock("../../state/server", () => ({
  serverEnvironment: {
    computerUseControlState: () => atoms.controlState,
    computerUseHistory: () => atoms.history,
    clearComputerUseHistory: atoms.clearHistory,
    pauseComputerUse: atoms.pause,
    resumeComputerUse: atoms.resume,
    revokeComputerUsePersistentGrant: atoms.revoke,
    stopComputerUse: atoms.stop,
  },
}));

vi.mock("../../state/environments", () => ({
  usePrimaryEnvironment: () => ({ environmentId, label: "This Mac" }),
}));

vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (atom: symbol | null) => (atom === atoms.history ? historyQuery : query),
}));

vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: symbol) =>
    command === atoms.revoke
      ? commands.revoke
      : command === atoms.clearHistory
        ? commands.clearHistory
        : command === atoms.pause
          ? commands.pause
          : command === atoms.resume
            ? commands.resume
            : commands.stop,
}));

import { ComputerUseAccessControls } from "./IntegrationsSettings";

function renderControls(): ReactElement<Record<string, unknown>> {
  hooks.beginRender();
  return ComputerUseAccessControls() as ReactElement<Record<string, unknown>>;
}

describe("ComputerUseAccessControls", () => {
  beforeEach(() => {
    hooks.reset();
    commands.revoke.mockReset().mockResolvedValue({ _tag: "Success", value: { removed: 1 } });
    commands.clearHistory.mockReset().mockResolvedValue({
      _tag: "Success",
      value: { deleted: 1 },
    });
    commands.stop.mockReset().mockResolvedValue({ _tag: "Success", value: { stopped: 1 } });
    commands.pause.mockReset().mockResolvedValue({ _tag: "Success", value: { stopped: 1 } });
    commands.resume.mockReset().mockResolvedValue({ _tag: "Success", value: { resumed: true } });
    query.refresh.mockReset();
    query.data = {
      environmentId,
      paused: false,
      host: {
        hostId,
        environmentId,
        platform: "macos",
        protocolVersion: 1,
        supportedOperations: ["status", "listTargets", "observe", "act"],
        verifiedIdentity: { subject: "com.t3tools.t3code", publisher: "T3 Code" },
      },
      activeControl: {
        threadId: ThreadId.make("thread-1"),
        turnId: TurnId.make("turn-1"),
        providerInstanceId: ProviderInstanceId.make("atomic"),
      },
      persistentGrants: [
        {
          environmentId,
          hostId,
          target: {
            targetId: ComputerUseTargetId.make("target-textedit"),
            kind: "application",
            displayName: "TextEdit",
            applicationId: "com.apple.TextEdit",
            stableIdentity: "macos:com.apple.TextEdit:APPLE",
          },
          access: "operate",
        },
      ],
    };
    historyQuery.data = {
      entries: [
        {
          entryId: "history-1" as import("@t3tools/contracts").ComputerUseHistoryEntryId,
          environmentId,
          hostId,
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
          state: "completed",
          summary: "Completed 1 action in TextEdit.",
          resultTag: "success",
          createdAt: "2026-08-27T20:00:00.000Z",
        },
      ],
    };
  });

  it("shows the connected controller and exposes stop and revoke actions", async () => {
    const controls = renderControls();
    expect(
      visitElements(controls, (element) => element.props["data-computer-use-status"] === "active"),
    ).not.toBeNull();
    expect(
      visitElements(
        controls,
        (element) => element.props["data-computer-use-grant"] === "TextEdit:operate",
      ),
    ).not.toBeNull();

    const stop = visitElements(
      controls,
      (element) => element.props["aria-label"] === "Stop computer control",
    );
    const pause = visitElements(
      controls,
      (element) => element.props["aria-label"] === "Pause computer control",
    );
    const revoke = visitElements(
      controls,
      (element) => element.props["aria-label"] === "Remove TextEdit computer access",
    );
    const clear = visitElements(
      controls,
      (element) => element.props["aria-label"] === "Clear Computer Use history",
    );
    (stop?.props.onClick as (() => void) | undefined)?.();
    (pause?.props.onClick as (() => void) | undefined)?.();
    (revoke?.props.onClick as (() => void) | undefined)?.();
    (clear?.props.onClick as (() => void) | undefined)?.();
    await Promise.resolve();

    expect(commands.stop).toHaveBeenCalledWith({ environmentId, input: {} });
    expect(commands.pause).toHaveBeenCalledWith({ environmentId, input: {} });
    expect(commands.revoke).toHaveBeenCalledWith({
      environmentId,
      input: {
        hostId,
        stableIdentity: "macos:com.apple.TextEdit:APPLE",
      },
    });
    expect(commands.clearHistory).toHaveBeenCalledWith({ environmentId, input: {} });
    expect(
      visitElements(
        controls,
        (element) => element.props["data-computer-use-history"] === "completed",
      ),
    ).not.toBeNull();
  });

  it("shows paused state and resumes only on an explicit user action", async () => {
    if (query.data) {
      query.data = { ...query.data, paused: true, activeControl: undefined };
    }
    const controls = renderControls();
    expect(
      visitElements(controls, (element) => element.props["data-computer-use-status"] === "paused"),
    ).not.toBeNull();
    const resume = visitElements(
      controls,
      (element) => element.props["aria-label"] === "Resume computer control",
    );
    (resume?.props.onClick as (() => void) | undefined)?.();
    await Promise.resolve();
    expect(commands.resume).toHaveBeenCalledWith({ environmentId, input: {} });
  });
});
