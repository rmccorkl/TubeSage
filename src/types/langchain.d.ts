declare module '@langchain/core/prompts' {
    export class ChatPromptTemplate {
        static fromMessages(messages: unknown[]): ChatPromptTemplate;
        formatMessages(values: Record<string, unknown>): unknown[];
    }

    export class MessagesPlaceholder {
        constructor(variableName: string);
    }
}

declare module '@langchain/core/runnables' {
    export class RunnableSequence {
        static from(runnables: unknown[]): RunnableSequence;
        invoke(input: unknown): Promise<unknown>;
    }
}

declare module '@langchain/openai' {
    import { BaseMessageLike } from '@langchain/core/messages';
    // Deliberately partial, and worth knowing why that matters: a spread
    // skips excess-property checking, so the transport this plugin passes
    // through `configuration` was invisible to the compiler for as long as it
    // was being dropped (#19). The two fields that carry it and the request
    // budget are named here so at least they are checked.
    interface ChatOpenAIFields {
        modelName?: string;
        temperature?: number;
        maxTokens?: number;
        apiKey?: string;
        maxRetries?: number;
        /** Per-request budget handed to the OpenAI SDK; ours, not its default (#19). */
        timeout?: number;
        /** Where ChatOpenAI actually reads `fetch` from — see getOpenAiConfiguration. */
        configuration?: Record<string, unknown>;
        /**
         * Sent as `reasoning_effort`, and only for what LangChain counts as
         * an OpenAI reasoning model (#43). `none` is one of the bundled SDK's
         * ReasoningEffort values (openai 7.43.0).
         */
        reasoning?: { effort: 'none' | 'low' | 'medium' | 'high' };
        /** Spread into every request body as it stands (#43). */
        modelKwargs?: Record<string, unknown>;
    }
    export class ChatOpenAI {
        constructor(config: ChatOpenAIFields);
        invoke(messages: BaseMessageLike[]): Promise<unknown>;
    }
    /**
     * What the builders construct (#48): the chat-completions class ChatOpenAI
     * delegates to for every model id it does not send to the Responses API.
     * It takes the same fields.
     */
    export class ChatOpenAICompletions {
        constructor(config: ChatOpenAIFields);
        invoke(messages: BaseMessageLike[]): Promise<unknown>;
    }
}

declare module '@langchain/anthropic' {
    import { BaseMessageLike } from '@langchain/core/messages';
    export class ChatAnthropic {
        constructor(config: {
            modelName?: string;
            temperature?: number;
            maxTokens?: number;
            apiKey?: string;
        });
        invoke(messages: BaseMessageLike[]): Promise<unknown>;
    }
}

declare module '@langchain/google-genai' {
    import { BaseMessageLike } from '@langchain/core/messages';
    export class ChatGoogleGenerativeAI {
        constructor(config: {
            modelName?: string;
            temperature?: number;
            maxTokens?: number;
            apiKey?: string;
        });
        invoke(messages: BaseMessageLike[]): Promise<unknown>;
    }
}
