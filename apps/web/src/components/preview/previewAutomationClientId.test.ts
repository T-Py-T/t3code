import { describe, expect, it, vi } from "vite-plus/test";

import { createPreviewAutomationClientId } from "./previewAutomationClientId";

describe("createPreviewAutomationClientId", () => {
  it("returns a preview- prefixed 32-hex-character id", () => {
    const bytes = new Uint8Array(16);
    bytes.fill(0xab);
    vi.stubGlobal("crypto", {
      getRandomValues: (target: Uint8Array) => {
        target.set(bytes);
        return target;
      },
    });

    expect(createPreviewAutomationClientId()).toBe(`preview-${"ab".repeat(16)}`);
    vi.unstubAllGlobals();
  });
});
