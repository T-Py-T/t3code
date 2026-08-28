import { describe, expect, it } from "vite-plus/test";

import {
  externalBrowserConnectionState,
  externalBrowserExecutableCandidates,
  normalizeExternalBrowserUrl,
} from "./ExternalBrowserManager.ts";

describe("externalBrowserExecutableCandidates", () => {
  it("prefers the native macOS Chrome install before compatible alternatives", () => {
    expect(
      externalBrowserExecutableCandidates({
        platform: "darwin",
        homeDirectory: "/Users/taylor",
        appDataDirectory: "/Users/taylor/Library/Application Support",
      }),
    ).toEqual([
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Users/taylor/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    ]);
  });

  it("searches both per-user and machine-wide Windows browser installs", () => {
    expect(
      externalBrowserExecutableCandidates({
        platform: "win32",
        homeDirectory: "C:\\Users\\Taylor",
        appDataDirectory: "C:\\Users\\Taylor\\AppData\\Roaming",
      }),
    ).toEqual([
      "C:\\Users\\Taylor\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Users\\Taylor\\AppData\\Local\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    ]);
  });
});

describe("normalizeExternalBrowserUrl", () => {
  it("normalizes public and loopback hosts using the preview URL policy", () => {
    expect(normalizeExternalBrowserUrl("example.com")).toBe("https://example.com/");
    expect(normalizeExternalBrowserUrl("localhost:5173/test")).toBe("http://localhost:5173/test");
  });

  it.each([
    "file:///tmp/private",
    "javascript:alert(1)",
    "data:text/html,hello",
    "chrome://settings",
  ])("rejects privileged or non-network URL %s", (url) => {
    expect(() => normalizeExternalBrowserUrl(url)).toThrow();
  });
});

describe("externalBrowserConnectionState", () => {
  it("distinguishes an unavailable browser from a closed compatible browser", () => {
    expect(externalBrowserConnectionState(false, false)).toBe("unavailable");
    expect(externalBrowserConnectionState(true, false)).toBe("disconnected");
    expect(externalBrowserConnectionState(true, true)).toBe("connected");
  });
});
