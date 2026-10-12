import { describe, expect, it } from "vite-plus/test";

import {
  projectScriptCwd,
  projectScriptRuntimeEnv,
  setupProjectScript,
} from "./projectScripts.ts";

describe("projectScripts", () => {
  it("prefers the active worktree path for script cwd", () => {
    expect(
      projectScriptCwd({
        project: { cwd: "/repo" },
        worktreePath: "/repo/.worktrees/feature",
      }),
    ).toBe("/repo/.worktrees/feature");
  });

  it("builds runtime env with project root and optional worktree path", () => {
    expect(
      projectScriptRuntimeEnv({
        project: { cwd: "/repo" },
        worktreePath: "/repo/.worktrees/feature",
        extraEnv: { FOO: "bar" },
      }),
    ).toEqual({
      T3CODE_PROJECT_ROOT: "/repo",
      T3CODE_WORKTREE_PATH: "/repo/.worktrees/feature",
      FOO: "bar",
    });
  });

  it("returns the first run-on-worktree-create script", () => {
    const selected = setupProjectScript([
      { id: "a", name: "A", command: "echo a", icon: "play", runOnWorktreeCreate: false },
      { id: "b", name: "B", command: "echo b", icon: "test", runOnWorktreeCreate: true },
      { id: "c", name: "C", command: "echo c", icon: "lint", runOnWorktreeCreate: true },
    ]);

    expect(selected?.id).toBe("b");
  });
});
