/**
 * Evaluator inference grants: a broker (Daimon's Grok engine broker) lends its
 * credential to one sequential lane of judge or optimizer requests without the
 * evaluator ever holding that credential. This is the runtime-neutral seam;
 * the Daimon binding lives with the native adapter.
 */
export const grokGrantModels = ['grok-4.6', 'grok-4.5', 'grok-build'] as const;
export const grokGrantReasoningEfforts = ['low', 'medium', 'high'] as const;
export const grokGrantPurposes = ['judge', 'optimizer'] as const;
export const grokGrantRefusalCodes = ['auth_stale', 'grant_limit', 'invalid_request', 'unavailable'] as const;

export type GrokGrantModel = (typeof grokGrantModels)[number];
export type GrokGrantReasoningEffort = (typeof grokGrantReasoningEfforts)[number];
export type GrokGrantPurpose = (typeof grokGrantPurposes)[number];
export type GrokGrantRefusalCode = (typeof grokGrantRefusalCodes)[number];

/** The only environment variable a grant client reads its token from (Daimon's declared `env_key`). */
export const grokGrantEnvKey = 'DAIMON_INFERENCE_GRANT';

export interface GrokInferenceGrant {
  grantId: string;
  /** Bearer for the broker proxy. Child-process environment only; never logged, persisted or put in argv. */
  token: string;
  baseUrl: string;
  model: GrokGrantModel;
  reasoningEffort: GrokGrantReasoningEffort;
  purpose: GrokGrantPurpose;
  /** ISO timestamp; the broker drops the grant at this instant. */
  expiresAt: string;
  limits: { maxRequests: number; maxTokens: number; timeoutMs: number };
}

export interface GrokClientConfigInput {
  baseUrl: string;
  model: GrokGrantModel;
  reasoningEffort: GrokGrantReasoningEffort;
  envKey: string;
}

/** A closed broker refusal. Anything else a broker call throws means the broker is unavailable. */
export class GrokGrantRefusal extends Error {
  constructor(readonly code: GrokGrantRefusalCode) { super(`Grok inference grant refused (${code})`); this.name = 'GrokGrantRefusal'; }
}

export interface GrokInferenceGrantAuthority {
  /** The only `--model` a grant client may run. */
  readonly clientModelId: string;
  /** The environment variable the rendered client config reads the grant token from. */
  readonly envKey: string;
  /** The broker's live-grant cap; a local pool never holds more. */
  readonly maxLiveGrants: number;
  request(input: { model: GrokGrantModel; reasoningEffort: GrokGrantReasoningEffort; purpose: GrokGrantPurpose }): Promise<GrokInferenceGrant>;
  release(grantId: string): Promise<boolean>;
  /** Exact `config.toml` bytes for a private GROK_HOME. */
  renderClientConfig(input: GrokClientConfigInput): string;
  /** Independently pinned sha256 of those bytes for the production proxy; `undefined` means no pin (fail closed). */
  pinnedClientConfigSha256(model: GrokGrantModel, reasoningEffort: GrokGrantReasoningEffort): string | undefined;
}
