import { CHECK_IDS, type B18PreflightCheck } from "./preflightTypes.js";
import { createCheck, FAIL, PASS, SKIP, parseJson } from "./preflightCheckers.js";

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

export const createFetchWithTimeout = (
  fetcher: Fetcher,
  timeoutMs: number
): ((input: string, init?: RequestInit) => Promise<Response>) => {
  return async (input, init = {}) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetcher(input, {
        ...init,
        signal: controller.signal
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new Error(`request timed out after ${timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  };
};

export const checkOllamaEmbeddings = async (
  fetcher: Fetcher,
  baseUrl: string,
  timeoutMs: number,
  model?: string
): Promise<B18PreflightCheck> => {
  const normalizedUrl = baseUrl.replace(/\/+$/u, "");
  const fetchWithTimeout = createFetchWithTimeout(fetcher, timeoutMs);

  try {
    const tagsResponse = await fetchWithTimeout(`${normalizedUrl}/api/tags`);
    if (!tagsResponse.ok) {
      return createCheck(
        SKIP,
        CHECK_IDS.ollama,
        "Ollama embeddings",
        `Ollama /api/tags returned ${tagsResponse.status} ${tagsResponse.statusText}`
      );
    }

    const tagsPayload = parseJson<{ models?: Array<{ name?: unknown }> }>(
      await tagsResponse.text()
    ) ?? {};
    const models = (tagsPayload.models ?? [])
      .map((entry) => String(entry.name ?? ""))
      .filter(Boolean);
    if (models.length === 0) {
      return createCheck(
        SKIP,
        CHECK_IDS.ollama,
        "Ollama embeddings",
        "Ollama /api/tags returned no models"
      );
    }

    const selectedModel = model ?? models[0]!;
    if (model && !models.includes(model)) {
      return createCheck(
        SKIP,
        CHECK_IDS.ollama,
        "Ollama embeddings",
        `Requested Ollama model ${model} is not installed`
      );
    }

    const embeddingsResponse = await fetchWithTimeout(`${normalizedUrl}/api/embeddings`, {
      body: JSON.stringify({
        model: selectedModel,
        prompt: "spawnfile b18 preflight"
      }),
      headers: { "content-type": "application/json" },
      method: "POST"
    });

    if (!embeddingsResponse.ok) {
      return createCheck(
        SKIP,
        CHECK_IDS.ollama,
        "Ollama embeddings",
        `Ollama /api/embeddings returned ${embeddingsResponse.status} ${embeddingsResponse.statusText}`
      );
    }

    const embeddingPayload = parseJson<{ embedding?: unknown }>(await embeddingsResponse.text());
    const dimension = Array.isArray(embeddingPayload?.embedding) ? embeddingPayload.embedding.length : 0;
    if (dimension <= 0) {
      return createCheck(
        SKIP,
        CHECK_IDS.ollama,
        "Ollama embeddings",
        "Ollama /api/embeddings response has no embedding vector"
      );
    }

    return createCheck(
      PASS,
      CHECK_IDS.ollama,
      "Ollama embeddings",
      `Ollama embeddings probe returned ${dimension}-dimension vector`
    );
  } catch (error) {
    return createCheck(
      SKIP,
      CHECK_IDS.ollama,
      "Ollama embeddings",
      `Ollama embeddings probe failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
};

export const checkMoltnetServer = async (
  fetcher: Fetcher,
  serverUrl: string,
  timeoutMs: number
): Promise<B18PreflightCheck> => {
  const fetchWithTimeout = createFetchWithTimeout(fetcher, timeoutMs);
  try {
    const response = await fetchWithTimeout(serverUrl);
    if (!response.ok) {
      return createCheck(
        SKIP,
        CHECK_IDS.moltnetServer,
        "Moltnet server",
        `Moltnet server returned ${response.status} ${response.statusText}`
      );
    }
    return createCheck(PASS, CHECK_IDS.moltnetServer, "Moltnet server", "Moltnet server is reachable");
  } catch (error) {
    return createCheck(
      SKIP,
      CHECK_IDS.moltnetServer,
      "Moltnet server",
      `Moltnet server check failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
};
