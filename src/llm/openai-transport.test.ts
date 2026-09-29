import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The one call the shim makes into the app. Everything below is the real
// wiring: the real factories, the real LangChain, the real OpenAI SDK.
const requestUrl = vi.hoisted(() => vi.fn());
vi.mock("obsidian", () => ({ requestUrl }));

import type { ChatOpenAI } from "@langchain/openai";
/** What the OpenAI SDK stores as its transport; named here to keep `globalThis` out of the file. */
type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
import { buildOpenAIModel, buildOpenRouterModel } from "./langchain-client";

/**
 * The OpenAI client ChatOpenAI actually builds.
 *
 * `_getClientOptions` is marked `@internal` by @langchain/openai, and it is
 * used here deliberately: it is the only way to make ChatOpenAI construct its
 * client without performing a request, and the client is the only place the
 * question "did our transport survive?" can honestly be asked. If a future
 * version removes it, this test fails loudly — which is the right outcome for
 * an assertion whose whole purpose is to notice the wiring changing
 * underneath us.
 */
function builtClient(model: ChatOpenAI): { fetch: FetchLike; baseURL?: string; timeout?: number } {
  const internal = model as unknown as {
    _getClientOptions(options: unknown): unknown;
    client: { fetch: FetchLike; baseURL?: string; timeout?: number };
  };
  internal._getClientOptions({});
  return internal.client;
}

const MODEL_OPTIONS = { apiKey: "sk-test-key", model: "gpt-4o", temperature: 0.2, maxTokens: 1000 };

beforeEach(() => {
  requestUrl.mockReset();
  requestUrl.mockResolvedValue({ status: 200, text: "{}", headers: {} });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the ChatOpenAI paths run on OUR transport (#19)", () => {
  // Why an assertion and not a reading: the transport reaches the SDK as one
  // property on a nested object. ChatOpenAI builds its client from
  // `{apiKey, organization, dangerouslyAllowBrowser, ...fields.configuration}`,
  // so a `fetch` in the wrong position is dropped in silence — no error, no
  // warning, and every request quietly on globalThis.fetch under the
  // provider's CORS policy. That is exactly what shipped before #19.
  for (const [name, build] of [
    ["OpenAI", buildOpenAIModel],
    ["OpenRouter", buildOpenRouterModel],
  ] as const) {
    it(`${name}: the built client's fetch is the shim, and a request through it reaches requestUrl`, async () => {
      const client = builtClient(build(MODEL_OPTIONS));

      expect(client.fetch).toBeDefined();

      // The assertion that matters is behavioural, not an identity check
      // against the platform fetch: not "it is some function of ours" but
      // "a request made through it goes out via Obsidian's requestUrl". With
      // the transport dropped, this client would reach for the platform
      // fetch and requestUrl would never be called.
      await client.fetch("https://api.example.com/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });

      expect(requestUrl).toHaveBeenCalledTimes(1);
      expect((requestUrl.mock.calls[0][0] as { url: string }).url).toBe(
        "https://api.example.com/v1/chat/completions",
      );
    });
  }

  it("OpenRouter keeps its baseURL and both attribution headers while moving onto the shim", () => {
    // The baseURL and the headers travel on the same nested object as the
    // transport, so they are the things most likely to be lost while moving
    // it. OpenRouter asks for both headers for attribution.
    const model = buildOpenRouterModel(MODEL_OPTIONS);
    const client = builtClient(model);
    expect(client.baseURL).toBe("https://openrouter.ai/api/v1");

    const configured = (model as unknown as {
      clientConfig: { defaultHeaders?: Record<string, string> };
    }).clientConfig;
    expect(configured.defaultHeaders?.["HTTP-Referer"]).toBe("https://github.com/rmccorkl/TubeSage");
    expect(configured.defaultHeaders?.["X-Title"]).toBe("TubeSage");
  });
});
