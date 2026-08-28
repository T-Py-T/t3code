import { Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";

import {
  COMPUTER_USE_MAX_ACTIONS_PER_BATCH,
  COMPUTER_USE_MAX_TEXT_LENGTH,
  COMPUTER_USE_MAX_TIMEOUT_MS,
  COMPUTER_USE_HISTORY_MAX_ENTRIES,
  COMPUTER_USE_HISTORY_MAX_QUERY_ENTRIES,
  ComputerUseActionBatch,
  ComputerUseHistoryEntry,
  ComputerUseHistoryEntryList,
  ComputerUseHistoryInput,
  ComputerUseHostRequest,
  ComputerUseHostResponse,
  ComputerUseHostStreamEvent,
  ComputerUseObservation,
  ComputerUseTarget,
} from "./computerUse.ts";

const decodeBatch = Schema.decodeUnknownSync(ComputerUseActionBatch);
const decodeHostRequest = Schema.decodeUnknownSync(ComputerUseHostRequest);
const decodeHostResponse = Schema.decodeUnknownSync(ComputerUseHostResponse);
const decodeHostStreamEvent = Schema.decodeUnknownSync(ComputerUseHostStreamEvent);
const decodeObservation = Schema.decodeUnknownSync(ComputerUseObservation);
const decodeTarget = Schema.decodeUnknownSync(ComputerUseTarget);
const decodeHistoryEntry = Schema.decodeUnknownSync(ComputerUseHistoryEntry);
const decodeHistory = Schema.decodeUnknownSync(ComputerUseHistoryEntryList);
const decodeHistoryInput = Schema.decodeUnknownSync(ComputerUseHistoryInput);

const allActions = [
  { _tag: "click", x: 10, y: 20 },
  { _tag: "double-click", x: 10, y: 20 },
  { _tag: "secondary-click", x: 10, y: 20 },
  { _tag: "move", x: 30, y: 40, durationMs: 100 },
  {
    _tag: "drag",
    from: { x: 10, y: 20 },
    to: { x: 30, y: 40 },
    durationMs: 200,
  },
  { _tag: "scroll", deltaX: 0, deltaY: 420, x: 30, y: 40 },
  { _tag: "text-entry", text: "hello" },
  { _tag: "paste", text: "clipboard text" },
  {
    _tag: "keypress",
    key: "Enter",
    modifiers: ["meta", "shift"],
    phase: "press",
  },
  { _tag: "selection", elementId: "field-1", start: 0, end: 5 },
  { _tag: "direct-value", elementId: "field-1", value: "replacement" },
  { _tag: "accessibility-action", elementId: "button-1", action: "press" },
  { _tag: "wait", durationMs: 250 },
  { _tag: "screenshot-refresh" },
] as const;

describe("Computer Use contracts", () => {
  it("advertises a structured Office document route without hiding its target identity", () => {
    expect(
      decodeTarget({
        targetId: "target-excel-book-1",
        kind: "office-document",
        displayName: "Microsoft Excel — Book1",
        applicationId: "com.microsoft.Excel",
        stableIdentity: "macos:com.microsoft.Excel:team:UBF8T346G9",
        integration: {
          _tag: "office-accessibility",
          application: "excel",
          documentName: "Book1",
          supportedOperations: ["observe", "act"],
        },
      }),
    ).toMatchObject({
      kind: "office-document",
      integration: {
        _tag: "office-accessibility",
        application: "excel",
        supportedOperations: ["observe", "act"],
      },
    });
  });

  it("decodes the complete bounded action vocabulary", () => {
    expect(decodeBatch({ actions: allActions })).toEqual({ actions: allActions });
  });

  it("rejects empty, oversized, non-finite, and oversized-text action batches", () => {
    expect(() => decodeBatch({ actions: [] })).toThrow();
    expect(() =>
      decodeBatch({
        actions: Array.from({ length: COMPUTER_USE_MAX_ACTIONS_PER_BATCH + 1 }, () => ({
          _tag: "screenshot-refresh",
        })),
      }),
    ).toThrow();
    expect(() =>
      decodeBatch({ actions: [{ _tag: "click", x: Number.POSITIVE_INFINITY, y: 0 }] }),
    ).toThrow();
    expect(() =>
      decodeBatch({
        actions: [{ _tag: "text-entry", text: "x".repeat(COMPUTER_USE_MAX_TEXT_LENGTH + 1) }],
      }),
    ).toThrow();
  });

  it("requires an observation for action requests and bounds their deadline", () => {
    const request = {
      requestId: "request-1",
      leaseId: "lease-1",
      environmentId: "environment-1",
      operation: "act",
      targetId: "target-1",
      observationId: "observation-1",
      input: { actions: [{ _tag: "click", x: 10, y: 20 }] },
      timeoutMs: COMPUTER_USE_MAX_TIMEOUT_MS,
    };

    expect(decodeHostRequest(request)).toMatchObject(request);
    expect(() => decodeHostRequest({ ...request, observationId: undefined })).toThrow();
    expect(() =>
      decodeHostRequest({ ...request, timeoutMs: COMPUTER_USE_MAX_TIMEOUT_MS + 1 }),
    ).toThrow();
  });

  it("decodes bounded observations without provider correlation metadata", () => {
    const observation = decodeObservation({
      observationId: "observation-1",
      target: {
        targetId: "target-1",
        kind: "application",
        displayName: "TextEdit",
        applicationId: "com.apple.TextEdit",
        stableIdentity: "macos:com.apple.TextEdit:APPLE",
      },
      capturedAt: "2026-08-27T20:00:00.000Z",
      width: 1280,
      height: 720,
      screenshot: {
        mimeType: "image/png",
        base64: "cG5n",
        width: 1280,
        height: 720,
      },
      elements: [
        {
          elementId: "field-1",
          role: "text-field",
          name: "Document",
          value: "redacted-at-projection-boundary",
          enabled: true,
        },
      ],
    });

    expect(observation.observationId).toBe("observation-1");
    expect(observation).not.toHaveProperty("threadId");
    expect(observation).not.toHaveProperty("providerSessionId");
  });

  it("requires exactly one valid success or failure response shape", () => {
    const correlation = {
      hostId: "host-1",
      connectionId: "connection-1",
      leaseId: "lease-1",
      requestId: "request-1",
    };

    expect(
      decodeHostResponse({ ...correlation, ok: true, result: { completedActions: 1 } }),
    ).toEqual({ ...correlation, ok: true, result: { completedActions: 1 } });
    expect(
      decodeHostResponse({
        ...correlation,
        ok: false,
        error: {
          _tag: "ComputerUseStaleObservationError",
          message: "stale",
        },
      }),
    ).toMatchObject({ ...correlation, ok: false });
    expect(() => decodeHostResponse({ ...correlation, ok: false })).toThrow();
    expect(() =>
      decodeHostResponse({
        ...correlation,
        ok: true,
        result: null,
        error: { _tag: "ComputerUseInterruptedError", message: "invalid mixed response" },
      }),
    ).toThrow();
  });

  it("carries an explicit lease cancellation to the signed host", () => {
    expect(
      decodeHostStreamEvent({
        type: "cancel",
        connectionId: "connection-1",
        leaseId: "lease-1",
        reason: "takeover",
      }),
    ).toEqual({
      type: "cancel",
      connectionId: "connection-1",
      leaseId: "lease-1",
      reason: "takeover",
    });
  });

  it("bounds privacy-safe Computer Use history without action payload fields", () => {
    const entry = decodeHistoryEntry({
      entryId: "history-1",
      environmentId: "environment-1",
      hostId: "host-1",
      threadId: "thread-1",
      turnId: "turn-1",
      providerInstanceId: "atomic",
      operation: "act",
      target: {
        kind: "application",
        displayName: "TextEdit",
        applicationId: "com.apple.TextEdit",
        stableIdentity: "macos:com.apple.TextEdit:APPLE",
      },
      risk: "reversible-local",
      state: "completed",
      summary: "Completed 1 action in TextEdit.",
      resultTag: "success",
      createdAt: "2026-08-27T20:00:00.000Z",
      screenshot: "must-not-be-part-of-history",
      text: "must-not-be-part-of-history",
    });

    expect(entry).not.toHaveProperty("screenshot");
    expect(entry).not.toHaveProperty("text");
    expect(() =>
      decodeHistory(Array.from({ length: COMPUTER_USE_HISTORY_MAX_ENTRIES + 1 }, () => entry)),
    ).toThrow();
    expect(() =>
      decodeHistoryInput({ limit: COMPUTER_USE_HISTORY_MAX_QUERY_ENTRIES + 1 }),
    ).toThrow();
  });
});
