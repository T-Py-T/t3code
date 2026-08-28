function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textFromContent(value: unknown, kind: "text" | "thinking"): string {
  if (typeof value === "string") return kind === "text" ? value.trim() : "";
  if (!Array.isArray(value)) return "";
  return value
    .flatMap((block) => {
      if (!isRecord(block) || block.type !== kind) return [];
      const text = kind === "thinking" ? block.thinking : block.text;
      return typeof text === "string" && text.trim() ? [text.trim()] : [];
    })
    .join("\n");
}

/** Present persisted OMP JSONL as a compact human transcript instead of raw protocol records. */
export function formatOmpTranscript(contents: string): string {
  const sections: string[] = [];
  for (const rawLine of contents.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      sections.push(`Session event\n${line}`);
      continue;
    }
    if (!isRecord(parsed)) continue;
    const message = isRecord(parsed.message) ? parsed.message : parsed;
    const role = typeof message.role === "string" ? message.role : undefined;
    const thinking = textFromContent(message.content, "thinking");
    const text = textFromContent(message.content, "text");
    if (thinking) sections.push(`Thinking\n${thinking}`);
    if (!text) continue;
    const label =
      role === "user"
        ? "You"
        : role === "assistant"
          ? "Assistant"
          : role === "toolResult"
            ? `Tool${typeof message.toolName === "string" ? ` · ${message.toolName}` : ""}`
            : role === "custom"
              ? "Agent event"
              : "Session event";
    sections.push(`${label}\n${text}`);
  }
  return sections.join("\n\n");
}
