import { describe, expect, it } from "vite-plus/test";

import { truncate } from "./String.ts";

describe("truncate", () => {
  it("trims surrounding whitespace before measuring length", () => {
    expect(truncate("  hello world  ", 20)).toBe("hello world");
  });

  it("appends an ellipsis when the trimmed text exceeds maxLength", () => {
    expect(truncate("abcdefghijklmnopqrstuvwxyz", 5)).toBe("abcde...");
  });

  it("returns the trimmed text unchanged when within the limit", () => {
    expect(truncate("short", 10)).toBe("short");
  });
});
