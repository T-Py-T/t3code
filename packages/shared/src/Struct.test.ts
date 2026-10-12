import { describe, expect, it } from "vite-plus/test";

import { deepMerge } from "./Struct.ts";

describe("deepMerge", () => {
  it("merges nested objects without mutating the source", () => {
    const current = { a: 1, nested: { x: 1, y: 2 } };
    const patch = { nested: { y: 3, z: 4 } };
    const merged = deepMerge(current, patch);

    expect(merged).toEqual({ a: 1, nested: { x: 1, y: 3, z: 4 } });
    expect(current.nested).toEqual({ x: 1, y: 2 });
  });

  it("replaces scalar values while leaving omitted keys untouched", () => {
    const current = { keep: "old", drop: "value" };
    const merged = deepMerge(current, { drop: "next" });

    expect(merged).toEqual({ keep: "old", drop: "next" });
  });

  it("returns the patch when either side is not an object", () => {
    expect(deepMerge({ a: 1 }, null as unknown as { a: number })).toBeNull();
    expect(deepMerge(null as unknown as { a: number }, { a: 2 })).toEqual({ a: 2 });
  });
});
