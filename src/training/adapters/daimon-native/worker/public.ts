import type { NativeConfig, NativeHost } from './types.js';
import type { NativeSandboxProjection } from '../receipt/index.js';

/** Grok projection options passed to Daimon verbatim from the launch receipt's broker section. */
export interface GrokBrokerProjectionOptions {
  slot: number; workerUid: number; workerHomePath: string; architecture: 'arm64' | 'x64'; usageLedgerPath: string;
  limits: { maxRequests: number; maxTokens: number; timeoutMs: number }; acceptanceStorePath: string; denyPaths: readonly string[]; seccompProfileSha256: string;
  /** The provisioner's sandbox profile digest; Daimon refuses a value that differs from its own render. */
  profileSha256: string;
}

/** Structural public seam keeps the optional runtime out of Paideia core installs. */
export interface NativeRuntimeModule {
  parseOrganizationRuntimeConfig(value: unknown): NativeConfig;
  createOrganizationRuntimeControlHost(value: unknown, options: { acceptanceStorePath: string; controlToken: string }): NativeHost;
  resolveOrganizationCodexSandboxProjection(value: unknown, agentId: string, options: { acceptanceStorePath: string }): Promise<NativeSandboxProjection>;
  resolveOrganizationGrokBrokerProjection?(value: unknown, agentId: string, options: GrokBrokerProjectionOptions): unknown;
  grokBrokerProjectionSha256?(projection: unknown): string;
  verifyGrokSlotPreflightReceipt?(value: unknown, projection: unknown, freshness: { expectedNonce: string; minGeneration: number }): unknown;
}

const grokExports = ['resolveOrganizationGrokBrokerProjection', 'grokBrokerProjectionSha256', 'verifyGrokSlotPreflightReceipt'] as const;

export async function loadDaimonRuntime(engine: 'codex' | 'grok' = 'codex'): Promise<NativeRuntimeModule> {
  const packageName = '@noopolis/daimon/runtime';
  let loaded: Record<string, unknown>;
  try { loaded = await import(packageName) as Record<string, unknown>; }
  catch (error) { throw new Error('Install optional @noopolis/daimon with its public /runtime export', { cause: error }); }
  if (typeof loaded['parseOrganizationRuntimeConfig'] !== 'function' || typeof loaded['createOrganizationRuntimeControlHost'] !== 'function') {
    throw new Error('Installed Daimon lacks the native organization control host');
  }
  if (engine === 'grok') {
    if (grokExports.some(name => typeof loaded[name] !== 'function')) throw new Error('Installed Daimon lacks the Grok broker projection and slot preflight capability');
  } else if (typeof loaded['resolveOrganizationCodexSandboxProjection'] !== 'function') throw new Error('Installed Daimon lacks exact native sandbox projection capability');
  return loaded as unknown as NativeRuntimeModule;
}
