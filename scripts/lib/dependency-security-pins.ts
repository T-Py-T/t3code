// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

export interface DependencySecurityPin {
  readonly package: string;
  readonly minimum: string;
  readonly advisory: string;
  /** When set, only lockfile versions whose major segment matches are checked. */
  readonly major?: number;
  /** When set, only lockfile versions starting with this prefix are checked (e.g. `0.8.`). */
  readonly versionPrefix?: string;
}

/**
 * Workspace overrides that mitigate known advisories. The paired test ensures
 * `pnpm-lock.yaml` resolves at or above these floors after install.
 */
export const DEPENDENCY_SECURITY_PINS: readonly DependencySecurityPin[] = [
  {
    package: "astro",
    minimum: "7.2.8",
    advisory: "GHSA-26w7-cxv4-gfx2",
  },
  {
    package: "devalue",
    minimum: "5.9.3",
    advisory: "GHSA-wf3x-273g-mvxv",
  },
  {
    package: "seroval",
    minimum: "1.6.1",
    advisory: "GHSA-mv8w-475r-vwqw",
  },
  {
    package: "tar",
    minimum: "7.5.19",
    advisory: "GHSA-23hp-3jrh-7fpw",
  },
  {
    package: "path-to-regexp",
    minimum: "6.3.0",
    major: 6,
    advisory: "GHSA-9wv6-86v2-598j",
  },
  {
    package: "undici",
    minimum: "6.29.0",
    major: 6,
    advisory: "GHSA-8436-99hf-9mmv",
  },
  {
    package: "undici",
    minimum: "7.30.0",
    major: 7,
    advisory: "GHSA-8436-99hf-9mmv",
  },
  {
    package: "undici",
    minimum: "8.11.2",
    major: 8,
    advisory: "GHSA-8436-99hf-9mmv",
  },
  {
    package: "@vitest/browser",
    minimum: "4.1.10",
    advisory: "GHSA-p63j-vcc4-9vmv",
  },
  {
    package: "electron",
    minimum: "41.10.7",
    advisory: "GHSA-r4w5-6pfg-jxp5",
  },
  {
    package: "hono",
    minimum: "4.13.7",
    advisory: "GHSA-9r54-4xrw-9vwh",
  },
  {
    package: "fast-uri",
    minimum: "3.1.8",
    advisory: "GHSA-7qff-7r8w-3jxr",
  },
  {
    package: "@xmldom/xmldom",
    minimum: "0.8.15",
    versionPrefix: "0.8.",
    advisory: "GHSA-6fg7-h29m-hq8p",
  },
  {
    package: "@xmldom/xmldom",
    minimum: "0.9.12",
    versionPrefix: "0.9.",
    advisory: "GHSA-6fg7-h29m-hq8p",
  },
  {
    package: "brace-expansion",
    minimum: "1.1.21",
    major: 1,
    advisory: "GHSA-2m24-5m98-8p9f",
  },
  {
    package: "brace-expansion",
    minimum: "2.1.7",
    major: 2,
    advisory: "GHSA-2m24-5m98-8p9f",
  },
  {
    package: "brace-expansion",
    minimum: "5.0.12",
    major: 5,
    advisory: "GHSA-2m24-5m98-8p9f",
  },
];

const REPO_ROOT = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../..",
);

export function compareSemver(left: string, right: string): number {
  const leftParts = left.split(".").map((part) => Number.parseInt(part, 10));
  const rightParts = right.split(".").map((part) => Number.parseInt(part, 10));
  const length = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < length; index += 1) {
    const leftValue = leftParts[index] ?? 0;
    const rightValue = rightParts[index] ?? 0;
    if (leftValue > rightValue) return 1;
    if (leftValue < rightValue) return -1;
  }

  return 0;
}

export function readLockedPackageVersions(
  lockfileContents: string,
  packageName: string,
): readonly string[] {
  const versions = new Set<string>();
  const escaped = packageName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const quoted = new RegExp(`^  '${escaped.replace("/", "\\/")}@([^:(]+)`, "gm");
  const bare = new RegExp(`^  ${escaped}@([^:(]+)`, "gm");

  for (const pattern of [quoted, bare]) {
    for (const match of lockfileContents.matchAll(pattern)) {
      const version = match[1];
      // Ignore pnpm override aliases such as `undici@6:` that are not semver versions.
      if (version !== undefined && /^\d+\.\d+/.test(version)) versions.add(version);
    }
  }

  return [...versions];
}

export function readWorkspaceLockfile(repoRoot = REPO_ROOT): string {
  return NodeFS.readFileSync(NodePath.join(repoRoot, "pnpm-lock.yaml"), "utf8");
}

export interface PinViolation {
  readonly pin: DependencySecurityPin;
  readonly resolved: string;
}

export function findDependencySecurityPinViolations(
  lockfileContents: string,
  pins: readonly DependencySecurityPin[] = DEPENDENCY_SECURITY_PINS,
): PinViolation[] {
  const violations: PinViolation[] = [];

  for (const pin of pins) {
    for (const resolved of readLockedPackageVersions(lockfileContents, pin.package)) {
      if (pin.major !== undefined) {
        const major = Number.parseInt(resolved.split(".")[0] ?? "", 10);
        if (major !== pin.major) continue;
      }

      if (pin.versionPrefix !== undefined && !resolved.startsWith(pin.versionPrefix)) {
        continue;
      }

      if (compareSemver(resolved, pin.minimum) < 0) {
        violations.push({ pin, resolved });
      }
    }
  }

  return violations;
}
