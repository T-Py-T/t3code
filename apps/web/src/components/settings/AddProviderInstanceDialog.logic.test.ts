import { describe, expect, it } from "vite-plus/test";

import { resolveWizardNavigation } from "./AddProviderInstanceDialog.logic";

const stepCount = 3;

describe("resolveWizardNavigation", () => {
  it("allows backward navigation even when identity validation fails", () => {
    expect(resolveWizardNavigation(2, 0, stepCount, { instanceIdError: "Required" })).toEqual({
      kind: "navigate",
      step: 0,
    });
  });

  it("blocks skipping past identity without a valid instance id", () => {
    expect(resolveWizardNavigation(1, 2, stepCount, { instanceIdError: "Invalid id" })).toEqual({
      kind: "blocked",
      step: 1,
      error: "Invalid id",
    });
  });

  it("allows advancing past identity when validation passes", () => {
    expect(resolveWizardNavigation(1, 2, stepCount, { instanceIdError: null })).toEqual({
      kind: "navigate",
      step: 2,
    });
  });

  it("clamps requested steps to the wizard range", () => {
    expect(resolveWizardNavigation(0, 99, stepCount, { instanceIdError: null })).toEqual({
      kind: "navigate",
      step: 2,
    });
  });
});
