import { afterEach, describe, expect, it } from "vite-plus/test";

import { isModelPickerOpen } from "./modelPickerVisibility";

const originalDocument = globalThis.document;

afterEach(() => {
  if (originalDocument === undefined) {
    delete (globalThis as { document?: Document }).document;
  } else {
    globalThis.document = originalDocument;
  }
});

describe("isModelPickerOpen", () => {
  it("returns false when the popover content is not mounted", () => {
    globalThis.document = {
      querySelector: () => null,
    } as unknown as Document;
    expect(isModelPickerOpen()).toBe(false);
  });

  it("returns true when model picker content is in the document", () => {
    const node = {};
    globalThis.document = {
      querySelector: (selector: string) =>
        selector === "[data-model-picker-content]" ? node : null,
    } as unknown as Document;
    expect(isModelPickerOpen()).toBe(true);
  });
});
