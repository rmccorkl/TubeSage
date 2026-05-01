import { getLogger } from "../utils/logger";
import { OllamaClient } from "./ollama-client";

const logger = getLogger('LLM_FACTORY');

/**
 * Settings interface needed by the factory
 */
export interface LLMSettings {
  selectedLLM: string;
  apiKeys: Record<string, string>;
  selectedModels: Record<string, string>;
}

/**
 * Factory for the Ollama client. Other providers go through LangChain
 * (`LangChainClient`) so they don't need factory indirection.
 */
export class LLMFactory {
  private settings: LLMSettings;
  private ollamaClient: OllamaClient | null = null;

  constructor(settings: LLMSettings) {
    this.settings = settings;
    logger.debug('Created LLM Factory');
  }

  getBestProvider(): string {
    return this.settings.selectedLLM;
  }

  getOllamaClient(): OllamaClient {
    if (!this.ollamaClient) {
      const baseUrl = this.settings.apiKeys['ollama'] || 'http://localhost:11434';
      this.ollamaClient = new OllamaClient(baseUrl);
    }
    return this.ollamaClient;
  }

  updateSettings(settings: LLMSettings): void {
    this.settings = settings;
    this.ollamaClient = null;
    logger.debug('LLM Factory settings updated');
  }
}
