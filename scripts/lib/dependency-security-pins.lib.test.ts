import { describe, expect, it } from "vite-plus/test";

import {
  compareSemver,
  findDependencySecurityPinViolations,
  readLockedPackageVersions,
} from "./dependency-security-pins.ts";

describe("dependency-security-pins helpers", () => {
  it("compares dotted numeric versions", () => {
    expect(compareSemver("7.5.19", "7.5.18")).toBe(1);
    expect(compareSemver("6.29.0", "7.0.0")).toBe(-1);
    expect(compareSemver("4.1.10", "4.1.10")).toBe(0);
  });

  it("reads scoped and bare package versions from lockfile snippets", () => {
    const lockfile = `
  '@vitest/browser@4.1.9':
    resolution: {integrity: sha512-abc}

  lodash@4.17.21:
    resolution: {integrity: sha512-def}

  undici@6:
    specifier: ^6.0.0
`;

    expect(readLockedPackageVersions(lockfile, "@vitest/browser")).toEqual(["4.1.9"]);
    expect(readLockedPackageVersions(lockfile, "lodash")).toEqual(["4.17.21"]);
    expect(readLockedPackageVersions(lockfile, "undici")).toEqual([]);
  });

  it("flags versions below configured floors per major line", () => {
    const lockfile = `
  path-to-regexp@6.2.0:
    resolution: {integrity: sha512-abc}

  path-to-regexp@0.1.12:
    resolution: {integrity: sha512-def}

  undici@6.28.0:
    resolution: {integrity: sha512-ghi}

  undici@8.11.0:
    resolution: {integrity: sha512-jkl}
`;

    const violations = findDependencySecurityPinViolations(lockfile, [
      { package: "path-to-regexp", minimum: "6.3.0", major: 6, advisory: "TEST" },
      { package: "undici", minimum: "6.29.0", major: 6, advisory: "TEST" },
      { package: "undici", minimum: "8.10.2", major: 8, advisory: "TEST" },
    ]);

    expect(violations.map((entry) => `${entry.pin.package}@${entry.resolved}`)).toEqual([
      "path-to-regexp@6.2.0",
      "undici@6.28.0",
    ]);
  });
});
