import { assert, describe, it } from "@effect/vitest";

import { DEFAULT_THREAD_TITLE, canReplaceThreadTitle } from "./threadTitles.ts";

describe("canReplaceThreadTitle", () => {
  it("allows replacement when the title is still the default", () => {
    assert.isTrue(canReplaceThreadTitle(DEFAULT_THREAD_TITLE));
    assert.isTrue(canReplaceThreadTitle(`  ${DEFAULT_THREAD_TITLE}  `));
  });

  it("allows replacement when the current title matches the seed", () => {
    assert.isTrue(canReplaceThreadTitle("Fix login bug", "Fix login bug"));
    assert.isTrue(canReplaceThreadTitle("  Fix login bug  ", "Fix login bug"));
  });

  it("blocks replacement for user-edited titles without a matching seed", () => {
    assert.isFalse(canReplaceThreadTitle("My custom title"));
    assert.isFalse(canReplaceThreadTitle("Fix login bug", "Different seed"));
    assert.isFalse(canReplaceThreadTitle("Fix login bug", ""));
    assert.isFalse(canReplaceThreadTitle("Fix login bug", "   "));
  });
});
