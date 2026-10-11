export interface DecisionHttpOptions {
  endpoint: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export function decisionHttp(options: DecisionHttpOptions) {
  const endpoint = new URL(options.endpoint);
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error('Invalid decision endpoint');
  }
  const timeoutMs = options.timeoutMs ?? 180_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) throw new Error('Invalid decision timeout');
  return {
    endpoint,
    async json(url: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
      if (signal?.aborted) throw new Error('Decision request cancelled');
      const deadline = AbortSignal.timeout(timeoutMs);
      const combined = signal === undefined ? deadline : AbortSignal.any([signal, deadline]);
      try {
        const response = await (options.fetch ?? fetch)(url, { method: body === undefined ? 'GET' : 'POST', signal: combined,
          ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
        if (!response.ok) throw new Error(`Decision HTTP ${response.status}`);
        return await response.json();
      } catch (error) {
        if (signal?.aborted) throw new Error('Decision request cancelled', { cause: error });
        if (deadline.aborted) throw new Error('Decision request timed out', { cause: error });
        throw error;
      }
    },
  };
}
