import { describe, expect, it } from "vite-plus/test";

import {
  formatAppDisplayName,
  resolveServerBackedAppDisplayName,
  resolveServerBackedAppStageLabel,
} from "./branding.logic";

describe("formatAppDisplayName", () => {
  it("omits the stage label for latest", () => {
    expect(formatAppDisplayName({ baseName: "T3 Code", stageLabel: "Latest" })).toBe("T3 Code");
  });

  it("appends other stage labels", () => {
    expect(formatAppDisplayName({ baseName: "T3 Code", stageLabel: "Nightly" })).toBe(
      "T3 Code (Nightly)",
    );
  });
});

describe("resolveServerBackedAppStageLabel", () => {
  it("detects nightly server versions", () => {
    expect(
      resolveServerBackedAppStageLabel({
        primaryServerVersion: "1.2.3-nightly.20260408.4",
        fallbackStageLabel: "Beta",
      }),
    ).toBe("Nightly");
  });

  it("uses the fallback when the server is not nightly", () => {
    expect(
      resolveServerBackedAppStageLabel({
        primaryServerVersion: "1.2.3",
        fallbackStageLabel: "Beta",
      }),
    ).toBe("Beta");
  });
});

describe("resolveServerBackedAppDisplayName", () => {
  it("keeps the fallback display name when the stage is unchanged", () => {
    expect(
      resolveServerBackedAppDisplayName({
        baseName: "T3 Code",
        fallbackDisplayName: "T3 Code (Beta)",
        fallbackStageLabel: "Beta",
        primaryServerVersion: "1.0.0",
      }),
    ).toBe("T3 Code (Beta)");
  });

  it("reformats when nightly is detected", () => {
    expect(
      resolveServerBackedAppDisplayName({
        baseName: "T3 Code",
        fallbackDisplayName: "T3 Code (Beta)",
        fallbackStageLabel: "Beta",
        primaryServerVersion: "1.0.0-nightly.20260408.1",
      }),
    ).toBe("T3 Code (Nightly)");
  });
});
