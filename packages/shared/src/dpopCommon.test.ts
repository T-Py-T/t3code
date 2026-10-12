import { describe, expect, it } from "vite-plus/test";

import { normalizeDpopHtu } from "./dpopCommon.ts";

describe("normalizeDpopHtu", () => {
  it("strips query strings and fragments", () => {
    expect(normalizeDpopHtu("https://api.example.test/resource?foo=1#frag")).toBe(
      "https://api.example.test/resource",
    );
  });

  it("returns null for invalid URLs", () => {
    expect(normalizeDpopHtu("not-a-url")).toBeNull();
  });
});
