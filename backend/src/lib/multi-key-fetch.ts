import { logger } from "./logger.js";

// Keep a rotating index for each set of keys to avoid repeatedly burning the first key.
// The key is the original comma-separated string, the value is the current index.
const keyIndexCache = new Map<string, number>();
const RETRYABLE_KEY_STATUSES = new Set([401, 402, 403, 429]);

type HeaderCarrier = {
  type: "header";
  name: string;
  keys: string[];
  prefix: string;
};

type QueryCarrier = {
  type: "query";
  name: string;
  keys: string[];
};

type KeyCarrier = HeaderCarrier | QueryCarrier;

function splitKeys(value: string): string[] {
  return value.split(",").map((key) => key.trim()).filter(Boolean);
}

function sameKeys(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function headerCarrier(headers: Headers, name: string, prefix = ""): HeaderCarrier | null {
  const raw = headers.get(name);
  if (!raw) return null;
  const value = prefix && raw.toLowerCase().startsWith(prefix.toLowerCase())
    ? raw.slice(prefix.length)
    : raw;
  const keys = splitKeys(value);
  if (keys.length <= 1) return null;
  return { type: "header", name, keys, prefix: prefix && raw.toLowerCase().startsWith(prefix.toLowerCase()) ? raw.slice(0, prefix.length) : "" };
}

function collectHeaderCarriers(headers: Headers): HeaderCarrier[] {
  return [
    headerCarrier(headers, "Authorization", "Bearer "),
    headerCarrier(headers, "x-api-key"),
    headerCarrier(headers, "X-API-KEY"),
    headerCarrier(headers, "X-Subscription-Token"),
    headerCarrier(headers, "X-GitHub-Models-Api-Key"),
    headerCarrier(headers, "X-GitHub-Token"),
  ].filter((carrier): carrier is HeaderCarrier => Boolean(carrier));
}

function collectQueryCarriers(url: URL | null): QueryCarrier[] {
  if (!url) return [];
  return ["api_key", "apikey", "key"]
    .map((name): QueryCarrier | null => {
      const raw = url.searchParams.get(name);
      if (!raw) return null;
      const keys = splitKeys(raw);
      return keys.length > 1 ? { type: "query", name, keys } : null;
    })
    .filter((carrier): carrier is QueryCarrier => Boolean(carrier));
}

function asUrl(input: RequestInfo | URL): URL | null {
  try {
    if (input instanceof Request) return new URL(input.url);
    return new URL(input.toString());
  } catch {
    return null;
  }
}

function applyActiveKey(headers: Headers, url: URL | null, carriers: KeyCarrier[], primaryKeys: string[], activeKey: string): string | URL {
  for (const carrier of carriers) {
    if (!sameKeys(carrier.keys, primaryKeys)) continue;
    if (carrier.type === "header") headers.set(carrier.name, `${carrier.prefix}${activeKey}`);
    else url?.searchParams.set(carrier.name, activeKey);
  }
  return url?.toString() ?? "";
}

/**
 * A drop-in replacement for the global fetch function that intercepts
 * requests with multiple API keys (comma-separated in headers) and 
 * automatically retries on rate limits (429) or quota errors (401/402/403).
 */
export async function multiKeyFetch(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  // We need to extract headers. Depending on how fetch was called,
  // headers could be in `init` or inside the `Request` object.
  let requestHeaders = new Headers();
  let isRequestObj = false;
  let requestObj: Request | null = null;

  if (input instanceof Request) {
    isRequestObj = true;
    requestObj = input;
    input.headers.forEach((value, key) => requestHeaders.set(key, value));
  }
  if (init?.headers) {
    const initHeaders = new Headers(init.headers);
    initHeaders.forEach((value, key) => requestHeaders.set(key, value));
  }

  const baseUrl = asUrl(input);
  const carriers = [...collectHeaderCarriers(requestHeaders), ...collectQueryCarriers(baseUrl)];
  const primaryCarrier = carriers[0];
  if (!primaryCarrier) return fetch(input, init);

  const keys = primaryCarrier.keys;
  if (keys.length <= 1) {
    return fetch(input, init);
  }

  const cacheKey = keys.join(",");
  let currentIndex = keyIndexCache.get(cacheKey) ?? 0;

  let lastResponse: Response | null = null;

  for (let attempt = 0; attempt < keys.length; attempt++) {
    const activeKey = keys[(currentIndex + attempt) % keys.length];
    
    // Update headers/query params with the single active key
    const newHeaders = new Headers(requestHeaders);
    const newUrl = baseUrl ? new URL(baseUrl.toString()) : null;
    const rewrittenUrl = applyActiveKey(newHeaders, newUrl, carriers, keys, activeKey);
    
    let fetchPromise: Promise<Response>;

    if (isRequestObj && requestObj) {
      // Reconstruct the request to avoid "body stream already read" if we need to retry
      // Note: If it's a stream body we might not be able to clone it easily, 
      // but usually SDKs pass stringified JSON which clones fine.
      const clonedReq = requestObj.clone();
      const newInit: RequestInit = {
        method: clonedReq.method,
        headers: newHeaders,
        body: clonedReq.body ? await clonedReq.clone().arrayBuffer() : null,
        redirect: clonedReq.redirect,
        signal: init?.signal ?? clonedReq.signal,
      };
      fetchPromise = fetch(rewrittenUrl || clonedReq.url, newInit);
    } else {
      const newInit: RequestInit = { ...init, headers: newHeaders };
      fetchPromise = fetch(rewrittenUrl || input, newInit);
    }

    lastResponse = await fetchPromise;

    // Retry if rate limited (429) or quota exceeded/invalid key (401, 402, 403)
    if (RETRYABLE_KEY_STATUSES.has(lastResponse.status)) {
      const maskedKey = `...${activeKey.slice(-4)}`;
      logger.warn(`[multi-key-fetch] Key ${maskedKey} got ${lastResponse.status}. Rolling over to next key. (${attempt + 1}/${keys.length})`);
      continue;
    }

    // Success or unrecoverable error (like 400 Bad Request, 500)
    // Update cache so next time we start at the key that worked (or at least didn't rate limit)
    keyIndexCache.set(cacheKey, (currentIndex + attempt) % keys.length);
    return lastResponse;
  }

  // If all keys failed, bump the index anyway so we don't hammer the exact same sequence next time
  keyIndexCache.set(cacheKey, (currentIndex + 1) % keys.length);
  return lastResponse!;
}
