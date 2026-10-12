import { describe, expect, it } from "vite-plus/test";

import {
  BUILT_IN_THEME_IDS,
  BUILT_IN_THEMES,
  getBuiltInTheme,
  getThemeColorsForAppearance,
  MOBILE_THEME_IDS,
  THEME_COLOR_ROLES,
} from "./themePalettes.ts";

describe("themePalettes", () => {
  it("lists every built-in id in the mobile catalog", () => {
    for (const id of BUILT_IN_THEME_IDS) {
      expect(MOBILE_THEME_IDS).toContain(id);
    }
  });

  it("exposes a lookup helper for built-in themes", () => {
    expect(getBuiltInTheme("t3-chat")?.label).toBe("T3 Chat");
    expect(getBuiltInTheme("missing-theme")).toBeNull();
  });

  it("defines every color role on each built-in theme palette", () => {
    for (const theme of BUILT_IN_THEMES) {
      for (const role of THEME_COLOR_ROLES) {
        expect(theme.colors[role], `${theme.id} primary ${role}`).toMatch(/^#|oklch\(/);
      }

      const dark = getThemeColorsForAppearance(theme, "dark");
      const light = getThemeColorsForAppearance(theme, "light");
      if (theme.appearance === "dark") {
        expect(dark).toEqual(theme.colors);
      }
      if (theme.appearance === "light") {
        expect(light).toEqual(theme.colors);
      }
      for (const palette of [dark, light]) {
        if (!palette) continue;
        for (const role of THEME_COLOR_ROLES) {
          expect(palette[role], `${theme.id} variant ${role}`).toMatch(/^#|oklch\(/);
        }
      }
    }
  });
});
