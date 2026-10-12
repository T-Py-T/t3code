import { ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  CHECKPOINT_REFS_PREFIX,
  checkpointRefForThreadTurn,
  resolveThreadWorkspaceCwd,
} from "./Utils.ts";

describe("checkpointRefForThreadTurn", () => {
  it("builds a stable ref under the checkpoints prefix", () => {
    const threadId = ThreadId.make("thread-abc");
    const ref = checkpointRefForThreadTurn(threadId, 3);

    expect(ref).toContain(CHECKPOINT_REFS_PREFIX);
    expect(ref).toContain("/turn/3");
  });
});

describe("resolveThreadWorkspaceCwd", () => {
  const projectId = ProjectId.make("project-1");

  it("prefers the thread worktree path when set", () => {
    expect(
      resolveThreadWorkspaceCwd({
        thread: { projectId, worktreePath: "/worktrees/feature" },
        projects: [{ id: projectId, workspaceRoot: "/repo" }],
      }),
    ).toBe("/worktrees/feature");
  });

  it("falls back to the project workspace root", () => {
    expect(
      resolveThreadWorkspaceCwd({
        thread: { projectId, worktreePath: null },
        projects: [{ id: projectId, workspaceRoot: "/repo" }],
      }),
    ).toBe("/repo");
  });

  it("returns undefined when no worktree or matching project exists", () => {
    expect(
      resolveThreadWorkspaceCwd({
        thread: { projectId, worktreePath: null },
        projects: [],
      }),
    ).toBeUndefined();
  });
});
