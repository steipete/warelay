/**
 * Embedding client for generating vector representations of text.
 * Supports OpenAI, Z.AI, and Ollama providers.
 */

import { loadConfig, type MemoryEmbeddingConfig } from "../config/config.js";

/** Interface for embedding clients */
export interface EmbeddingClient {
  /** Generate embedding for a single text */
  embed(text: string): Promise<number[]>;
  /** Generate embeddings for multiple texts (batch) */
  embedBatch(texts: string[]): Promise<number[][]>;
  /** Get the embedding dimension */
  dimensions(): number;
}

/** OpenAI embedding client using REST API */
class OpenAIEmbeddingClient implements EmbeddingClient {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly dims: number;
  private readonly baseUrl: string;

  constructor(config: MemoryEmbeddingConfig) {
    this.apiKey = config.apiKey ?? process.env.OPENAI_API_KEY ?? "";
    this.model = config.model ?? "text-embedding-3-small";
    this.dims = config.dimensions ?? 1536;
    this.baseUrl = config.baseUrl ?? "https://api.openai.com/v1";

    if (!this.apiKey) {
      throw new Error(
        "OpenAI API key required: set memory.embedding.apiKey or OPENAI_API_KEY env",
      );
    }
  }

  dimensions(): number {
    return this.dims;
  }

  async embed(text: string): Promise<number[]> {
    const result = await this.embedBatch([text]);
    return result[0] ?? [];
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const response = await fetch(`${this.baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        input: texts,
        dimensions: this.dims,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `OpenAI embedding failed (${response.status}): ${errorText}`,
      );
    }

    const data = (await response.json()) as {
      data: Array<{ embedding: number[]; index: number }>;
    };

    // Sort by index to maintain order
    const sorted = data.data.sort((a, b) => a.index - b.index);
    return sorted.map((item) => item.embedding);
  }
}

/** Z.AI embedding client - uses OpenAI-compatible API with Z.AI credentials */
class ZAIEmbeddingClient implements EmbeddingClient {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly dims: number;
  private readonly baseUrl: string;

  constructor(config: MemoryEmbeddingConfig) {
    // Get Z.AI credentials from models config if not provided directly
    const fullConfig = loadConfig();
    const zaiProvider = fullConfig.models?.providers?.zai;

    this.apiKey = config.apiKey ?? zaiProvider?.apiKey ?? "";
    this.model = config.model ?? "text-embedding-3-small";
    this.dims = config.dimensions ?? 1536;
    // Z.AI OpenAI-compatible endpoint
    this.baseUrl =
      config.baseUrl ?? "https://api.z.ai/api/openai/v1";

    if (!this.apiKey) {
      throw new Error(
        "Z.AI API key required: set memory.embedding.apiKey or configure models.providers.zai",
      );
    }
  }

  dimensions(): number {
    return this.dims;
  }

  async embed(text: string): Promise<number[]> {
    const result = await this.embedBatch([text]);
    return result[0] ?? [];
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const response = await fetch(`${this.baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        input: texts,
        dimensions: this.dims,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Z.AI embedding failed (${response.status}): ${errorText}`,
      );
    }

    const data = (await response.json()) as {
      data: Array<{ embedding: number[]; index: number }>;
    };

    // Sort by index to maintain order
    const sorted = data.data.sort((a, b) => a.index - b.index);
    return sorted.map((item) => item.embedding);
  }
}

/** Ollama embedding client for local models */
class OllamaEmbeddingClient implements EmbeddingClient {
  private readonly model: string;
  private readonly dims: number;
  private readonly baseUrl: string;

  constructor(config: MemoryEmbeddingConfig) {
    this.model = config.model ?? "nomic-embed-text";
    this.dims = config.dimensions ?? 768;
    this.baseUrl = config.baseUrl ?? "http://localhost:11434";
  }

  dimensions(): number {
    return this.dims;
  }

  async embed(text: string): Promise<number[]> {
    const response = await fetch(`${this.baseUrl}/api/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        prompt: text,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Ollama embedding failed (${response.status}): ${errorText}`,
      );
    }

    const data = (await response.json()) as { embedding: number[] };
    return data.embedding;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    // Ollama doesn't support batch - call sequentially
    const results: number[][] = [];
    for (const text of texts) {
      results.push(await this.embed(text));
    }
    return results;
  }
}

/**
 * Create an embedding client based on configuration.
 * Defaults to OpenAI if provider not specified.
 */
export function createEmbeddingClient(
  config: MemoryEmbeddingConfig,
): EmbeddingClient {
  const provider = config.provider ?? "openai";

  switch (provider) {
    case "openai":
      return new OpenAIEmbeddingClient(config);
    case "zai":
      return new ZAIEmbeddingClient(config);
    case "ollama":
      return new OllamaEmbeddingClient(config);
    case "local":
      // Local provider uses OpenAI-compatible API (for TEI, sentence-transformers server, etc.)
      return new OpenAIEmbeddingClient({
        ...config,
        apiKey: config.apiKey ?? "local", // API key not needed for local server
        baseUrl: config.baseUrl ?? "http://localhost:8080",
      });
    default:
      throw new Error(`Unknown embedding provider: ${provider}`);
  }
}
