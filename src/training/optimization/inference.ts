import type { InferenceProvider } from '../contracts/execution.js';
import { InferenceFailure } from '../inference/index.js';
import { generateParamsSchema, inferenceSchema } from './protocol.js';
import type { DspyOptimizationOptions } from './types.js';

/** Exact two-message mapping; unsupported conversations are rejected, never flattened. */
export function createDspyGeneration(provider: InferenceProvider, model: string): DspyOptimizationOptions['generate'] {
  if (provider.capabilities.tools !== 'disabled') {
    throw new Error('DSPy reflection requires an explicit tool-free inference route');
  }
  if (model.trim().length === 0) throw new Error('DSPy reflection requires an explicit model');
  return async (raw, signal) => {
    const request = generateParamsSchema.parse(raw);
    const [system, user] = request.messages;
    if (request.messages.length !== 2 || system?.role !== 'system' || user?.role !== 'user') {
      throw new Error('InferenceRequest cannot represent this DSPy message sequence without changing roles');
    }
    signal.throwIfAborted();
    const response = await provider.generate({ system: system.content, prompt: user.content, model, signal });
    try { return inferenceSchema.parse(response); }
    catch {
      throw new InferenceFailure('protocol', 'Optimizer inference returned invalid completion metadata', {
        attempts: response.attempts, usage: response.usage,
        responseModel: response.modelBasis === 'requested-assumption' ? null : response.model,
        responseRoute: response.route,
      });
    }
  };
}
