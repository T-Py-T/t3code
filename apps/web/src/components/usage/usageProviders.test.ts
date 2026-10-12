import { describe, expect, it } from "vite-plus/test";

import { PROVIDER_ORDER, PROVIDER_PRESENTATION, providersWithUsage } from "./usageProviders";

describe("PROVIDER_PRESENTATION", () => {
  it("covers every provider in stable order", () => {
    expect(PROVIDER_ORDER).toEqual(["codex", "claude", "grok"]);
    for (const provider of PROVIDER_ORDER) {
      expect(PROVIDER_PRESENTATION[provider].label.length).toBeGreaterThan(0);
    }
  });
});

describe("providersWithUsage", () => {
  it("returns providers with token or cost activity in chart order", () => {
    expect(
      providersWithUsage([
        { provider: "grok", costUsd: 0, totalTokens: 0 },
        { provider: "claude", costUsd: 0, totalTokens: 42 },
        { provider: "codex", costUsd: 1.5, totalTokens: 0 },
      ]),
    ).toEqual(["codex", "claude"]);
  });

  it("returns an empty list when nothing is active", () => {
    expect(providersWithUsage([{ provider: "codex", costUsd: 0, totalTokens: 0 }])).toEqual([]);
  });
});
