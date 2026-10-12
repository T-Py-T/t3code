import { assert, describe, it } from "@effect/vitest";

import {
  cacheSavingsUsd,
  lookupRate,
  normalizeModelName,
  parseRateTable,
  priceUsage,
} from "./usagePricing.ts";

describe("usagePricing", () => {
  it("parseRateTable drops entries without input and output rates", () => {
    const table = parseRateTable({
      complete: {
        input_cost_per_token: 0.000003,
        output_cost_per_token: 0.000015,
      },
      missingOutput: { input_cost_per_token: 1 },
      missingInput: { output_cost_per_token: 1 },
      notAnObject: "nope",
    });

    assert.strictEqual(table.size, 1);
    const rate = lookupRate(table, "complete");
    assert.isNotNull(rate);
    assert.strictEqual(rate!.inputCostPerToken, 0.000003);
    assert.strictEqual(rate!.outputCostPerToken, 0.000015);
  });

  it("parseRateTable defaults cache rates to input when omitted", () => {
    const table = parseRateTable({
      model: {
        input_cost_per_token: 2,
        output_cost_per_token: 3,
      },
    });
    const rate = lookupRate(table, "model");
    assert.strictEqual(rate!.cacheReadCostPerToken, 2);
    assert.strictEqual(rate!.cacheCreationCostPerToken, 2);
  });

  it("normalizeModelName strips provider prefix and lowercases", () => {
    assert.strictEqual(normalizeModelName("anthropic/claude-opus-5"), "claude-opus-5");
    assert.strictEqual(normalizeModelName("  GPT-4o  "), "gpt-4o");
  });

  it("lookupRate returns null for ambiguous or synthetic models", () => {
    const table = parseRateTable({
      opus: { input_cost_per_token: 1, output_cost_per_token: 1 },
    });
    assert.isNull(lookupRate(table, "opus"));
    assert.isNull(lookupRate(table, "<synthetic>"));
    assert.isNull(lookupRate(table, ""));
  });

  it("priceUsage prefers provider-reported cost", () => {
    const table = parseRateTable({
      m: { input_cost_per_token: 1, output_cost_per_token: 1 },
    });
    const priced = priceUsage(
      table,
      "m",
      {
        uncachedInputTokens: 100,
        cachedInputTokens: 0,
        cacheCreationTokens: 0,
        outputTokens: 10,
        reasoningTokens: 0,
      },
      0.42,
    );
    assert.strictEqual(priced.costUsd, 0.42);
    assert.strictEqual(priced.costSource, "providerReported");
  });

  it("priceUsage computes model-priced totals from token buckets", () => {
    const table = parseRateTable({
      m: {
        input_cost_per_token: 0.001,
        output_cost_per_token: 0.01,
        cache_read_input_token_cost: 0.0002,
        cache_creation_input_token_cost: 0.002,
      },
    });
    const priced = priceUsage(
      table,
      "m",
      {
        uncachedInputTokens: 10,
        cachedInputTokens: 5,
        cacheCreationTokens: 2,
        outputTokens: 3,
        reasoningTokens: 1,
      },
      null,
    );
    assert.strictEqual(priced.costSource, "modelPriced");
    assert.strictEqual(priced.costUsd, 10 * 0.001 + 5 * 0.0002 + 2 * 0.002 + 3 * 0.01);
  });

  it("cacheSavingsUsd measures discount on cached input", () => {
    const table = parseRateTable({
      m: {
        input_cost_per_token: 1,
        output_cost_per_token: 0,
        cache_read_input_token_cost: 0.25,
      },
    });
    assert.strictEqual(
      cacheSavingsUsd(table, "m", {
        uncachedInputTokens: 0,
        cachedInputTokens: 4,
        cacheCreationTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
      }),
      3,
    );
  });
});
