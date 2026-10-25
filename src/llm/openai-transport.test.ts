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
import { getLogsForCallout, LogLevel, logMark, setGlobalLogLevel } from "../utils/logger";
import type { ReasoningEffort } from "./reasoning-effort";

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

describe("reasoning effort and extra request parameters, as they go out on the wire (#43)", () => {
  /** A chat completion any ChatOpenAI path accepts; the content type and `usage` matter (see the OpenRouter header test). */
  function answerChat(): void {
    requestUrl.mockResolvedValue({
      status: 200,
      headers: { "content-type": "application/json" },
      text: JSON.stringify({
        id: "chatcmpl-test",
        object: "chat.completion",
        created: 0,
        model: "m",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    });
  }

  /** The JSON body of the one request that went out. */
  function sentBody(): Record<string, unknown> {
    expect(requestUrl).toHaveBeenCalledTimes(1);
    return JSON.parse((requestUrl.mock.calls[0][0] as { body: string }).body) as Record<string, unknown>;
  }

  async function bodyFor(model: ChatOpenAI): Promise<Record<string, unknown>> {
    answerChat();
    await model.invoke(["hello"]);
    return sentBody();
  }

  describe("OpenAI: LangChain's own reasoning option, which it sends for OpenAI's reasoning models", () => {
    it.each(["none", "low", "medium", "high"] as const)("%s goes out as reasoning_effort, unchanged", async (effort) => {
      const body = await bodyFor(buildOpenAIModel({ ...MODEL_OPTIONS, model: "gpt-5", reasoningEffort: effort }));
      expect(body.reasoning_effort).toBe(effort);
      expect(body).not.toHaveProperty("reasoning");
    });

    it("default sends nothing at all", async () => {
      const body = await bodyFor(buildOpenAIModel({ ...MODEL_OPTIONS, model: "gpt-5", reasoningEffort: "default" }));
      expect(body).not.toHaveProperty("reasoning_effort");
      expect(body).not.toHaveProperty("reasoning");
    });

    it("a model that does not reason (gpt-4o) is not sent it, rather than refused with a 400", async () => {
      const body = await bodyFor(buildOpenAIModel({ ...MODEL_OPTIONS, model: "gpt-4o", reasoningEffort: "low" }));
      expect(body).not.toHaveProperty("reasoning_effort");
    });
  });

  describe("OpenRouter: its own reasoning object, whatever the model id", () => {
    it.each(["none", "low", "high"] as const)("%s goes out as reasoning.effort", async (effort) => {
      const body = await bodyFor(buildOpenRouterModel({ ...MODEL_OPTIONS, model: "deepseek/deepseek-r1", reasoningEffort: effort }));
      expect(body.reasoning).toEqual({ effort });
      expect(body).not.toHaveProperty("reasoning_effort");
    });

    it("default sends nothing at all", async () => {
      const body = await bodyFor(buildOpenRouterModel({ ...MODEL_OPTIONS, model: "deepseek/deepseek-r1", reasoningEffort: "default" }));
      expect(body).not.toHaveProperty("reasoning");
      expect(body).not.toHaveProperty("reasoning_effort");
    });
  });

  describe("the OpenAI-compatible server: reasoning_effort as-is, plus the user's extra fields", () => {
    const build = (options: { reasoningEffort?: "default" | "none" | "low" | "medium" | "high"; extraParams?: string }) =>
      buildOpenAiCompatibleModel({ ...MODEL_OPTIONS, model: "qwen3-8b", baseURL: LOCAL_SERVER, ...options });

    it.each(["none", "medium"] as const)("%s goes out as reasoning_effort, whatever the model id", async (effort) => {
      const body = await bodyFor(build({ reasoningEffort: effort }));
      expect(body.reasoning_effort).toBe(effort);
      expect(body).not.toHaveProperty("reasoning");
    });

    it("default, with no extra fields, sends nothing new", async () => {
      const body = await bodyFor(build({ reasoningEffort: "default", extraParams: "" }));
      expect(body).not.toHaveProperty("reasoning_effort");
      expect(body).not.toHaveProperty("reasoning");
      expect(body).not.toHaveProperty("chat_template_kwargs");
    });

    it("merges the extra fields into the request as they were typed", async () => {
      const body = await bodyFor(build({ extraParams: '{"chat_template_kwargs": {"enable_thinking": false}}' }));
      expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
      expect(body.model).toBe("qwen3-8b");
    });

    it("lets an extra reasoning_effort win over the setting: the raw JSON is the more specific instruction", async () => {
      const body = await bodyFor(build({ reasoningEffort: "high", extraParams: '{"reasoning_effort": "low"}' }));
      expect(body.reasoning_effort).toBe("low");
    });

    it("refuses stored extra fields that are not a JSON object, as a hand-edited data.json can hold, before any request", () => {
      expect(() => build({ extraParams: "[1, 2]" })).toThrow(t("notice.openaiCompatible.extraParamsUnreadable"));
      expect(requestUrl).not.toHaveBeenCalled();
    });
  });

  it("the settings reach the request through TranscriptSummarizer and LangChainClient, as main.ts builds them", async () => {
    answerChat();
    const summarizer = new TranscriptSummarizer(
      { model: "qwen3-8b", temperature: 0, maxTokens: 100, systemPrompt: "system", userPrompt: "user" },
      {},
      { "openai-compatible": LOCAL_SERVER },
      { reasoningEffort: "low", openaiCompatibleExtraParams: '{"top_k": 20}' },
    );
    await expect(summarizer.summarize("a transcript", "openai-compatible")).resolves.toBe("ok");
    const body = sentBody();
    expect(body.reasoning_effort).toBe("low");
    expect(body.top_k).toBe(20);
  });

  describe("Ollama: none turns thinking off; every other level sends nothing", () => {
    const OLLAMA = "http://localhost:11434";

    /** Ollama's own API: the version probe, then the generate or chat call. */
    function answerOllama(): void {
      requestUrl.mockImplementation((request: { url: string }) => Promise.resolve({
        status: 200,
        headers: { "content-type": "application/json" },
        text: request.url.endsWith("/api/version")
          ? JSON.stringify({ version: "0.12.0" })
          : request.url.endsWith("/api/generate")
            ? JSON.stringify({ response: "ok", done: true })
            : `${JSON.stringify({ model: "qwen3", message: { role: "assistant", content: "ok" }, done: true })}\n`,
      }));
    }

    function bodySentTo(path: string): Record<string, unknown> {
      const call = requestUrl.mock.calls.find(([request]) => (request as { url: string }).url === `${OLLAMA}${path}`);
      expect(call, `no request to ${path}`).toBeDefined();
      return JSON.parse((call?.[0] as { body: string }).body) as Record<string, unknown>;
    }

    async function generateBody(reasoningEffort: "default" | "none" | "low" | "medium" | "high"): Promise<Record<string, unknown>> {
      answerOllama();
      // The path a note actually takes: summarize() hands Ollama to OllamaClient's /api/generate.
      const summarizer = new TranscriptSummarizer(
        { model: "qwen3", temperature: 0, maxTokens: 100, systemPrompt: "system", userPrompt: "user" },
        { ollama: OLLAMA },
        {},
        { reasoningEffort },
      );
      await expect(summarizer.summarize("a transcript", "ollama")).resolves.toBe("ok");
      return bodySentTo("/api/generate");
    }

    it("none sends think: false to /api/generate", async () => {
      expect((await generateBody("none")).think).toBe(false);
    });

    it.each(["default", "low", "medium", "high"] as const)("%s sends no think field to /api/generate", async (effort) => {
      expect(await generateBody(effort)).not.toHaveProperty("think");
    });

    it.each([
      ["none", false],
      ["default", undefined],
      ["high", undefined],
    ] as const)("ChatOllama, where LangChainClient builds it: %s sends think %s", async (reasoningEffort, think) => {
      answerOllama();
      const client = new LangChainClient({ provider: "ollama", model: "qwen3", apiKey: OLLAMA, baseURL: "", reasoningEffort });
      await expect(client.generateCompletion("system", "user")).resolves.toBe("ok");
      expect(bodySentTo("/api/chat").think).toBe(think);
    });
  });
});

describe("the debug callout names the reasoning effort that went out, as plain lines (#46)", () => {
  // Only a log call's message string reaches the callout; an object passed
  // beside it is dropped, which is why #43's level never showed in a note.
  // So every assertion reads the callout itself, the text the note gets.
  const OLLAMA = "http://localhost:11434";
  let mark = 0;

  beforeEach(() => {
    setGlobalLogLevel(LogLevel.DEBUG);
    mark = logMark();
  });

  afterEach(() => {
    setGlobalLogLevel(LogLevel.INFO);
  });

  /** One answer per provider API, told apart by the URL each one calls. */
  function answerEveryProvider(): void {
    requestUrl.mockImplementation((request: { url: string }) => {
      const reply = (body: unknown, suffix = "") => Promise.resolve({
        status: 200,
        headers: { "content-type": "application/json" },
        text: `${JSON.stringify(body)}${suffix}`,
      });
      if (request.url.endsWith("/api/version")) return reply({ version: "0.12.0" });
      if (request.url.endsWith("/api/generate")) return reply({ response: "ok", done: true });
      if (request.url.endsWith("/api/chat")) return reply({ model: "qwen3", message: { role: "assistant", content: "ok" }, done: true }, "\n");
      if (request.url.endsWith("/v1/messages")) return reply({ content: [{ type: "text", text: "ok" }] });
      if (request.url.includes(":generateContent")) return reply({ candidates: [{ content: { parts: [{ text: "ok" }] } }] });
      return reply({
        id: "chatcmpl-test",
        object: "chat.completion",
        created: 0,
        model: "m",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    });
  }

  /** One request through LangChainClient, the path every provider but direct Ollama takes. */
  async function request(provider: string, model: string, reasoningEffort: ReasoningEffort, openaiCompatibleExtraParams?: string): Promise<void> {
    answerEveryProvider();
    const client = new LangChainClient({
      provider,
      model,
      apiKey: provider === "ollama" ? OLLAMA : "sk-test-key",
      baseURL: provider === "openai-compatible" ? LOCAL_SERVER : "",
      reasoningEffort,
      openaiCompatibleExtraParams,
    });
    await expect(client.generateCompletion("system", "user")).resolves.toBe("ok");
  }

  /** The callout lines logged since the test began that start with `text` after their prefix. */
  function calloutLinesAbout(text: string): string[] {
    return getLogsForCallout(mark).split("\n").filter((line) => line.includes(`] ${text}`));
  }

  const effortLines = () => calloutLinesAbout("Reasoning effort:");

  describe("OpenAI: LangChain's reasoning option, which its model gate can drop", () => {
    it.each(["none", "low", "medium", "high"] as const)("%s on a reasoning model names reasoning.effort", async (effort) => {
      await request("openai", "gpt-5", effort);
      expect(effortLines()).toEqual([`> [LANGCHAIN] [DEBUG] Reasoning effort: ${effort} -> reasoning.effort`]);
    });

    it("default says nothing was sent", async () => {
      await request("openai", "gpt-5", "default");
      expect(effortLines()).toEqual(["> [LANGCHAIN] [DEBUG] Reasoning effort: default (nothing sent)"]);
    });

    it("a level on a model LangChain does not count as reasoning says it was dropped", async () => {
      await request("openai", "gpt-4o", "high");
      expect(effortLines()).toEqual(["> [LANGCHAIN] [DEBUG] Reasoning effort: high (dropped: model is not an OpenAI reasoning model)"]);
    });
  });

  describe("OpenRouter: its own reasoning object, through modelKwargs", () => {
    it.each(["none", "low", "medium", "high"] as const)("%s names reasoning.effort via modelKwargs", async (effort) => {
      await request("openrouter", "deepseek/deepseek-r1", effort);
      expect(effortLines()).toEqual([`> [LANGCHAIN] [DEBUG] Reasoning effort: ${effort} -> reasoning.effort via modelKwargs`]);
    });

    it("default says nothing was sent", async () => {
      await request("openrouter", "deepseek/deepseek-r1", "default");
      expect(effortLines()).toEqual(["> [LANGCHAIN] [DEBUG] Reasoning effort: default (nothing sent)"]);
    });
  });

  describe("the OpenAI-compatible server: reasoning_effort, and the extra fields by key name only", () => {
    it.each(["none", "low", "medium", "high"] as const)("%s names reasoning_effort via modelKwargs", async (effort) => {
      await request("openai-compatible", "qwen3-8b", effort);
      expect(effortLines()).toEqual([`> [LANGCHAIN] [DEBUG] Reasoning effort: ${effort} -> reasoning_effort via modelKwargs`]);
    });

    it("default says nothing was sent, and no extra fields says none", async () => {
      await request("openai-compatible", "qwen3-8b", "default", "");
      expect(effortLines()).toEqual(["> [LANGCHAIN] [DEBUG] Reasoning effort: default (nothing sent)"]);
      expect(calloutLinesAbout("Extra request parameters:")).toEqual(["> [LANGCHAIN] [DEBUG] Extra request parameters: none"]);
    });

    it("names the extra fields' top-level keys and never their values", async () => {
      await request("openai-compatible", "qwen3-8b", "default", '{"chat_template_kwargs": {"enable_thinking": false}, "top_k": "zz-secret-zz"}');
      expect(calloutLinesAbout("Extra request parameters:")).toEqual(["> [LANGCHAIN] [DEBUG] Extra request parameters: keys=chat_template_kwargs, top_k"]);
      const callout = getLogsForCallout(mark);
      expect(callout).not.toContain("zz-secret-zz");
      expect(callout).not.toContain("enable_thinking");
    });

    it("an extra reasoning_effort, which wins, is named as the override instead of the level", async () => {
      await request("openai-compatible", "qwen3-8b", "high", '{"reasoning_effort": "low"}');
      expect(effortLines()).toEqual(["> [LANGCHAIN] [DEBUG] Reasoning effort: high (overridden by extra request parameters)"]);
      expect(calloutLinesAbout("Extra request parameters:")).toEqual(["> [LANGCHAIN] [DEBUG] Extra request parameters: keys=reasoning_effort"]);
    });
  });

  describe("Ollama, on both paths: none is think:false, and the other levels say why nothing went", () => {
    const EXPECTED = [
      ["none", "Reasoning effort: none -> think:false"],
      ["default", "Reasoning effort: default (nothing sent)"],
      ["low", "Reasoning effort: low (nothing sent: Ollama can only turn thinking off)"],
      ["high", "Reasoning effort: high (nothing sent: Ollama can only turn thinking off)"],
    ] as const;

    it.each(EXPECTED)("the path a note takes, OllamaClient's /api/generate: %s", async (reasoningEffort, line) => {
      answerEveryProvider();
      const summarizer = new TranscriptSummarizer(
        { model: "qwen3", temperature: 0, maxTokens: 100, systemPrompt: "system", userPrompt: "user" },
        { ollama: OLLAMA },
        {},
        { reasoningEffort },
      );
      await expect(summarizer.summarize("a transcript", "ollama")).resolves.toBe("ok");
      expect(effortLines()).toEqual([`> [LLM] [DEBUG] ${line}`]);
    });

    it.each(EXPECTED)("ChatOllama, where LangChainClient builds it: %s", async (reasoningEffort, line) => {
      await request("ollama", "qwen3", reasoningEffort);
      expect(effortLines()).toEqual([`> [LANGCHAIN] [DEBUG] ${line}`]);
    });
  });

  describe("Anthropic and Gemini ignore the setting, and say so only when a level is set", () => {
    it.each([
      ["anthropic", "claude-sonnet-4-5"],
      ["google", "gemini-2.5-flash"],
    ])("%s with a level: ignored by this provider", async (provider, model) => {
      await request(provider, model, "high");
      expect(effortLines()).toEqual(["> [LANGCHAIN] [DEBUG] Reasoning effort: ignored by this provider"]);
    });

    it.each([
      ["anthropic", "claude-sonnet-4-5"],
      ["google", "gemini-2.5-flash"],
    ])("%s at default: no line at all", async (provider, model) => {
      await request(provider, model, "default");
      expect(effortLines()).toEqual([]);
    });
  });
});
