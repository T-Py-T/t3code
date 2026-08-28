import { describe, expect, it } from "vite-plus/test";

import { formatOmpTranscript } from "./ompTranscript.ts";

describe("formatOmpTranscript", () => {
  it("turns OMP JSONL session entries into a readable agent transcript", () => {
    const contents = [
      JSON.stringify({
        type: "message",
        message: { role: "user", content: [{ type: "text", text: "Inspect the provider" }] },
      }),
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Check the RPC contract" },
            { type: "text", text: "The provider is ready." },
          ],
        },
      }),
      JSON.stringify({
        type: "message",
        message: {
          role: "toolResult",
          toolName: "read",
          content: [{ type: "text", text: "source text" }],
        },
      }),
    ].join("\n");

    expect(formatOmpTranscript(contents)).toBe(
      [
        "You\nInspect the provider",
        "Thinking\nCheck the RPC contract",
        "Assistant\nThe provider is ready.",
        "Tool · read\nsource text",
      ].join("\n\n"),
    );
  });

  it("keeps malformed lines visible without exposing a parsing error", () => {
    expect(formatOmpTranscript("not-json\n")).toBe("Session event\nnot-json");
  });
});
