import { describe, expect, it } from "vite-plus/test";

import {
  deriveActiveWorkStartedAt,
  formatDuration,
  formatElapsed,
  isLatestTurnSettled,
} from "./orchestrationTiming.ts";

describe("orchestrationTiming", () => {
  it("formats durations for sub-second and multi-minute ranges", () => {
    expect(formatDuration(0)).toBe("0ms");
    expect(formatDuration(12.4)).toBe("12ms");
    expect(formatDuration(1_500)).toBe("1.5s");
    expect(formatDuration(45_000)).toBe("45s");
    expect(formatDuration(125_000)).toBe("2m 5s");
  });

  it("formats elapsed time between ISO timestamps", () => {
    expect(formatElapsed("2026-01-01T00:00:00.000Z", "2026-01-01T00:00:02.500Z")).toBe("2.5s");
    expect(formatElapsed("invalid", "2026-01-01T00:00:02.500Z")).toBeNull();
  });

  it("detects settled turns and derives active work start times", () => {
    const latestTurn = {
      turnId: "turn-1",
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:00:05.000Z",
    };

    expect(isLatestTurnSettled(latestTurn, { orchestrationStatus: "idle" })).toBe(true);
    expect(isLatestTurnSettled(latestTurn, { orchestrationStatus: "running" })).toBe(false);
    expect(
      deriveActiveWorkStartedAt(latestTurn, { orchestrationStatus: "idle" }, "2026-01-01T00:00:10.000Z"),
    ).toBe("2026-01-01T00:00:10.000Z");
    expect(
      deriveActiveWorkStartedAt(latestTurn, { orchestrationStatus: "running" }, null),
    ).toBe("2026-01-01T00:00:00.000Z");
  });
});
