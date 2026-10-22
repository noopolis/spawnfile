import { grokGrantModels, grokGrantPurposes, grokGrantReasoningEfforts, type GrokGrantModel, type GrokGrantPurpose,
  type GrokGrantReasoningEffort } from '../../contracts/inference-grants.js';
import type { InferenceProvider, InferenceResult, Usage } from '../../contracts/execution.js';
import type { runProcess } from '../../platform/process/index.js';
import { InferenceFailure } from '../failure.js';
import { validateInferenceSchema } from '../response-schema.js';
import { runGrokCli } from './cli.js';
import { prepareGrokGrantCall } from './grant-home.js';
import type { GrokGrantPool } from './grant-pool.js';

export interface GrokBrokerInferenceOptions {
  pool: GrokGrantPool;
  /** Container-provisioned evaluator root for private GROK_HOMEs; absent fails closed. */
  homeRoot: string | undefined;
  purpose: GrokGrantPurpose;
  reasoningEffort: GrokGrantReasoningEffort;
  command?: string;
  timeoutMs?: number;
  process?: typeof runProcess;
}

/**
 * Grok judge/optimizer inference through a Daimon broker inference grant. Never
 * uses a desktop login: every failure to reach the broker, verify the client pin
 * or provision the private home is a failure, not a fallback.
 */
export function createGrokBrokerInference(options: GrokBrokerInferenceOptions): InferenceProvider {
  const { pool } = options;
  return {
    id: 'grok-broker-grant',
    capabilities: { tools: 'disabled', billing: 'subscription', temperature: false, seed: false, credentialAuthority: `grok-broker-grant:${pool.id}` },
    async generate(request) {
      validateInferenceSchema(request.responseSchema);
      const responseSchema = request.responseSchema === undefined ? undefined : structuredClone(request.responseSchema);
      if (!(grokGrantReasoningEfforts as readonly unknown[]).includes(options.reasoningEffort) || !(grokGrantPurposes as readonly unknown[]).includes(options.purpose)) {
        throw new InferenceFailure('unsupported', 'Invalid Grok broker-grant controls');
      }
      if (!request.prompt.trim() || !(grokGrantModels as readonly string[]).includes(request.model) ||
        request.temperature !== undefined || request.seed !== undefined) throw new InferenceFailure('unsupported', 'Invalid Grok broker-grant inference controls');
      if (options.homeRoot === undefined) throw new InferenceFailure('unsupported', 'Grok broker-grant inference requires a provisioned private home root');
      if (request.signal?.aborted) throw new InferenceFailure('cancelled', 'Grok cancelled before launch');
      const timeoutMs = options.timeoutMs ?? 180_000;
      const lease = await pool.acquire({ model: request.model as GrokGrantModel, reasoningEffort: options.reasoningEffort, purpose: options.purpose }, timeoutMs, request.signal);
      let result: InferenceResult | undefined;
      try {
        const call = await prepareGrokGrantCall(options.homeRoot, lease.authority, lease.grant, request.prompt);
        try {
          result = await runGrokCli({ command: options.command ?? 'grok', cwd: call.work, promptFile: call.promptFile, env: call.env,
            timeoutMs: lease.callTimeoutMs, cliModel: lease.authority.clientModelId, reasoningEffort: options.reasoningEffort, request, responseSchema,
            mode: { auth: 'broker-grant', clientModelId: lease.authority.clientModelId, grantModel: lease.grant.model }, process: options.process });
          return result;
        } finally { await call.cleanup(); }
      } finally {
        await lease.settle(result === undefined ? { ok: false } : { ok: true, tokens: spent(result.usage) });
      }
    },
  };
}

function spent(usage: Usage | null): number | null {
  if (usage === null || usage.inputTokens === null || usage.outputTokens === null) return null;
  return usage.inputTokens + usage.outputTokens;
}
