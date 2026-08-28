import type {
  DesktopExternalBrowserBridge,
  EnvironmentId,
  PreviewAutomationClickInput,
  PreviewAutomationEvaluateInput,
  PreviewAutomationNavigateInput,
  PreviewAutomationOpenInput,
  PreviewAutomationPressInput,
  PreviewAutomationRequest,
  PreviewAutomationResizeInput,
  PreviewAutomationScrollInput,
  PreviewAutomationSetColorSchemeInput,
  PreviewAutomationTypeInput,
  PreviewAutomationWaitForInput,
} from "@t3tools/contracts";

type ResolveNavigation = (input: PreviewAutomationNavigateInput) => string;

export function isExternalBrowserAutomationRequest(request: PreviewAutomationRequest): boolean {
  return (
    typeof request.input === "object" &&
    request.input !== null &&
    "browser" in request.input &&
    request.input.browser === "external"
  );
}

export async function routeExternalBrowserAutomationRequest(input: {
  readonly bridge: DesktopExternalBrowserBridge | undefined;
  readonly enabled: boolean;
  readonly environmentId: EnvironmentId;
  readonly request: PreviewAutomationRequest;
  readonly signal: AbortSignal;
  readonly resolveNavigation: ResolveNavigation;
}): Promise<unknown> {
  const { bridge, enabled, request, signal } = input;
  if (!enabled) {
    throw new Error(
      "Signed-in external browser access is disabled. Enable it in Settings > Integrations > Browser.",
    );
  }
  if (!bridge) {
    throw new Error("Signed-in external browser control requires the T3 Code desktop app.");
  }
  signal.throwIfAborted();
  const cancel = () => {
    void bridge.cancel(request.requestId);
  };
  signal.addEventListener("abort", cancel, { once: true });
  const tabId = request.tabId ?? null;
  const expectedIdentity = request.expectedExternalBrowserIdentity;
  try {
    signal.throwIfAborted();
    switch (request.operation) {
      case "status":
        return await bridge.status(tabId, request.requestId, expectedIdentity);
      case "open": {
        const openInput = request.input as PreviewAutomationOpenInput;
        if (!openInput.url) {
          return await bridge.open(openInput, tabId, request.requestId, expectedIdentity);
        }
        const resolvedUrl = input.resolveNavigation({
          browser: "external",
          url: openInput.url,
        });
        return await bridge.open(
          { ...openInput, url: resolvedUrl },
          tabId,
          request.requestId,
          expectedIdentity,
        );
      }
      case "navigate": {
        const navigateInput = request.input as PreviewAutomationNavigateInput;
        const resolvedUrl = input.resolveNavigation(navigateInput);
        const { target: _target, ...withoutTarget } = navigateInput;
        return await bridge.navigate(
          { ...withoutTarget, url: resolvedUrl },
          tabId,
          request.requestId,
          expectedIdentity,
        );
      }
      case "resize":
        return await bridge.resize(
          request.input as PreviewAutomationResizeInput,
          tabId,
          request.requestId,
          expectedIdentity,
        );
      case "setColorScheme":
        return await bridge.setColorScheme(
          request.input as PreviewAutomationSetColorSchemeInput,
          tabId,
          request.requestId,
          expectedIdentity,
        );
      case "snapshot":
        return await bridge.snapshot(tabId, request.requestId, expectedIdentity);
      case "click":
        return await bridge.click(
          request.input as PreviewAutomationClickInput,
          tabId,
          request.requestId,
          expectedIdentity,
        );
      case "type":
        return await bridge.type(
          request.input as PreviewAutomationTypeInput,
          tabId,
          request.requestId,
          expectedIdentity,
        );
      case "press":
        return await bridge.press(
          request.input as PreviewAutomationPressInput,
          tabId,
          request.requestId,
          expectedIdentity,
        );
      case "scroll":
        return await bridge.scroll(
          request.input as PreviewAutomationScrollInput,
          tabId,
          request.requestId,
          expectedIdentity,
        );
      case "evaluate":
        return await bridge.evaluate(
          request.input as PreviewAutomationEvaluateInput,
          tabId,
          request.requestId,
          expectedIdentity,
        );
      case "waitFor":
        return await bridge.waitFor(
          request.input as PreviewAutomationWaitForInput,
          tabId,
          request.requestId,
          expectedIdentity,
        );
      case "recordingStart":
      case "recordingStop":
        throw new Error(
          "External browser recording is not available yet. Use browser='built-in' for recording.",
        );
    }
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}
