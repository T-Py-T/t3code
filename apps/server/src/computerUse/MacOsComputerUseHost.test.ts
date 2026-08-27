import * as NodeURL from "node:url";

import { describe, expect, it } from "vite-plus/test";

import { macOsComputerUseHelperPathCandidates } from "./MacOsComputerUseHost.ts";

describe("macOsComputerUseHelperPathCandidates", () => {
  it("prefers the explicit helper path without falling back", () => {
    expect(
      macOsComputerUseHelperPathCandidates(
        { computerUseHelperPath: "/Applications/T3 Code.app/Contents/Helpers/T3CodeComputerUse" },
        "file:///repo/apps/server/dist/bin.mjs",
      ),
    ).toEqual(["/Applications/T3 Code.app/Contents/Helpers/T3CodeComputerUse"]);
  });

  it("resolves the helper from a bundled server module", () => {
    const candidates = macOsComputerUseHelperPathCandidates(
      { computerUseHelperPath: undefined },
      "file:///repo/apps/server/dist/bin.mjs",
    );

    expect(candidates).toContain(
      NodeURL.fileURLToPath(
        new URL("file:///repo/native/computer-use-macos/.build/debug/T3CodeComputerUse"),
      ),
    );
  });

  it("resolves the helper when the module executes from source", () => {
    const candidates = macOsComputerUseHelperPathCandidates(
      { computerUseHelperPath: undefined },
      "file:///repo/apps/server/src/computerUse/MacOsComputerUseHost.ts",
    );

    expect(candidates).toContain(
      NodeURL.fileURLToPath(
        new URL("file:///repo/native/computer-use-macos/.build/debug/T3CodeComputerUse"),
      ),
    );
  });
});
