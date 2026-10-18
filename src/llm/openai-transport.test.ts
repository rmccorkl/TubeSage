import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The one call the shim makes into the app. Everything below is the real
// wiring: the real factories, the real LangChain, the real OpenAI SDK.
const requestUrl = vi.hoisted(() => vi.fn());
vi.mock("obsidian", () => ({ requestUrl }));

import type { ChatOpenAI } from "@langchain/openai";
/** What the OpenAI SDK stores as its transport; named here to keep `globalThis` out of the file. */
type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
import { buildOpenAIModel, buildOpenAiCompatibleModel, buildOpenRouterModel, LangChainClient } from "./langchain-client";
import { baseUrlOverrides, modelListUrl } from "./base-url";
import { TranscriptSummarizer } from "./transcript-summarizer";
import { DEFAULT_REQUEST_TIMEOUT_MS, setRequestBudgetMs } from "../utils/request-budget";
import { t } from "../i18n";

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

/** A self-hosted server on the local network, over plain http as most of them are (#25). */
const LOCAL_SERVER = "http://192.168.1.20:1234/v1";

/** The custom endpoint's builder in the shape the shared loops below call. */
const buildLocalServerModel = (options: typeof MODEL_OPTIONS) =>
  buildOpenAiCompatibleModel({ ...options, baseURL: LOCAL_SERVER });

beforeEach(() => {
  requestUrl.mockReset();
  requestUrl.mockResolvedValue({ status: 200, text: "{}", headers: {} });
  // The shim arms its budget on `window` timers; this suite runs on node,
  // where there is no window at all.
  // eslint-disable-next-line obsidianmd/no-global-this, obsidianmd/prefer-active-doc -- no window exists on node; this is what creates one
  vi.stubGlobal("window", globalThis);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
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
    ["OpenAI-compatible server", buildLocalServerModel],
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

  it("OpenRouter's attribution headers survive as far as requestUrl, which is where they count (#19 F4)", async () => {
    // The configured value (asserted below) is one step BEFORE the risky
    // part. Between there and the wire, openai-node turns the headers into a
    // `Headers` instance and the shim's normalizeHeaders folds that back into
    // a plain record — and iterating a Headers yields LOWERCASED names, so
    // what reaches requestUrl is `http-referer`, not `HTTP-Referer`. That is
    // correct on the wire (header names are case-insensitive) and invisible
    // at the clientConfig layer, which is exactly why this assertion is worth
    // having. The capture, and the three things below that make it work, come
    // from the reviewer's probe rather than being rediscovered here.
    requestUrl.mockResolvedValue({
      status: 200,
      // Both of these are load bearing: without the content type openai-node
      // hands LangChain raw text instead of a parsed object, and without
      // `usage` the same path fails — either way with a TypeError deep in
      // chat_models that reads like a shim bug and is not one.
      headers: { "content-type": "application/json" },
      text: JSON.stringify({
        id: "chatcmpl-test",
        object: "chat.completion",
        created: 0,
        model: "gpt-4o",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    });

    await buildOpenRouterModel(MODEL_OPTIONS).invoke(["hello"]);

    const sent = requestUrl.mock.calls[0][0] as {
      url: string;
      headers: Record<string, string>;
      throw?: boolean;
    };
    expect(sent.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(sent.headers["http-referer"]).toBe("https://github.com/rmccorkl/TubeSage");
    expect(sent.headers["x-title"]).toBe("TubeSage");
    // Pinned in the same breath because the SDK's typed errors depend on it:
    // `throw: false` is what makes requestUrl RETURN a 4xx/5xx response
    // instead of throwing, which is how a 429 becomes a RateLimitError rather
    // than an unrecognisable failure. Cheap to assert, and it catches anyone
    // tidying it away.
    expect(sent.throw).toBe(false);
  });

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

describe("the configured budget is the one that applies, not the SDK's ten minutes (#19 F1)", () => {
  // The interaction between parts 3 and 4 of #19. The SDK implements its
  // timeout by aborting the signal it hands to fetch; part 4 taught the shim
  // to honour signals, so from that commit the SDK's DEFAULT_TIMEOUT of
  // 600000 ms — which these builders never overrode — started landing. A user
  // who reads the new per-call timings, raises the budget to twenty minutes
  // exactly as #19 intends, and still loses the request at ten, with a
  // message that is not ours and explains nothing.
  const RAISED_BUDGET_MS = 30 * 60_000;
  const SDK_DEFAULT_MS = 600_000;

  beforeEach(() => {
    vi.useFakeTimers();
    setRequestBudgetMs(RAISED_BUDGET_MS);
  });

  afterEach(() => {
    vi.useRealTimers();
    setRequestBudgetMs(DEFAULT_REQUEST_TIMEOUT_MS);
  });

  for (const [name, build] of [
    ["OpenAI", buildOpenAIModel],
    ["OpenRouter", buildOpenRouterModel],
    ["OpenAI-compatible server", buildLocalServerModel],
  ] as const) {
    it(`${name}: a request outlives the SDK's default and is bounded at the configured budget`, async () => {
      requestUrl.mockReturnValue(new Promise(() => undefined));
      let outcome = "pending";
      void build(MODEL_OPTIONS).invoke(["hello"]).then(
        () => { outcome = "resolved"; },
        (error: unknown) => { outcome = `rejected: ${error instanceof Error ? error.message : String(error)}`; },
      );

      // Past the SDK's own ten minutes: the user asked for thirty.
      await vi.advanceTimersByTimeAsync(SDK_DEFAULT_MS + 1);
      expect(outcome).toBe("pending");

      // And bounded at the budget that was actually configured.
      //
      // WHICH clock ends it, since both are now set to the same number: the
      // SDK's, because it arms its abort just before handing the request to
      // our fetch. So the message the user sees at the budget is openai's
      // "Request timed out.", not the shim's "TubeSage stopped waiting…".
      // Both are honest about what happened; only ours names the configured
      // limit. Pinned here so that if anyone gives the SDK a grace period to
      // change which one wins, they change this deliberately.
      await vi.advanceTimersByTimeAsync(RAISED_BUDGET_MS);
      expect(outcome).toMatch(/^rejected: /);
      expect(outcome).toMatch(/timed out|stopped waiting/i);
    });
  }
});

describe("the OpenAI-compatible server is ChatOpenAI at the user's address (#25)", () => {
  /** A chat completion as a local server returns one; the content type and `usage` matter (see the OpenRouter header test). */
  function answerWith(content: string): void {
    requestUrl.mockResolvedValue({
      status: 200,
      headers: { "content-type": "application/json" },
      text: JSON.stringify({
        id: "chatcmpl-local",
        object: "chat.completion",
        created: 0,
        model: "llama-3.1-8b-instruct",
        choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      }),
    });
  }

  function sentRequest(): { url: string; headers: Record<string, string> } {
    return requestUrl.mock.calls[0][0] as { url: string; headers: Record<string, string> };
  }

  it("builds the client at the user's base URL, on the shim, without OpenRouter's attribution headers", () => {
    const model = buildLocalServerModel(MODEL_OPTIONS);
    expect(builtClient(model).baseURL).toBe(LOCAL_SERVER);
    const configured = (model as unknown as {
      clientConfig: { defaultHeaders?: Record<string, string> };
    }).clientConfig;
    // OpenRouter's headers are OpenRouter's to ask for: a user's own server
    // should not be told about TubeSage's GitHub page.
    expect(configured.defaultHeaders).toBeUndefined();
  });

  it("works with a BLANK key: the request goes out with a placeholder bearer token and the answer comes back", async () => {
    answerWith("summary from the local server");

    const response: unknown = await buildOpenAiCompatibleModel({ ...MODEL_OPTIONS, apiKey: "", baseURL: LOCAL_SERVER }).invoke(["hello"]);

    expect((response as { content: unknown }).content).toBe("summary from the local server");
    const sent = sentRequest();
    expect(sent.url).toBe(`${LOCAL_SERVER}/chat/completions`);
    expect(sent.headers.authorization).toBe("Bearer not-needed");
    expect(sent.headers["http-referer"]).toBeUndefined();
    expect(sent.headers["x-title"]).toBeUndefined();
  });

  it("works with NO key at all, as a hand-edited or pre-release data.json can leave it: no TypeError, placeholder sent", async () => {
    answerWith("ok");
    const options = { ...MODEL_OPTIONS, apiKey: undefined as unknown as string, baseURL: LOCAL_SERVER };
    let model: ReturnType<typeof buildOpenAiCompatibleModel> | undefined;
    expect(() => { model = buildOpenAiCompatibleModel(options); }).not.toThrow();
    const response: unknown = await model?.invoke(["hello"]);
    expect((response as { content: unknown }).content).toBe("ok");
    expect(sentRequest().headers.authorization).toBe("Bearer not-needed");
  });

  it("treats a key of only spaces as blank, and sends a real key when there is one", async () => {
    answerWith("ok");
    await buildOpenAiCompatibleModel({ ...MODEL_OPTIONS, apiKey: "   ", baseURL: LOCAL_SERVER }).invoke(["hello"]);
    expect(sentRequest().headers.authorization).toBe("Bearer not-needed");

    requestUrl.mockClear();
    await buildOpenAiCompatibleModel({ ...MODEL_OPTIONS, apiKey: "local-key", baseURL: LOCAL_SERVER }).invoke(["hello"]);
    expect(sentRequest().headers.authorization).toBe("Bearer local-key");
  });

  it.each([
    ["no scheme", "192.168.1.20:1234/v1"],
    ["a scheme it cannot use", "ftp://192.168.1.20/v1"],
    ["blank", ""],
  ])("refuses an address with %s, with the message the settings tab shows, before any request", (_why, baseURL) => {
    expect(() => buildOpenAiCompatibleModel({ ...MODEL_OPTIONS, baseURL })).toThrow(t("notice.openaiCompatible.invalidUrl"));
    expect(requestUrl).not.toHaveBeenCalled();
  });
});

describe("every provider's base URL: blank is the vendor, set is the custom host, for chat AND model list (#29)", () => {
  const GATEWAY = "http://gateway.local:4000";

  /** A reply each provider's parser accepts; the shape differs, the transport does not. */
  function answerFor(provider: string): void {
    const bodies: Record<string, unknown> = {
      anthropic: { content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1, output_tokens: 1 } },
      google: { candidates: [{ content: { parts: [{ text: "ok" }] } }] },
    };
    requestUrl.mockResolvedValue({
      status: 200,
      headers: { "content-type": "application/json" },
      text: JSON.stringify(bodies[provider] ?? {
        id: "chatcmpl-test",
        object: "chat.completion",
        created: 0,
        model: "m",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    });
  }

  /** The URL the chat request for `provider` actually went to, through the real LangChainClient switch. */
  async function chatUrl(provider: string, baseURL: string): Promise<string> {
    answerFor(provider);
    const client = new LangChainClient({ provider, model: "some-model", apiKey: "key", baseURL });
    await expect(client.generateCompletion("system", "user")).resolves.toBe("ok");
    return (requestUrl.mock.calls[0][0] as { url: string }).url;
  }

  it.each([
    ["openai", "https://api.openai.com/v1/chat/completions"],
    ["openrouter", "https://openrouter.ai/api/v1/chat/completions"],
    ["anthropic", "https://api.anthropic.com/v1/messages"],
    ["google", "https://generativelanguage.googleapis.com/v1beta/models/some-model:generateContent?key=key"],
  ])("%s with a blank base URL goes exactly where it always did", async (provider, url) => {
    expect(await chatUrl(provider, "")).toBe(url);
  });

  it.each(["openai", "openrouter", "anthropic", "google"])(
    "%s with a custom base URL (trailing slash and all): chat and model list both go to it, with no doubled slash",
    async (provider) => {
      const base = `${GATEWAY}/${provider}/`;
      const chat = await chatUrl(provider, base);
      const list = modelListUrl(provider, { customBaseUrls: { [provider]: base }, customBaseUrlEnabled: { [provider]: true }, openaiCompatibleBaseUrl: "" });
      for (const url of [chat, list]) {
        expect(url.startsWith(`${GATEWAY}/${provider}/`)).toBe(true);
        expect(url.slice("http://".length)).not.toContain("//");
      }
    },
  );

  it("refuses a malformed custom base URL before any request, instead of falling back to the vendor", async () => {
    const client = new LangChainClient({ provider: "anthropic", model: "m", apiKey: "key", baseURL: "gateway.local" });
    await expect(client.generateCompletion("system", "user")).rejects.toThrow(t("notice.baseUrl.invalid"));
    expect(requestUrl).not.toHaveBeenCalled();
  });

  it("keeps OpenRouter's attribution headers when its base URL is overridden", () => {
    const model = buildOpenRouterModel({ ...MODEL_OPTIONS, baseURL: `${GATEWAY}/openrouter/v1` });
    expect(builtClient(model).baseURL).toBe(`${GATEWAY}/openrouter/v1`);
    const configured = (model as unknown as { clientConfig: { defaultHeaders?: Record<string, string> } }).clientConfig;
    expect(configured.defaultHeaders?.["X-Title"]).toBe("TubeSage");
  });
});

describe("the custom-base-URL toggle decides for chat and model list alike, end to end (#28)", () => {
  const GATEWAY_ANTHROPIC = "http://gateway.local:4000/anthropic";

  it.each([
    [false, "https://api.anthropic.com"],
    [true, GATEWAY_ANTHROPIC],
  ])("toggle on = %s: the summary request and the model list both go to %s", async (enabled, base) => {
    requestUrl.mockResolvedValue({
      status: 200,
      headers: { "content-type": "application/json" },
      text: JSON.stringify({ content: [{ type: "text", text: "summary" }] }),
    });
    // The URL is typed in both cases; only the toggle differs.
    const settings = { customBaseUrls: { anthropic: GATEWAY_ANTHROPIC }, customBaseUrlEnabled: { anthropic: enabled }, openaiCompatibleBaseUrl: "" };
    // As main.ts builds it: the override map from the same settings.
    const summarizer = new TranscriptSummarizer(
      { model: "claude-test", temperature: 0, maxTokens: 100, systemPrompt: "system", userPrompt: "user" },
      { anthropic: "sk-ant-test" },
      baseUrlOverrides(settings),
    );

    await expect(summarizer.summarize("a transcript", "anthropic")).resolves.toBe("summary");
    expect((requestUrl.mock.calls[0][0] as { url: string }).url).toBe(`${base}/v1/messages`);
    expect(modelListUrl("anthropic", settings)).toBe(`${base}/v1/models`);
  });
});
