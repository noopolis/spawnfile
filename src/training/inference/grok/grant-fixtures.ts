import { createHash } from 'node:crypto';
import { GrokGrantRefusal, type GrokInferenceGrant, type GrokInferenceGrantAuthority } from '../../contracts/inference-grants.js';

/** Test-only broker double: deterministic grants, recorded requests/releases, and a pin over its own rendered bytes. */
export function fakeGrantAuthority(patch: Partial<GrokInferenceGrantAuthority> & { ttlMs?: number; now?: () => number; refusals?: GrokGrantRefusal[] } = {}) {
  let next = 0;
  const requests: Parameters<GrokInferenceGrantAuthority['request']>[0][] = [];
  const releases: string[] = [];
  const render = (input: Parameters<GrokInferenceGrantAuthority['renderClientConfig']>[0]) =>
    `[model.daimon-inference-grok]\nmodel = "${input.model}"\nbase_url = "${input.baseUrl}"\nenv_key = "${input.envKey}"\nreasoning = "${input.reasoningEffort}"\n`;
  const authority: GrokInferenceGrantAuthority = {
    clientModelId: 'daimon-inference-grok', envKey: 'DAIMON_INFERENCE_GRANT', maxLiveGrants: 8,
    async request(input) {
      requests.push(input);
      const refusal = patch.refusals?.shift();
      if (refusal) throw refusal;
      next++;
      const grant: GrokInferenceGrant = { grantId: next.toString(16).padStart(32, '0'), token: `inference_${'T'.repeat(40)}${String(next).padStart(3, '0')}`,
        baseUrl: 'http://127.0.0.1:43123/v1', ...input, expiresAt: new Date((patch.now ?? Date.now)() + (patch.ttlMs ?? 600_000)).toISOString(),
        limits: { maxRequests: 64, maxTokens: 2_000_000, timeoutMs: 600_000 } };
      return grant;
    },
    async release(grantId) { releases.push(grantId); return true; },
    renderClientConfig: render,
    // Pinned over this authority's own declared env key, so an unexpected key fails the key rule, not the pin.
    pinnedClientConfigSha256: (model, reasoningEffort) => createHash('sha256').update(render({ baseUrl: 'http://127.0.0.1:43123/v1', model, reasoningEffort, envKey: (patch.envKey as string | undefined) ?? 'DAIMON_INFERENCE_GRANT' })).digest('hex'),
    ...patch,
  };
  return { authority, requests, releases };
}
