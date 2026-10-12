import { describe, expect, it } from "vite-plus/test";

import {
  mergeUpdateManifests,
  parseUpdateManifest,
  serializeUpdateManifest,
} from "./update-manifest.ts";

const sampleManifest = `version: '0.0.4'
files:
  - url: T3-Code-0.0.4-arm64.zip
    sha512: arm64zip
    size: 125621344
path: T3-Code-0.0.4-arm64.zip
sha512: arm64zip
stagingPercentage: 25
releaseDate: '2026-03-07T10:32:14.587Z'
`;

describe("update-manifest", () => {
  it("parses desktop update manifests and ignores legacy path fields", () => {
    const parsed = parseUpdateManifest(sampleManifest, "latest-mac.yml", "mac");

    expect(parsed.version).toBe("0.0.4");
    expect(parsed.releaseDate).toBe("2026-03-07T10:32:14.587Z");
    expect(parsed.files).toEqual([
      {
        url: "T3-Code-0.0.4-arm64.zip",
        sha512: "arm64zip",
        size: 125621344,
      },
    ]);
    expect(parsed.extras).toEqual({ stagingPercentage: 25 });
  });

  it("round-trips through serialize and parse", () => {
    const parsed = parseUpdateManifest(sampleManifest, "latest-mac.yml", "mac");
    const serialized = serializeUpdateManifest(parsed, { platformLabel: "mac" });
    const again = parseUpdateManifest(serialized, "latest-mac.yml", "mac");

    expect(again).toEqual(parsed);
  });

  it("merges manifests with the same version and picks the later release date", () => {
    const arm64 = parseUpdateManifest(
      `version: '0.0.4'
files:
  - url: arm64.zip
    sha512: a
    size: 1
releaseDate: '2026-03-07T10:32:14.587Z'
`,
      "arm64.yml",
      "mac",
    );
    const x64 = parseUpdateManifest(
      `version: '0.0.4'
files:
  - url: x64.zip
    sha512: b
    size: 2
releaseDate: '2026-03-07T10:36:07.540Z'
`,
      "x64.yml",
      "mac",
    );

    const merged = mergeUpdateManifests(arm64, x64, "mac");
    expect(merged.releaseDate).toBe("2026-03-07T10:36:07.540Z");
    expect(merged.files.map((file) => file.url)).toEqual(["arm64.zip", "x64.zip"]);
  });

  it("rejects merge when extras conflict", () => {
    const left = parseUpdateManifest(
      `version: '1.0.0'
files:
  - url: a.zip
    sha512: x
    size: 1
stagingPercentage: 10
releaseDate: '2026-01-01T00:00:00.000Z'
`,
      "left.yml",
      "win",
    );
    const right = parseUpdateManifest(
      `version: '1.0.0'
files:
  - url: b.zip
    sha512: y
    size: 2
stagingPercentage: 20
releaseDate: '2026-01-01T00:00:00.000Z'
`,
      "right.yml",
      "win",
    );

    expect(() => mergeUpdateManifests(left, right, "win")).toThrow(
      "Cannot merge win update manifests: conflicting 'stagingPercentage' values",
    );
  });
});
