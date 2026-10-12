import { describe, expect, it } from "@effect/vitest";

import {
  extractBranchNameFromRemoteRef,
  parseRemoteNames,
  parseRemoteNamesInGitOrder,
  parseRemoteRefWithRemoteNames,
} from "./remoteRefs.ts";

describe("parseRemoteNames", () => {
  it("preserves git order in parseRemoteNamesInGitOrder", () => {
    expect(parseRemoteNamesInGitOrder("origin\nupstream\n")).toEqual(["origin", "upstream"]);
  });

  it("sorts remotes longest-first for prefix matching", () => {
    expect(parseRemoteNames("origin\nupstream\n")).toEqual(["upstream", "origin"]);
  });
});

describe("parseRemoteRefWithRemoteNames", () => {
  const remotes = ["upstream", "origin"];

  it("matches the longest applicable remote prefix", () => {
    expect(parseRemoteRefWithRemoteNames("origin/main", remotes)).toEqual({
      remoteRef: "origin/main",
      remoteName: "origin",
      branchName: "main",
    });
  });

  it("returns null for empty branch segments", () => {
    expect(parseRemoteRefWithRemoteNames("origin/", remotes)).toBeNull();
  });
});

describe("extractBranchNameFromRemoteRef", () => {
  it("strips refs/remotes and remote prefixes", () => {
    expect(
      extractBranchNameFromRemoteRef("refs/remotes/origin/feature/x", {
        remoteNames: ["origin"],
      }),
    ).toBe("feature/x");
  });

  it("falls back to the segment after the first slash", () => {
    expect(extractBranchNameFromRemoteRef("custom/branch")).toBe("branch");
    expect(extractBranchNameFromRemoteRef("plain-branch")).toBe("plain-branch");
  });
});
