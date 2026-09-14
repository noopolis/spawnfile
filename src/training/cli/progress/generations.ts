import type { OptimizerGeneration } from '../../experiments/index.js';
import type { DspyRestoredEvidence } from '../../optimization/index.js';

/** Invocation-local presentation merged with immutable optimizer recovery receipts. */
export function createGenerationTracker() {
  const generations = new Map<string, OptimizerGeneration>();
  let restoredAttempts = 0, currentAttempts = 0;
  return {
    snapshot: () => structuredClone([...generations.values()]),
    attempts: () => restoredAttempts + currentAttempts,
    interrupt() {
      for (const [id, value] of generations) if (value.outcome === 'pending') {
        generations.set(id, { ...value, outcome: 'interrupted; usage unknown' });
      }
    },
    observe(event: { type: string; payload: unknown }): boolean {
      if (event.type === 'optimizer.restored') {
        const evidence = event.payload as DspyRestoredEvidence;
        for (const key of generations.keys()) if (key.startsWith('restored:')) generations.delete(key);
        for (const { callbackId, ...value } of evidence.generations) {
          generations.set(`restored:${callbackId}`, { ...value, outcome: 'completed' });
        }
        if (evidence.failedAttempts.length) generations.set('restored:failed', {
          model: null, usage: null, attempts: evidence.failedAttempts, outcome: 'generation-error',
        });
        restoredAttempts = 0;
        for (const reservation of evidence.reservations) if (reservation.method === 'generate') {
          restoredAttempts += reservation.attempts;
          for (let index = reservation.settledAttempts; index < reservation.attempts; index++) {
            generations.set(`restored:unknown:${reservation.id}:${index}`, {
              model: null, usage: null, outcome: 'interrupted; usage unknown',
            });
          }
        }
        return true;
      }
      if (!['optimizer.generation.started', 'optimizer.generation.completed', 'optimizer.generation.failed'].includes(event.type)) return false;
      const payload = event.payload as Partial<OptimizerGeneration> & { attempt: number };
      currentAttempts = Math.max(currentAttempts, payload.attempt);
      generations.set(`current:${payload.attempt}`, { model: payload.model ?? null, usage: payload.usage ?? null,
        requestedModel: payload.requestedModel, modelBasis: payload.modelBasis, route: payload.route, attempts: payload.attempts,
        outcome: event.type.endsWith('.started') ? 'pending' : event.type.endsWith('.failed') ? 'generation-error' : 'completed' });
      return true;
    },
  };
}
