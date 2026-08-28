import {
  EnvironmentId,
  ThreadId,
  type DesktopExternalBrowserBridge,
  type PreviewAutomationRequest,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  isExternalBrowserAutomationRequest,
  routeExternalBrowserAutomationRequest,
} from "./externalBrowserAutomation.ts";

const request = (overrides: Partial<PreviewAutomationRequest>): PreviewAutomationRequest => ({
  requestId: "request-1",
  threadId: ThreadId.make("thread-1"),
  operation: "status",
  input: { browser: "external" },
  timeoutMs: 15_000,
  ...overrides,
});

const bridge = (overrides: Partial<DesktopExternalBrowserBridge> = {}) =>
  ({
    status: vi.fn(),
    open: vi.fn(),
    close: vi.fn(),
    navigate: vi.fn(),
    resize: vi.fn(),
    setColorScheme: vi.fn(),
    snapshot: vi.fn(),
    click: vi.fn(),
    type: vi.fn(),
    press: vi.fn(),
    scroll: vi.fn(),
    evaluate: vi.fn(),
    waitFor: vi.fn(),
    ...overrides,
  }) satisfies DesktopExternalBrowserBridge;

describe("isExternalBrowserAutomationRequest", () => {
  it("routes only requests that explicitly select the external browser", () => {
    expect(isExternalBrowserAutomationRequest(request({}))).toBe(true);
    expect(isExternalBrowserAutomationRequest(request({ input: {} }))).toBe(false);
    expect(isExternalBrowserAutomationRequest(request({ input: { browser: "built-in" } }))).toBe(
      false,
    );
  });
});

describe("routeExternalBrowserAutomationRequest", () => {
  it("resolves environment-relative navigation before invoking the desktop bridge", async () => {
    const navigate = vi.fn().mockResolvedValue({ browser: "external" });
    const desktopBridge = bridge({ navigate });
    const resolveNavigation = vi.fn(() => "http://127.0.0.1:5173/test");

    await routeExternalBrowserAutomationRequest({
      bridge: desktopBridge,
      enabled: true,
      environmentId: EnvironmentId.make("local"),
      request: request({
        operation: "navigate",
        tabId: "external_1",
        input: {
          browser: "external",
          target: { kind: "environment-port", port: 5173, path: "/test" },
        },
      }),
      resolveNavigation,
    });

    expect(resolveNavigation).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledWith(
      expect.objectContaining({
        browser: "external",
        url: "http://127.0.0.1:5173/test",
      }),
      "external_1",
    );
    expect(navigate.mock.calls[0]?.[0]).not.toHaveProperty("target");
  });

  it("refuses to reach the desktop bridge while persistent signed-in access is disabled", async () => {
    const status = vi.fn();
    await expect(
      routeExternalBrowserAutomationRequest({
        bridge: bridge({ status }),
        enabled: false,
        environmentId: EnvironmentId.make("local"),
        request: request({}),
        resolveNavigation: vi.fn(),
      }),
    ).rejects.toThrow(/disabled/i);
    expect(status).not.toHaveBeenCalled();
  });
});
