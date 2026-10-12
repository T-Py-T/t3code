import { assert, describe, it } from "@effect/vitest";

import {
  conventionalCommitsTextGenerationPolicy,
  customTextGenerationPolicy,
  defaultTextGenerationPolicy,
  repositoryConventionsTextGenerationPolicy,
  textGenerationPresets,
} from "./TextGenerationPresets.ts";

describe("textGenerationPresets", () => {
  it("exposes stable preset policies by kind", () => {
    assert.strictEqual(textGenerationPresets.default.kind, "default");
    assert.strictEqual(textGenerationPresets.conventional_commits.kind, "conventional_commits");
    assert.strictEqual(textGenerationPresets.repo_conventions.kind, "repo_conventions");
    assert.strictEqual(defaultTextGenerationPolicy.inferRepositoryConventions, false);
    assert.strictEqual(repositoryConventionsTextGenerationPolicy.inferRepositoryConventions, true);
    assert.isString(conventionalCommitsTextGenerationPolicy.commitInstructions);
  });

  it("customTextGenerationPolicy merges overrides onto a custom kind", () => {
    const policy = customTextGenerationPolicy({
      commitInstructions: "Use emoji prefixes",
      inferRepositoryConventions: true,
    });
    assert.strictEqual(policy.kind, "custom");
    assert.strictEqual(policy.commitInstructions, "Use emoji prefixes");
    assert.strictEqual(policy.inferRepositoryConventions, true);
  });
});
