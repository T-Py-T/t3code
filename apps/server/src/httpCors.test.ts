import { assert, describe, it } from "@effect/vitest";

import {
  browserApiCorsAllowedHeaders,
  browserApiCorsAllowedMethods,
  browserApiCorsHeaders,
} from "./httpCors.ts";

describe("httpCors", () => {
  it("advertises browser API methods and headers consistently", () => {
    assert.deepStrictEqual(browserApiCorsAllowedMethods, ["GET", "POST", "OPTIONS"]);
    assert.include(browserApiCorsAllowedHeaders, "authorization");
    assert.include(browserApiCorsAllowedHeaders, "dpop");
    assert.strictEqual(
      browserApiCorsHeaders["access-control-allow-methods"],
      browserApiCorsAllowedMethods.join(", "),
    );
    assert.strictEqual(
      browserApiCorsHeaders["access-control-allow-headers"],
      browserApiCorsAllowedHeaders.join(", "),
    );
    assert.strictEqual(browserApiCorsHeaders["access-control-allow-origin"], "*");
  });
});
