import { describe, expect, it } from "vite-plus/test";

import { STANDARD_THEME_PREVIEW_COLORS } from "./themePreview.ts";
import { mixThemePreviewBase } from "./themePreview.ts";

describe("mixThemePreviewBase", () => {
  it("returns the canvas color when parsing fails", () => {
    expect(mixThemePreviewBase({ canvas: "not-a-color", accent: "#000", messageAction: "#000" }, "light")).toBe(
      "not-a-color",
    );
  });

  it("mixes hex canvas colors toward the mode base target", () => {
    const mixed = mixThemePreviewBase(STANDARD_THEME_PREVIEW_COLORS.light, "light");
    expect(mixed).toMatch(/^#[0-9a-f]{6}$/i);
    expect(mixed).not.toBe(STANDARD_THEME_PREVIEW_COLORS.light.canvas);
  });

  it("supports oklch canvas inputs for dark previews", () => {
    const mixed = mixThemePreviewBase(
      {
        canvas: "oklch(0.2 0.02 300)",
        accent: STANDARD_THEME_PREVIEW_COLORS.dark.accent,
        messageAction: STANDARD_THEME_PREVIEW_COLORS.dark.messageAction,
      },
      "dark",
    );
    expect(mixed).toMatch(/^#[0-9a-f]{6}$/i);
  });
});
