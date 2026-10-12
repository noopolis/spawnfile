import type { InferenceFailureEvidence } from '../failure.js';
import type { Usage } from '../../contracts/execution.js';

export interface ClaudeResult {
  text: string;
  model?: string;
  usage: Usage | null;
}

export function decodeClaudeResult(value: Record<string, unknown>, structured = false): ClaudeResult {
  if (value['type'] !== 'result' || value['subtype'] !== 'success' || value['is_error'] === true) {
    throw new Error('Claude generation did not complete successfully');
  }
  const text = structured ? JSON.stringify(value['structured_output']) : value['result'];
  if (typeof text !== 'string' || text.trim().length === 0) {
    throw new Error('Claude generation returned empty output');
  }
  return { text, model: typeof value['model'] === 'string' ? value['model'] : undefined, usage: claudeResultUsage(value) };
}

export function claudeResultUsage(value: Record<string, unknown>): Usage | null {
  const raw = value['usage'];
  const usage = raw !== null && typeof raw === 'object' ? raw as Record<string, unknown> : undefined;
  const count = (key: string): number | null => {
    const entry = usage?.[key];
    return typeof entry === 'number' && Number.isSafeInteger(entry) && entry >= 0 ? entry : null;
  };
  // Claude input_tokens excludes cache reads/writes, unlike Codex's total input_tokens.
  const uncached = count('input_tokens');
  const reads = count('cache_read_input_tokens');
  const writes = count('cache_creation_input_tokens');
  const creation = usage?.['cache_creation'];
  const duration = creation !== null && typeof creation === 'object' ? creation as Record<string, unknown> : undefined;
  const durationCount = (key: string): number | null => {
    const value = duration?.[key];
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
  };
  const total = uncached === null || reads === null || writes === null ? null : uncached + reads + writes;
  const input = total !== null && Number.isSafeInteger(total) ? total : null;
  return usage === undefined ? null : { inputTokens: input, cachedInputTokens: reads, cacheWriteInputTokens: writes,
      cacheWrite5mInputTokens: durationCount('ephemeral_5m_input_tokens'),
      cacheWrite1hInputTokens: durationCount('ephemeral_1h_input_tokens'),
      outputTokens: count('output_tokens'), reasoningTokens: null, source: 'claude.result.usage' };
}

export function savedSubscription(value: Record<string, unknown>): boolean {
  return value['loggedIn'] === true && value['authMethod'] === 'claude.ai' && value['apiProvider'] === 'firstParty';
}

export function claudeEnvironment(): NodeJS.ProcessEnv {
  // Saved subscription/keychain transport needs native host integration variables.
  // The inference child has no tools; provider and API overrides are still removed.
  const env = { ...process.env };
  delete env['CLAUDECODE'];
  delete env['CLAUDE_CODE_SIMPLE'];
  for (const name of Object.keys(env)) {
    if (/^(ANTHROPIC_(API_KEY|AUTH_TOKEN|BASE_URL|CUSTOM_HEADERS|PROFILE|FEDERATION_.*|ORGANIZATION_ID|IDENTITY_TOKEN_FILE)|CLAUDE_CODE_(OAUTH_TOKEN.*|USE_.*|API_KEY_HELPER.*)|TYPESAFE_API_KEY|OPENAI_API_KEY|CODEX_API_KEY)$/u.test(name)) delete env[name];
  }
  return env;
}

export function parseEnvelope(line: string): Record<string, unknown> {
  const value: unknown = JSON.parse(line);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Malformed Claude protocol');
  return value as Record<string, unknown>;
}

/** Preserve only independently observed model and usage, never raw provider output. */
export function claudeFailureEvidence(value: Record<string, unknown> | undefined, reportedModel?: string): InferenceFailureEvidence {
  const terminalModel = value?.['model'];
  const model = [typeof terminalModel === 'string' ? terminalModel : undefined, reportedModel]
    .find(candidate => candidate !== undefined && candidate.trim().length > 0);
  return { usage: value === undefined ? null : claudeResultUsage(value), responseModel: model ?? null, responseRoute: 'claude-subscription' };
}

/** StructuredOutput is the pinned CLI's schema completion, never an arbitrary agent tool. */
export function validateClaudeInitialization(value: Record<string, unknown>, structured: boolean): void {
  const tools = value['tools'], servers = value['mcp_servers'];
  const allowed = Array.isArray(tools) && (tools.length === 0 ||
    (structured && tools.length === 1 && tools[0] === 'StructuredOutput'));
  if (!allowed || !Array.isArray(servers) || servers.length !== 0) throw new Error('Claude inference isolation was not acknowledged');
}
