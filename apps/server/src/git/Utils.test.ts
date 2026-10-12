// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";

import { isGitRepository } from "./Utils.ts";

describe("isGitRepository", () => {
  it("returns true when a .git directory exists", () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-git-utils-"));
    NodeFS.mkdirSync(NodePath.join(dir, ".git"));
    assert.isTrue(isGitRepository(dir));
    NodeFS.rmSync(dir, { recursive: true, force: true });
  });

  it("returns false for a plain directory", () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-git-utils-"));
    assert.isFalse(isGitRepository(dir));
    NodeFS.rmSync(dir, { recursive: true, force: true });
  });
});
