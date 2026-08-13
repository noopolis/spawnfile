import type { MemoryE2EStatus } from "./memoryIntegration.js";

const DEFAULT_POLL_TIMEOUT_MS = 1_000;

export interface OllamaEmbeddingsProbeOptions {
  baseUrl?: string;
  model?: string;
  prompt?: string;
  timeoutMs?: number;
}

export interface OllamaEmbeddingsProbeResult {
  baseUrl: string;
  message: string;
  model?: string;
  status: MemoryE2EStatus;
  vectorDimension?: number;
}

const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number): Promise<T> => {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
};

const fetchJson = async <T>(url: string, init?: RequestInit, timeoutMs = DEFAULT_POLL_TIMEOUT_MS): Promise<T> => {
  const response = await withTimeout(fetch(url, init), timeoutMs);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  }
  return (await response.json()) as T;
};

export const runOllamaEmbeddingsProbe = async (
  options: OllamaEmbeddingsProbeOptions = {}
): Promise<OllamaEmbeddingsProbeResult> => {
  const baseUrl = options.baseUrl ?? "http://127.0.0.1:11434";
  const prompt = options.prompt ?? "spawnfile e2e embeddings probe";
  const timeoutMs = options.timeoutMs ?? 3_000;

  try {
    const tags = await fetchJson<{ models?: Array<{ name: string }> }>(
      `${baseUrl}/api/tags`,
      undefined,
      timeoutMs
    );
    const candidates = [...(tags.models ?? [])].map((entry) => entry.name).filter(Boolean);

    if (candidates.length === 0) {
      return {
        baseUrl,
        message: "Ollama tags endpoint responded, but no model list is available",
        status: "unsupported"
      };
    }

    const selectedModel = options.model ?? candidates[0];
    if (options.model && !candidates.includes(options.model)) {
      return {
        baseUrl,
        model: options.model,
        message: `Ollama is available but requested model ${options.model} is not installed`,
        status: "unsupported"
      };
    }

    const embeddingResponse = await fetchJson<{ embedding?: number[] }>(`${baseUrl}/api/embeddings`, {
      body: JSON.stringify({
        model: selectedModel,
        prompt
      }),
      headers: {
        "content-type": "application/json"
      },
      method: "POST"
    }, timeoutMs);

    const vectorDimension = Array.isArray(embeddingResponse.embedding)
      ? embeddingResponse.embedding.length
      : undefined;
    if (!vectorDimension) {
      return {
        baseUrl,
        model: selectedModel,
        message: "Ollama embeddings endpoint responded but did not include a vector",
        status: "unsupported"
      };
    }

    return {
      baseUrl,
      model: selectedModel,
      message: `Ollama embeddings probe succeeded with ${vectorDimension} dimensions`,
      status: "passed",
      vectorDimension
    };
  } catch (error) {
    return {
      baseUrl,
      message: `Ollama embeddings probe skipped: ${error instanceof Error ? error.message : String(error)}`,
      status: "skipped"
    };
  }
};
