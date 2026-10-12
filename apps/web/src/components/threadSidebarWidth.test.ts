import { describe, expect, it } from "vite-plus/test";

import {
  THREAD_MAIN_CONTENT_MIN_WIDTH,
  THREAD_SIDEBAR_MIN_WIDTH,
  resolveInitialThreadSidebarWidth,
  resolveThreadSidebarMaximumWidth,
} from "./threadSidebarWidth";

describe("resolveThreadSidebarMaximumWidth", () => {
  it("never goes below the sidebar minimum", () => {
    expect(resolveThreadSidebarMaximumWidth(100)).toBe(THREAD_SIDEBAR_MIN_WIDTH);
  });

  it("reserves space for the main chat column", () => {
    const viewport = THREAD_MAIN_CONTENT_MIN_WIDTH + THREAD_SIDEBAR_MIN_WIDTH + 200;
    expect(resolveThreadSidebarMaximumWidth(viewport)).toBe(
      viewport - THREAD_MAIN_CONTENT_MIN_WIDTH,
    );
  });
});

describe("resolveInitialThreadSidebarWidth", () => {
  const viewport = THREAD_MAIN_CONTENT_MIN_WIDTH + THREAD_SIDEBAR_MIN_WIDTH + 400;

  it("uses the default width when nothing is stored", () => {
    expect(resolveInitialThreadSidebarWidth(null, viewport)).toBe(16 * 16);
  });

  it("clamps stored widths to the allowed range", () => {
    expect(resolveInitialThreadSidebarWidth(THREAD_SIDEBAR_MIN_WIDTH - 10, viewport)).toBe(
      THREAD_SIDEBAR_MIN_WIDTH,
    );
    expect(resolveInitialThreadSidebarWidth(10_000, viewport)).toBe(
      resolveThreadSidebarMaximumWidth(viewport),
    );
  });
});
