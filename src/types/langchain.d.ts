declare module '@langchain/core/prompts' {
    export class ChatPromptTemplate {
        static fromMessages(messages: any[]): ChatPromptTemplate;
        formatMessages(values: Record<string, any>): any[];
    }

    export class MessagesPlaceholder {
        constructor(variableName: string);
    }
}

declare module '@langchain/core/messages' {
    export class HumanMessage {
        constructor(content: string);
    }

    export class SystemMessage {
        constructor(content: string);
    }
}

declare module '@langchain/core/runnables' {
    export class RunnableSequence {
        static from(runnables: any[]): RunnableSequence;
        invoke(input: any): Promise<any>;
    }
}

declare module '@langchain/openai' {
    export class ChatOpenAI {
        constructor(config: {
            modelName?: string;
            temperature?: number;
            maxTokens?: number;
            apiKey?: string;
        });
        invoke(messages: any[]): Promise<any>;
    }
}

declare module '@langchain/anthropic' {
    export class ChatAnthropic {
        constructor(config: {
            modelName?: string;
            temperature?: number;
            maxTokens?: number;
            apiKey?: string;
        });
        invoke(messages: any[]): Promise<any>;
    }
}

declare module '@langchain/google-genai' {
    export class ChatGoogleGenerativeAI {
        constructor(config: {
            modelName?: string;
            temperature?: number;
            maxTokens?: number;
            apiKey?: string;
        });
        invoke(messages: any[]): Promise<any>;
    }
} 