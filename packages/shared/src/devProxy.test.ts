import { describe, expect, it } from "vite-plus/test";

import { DEV_PROXIED_PATH_PREFIXES, isDevProxiedPath } from "./devProxy.ts";

describe("devProxy", () => {
  it("matches exact prefixes and nested paths only", () => {
    for (const prefix of DEV_PROXIED_PATH_PREFIXES) {
      expect(isDevProxiedPath(prefix)).toBe(true);
      expect(isDevProxiedPath(`${prefix}/nested`)).toBe(true);
    }

    expect(isDevProxiedPath("/apiary")).toBe(false);
    expect(isDevProxiedPath("/vite-asset.js")).toBe(false);
  });
});
