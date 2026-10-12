import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";

import {
  compactMetricAttributes,
  normalizeModelMetricLabel,
  outcomeFromExit,
} from "./Attributes.ts";

describe("compactMetricAttributes", () => {
  it("drops nullish values and stringifies primitives", () => {
    expect(
      compactMetricAttributes({
        keep: "value",
        count: 3,
        enabled: true,
        big: 9n,
        skip: null,
        missing: undefined,
        nested: { nope: true },
      }),
    ).toEqual({
      keep: "value",
      count: "3",
      enabled: "true",
      big: "9",
    });
  });
});

describe("outcomeFromExit", () => {
  it("classifies success, failure, and interrupt exits", () => {
    expect(outcomeFromExit(Exit.succeed(1))).toBe("success");
    expect(outcomeFromExit(Exit.fail("boom"))).toBe("failure");
    expect(
      outcomeFromExit(Exit.failCause(Cause.interrupt("fiber-1" as never))),
    ).toBe("interrupt");
  });
});

describe("normalizeModelMetricLabel", () => {
  it("maps known families and trims casing", () => {
    expect(normalizeModelMetricLabel("  GPT-4o ")).toBe("gpt");
    expect(normalizeModelMetricLabel("claude-sonnet")).toBe("claude");
    expect(normalizeModelMetricLabel("gemini-pro")).toBe("gemini");
    expect(normalizeModelMetricLabel("custom-model")).toBe("other");
  });

  it("returns undefined for blank input", () => {
    expect(normalizeModelMetricLabel("   ")).toBeUndefined();
    expect(normalizeModelMetricLabel(null)).toBeUndefined();
  });
});
