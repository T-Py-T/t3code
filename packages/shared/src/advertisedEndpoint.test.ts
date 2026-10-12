import { describe, expect, it } from "vite-plus/test";

import {
  classifyHostedHttpsCompatibility,
  createAdvertisedEndpoint,
  deriveWsBaseUrl,
  normalizeHttpBaseUrl,
} from "./advertisedEndpoint.ts";

describe("advertisedEndpoint", () => {
  it("normalizes websocket origins to http(s) and strips path/query", () => {
    expect(normalizeHttpBaseUrl("wss://relay.example.test/foo?bar=1#frag")).toBe(
      "https://relay.example.test/",
    );
    expect(normalizeHttpBaseUrl("ws://127.0.0.1:5733/ws")).toBe("http://127.0.0.1:5733/");
  });

  it("derives websocket base URLs from normalized http origins", () => {
    expect(deriveWsBaseUrl("https://relay.example.test")).toBe("wss://relay.example.test/");
    expect(deriveWsBaseUrl("http://127.0.0.1:13773")).toBe("ws://127.0.0.1:13773/");
  });

  it("classifies http endpoints as mixed-content blocked for hosted https app", () => {
    expect(classifyHostedHttpsCompatibility("http://localhost:5733")).toBe(
      "mixed-content-blocked",
    );
    expect(classifyHostedHttpsCompatibility("https://relay.example.test", "compatible")).toBe(
      "compatible",
    );
  });

  it("builds advertised endpoints with derived websocket URLs", () => {
    const endpoint = createAdvertisedEndpoint({
      id: "local",
      label: "Local",
      provider: {
        id: "manual",
        label: "Manual",
        kind: "manual",
        isAddon: false,
      },
      httpBaseUrl: "https://host.test:8443/api",
      reachability: "loopback",
      source: "user",
    });

    expect(endpoint.httpBaseUrl).toBe("https://host.test:8443/");
    expect(endpoint.wsBaseUrl).toBe("wss://host.test:8443/");
    expect(endpoint.compatibility.hostedHttpsApp).toBe("unknown");
    expect(endpoint.compatibility.desktopApp).toBe("compatible");
  });
});
