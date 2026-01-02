/**
 * Qdrant vector database client for memory storage.
 * Uses REST API - no additional dependencies required.
 */

import type { MemoryQdrantConfig } from "../config/config.js";
import type { EmbeddingClient } from "./embedding.js";
import type {
  Memory,
  MemoryListOptions,
  MemorySaveInput,
  MemorySearchOptions,
  MemorySearchResult,
} from "./types.js";

/** Memory store interface */
export interface MemoryStore {
  /** Initialize the store (create collection if needed) */
  init(): Promise<void>;
  /** Save a new memory */
  save(input: MemorySaveInput): Promise<Memory>;
  /** Search for memories by semantic similarity */
  search(
    query: string,
    opts?: MemorySearchOptions,
  ): Promise<MemorySearchResult[]>;
  /** Get a specific memory by ID */
  get(id: string): Promise<Memory | null>;
  /** Delete a memory by ID */
  delete(id: string): Promise<boolean>;
  /** Delete all expired memories */
  deleteExpired(): Promise<number>;
  /** List memories with optional filters */
  list(opts?: MemoryListOptions): Promise<Memory[]>;
}

type QdrantCondition = {
  key?: string;
  match?: { value: string | number };
  range?: { lt?: number; gt?: number; lte?: number; gte?: number };
  is_null?: { key: string };
  should?: QdrantCondition[];
};

type QdrantFilter = {
  must?: QdrantCondition[];
};

type QdrantSearchResult = {
  id: string;
  score: number;
  payload: Record<string, unknown>;
};

type QdrantScrollResult = {
  points: Array<{
    id: string;
    payload: Record<string, unknown>;
  }>;
  next_page_offset?: string | number | null;
};

/** Qdrant-based memory store implementation */
export class QdrantMemoryStore implements MemoryStore {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly collection: string;
  private readonly embedder: EmbeddingClient;

  constructor(config: MemoryQdrantConfig, embedder: EmbeddingClient) {
    this.baseUrl = (config.url ?? "http://localhost:6333").replace(/\/$/, "");
    this.apiKey = config.apiKey;
    this.collection = config.collection ?? "clawdis_memories";
    this.embedder = embedder;
  }

  /** Make a request to Qdrant REST API */
  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.apiKey) {
      headers["api-key"] = this.apiKey;
    }

    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Qdrant ${method} ${path} failed (${response.status}): ${errorText}`,
      );
    }

    const data = await response.json();
    return (data as { result?: T }).result ?? (data as T);
  }

  /** Check if collection exists */
  private async collectionExists(): Promise<boolean> {
    try {
      await this.request("GET", `/collections/${this.collection}`);
      return true;
    } catch {
      return false;
    }
  }

  /** Create the collection with proper schema */
  private async createCollection(): Promise<void> {
    await this.request("PUT", `/collections/${this.collection}`, {
      vectors: {
        size: this.embedder.dimensions(),
        distance: "Cosine",
      },
    });

    // Create payload indexes for filtering
    const indexConfigs: Array<{ field: string; schema: unknown }> = [
      { field: "category", schema: "keyword" },
      { field: "senderId", schema: "keyword" },
      { field: "sessionId", schema: "keyword" },
      // Integer fields with range support for order_by
      {
        field: "createdAt",
        schema: { type: "integer", lookup: true, range: true },
      },
      {
        field: "expiresAt",
        schema: { type: "integer", lookup: true, range: true },
      },
    ];
    for (const { field, schema } of indexConfigs) {
      try {
        await this.request("PUT", `/collections/${this.collection}/index`, {
          field_name: field,
          field_schema: schema,
        });
      } catch {
        // Index might already exist - ignore
      }
    }
  }

  async init(): Promise<void> {
    const exists = await this.collectionExists();
    if (!exists) {
      await this.createCollection();
    }
  }

  async save(input: MemorySaveInput): Promise<Memory> {
    const id = crypto.randomUUID();
    const now = Date.now();

    const memory: Memory = {
      id,
      content: input.content,
      category: input.category,
      source: input.source,
      sessionId: input.sessionId,
      senderId: input.senderId ?? "global",
      confidence: input.confidence ?? 1.0,
      createdAt: now,
      updatedAt: now,
      expiresAt: input.expiresAt,
      metadata: input.metadata,
    };

    const embedding = await this.embedder.embed(memory.content);

    await this.request("PUT", `/collections/${this.collection}/points`, {
      points: [
        {
          id,
          vector: embedding,
          payload: memory,
        },
      ],
    });

    return memory;
  }

  async search(
    query: string,
    opts?: MemorySearchOptions,
  ): Promise<MemorySearchResult[]> {
    const embedding = await this.embedder.embed(query);
    const filter = this.buildFilter(opts);

    const body = {
      vector: embedding,
      limit: opts?.limit ?? 5,
      filter: filter.must?.length ? filter : undefined,
      with_payload: true,
    };

    const results = await this.request<QdrantSearchResult[]>(
      "POST",
      `/collections/${this.collection}/points/search`,
      body,
    );

    // Ensure results is an array
    const resultsArray = Array.isArray(results) ? results : [];

    return resultsArray
      .filter((r) => !opts?.minScore || r.score >= opts.minScore)
      .map((r) => ({
        ...(r.payload as Memory),
        score: r.score,
      }));
  }

  async get(id: string): Promise<Memory | null> {
    try {
      const result = await this.request<{
        id: string;
        payload: Record<string, unknown>;
      }>("GET", `/collections/${this.collection}/points/${id}`);
      return result.payload as Memory;
    } catch {
      return null;
    }
  }

  async delete(id: string): Promise<boolean> {
    try {
      await this.request(
        "POST",
        `/collections/${this.collection}/points/delete`,
        {
          points: [id],
        },
      );
      return true;
    } catch {
      return false;
    }
  }

  async deleteExpired(): Promise<number> {
    const now = Date.now();

    // Find expired memories
    const results = await this.request<QdrantScrollResult>(
      "POST",
      `/collections/${this.collection}/points/scroll`,
      {
        filter: {
          must: [
            {
              key: "expiresAt",
              range: { lt: now, gt: 0 },
            },
          ],
        },
        limit: 1000,
        with_payload: false,
      },
    );

    if (!results.points?.length) return 0;

    const ids = results.points.map((p) => p.id);
    await this.request(
      "POST",
      `/collections/${this.collection}/points/delete`,
      {
        points: ids,
      },
    );

    return ids.length;
  }

  async list(opts?: MemoryListOptions): Promise<Memory[]> {
    const filter = this.buildFilter(opts);

    const results = await this.request<QdrantScrollResult>(
      "POST",
      `/collections/${this.collection}/points/scroll`,
      {
        filter: filter.must?.length ? filter : undefined,
        limit: opts?.limit ?? 20,
        offset: opts?.offset,
        with_payload: true,
        order_by: {
          key: "createdAt",
          direction: "desc",
        },
      },
    );

    return (results.points ?? []).map((p) => p.payload as Memory);
  }

  private buildFilter(
    opts?: MemorySearchOptions | MemoryListOptions,
  ): QdrantFilter {
    const must: QdrantFilter["must"] = [];

    if (opts?.senderId) {
      must.push({ key: "senderId", match: { value: opts.senderId } });
    }

    if (opts?.category) {
      must.push({ key: "category", match: { value: opts.category } });
    }

    // Note: expired memories are cleaned up separately via deleteExpired()
    // No automatic expiry filter here since Qdrant can't easily filter for
    // "field doesn't exist OR field >= now"

    return { must };
  }
}
