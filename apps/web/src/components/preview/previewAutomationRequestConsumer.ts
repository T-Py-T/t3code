import type {
  PreviewAutomationHost,
  PreviewAutomationRequest,
  PreviewAutomationResponse,
  PreviewAutomationStreamEvent,
} from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import {
  PreviewAutomationOperationError,
  type PreviewAutomationOperationContext,
  serializePreviewAutomationHostError,
} from "./previewAutomationErrors";

type AutomationStreamResult<E> = AsyncResult.AsyncResult<PreviewAutomationStreamEvent, E>;

export function serializePreviewAutomationError(
  error: unknown,
  context: PreviewAutomationOperationContext,
): NonNullable<PreviewAutomationResponse["error"]> {
  return serializePreviewAutomationHostError(
    PreviewAutomationOperationError.fromCause({ ...context, cause: error }),
  );
}

export function createPreviewAutomationRequestConsumerAtom<E>(options: {
  readonly requestsAtom: Atom.Atom<AutomationStreamResult<E>>;
  readonly clientId: PreviewAutomationHost["clientId"];
  readonly connectionAtom: Atom.Writable<PreviewAutomationStreamEvent["connectionId"] | null>;
  readonly environmentId: PreviewAutomationHost["environmentId"];
  readonly requestHandlerAtom: Atom.Atom<{
    readonly handle: (request: PreviewAutomationRequest, signal: AbortSignal) => Promise<unknown>;
  }>;
  readonly respond: (response: PreviewAutomationResponse) => Promise<unknown>;
  readonly label: string;
}): Atom.Atom<void> {
  return Atom.make((get) => {
    get.mount(options.connectionAtom);
    get.mount(options.requestHandlerAtom);
    let disposed = false;
    let activeConnectionId: PreviewAutomationStreamEvent["connectionId"] | null = null;
    let connectionExplicitlyAnnounced = false;
    let reportedConnectionId: PreviewAutomationStreamEvent["connectionId"] | null = null;
    let requestsVersion = 0;
    const activeRequests = new Map<
      string,
      { readonly controller: AbortController; cancelledByBroker: boolean }
    >();

    const consume = (result: AutomationStreamResult<E>) => {
      if (!AsyncResult.isSuccess(result)) return;
      const event = result.value;
      if (event.type === "connected") {
        if (activeConnectionId !== null && activeConnectionId !== event.connectionId) {
          for (const { controller } of activeRequests.values()) controller.abort();
          activeRequests.clear();
        }
        activeConnectionId = event.connectionId;
        connectionExplicitlyAnnounced = true;
      } else if (activeConnectionId === null) {
        activeConnectionId = event.connectionId;
      } else if (activeConnectionId !== event.connectionId) {
        if (connectionExplicitlyAnnounced) return;
        activeConnectionId = event.connectionId;
      }
      if (reportedConnectionId !== event.connectionId) {
        reportedConnectionId = event.connectionId;
        get.set(options.connectionAtom, event.connectionId);
      }
      if (event.type === "connected") {
        return;
      }
      if (event.type === "cancel") {
        const active = activeRequests.get(event.requestId);
        if (active) {
          active.cancelledByBroker = true;
          active.controller.abort();
        }
        return;
      }
      const request = event.request;
      const controller = new AbortController();
      const active = { controller, cancelledByBroker: false };
      activeRequests.set(request.requestId, active);
      void get
        .once(options.requestHandlerAtom)
        .handle(request, controller.signal)
        .then(
          (value) => {
            if (active.cancelledByBroker) {
              return options.respond({
                clientId: options.clientId,
                connectionId: event.connectionId,
                requestId: request.requestId,
                ok: false,
                error: {
                  _tag: "PreviewAutomationControlInterruptedError",
                  message: `Preview automation ${request.operation} was interrupted.`,
                },
              });
            }
            if (disposed || controller.signal.aborted) return;
            return options.respond({
              clientId: options.clientId,
              connectionId: event.connectionId,
              requestId: request.requestId,
              ok: true,
              ...(value === undefined ? {} : { result: value }),
            });
          },
          (error) => {
            if (active.cancelledByBroker) {
              return options.respond({
                clientId: options.clientId,
                connectionId: event.connectionId,
                requestId: request.requestId,
                ok: false,
                error: {
                  _tag: "PreviewAutomationControlInterruptedError",
                  message: `Preview automation ${request.operation} was interrupted.`,
                },
              });
            }
            if (disposed || controller.signal.aborted) return;
            return options.respond({
              clientId: options.clientId,
              connectionId: event.connectionId,
              requestId: request.requestId,
              ok: false,
              error: serializePreviewAutomationError(error, {
                requestId: request.requestId,
                operation: request.operation,
                environmentId: options.environmentId,
                threadId: request.threadId,
                tabId: request.tabId ?? null,
              }),
            });
          },
        )
        .finally(() => {
          if (activeRequests.get(request.requestId) === active) {
            activeRequests.delete(request.requestId);
          }
        });
    };

    get.addFinalizer(() => {
      disposed = true;
      for (const { controller } of activeRequests.values()) controller.abort();
      activeRequests.clear();
    });
    const initialRequest = get.once(options.requestsAtom);
    if (AsyncResult.isSuccess(initialRequest)) {
      activeConnectionId = initialRequest.value.connectionId;
      connectionExplicitlyAnnounced = initialRequest.value.type === "connected";
      if (initialRequest.value.type === "connected") {
        reportedConnectionId = initialRequest.value.connectionId;
        get.set(options.connectionAtom, initialRequest.value.connectionId);
      }
    }
    get.subscribe(options.requestsAtom, (result) => {
      requestsVersion += 1;
      consume(result);
    });
    queueMicrotask(() => {
      const initialConnectionWasSkipped =
        AsyncResult.isSuccess(initialRequest) &&
        initialRequest.value.connectionId === activeConnectionId &&
        initialRequest.value.connectionId !== reportedConnectionId;
      if (!disposed && (requestsVersion === 0 || initialConnectionWasSkipped)) {
        consume(initialRequest);
      }
    });
  }).pipe(Atom.setIdleTTL(0), Atom.withLabel(options.label));
}
