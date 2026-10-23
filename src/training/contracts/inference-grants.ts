/** A host lends a bounded credential capability without exposing its native login. */
export interface InferenceGrant {
  grantId: string;
  token: string;
  baseUrl: string;
  model: string;
  reasoningEffort: 'low' | 'medium' | 'high';
  purpose: 'judge' | 'optimizer';
  expiresAt: string;
  limits: { maxRequests: number; maxTokens: number; timeoutMs: number };
}
export interface InferenceClientConfigInput {
  baseUrl: string;
  model: string;
  reasoningEffort: 'low' | 'medium' | 'high';
  envKey: string;
}
export interface InferenceGrantAuthority {
  readonly clientModelId: string;
  readonly envKey: string;
  readonly maxLiveGrants: number;
  request(input: { model: string; reasoningEffort: 'low' | 'medium' | 'high'; purpose: 'judge' | 'optimizer' }): Promise<InferenceGrant>;
  release(grantId: string): Promise<boolean>;
  renderClientConfig(input: InferenceClientConfigInput): string;
  pinnedClientConfigSha256(model: string, reasoningEffort: 'low' | 'medium' | 'high'): string | undefined;
}
