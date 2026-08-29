import { describe, expect, it } from "vite-plus/test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ProviderDriverKind } from "@t3tools/contracts";

import { AtomicIcon, OmpIcon, PiAgentIcon } from "../Icons.tsx";
import { getDriverOption } from "./providerDriverMeta.ts";

describe("Oh My Pi provider presentation", () => {
  it("makes OMP selectable with its annotated settings form", () => {
    const option = getDriverOption(ProviderDriverKind.make("omp"));

    expect(option?.label).toBe("Oh My Pi");
    expect(option?.badgeLabel).toBe("Early Access");
    expect(option?.settingsSchema.fields).toHaveProperty("approvalMode");
  });

  it("renders the official OMP gradient without reusing Pi or Atomic presentation", () => {
    const markup = renderToStaticMarkup(
      createElement(
        "div",
        null,
        createElement(OmpIcon, { "aria-label": "Oh My Pi" }),
        createElement(OmpIcon, { "aria-label": "Oh My Pi secondary" }),
      ),
    );
    const gradientIds = [...markup.matchAll(/id="([^"]+-omp-gradient)"/g)].map(
      (match) => match[1],
    );

    expect(markup).toContain('stop-color="#F84FCC"');
    expect(markup).toContain('stop-color="#9362F4"');
    expect(markup).toContain('stop-color="#00DBE4"');
    expect(gradientIds).toHaveLength(2);
    expect(new Set(gradientIds).size).toBe(2);
    for (const gradientId of gradientIds) {
      expect(markup).toContain(`fill="url(#${gradientId})"`);
    }

    expect(getDriverOption(ProviderDriverKind.make("omp"))?.icon).toBe(OmpIcon);
    expect(getDriverOption(ProviderDriverKind.make("pi"))?.icon).toBe(PiAgentIcon);
    expect(getDriverOption(ProviderDriverKind.make("atomic"))?.icon).toBe(AtomicIcon);
  });
});
