import { describe, expect, it } from "vite-plus/test";

import {
  DEPENDENCY_SECURITY_PINS,
  findDependencySecurityPinViolations,
  readWorkspaceLockfile,
} from "./lib/dependency-security-pins.ts";

describe("dependency security pins", () => {
  it("resolves patched versions in pnpm-lock.yaml", () => {
    const violations = findDependencySecurityPinViolations(readWorkspaceLockfile());

    expect(
      violations,
      violations
        .map(
          (entry) =>
            `${entry.pin.package}@${entry.resolved} < ${entry.pin.minimum} (${entry.pin.advisory})`,
        )
        .join("\n"),
    ).toEqual([]);

    expect(DEPENDENCY_SECURITY_PINS.length).toBeGreaterThan(0);
  });
});
