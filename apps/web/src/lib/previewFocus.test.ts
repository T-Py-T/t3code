import { afterEach, describe, expect, it } from "vite-plus/test";

import { isPreviewFocused } from "./previewFocus";

class MockHTMLElement {
  isConnected = false;
  tagName = "div";

  closest(selector: string): MockHTMLElement | null {
    if (!this.isConnected) return null;
    if (selector === "[data-preview-panel-mode]") return this;
    return null;
  }
}

const originalDocument = globalThis.document;
const originalHTMLElement = globalThis.HTMLElement;

afterEach(() => {
  if (originalDocument === undefined) {
    delete (globalThis as { document?: Document }).document;
  } else {
    globalThis.document = originalDocument;
  }

  if (originalHTMLElement === undefined) {
    delete (globalThis as { HTMLElement?: typeof HTMLElement }).HTMLElement;
  } else {
    globalThis.HTMLElement = originalHTMLElement;
  }
});

describe("isPreviewFocused", () => {
  it("returns false when nothing is focused", () => {
    globalThis.HTMLElement = MockHTMLElement as unknown as typeof HTMLElement;
    globalThis.document = { activeElement: null } as unknown as Document;
    expect(isPreviewFocused()).toBe(false);
  });

  it("returns true for a connected element inside the preview panel", () => {
    const focused = new MockHTMLElement();
    focused.isConnected = true;

    globalThis.HTMLElement = MockHTMLElement as unknown as typeof HTMLElement;
    globalThis.document = { activeElement: focused } as unknown as Document;

    expect(isPreviewFocused()).toBe(true);
  });

  it("returns true when focus is on a webview element", () => {
    const webview = new MockHTMLElement();
    webview.isConnected = true;
    webview.tagName = "webview";

    globalThis.HTMLElement = MockHTMLElement as unknown as typeof HTMLElement;
    globalThis.document = { activeElement: webview } as unknown as Document;

    expect(isPreviewFocused()).toBe(true);
  });
});
