import { InferenceFailure } from '../failure.js';

/** Native truncate/shift controls are verified against the first tested server release. */
export function ollamaContextSupport(base: URL, fetcher: typeof fetch) {
  let verified = false;
  return async (signal: AbortSignal): Promise<void> => {
    if (verified) return;
    const url = new URL(`${base.pathname.replace(/\/$/u, '')}/api/version`, base);
    const response = await fetcher(url, { signal });
    if (!response.ok) throw new InferenceFailure(response.status === 401 || response.status === 403 ? 'authentication' : 'unavailable', 'Ollama context capability check failed');
    let body: { version?: unknown } | null;
    try { body = await response.json() as { version?: unknown } | null; }
    catch (error) {
      if (signal.aborted) throw error;
      throw new InferenceFailure('protocol', 'Ollama version response is not valid JSON');
    }
    const version = typeof body?.version === 'string' ? /^(\d+)\.(\d+)\.(\d+)$/u.exec(body.version) : null;
    if (!version || (Number(version[1]) === 0 && Number(version[2]) < 34)) {
      throw new InferenceFailure('unsupported', 'Explicit no-truncation context requires Ollama 0.34.0 or later');
    }
    verified = true;
  };
}
