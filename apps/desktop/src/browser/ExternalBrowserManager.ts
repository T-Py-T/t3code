import type {
  PreviewAutomationActionEvent,
  PreviewAutomationClickInput,
  PreviewAutomationConsoleEntry,
  PreviewAutomationEvaluateInput,
  PreviewAutomationNavigateInput,
  PreviewAutomationNetworkEntry,
  PreviewAutomationOpenInput,
  PreviewAutomationPressInput,
  PreviewAutomationResizeInput,
  PreviewAutomationResizeResult,
  PreviewAutomationScrollInput,
  PreviewAutomationSetColorSchemeInput,
  PreviewAutomationSetColorSchemeResult,
  PreviewAutomationSnapshot,
  PreviewAutomationStatus,
  PreviewAutomationTypeInput,
  PreviewAutomationWaitForInput,
} from "@t3tools/contracts";
import { normalizePreviewUrl, newPreviewTabId } from "@t3tools/shared/preview";
import { resolvePreviewViewport } from "@t3tools/shared/previewViewport";
import type { BrowserContext, Page } from "playwright-core";
import { chromium } from "playwright-core";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";

const PROFILE_NAME = "T3 Code Computer Use";
const MAX_VISIBLE_TEXT_LENGTH = 20_000;
const MAX_INTERACTIVE_ELEMENTS = 200;
const MAX_DIAGNOSTIC_ENTRIES = 200;
const MAX_EVALUATION_BYTES = 64_000;
const DEFAULT_TIMEOUT_MS = 15_000;

export interface ExternalBrowserExecutableInput {
  readonly platform: NodeJS.Platform;
  readonly homeDirectory: string;
  readonly appDataDirectory: string;
}

/** Ordered system-browser locations. No bundled browser download is required. */
export function externalBrowserExecutableCandidates(
  input: ExternalBrowserExecutableInput,
): readonly string[] {
  if (input.platform === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      `${input.homeDirectory}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`,
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    ];
  }
  if (input.platform === "win32") {
    const localAppData = `${input.homeDirectory}\\AppData\\Local`;
    return [
      `${localAppData}\\Google\\Chrome\\Application\\chrome.exe`,
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      `${localAppData}\\Microsoft\\Edge\\Application\\msedge.exe`,
      "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    ];
  }
  return [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/microsoft-edge",
    "/usr/bin/microsoft-edge-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];
}

/** External control deliberately excludes local files and privileged browser pages. */
export function normalizeExternalBrowserUrl(rawUrl: string): string {
  return normalizePreviewUrl(rawUrl);
}

export class ExternalBrowserOperationError extends Schema.TaggedErrorClass<ExternalBrowserOperationError>()(
  "ExternalBrowserOperationError",
  {
    operation: Schema.String,
    reason: Schema.Literals([
      "browser-unavailable",
      "not-connected",
      "tab-not-found",
      "operation-failed",
      "result-too-large",
      "unsupported",
    ]),
    tabId: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "browser-unavailable":
        return "Google Chrome, Microsoft Edge, Brave, or Chromium is required for external browser control.";
      case "not-connected":
        return "The T3 Code signed-in browser is not connected. Open it from Settings > Integrations.";
      case "tab-not-found":
        return `External browser tab ${this.tabId ?? "(unknown)"} is no longer available.`;
      case "result-too-large":
        return "The external browser evaluation result exceeded the 64 KB safety limit.";
      case "unsupported":
        return `The external browser does not support ${this.operation}.`;
      default:
        return `External browser ${this.operation} failed.`;
    }
  }
}

interface ExternalBrowserDiagnostics {
  readonly consoleEntries: PreviewAutomationConsoleEntry[];
  readonly networkEntries: PreviewAutomationNetworkEntry[];
  readonly actionTimeline: PreviewAutomationActionEvent[];
}

interface ExternalBrowserRuntime {
  readonly context: BrowserContext;
  readonly pages: Map<string, Page>;
  readonly pageIds: WeakMap<Page, string>;
  readonly diagnostics: Map<string, ExternalBrowserDiagnostics>;
  currentTabId: string | null;
}

const boundedPush = <A>(entries: A[], entry: A): void => {
  entries.push(entry);
  if (entries.length > MAX_DIAGNOSTIC_ENTRIES) {
    entries.splice(0, entries.length - MAX_DIAGNOSTIC_ENTRIES);
  }
};

const timestamp = (): string => DateTime.formatIso(DateTime.nowUnsafe());

const freshDiagnostics = (): ExternalBrowserDiagnostics => ({
  consoleEntries: [],
  networkEntries: [],
  actionTimeline: [],
});

export function externalBrowserConnectionState(
  available: boolean,
  connected: boolean,
): "unavailable" | "disconnected" | "connected" {
  if (!available) return "unavailable";
  return connected ? "connected" : "disconnected";
}

const statusForPage = async (
  available: boolean,
  page: Page | null,
  tabId: string | null,
): Promise<PreviewAutomationStatus> => {
  const viewport = page?.viewportSize() ?? null;
  return {
    available,
    visible: page !== null,
    browser: "external",
    connectionState: externalBrowserConnectionState(available, page !== null),
    profileName: PROFILE_NAME,
    tabId,
    url: page?.url() ?? null,
    title: page === null ? null : await page.title().catch(() => ""),
    loading: false,
    ...(viewport === null ? {} : { viewport }),
  };
};

const pageLocator = (
  page: Page,
  input: { readonly locator?: string | undefined; readonly selector?: string | undefined },
) => page.locator(input.locator ?? input.selector!);

export class ExternalBrowserManager extends Context.Service<
  ExternalBrowserManager,
  {
    readonly status: (tabId?: string | null) => Effect.Effect<PreviewAutomationStatus>;
    readonly open: (
      input: PreviewAutomationOpenInput,
      requestedTabId?: string | null,
    ) => Effect.Effect<PreviewAutomationStatus, ExternalBrowserOperationError>;
    readonly close: () => Effect.Effect<void, ExternalBrowserOperationError>;
    readonly navigate: (
      input: PreviewAutomationNavigateInput,
      tabId?: string | null,
    ) => Effect.Effect<PreviewAutomationStatus, ExternalBrowserOperationError>;
    readonly resize: (
      input: PreviewAutomationResizeInput,
      tabId?: string | null,
    ) => Effect.Effect<PreviewAutomationResizeResult, ExternalBrowserOperationError>;
    readonly setColorScheme: (
      input: PreviewAutomationSetColorSchemeInput,
      tabId?: string | null,
    ) => Effect.Effect<PreviewAutomationSetColorSchemeResult, ExternalBrowserOperationError>;
    readonly snapshot: (
      tabId?: string | null,
    ) => Effect.Effect<PreviewAutomationSnapshot, ExternalBrowserOperationError>;
    readonly click: (
      input: PreviewAutomationClickInput,
      tabId?: string | null,
    ) => Effect.Effect<void, ExternalBrowserOperationError>;
    readonly type: (
      input: PreviewAutomationTypeInput,
      tabId?: string | null,
    ) => Effect.Effect<void, ExternalBrowserOperationError>;
    readonly press: (
      input: PreviewAutomationPressInput,
      tabId?: string | null,
    ) => Effect.Effect<void, ExternalBrowserOperationError>;
    readonly scroll: (
      input: PreviewAutomationScrollInput,
      tabId?: string | null,
    ) => Effect.Effect<void, ExternalBrowserOperationError>;
    readonly evaluate: (
      input: PreviewAutomationEvaluateInput,
      tabId?: string | null,
    ) => Effect.Effect<unknown, ExternalBrowserOperationError>;
    readonly waitFor: (
      input: PreviewAutomationWaitForInput,
      tabId?: string | null,
    ) => Effect.Effect<void, ExternalBrowserOperationError>;
  }
>()("@t3tools/desktop/browser/ExternalBrowserManager") {}

export const make = Effect.gen(function* ExternalBrowserManagerMake() {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const mutationGate = yield* Semaphore.make(1);
  const profileDirectory = environment.path.join(environment.stateDir, "external-browser-profile");
  const candidates = externalBrowserExecutableCandidates(environment);
  let executablePathCache: string | null | undefined;
  let runtime: ExternalBrowserRuntime | null = null;
  let actionSequence = 0;
  const isExternalBrowserOperationError = Schema.is(ExternalBrowserOperationError);

  const findExecutable = Effect.fn("ExternalBrowserManager.findExecutable")(function* () {
    if (executablePathCache !== undefined) return executablePathCache;
    for (const candidate of candidates) {
      if (yield* fileSystem.exists(candidate).pipe(Effect.orElseSucceed(() => false))) {
        executablePathCache = candidate;
        return candidate;
      }
    }
    executablePathCache = null;
    return null;
  });

  const attemptPromise = <A>(
    operation: string,
    run: () => PromiseLike<A>,
    tabId?: string | null,
  ): Effect.Effect<A, ExternalBrowserOperationError> =>
    Effect.tryPromise({
      try: run,
      catch: (cause) =>
        isExternalBrowserOperationError(cause)
          ? cause
          : new ExternalBrowserOperationError({
              operation,
              reason: "operation-failed",
              ...(tabId ? { tabId } : {}),
              cause,
            }),
    });

  const diagnosticsFor = (activeRuntime: ExternalBrowserRuntime, tabId: string) => {
    const existing = activeRuntime.diagnostics.get(tabId);
    if (existing) return existing;
    const created = freshDiagnostics();
    activeRuntime.diagnostics.set(tabId, created);
    return created;
  };

  const registerPage = (activeRuntime: ExternalBrowserRuntime, page: Page): string => {
    const known = activeRuntime.pageIds.get(page);
    if (known) return known;
    const tabId = newPreviewTabId().replace("tab_", "external_");
    activeRuntime.pages.set(tabId, page);
    activeRuntime.pageIds.set(page, tabId);
    activeRuntime.currentTabId = tabId;
    const diagnostics = diagnosticsFor(activeRuntime, tabId);
    page.on("console", (message) => {
      boundedPush(diagnostics.consoleEntries, {
        level: message.type(),
        text: message.text(),
        timestamp: timestamp(),
        source: message.location().url || undefined,
      });
    });
    page.on("response", (response) => {
      boundedPush(diagnostics.networkEntries, {
        url: response.url(),
        method: response.request().method(),
        status: response.status(),
        failed: false,
        timestamp: timestamp(),
      });
    });
    page.on("requestfailed", (request) => {
      boundedPush(diagnostics.networkEntries, {
        url: request.url(),
        method: request.method(),
        status: null,
        failed: true,
        ...(request.failure() ? { errorText: request.failure()!.errorText } : {}),
        timestamp: timestamp(),
      });
    });
    page.once("close", () => {
      activeRuntime.pages.delete(tabId);
      activeRuntime.diagnostics.delete(tabId);
      if (activeRuntime.currentTabId === tabId) {
        activeRuntime.currentTabId = activeRuntime.pages.keys().next().value ?? null;
      }
    });
    return tabId;
  };

  const launch = Effect.fn("ExternalBrowserManager.launch")(function* () {
    if (runtime !== null) return runtime;
    const executablePath = yield* findExecutable();
    if (executablePath === null) {
      return yield* new ExternalBrowserOperationError({
        operation: "open",
        reason: "browser-unavailable",
      });
    }
    yield* fileSystem.makeDirectory(profileDirectory, { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new ExternalBrowserOperationError({
            operation: "open",
            reason: "operation-failed",
            cause,
          }),
      ),
    );
    const context = yield* attemptPromise("open", () =>
      chromium.launchPersistentContext(profileDirectory, {
        executablePath,
        headless: false,
        viewport: { width: 1280, height: 800 },
        acceptDownloads: true,
        args: ["--no-first-run", "--no-default-browser-check"],
      }),
    );
    const created: ExternalBrowserRuntime = {
      context,
      pages: new Map(),
      pageIds: new WeakMap(),
      diagnostics: new Map(),
      currentTabId: null,
    };
    runtime = created;
    context.on("page", (page) => registerPage(created, page));
    context.once("close", () => {
      if (runtime?.context === context) runtime = null;
    });
    for (const page of context.pages()) registerPage(created, page);
    return created;
  });

  const resolvePage = (
    operation: string,
    requestedTabId?: string | null,
  ): { readonly runtime: ExternalBrowserRuntime; readonly page: Page; readonly tabId: string } => {
    const activeRuntime = runtime;
    if (activeRuntime === null) {
      throw new ExternalBrowserOperationError({ operation, reason: "not-connected" });
    }
    const tabId = requestedTabId ?? activeRuntime.currentTabId;
    const page = tabId === null ? undefined : activeRuntime.pages.get(tabId);
    if (!tabId || !page || page.isClosed()) {
      throw new ExternalBrowserOperationError({
        operation,
        reason: "tab-not-found",
        ...(tabId ? { tabId } : {}),
      });
    }
    activeRuntime.currentTabId = tabId;
    return { runtime: activeRuntime, page, tabId };
  };

  const withPage = <A>(
    operation: string,
    requestedTabId: string | null | undefined,
    run: (activeRuntime: ExternalBrowserRuntime, page: Page, tabId: string) => PromiseLike<A>,
  ): Effect.Effect<A, ExternalBrowserOperationError> =>
    mutationGate.withPermit(
      attemptPromise(
        operation,
        async () => {
          const resolved = resolvePage(operation, requestedTabId);
          const diagnostics = diagnosticsFor(resolved.runtime, resolved.tabId);
          const action: PreviewAutomationActionEvent = {
            id: `${resolved.tabId}:${++actionSequence}`,
            action: operation,
            status: "running",
            startedAt: timestamp(),
          };
          boundedPush(diagnostics.actionTimeline, action);
          try {
            const value = await run(resolved.runtime, resolved.page, resolved.tabId);
            Object.assign(action, { status: "succeeded", completedAt: timestamp() });
            return value;
          } catch (cause) {
            Object.assign(action, {
              status: "failed",
              completedAt: timestamp(),
              error: cause instanceof Error ? cause.message : String(cause),
            });
            throw cause;
          }
        },
        requestedTabId,
      ),
    );

  const status = (requestedTabId?: string | null): Effect.Effect<PreviewAutomationStatus> =>
    Effect.gen(function* () {
      const executable = yield* findExecutable();
      const activeRuntime = runtime;
      if (activeRuntime === null)
        return yield* Effect.promise(() => statusForPage(executable !== null, null, null));
      const tabId = requestedTabId ?? activeRuntime.currentTabId;
      const page = tabId ? (activeRuntime.pages.get(tabId) ?? null) : null;
      return yield* Effect.promise(() =>
        statusForPage(executable !== null, page, page ? tabId : null),
      );
    });

  const open = (
    input: PreviewAutomationOpenInput,
    requestedTabId?: string | null,
  ): Effect.Effect<PreviewAutomationStatus, ExternalBrowserOperationError> =>
    mutationGate.withPermit(
      Effect.gen(function* () {
        const activeRuntime = yield* launch();
        let page: Page | undefined;
        let tabId: string | null = null;
        if (input.reuseExistingTab !== false) {
          tabId = requestedTabId ?? activeRuntime.currentTabId;
          page = tabId ? activeRuntime.pages.get(tabId) : undefined;
        }
        if (!page || page.isClosed()) {
          page = yield* attemptPromise("open", () => activeRuntime.context.newPage());
          tabId = registerPage(activeRuntime, page);
        }
        activeRuntime.currentTabId = tabId;
        if (input.url) {
          const url = normalizeExternalBrowserUrl(input.url);
          yield* attemptPromise(
            "open",
            () => page!.goto(url, { waitUntil: "load", timeout: DEFAULT_TIMEOUT_MS }),
            tabId,
          );
        }
        yield* attemptPromise("open", () => page!.bringToFront(), tabId);
        return yield* Effect.promise(() => statusForPage(true, page!, tabId));
      }),
    );

  const close = mutationGate.withPermit(
    Effect.gen(function* () {
      const activeRuntime = runtime;
      if (activeRuntime === null) return;
      runtime = null;
      yield* attemptPromise("close", () => activeRuntime.context.close());
    }),
  );

  const service = ExternalBrowserManager.of({
    status,
    open,
    close: () => close,
    navigate: (input, tabId) =>
      withPage("navigate", tabId, async (_activeRuntime, page, activeTabId) => {
        const url = normalizeExternalBrowserUrl(input.url!);
        const waitUntil =
          input.readiness === "domContentLoaded"
            ? "domcontentloaded"
            : input.readiness === "none"
              ? "commit"
              : "load";
        await page.goto(url, { waitUntil, timeout: input.timeoutMs ?? DEFAULT_TIMEOUT_MS });
        return await statusForPage(true, page, activeTabId);
      }),
    resize: (input, tabId) =>
      withPage("resize", tabId, async (_activeRuntime, page, activeTabId) => {
        const current = page.viewportSize() ?? { width: 1280, height: 800 };
        const setting = resolvePreviewViewport(input);
        const viewport =
          setting._tag === "fill" ? current : { width: setting.width, height: setting.height };
        await page.setViewportSize(viewport);
        return { tabId: activeTabId, setting, viewport } satisfies PreviewAutomationResizeResult;
      }),
    setColorScheme: (input, tabId) =>
      withPage("setColorScheme", tabId, async (_activeRuntime, page, activeTabId) => {
        await page.emulateMedia({
          colorScheme: input.colorScheme === "system" ? null : input.colorScheme,
        });
        return {
          tabId: activeTabId,
          colorScheme: input.colorScheme,
        } satisfies PreviewAutomationSetColorSchemeResult;
      }),
    snapshot: (tabId) =>
      withPage("snapshot", tabId, async (activeRuntime, page, activeTabId) => {
        const [visibleText, interactiveElements, accessibilityTree, screenshot, viewport] =
          await Promise.all([
            page
              .locator("body")
              .innerText()
              .catch(() => ""),
            page.locator("a,button,input,textarea,select,[role],[tabindex]").evaluateAll(
              (elements, maximum) =>
                elements.slice(0, maximum).map((element, index) => {
                  const htmlElement = element as HTMLElement;
                  const rect = htmlElement.getBoundingClientRect();
                  const tag = htmlElement.tagName.toLowerCase();
                  const id = htmlElement.id;
                  const selector = id
                    ? `${tag}#${CSS.escape(id)}`
                    : `${tag}:nth-of-type(${index + 1})`;
                  return {
                    tag,
                    role: htmlElement.getAttribute("role"),
                    name:
                      htmlElement.getAttribute("aria-label") ??
                      (htmlElement as HTMLInputElement).value ??
                      htmlElement.innerText ??
                      "",
                    selector,
                    x: rect.x,
                    y: rect.y,
                    width: rect.width,
                    height: rect.height,
                  };
                }),
              MAX_INTERACTIVE_ELEMENTS,
            ),
            page
              .locator("body")
              .ariaSnapshot({ timeout: DEFAULT_TIMEOUT_MS })
              .catch(() => ""),
            page.screenshot({ type: "png" }),
            page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight })),
          ]);
        const diagnostics = diagnosticsFor(activeRuntime, activeTabId);
        return {
          url: page.url(),
          title: await page.title(),
          loading: false,
          visibleText: visibleText.slice(0, MAX_VISIBLE_TEXT_LENGTH),
          interactiveElements,
          accessibilityTree,
          consoleEntries: [...diagnostics.consoleEntries],
          networkEntries: [...diagnostics.networkEntries],
          actionTimeline: [...diagnostics.actionTimeline],
          screenshot: {
            mimeType: "image/png",
            data: screenshot.toString("base64"),
            width: viewport.width,
            height: viewport.height,
          },
        } satisfies PreviewAutomationSnapshot;
      }),
    click: (input, tabId) =>
      withPage("click", tabId, async (_activeRuntime, page) => {
        if (input.x !== undefined && input.y !== undefined) {
          await page.mouse.click(input.x, input.y);
          return;
        }
        await pageLocator(page, input).click({ timeout: input.timeoutMs ?? DEFAULT_TIMEOUT_MS });
      }),
    type: (input, tabId) =>
      withPage("type", tabId, async (_activeRuntime, page) => {
        if (!input.locator && !input.selector) {
          await page.keyboard.insertText(input.text);
          return;
        }
        const locator = pageLocator(page, input);
        if (input.clear) await locator.fill("");
        await locator.pressSequentially(input.text, {
          timeout: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        });
      }),
    press: (input, tabId) =>
      withPage("press", tabId, async (_activeRuntime, page) => {
        const chord = [...(input.modifiers ?? []), input.key].join("+");
        await page.keyboard.press(chord);
      }),
    scroll: (input, tabId) =>
      withPage("scroll", tabId, async (_activeRuntime, page) => {
        const deltaX = input.deltaX ?? 0;
        const deltaY = input.deltaY ?? 0;
        if (input.locator || input.selector) {
          await pageLocator(page, input).evaluate(
            (element, delta) => element.scrollBy(delta.x, delta.y),
            { x: deltaX, y: deltaY },
          );
          return;
        }
        await page.mouse.wheel(deltaX, deltaY);
      }),
    evaluate: (input, tabId) =>
      withPage("evaluate", tabId, async (_activeRuntime, page) => {
        const result = await page.evaluate(input.expression);
        const encoded = JSON.stringify(result);
        if (encoded !== undefined && Buffer.byteLength(encoded, "utf8") > MAX_EVALUATION_BYTES) {
          throw new ExternalBrowserOperationError({
            operation: "evaluate",
            reason: "result-too-large",
          });
        }
        return result;
      }),
    waitFor: (input, tabId) =>
      withPage("waitFor", tabId, async (_activeRuntime, page) => {
        const timeout = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        if (input.locator || input.selector) {
          await pageLocator(page, input).waitFor({ state: "visible", timeout });
        }
        if (input.text) {
          await page
            .getByText(input.text, { exact: false })
            .first()
            .waitFor({ state: "visible", timeout });
        }
        if (input.urlIncludes) {
          await page.waitForURL((url) => url.href.includes(input.urlIncludes!), { timeout });
        }
      }),
  });

  yield* Effect.addFinalizer(() => service.close().pipe(Effect.ignore));
  return service;
}).pipe(Effect.withSpan("ExternalBrowserManager.make"));

export const layer = Layer.effect(ExternalBrowserManager, make);
