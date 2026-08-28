import {
  DesktopExternalBrowserClickInputSchema,
  DesktopExternalBrowserCancelInputSchema,
  DesktopExternalBrowserEvaluateInputSchema,
  DesktopExternalBrowserNavigateInputSchema,
  DesktopExternalBrowserOpenInputSchema,
  DesktopExternalBrowserPressInputSchema,
  DesktopExternalBrowserResizeInputSchema,
  DesktopExternalBrowserScrollInputSchema,
  DesktopExternalBrowserSetColorSchemeInputSchema,
  DesktopExternalBrowserStatusInputSchema,
  DesktopExternalBrowserTypeInputSchema,
  DesktopExternalBrowserWaitForInputSchema,
  PreviewAutomationResizeResult,
  PreviewAutomationSetColorSchemeResult,
  PreviewAutomationSnapshot,
  PreviewAutomationStatus,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as ExternalBrowserManager from "../../browser/ExternalBrowserManager.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

export const status = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.EXTERNAL_BROWSER_STATUS_CHANNEL,
  payload: DesktopExternalBrowserStatusInputSchema,
  result: PreviewAutomationStatus,
  handler: Effect.fn("desktop.ipc.externalBrowser.status")(function* ({
    tabId,
    operationId,
    expectedIdentity,
  }) {
    const manager = yield* ExternalBrowserManager.ExternalBrowserManager;
    return yield* manager.status(tabId, operationId, expectedIdentity);
  }),
});

export const open = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.EXTERNAL_BROWSER_OPEN_CHANNEL,
  payload: DesktopExternalBrowserOpenInputSchema,
  result: PreviewAutomationStatus,
  handler: Effect.fn("desktop.ipc.externalBrowser.open")(function* ({
    input,
    tabId,
    operationId,
    expectedIdentity,
  }) {
    const manager = yield* ExternalBrowserManager.ExternalBrowserManager;
    return yield* manager.open(input, tabId, operationId, expectedIdentity);
  }),
});

export const close = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.EXTERNAL_BROWSER_CLOSE_CHANNEL,
  payload: Schema.Void,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.externalBrowser.close")(function* () {
    const manager = yield* ExternalBrowserManager.ExternalBrowserManager;
    yield* manager.close();
  }),
});

export const navigate = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.EXTERNAL_BROWSER_NAVIGATE_CHANNEL,
  payload: DesktopExternalBrowserNavigateInputSchema,
  result: PreviewAutomationStatus,
  handler: Effect.fn("desktop.ipc.externalBrowser.navigate")(function* ({
    input,
    tabId,
    operationId,
    expectedIdentity,
  }) {
    const manager = yield* ExternalBrowserManager.ExternalBrowserManager;
    return yield* manager.navigate(input, tabId, operationId, expectedIdentity);
  }),
});

export const resize = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.EXTERNAL_BROWSER_RESIZE_CHANNEL,
  payload: DesktopExternalBrowserResizeInputSchema,
  result: PreviewAutomationResizeResult,
  handler: Effect.fn("desktop.ipc.externalBrowser.resize")(function* ({
    input,
    tabId,
    operationId,
    expectedIdentity,
  }) {
    const manager = yield* ExternalBrowserManager.ExternalBrowserManager;
    return yield* manager.resize(input, tabId, operationId, expectedIdentity);
  }),
});

export const setColorScheme = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.EXTERNAL_BROWSER_SET_COLOR_SCHEME_CHANNEL,
  payload: DesktopExternalBrowserSetColorSchemeInputSchema,
  result: PreviewAutomationSetColorSchemeResult,
  handler: Effect.fn("desktop.ipc.externalBrowser.setColorScheme")(function* ({
    input,
    tabId,
    operationId,
    expectedIdentity,
  }) {
    const manager = yield* ExternalBrowserManager.ExternalBrowserManager;
    return yield* manager.setColorScheme(input, tabId, operationId, expectedIdentity);
  }),
});

export const snapshot = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.EXTERNAL_BROWSER_SNAPSHOT_CHANNEL,
  payload: DesktopExternalBrowserStatusInputSchema,
  result: PreviewAutomationSnapshot,
  handler: Effect.fn("desktop.ipc.externalBrowser.snapshot")(function* ({
    tabId,
    operationId,
    expectedIdentity,
  }) {
    const manager = yield* ExternalBrowserManager.ExternalBrowserManager;
    return yield* manager.snapshot(tabId, operationId, expectedIdentity);
  }),
});

export const click = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.EXTERNAL_BROWSER_CLICK_CHANNEL,
  payload: DesktopExternalBrowserClickInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.externalBrowser.click")(function* ({
    input,
    tabId,
    operationId,
    expectedIdentity,
  }) {
    const manager = yield* ExternalBrowserManager.ExternalBrowserManager;
    yield* manager.click(input, tabId, operationId, expectedIdentity);
  }),
});

export const type = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.EXTERNAL_BROWSER_TYPE_CHANNEL,
  payload: DesktopExternalBrowserTypeInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.externalBrowser.type")(function* ({
    input,
    tabId,
    operationId,
    expectedIdentity,
  }) {
    const manager = yield* ExternalBrowserManager.ExternalBrowserManager;
    yield* manager.type(input, tabId, operationId, expectedIdentity);
  }),
});

export const press = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.EXTERNAL_BROWSER_PRESS_CHANNEL,
  payload: DesktopExternalBrowserPressInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.externalBrowser.press")(function* ({
    input,
    tabId,
    operationId,
    expectedIdentity,
  }) {
    const manager = yield* ExternalBrowserManager.ExternalBrowserManager;
    yield* manager.press(input, tabId, operationId, expectedIdentity);
  }),
});

export const scroll = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.EXTERNAL_BROWSER_SCROLL_CHANNEL,
  payload: DesktopExternalBrowserScrollInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.externalBrowser.scroll")(function* ({
    input,
    tabId,
    operationId,
    expectedIdentity,
  }) {
    const manager = yield* ExternalBrowserManager.ExternalBrowserManager;
    yield* manager.scroll(input, tabId, operationId, expectedIdentity);
  }),
});

export const evaluate = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.EXTERNAL_BROWSER_EVALUATE_CHANNEL,
  payload: DesktopExternalBrowserEvaluateInputSchema,
  result: Schema.Unknown,
  handler: Effect.fn("desktop.ipc.externalBrowser.evaluate")(function* ({
    input,
    tabId,
    operationId,
    expectedIdentity,
  }) {
    const manager = yield* ExternalBrowserManager.ExternalBrowserManager;
    return yield* manager.evaluate(input, tabId, operationId, expectedIdentity);
  }),
});

export const waitFor = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.EXTERNAL_BROWSER_WAIT_FOR_CHANNEL,
  payload: DesktopExternalBrowserWaitForInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.externalBrowser.waitFor")(function* ({
    input,
    tabId,
    operationId,
    expectedIdentity,
  }) {
    const manager = yield* ExternalBrowserManager.ExternalBrowserManager;
    yield* manager.waitFor(input, tabId, operationId, expectedIdentity);
  }),
});

export const cancel = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.EXTERNAL_BROWSER_CANCEL_CHANNEL,
  payload: DesktopExternalBrowserCancelInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.externalBrowser.cancel")(function* ({ operationId }) {
    const manager = yield* ExternalBrowserManager.ExternalBrowserManager;
    yield* manager.cancel(operationId);
  }),
});

export const methods = [
  status,
  open,
  close,
  navigate,
  resize,
  setColorScheme,
  snapshot,
  click,
  type,
  press,
  scroll,
  evaluate,
  waitFor,
  cancel,
] as const;
