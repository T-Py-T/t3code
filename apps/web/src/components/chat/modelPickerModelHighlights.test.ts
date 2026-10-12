import { ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { isModelPickerNewModel } from "./modelPickerModelHighlights";

describe("isModelPickerNewModel", () => {
  it("returns false when the model is not in the highlight set", () => {
    expect(isModelPickerNewModel(ProviderDriverKind.make("claudeAgent"), "claude-opus-4-6")).toBe(
      false,
    );
    expect(isModelPickerNewModel(ProviderDriverKind.make("codex"), "gpt-5")).toBe(false);
  });
});
