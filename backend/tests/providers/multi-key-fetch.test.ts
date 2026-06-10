import test from "node:test";
import assert from "node:assert/strict";
import { multiKeyFetch } from "../../src/lib/multi-key-fetch.js";

test("multiKeyFetch retries header keys after rate limit", async () => {
  const originalFetch = globalThis.fetch;
  const seen: string[] = [];
  try {
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      seen.push(headers.get("Authorization") ?? "");
      return new Response("{}", { status: seen.length === 1 ? 429 : 200 });
    }) as typeof fetch;

    const response = await multiKeyFetch("https://example.test/chat", {
      headers: { Authorization: "Bearer key-one,key-two" },
    });

    assert.equal(response.status, 200);
    assert.deepEqual(seen, ["Bearer key-one", "Bearer key-two"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("multiKeyFetch retries query parameter keys after auth failure", async () => {
  const originalFetch = globalThis.fetch;
  const seen: string[] = [];
  try {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(input.toString());
      seen.push(url.searchParams.get("api_key") ?? "");
      return new Response("{}", { status: seen.length === 1 ? 403 : 200 });
    }) as typeof fetch;

    const response = await multiKeyFetch("https://api.scraperapi.com/?api_key=query-one,query-two&url=https%3A%2F%2Fexample.com");

    assert.equal(response.status, 200);
    assert.deepEqual(seen, ["query-one", "query-two"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
