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
    export class ChatOpenAI {
        constructor(config: {
            modelName?: string;
            temperature?: number;
            maxTokens?: number;
            apiKey?: string;
        });
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
