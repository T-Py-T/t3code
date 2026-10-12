import { describe, expect, it } from "vite-plus/test";

import { describeReadinessCause } from "./httpReadiness.ts";

describe("describeReadinessCause", () => {
  it("preserves tagged error shape and nested causes", () => {
    const nested = new Error("inner");
    const error = Object.assign(new Error("outer"), {
      _tag: "ProbeError",
      cause: nested,
    });

    expect(describeReadinessCause(error)).toEqual({
      _tag: "ProbeError",
      message: "outer",
      cause: {
        name: "Error",
        message: "inner",
      },
    });
  });

  it("walks plain object reason chains", () => {
    expect(
      describeReadinessCause({
        _tag: "Timeout",
        message: "timed out",
        reason: { message: "socket hang up" },
      }),
    ).toEqual({
      _tag: "Timeout",
      message: "timed out",
      reason: { message: "socket hang up" },
    });
  });
});
