import { MAX_KEYBINDINGS_COUNT, type KeybindingRule } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  compileResolvedKeybindingRule,
  compileResolvedKeybindingsConfig,
  DEFAULT_KEYBINDINGS,
  DEFAULT_RESOLVED_KEYBINDINGS,
  parseKeybindingShortcut,
  parseKeybindingWhenExpression,
} from "./keybindings.ts";

describe("parseKeybindingShortcut", () => {
  it("parses mod and letter shortcuts", () => {
    expect(parseKeybindingShortcut("mod+j")).toEqual({
      key: "j",
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      modKey: true,
    });
  });

  it("parses the plus key without treating trailing empties as invalid", () => {
    expect(parseKeybindingShortcut("mod++")).toEqual({
      key: "+",
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      modKey: true,
    });
  });

  it("normalizes space and escape aliases", () => {
    expect(parseKeybindingShortcut("shift+space")?.key).toBe(" ");
    expect(parseKeybindingShortcut("esc")?.key).toBe("escape");
  });

  it("accepts cmd/meta/ctrl/alt/option/control aliases", () => {
    expect(parseKeybindingShortcut("cmd+shift+p")).toEqual({
      key: "p",
      metaKey: true,
      ctrlKey: false,
      shiftKey: true,
      altKey: false,
      modKey: false,
    });
    expect(parseKeybindingShortcut("ctrl+alt+delete")?.ctrlKey).toBe(true);
    expect(parseKeybindingShortcut("ctrl+alt+delete")?.altKey).toBe(true);
  });

  it("rejects duplicate keys and ambiguous sequences", () => {
    expect(parseKeybindingShortcut("mod++j")).toBeNull();
    expect(parseKeybindingShortcut("a+b")).toBeNull();
    expect(parseKeybindingShortcut("mod")).toBeNull();
  });
});

describe("parseKeybindingWhenExpression", () => {
  it("parses identifiers and negation", () => {
    expect(parseKeybindingWhenExpression("terminalFocus")).toEqual({
      type: "identifier",
      name: "terminalFocus",
    });
    expect(parseKeybindingWhenExpression("!terminalFocus")).toEqual({
      type: "not",
      node: { type: "identifier", name: "terminalFocus" },
    });
  });

  it("parses boolean precedence with grouping", () => {
    expect(parseKeybindingWhenExpression("a && b || c")).toEqual({
      type: "or",
      left: {
        type: "and",
        left: { type: "identifier", name: "a" },
        right: { type: "identifier", name: "b" },
      },
      right: { type: "identifier", name: "c" },
    });
    expect(parseKeybindingWhenExpression("(a || b) && c")).toEqual({
      type: "and",
      left: {
        type: "or",
        left: { type: "identifier", name: "a" },
        right: { type: "identifier", name: "b" },
      },
      right: { type: "identifier", name: "c" },
    });
  });

  it("rejects junk tokens and unconsumed input", () => {
    expect(parseKeybindingWhenExpression("")).toBeNull();
    expect(parseKeybindingWhenExpression("a $$ b")).toBeNull();
    expect(parseKeybindingWhenExpression("a &&")).toBeNull();
  });
});

describe("compileResolvedKeybindingsConfig", () => {
  it("compiles default keybindings and caps the list", () => {
    expect(DEFAULT_RESOLVED_KEYBINDINGS.length).toBeGreaterThan(0);
    expect(DEFAULT_RESOLVED_KEYBINDINGS.length).toBeLessThanOrEqual(MAX_KEYBINDINGS_COUNT);
    for (const rule of DEFAULT_KEYBINDINGS) {
      expect(compileResolvedKeybindingRule(rule)).not.toBeNull();
    }
  });

  it("drops invalid rules while keeping valid neighbors", () => {
    const compiled = compileResolvedKeybindingsConfig([
      { key: "mod+j", command: "terminal.toggle" },
      { key: "a+b", command: "sidebar.toggle" },
      { key: "mod+b", command: "sidebar.toggle", when: "broken &&" },
      { key: "mod+k", command: "commandPalette.toggle", when: "!terminalFocus" },
    ]);
    expect(compiled.map((rule) => rule.command)).toEqual([
      "terminal.toggle",
      "commandPalette.toggle",
    ]);
  });

  it("keeps only the most recent rules when over the cap", () => {
    const rules: KeybindingRule[] = Array.from({ length: MAX_KEYBINDINGS_COUNT + 3 }, (_, index) => ({
      key: `mod+${(index % 9) + 1}`,
      command: "terminal.toggle",
    }));
    const compiled = compileResolvedKeybindingsConfig(rules);
    expect(compiled).toHaveLength(MAX_KEYBINDINGS_COUNT);
    expect(compiled[0]?.shortcut.key).toBe(`${((3 % 9) + 1).toString()}`);
    expect(compiled.at(-1)?.shortcut.key).toBe(
      `${(((MAX_KEYBINDINGS_COUNT + 2) % 9) + 1).toString()}`,
    );
  });
});
