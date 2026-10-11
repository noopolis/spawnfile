import { createHash } from 'node:crypto';
import { parseTransportSource, type TransportDeliverySource } from './wake-delivery/index.js';

export interface ExternalInputSource { kind: string; id: string; sha256: string }
export interface DeliveryControls { maxExternalDeliveries?: number; source?: ExternalInputSource }

/**
 * The most external continuations one trial may declare, and the wakes they cost.
 *
 * `MAX_TRIAL_WAKES` is the task delivery plus those continuations, and the worker's
 * runtime wake ceiling is derived from it rather than declared beside it. That
 * ceiling is published before any delivery arrives, so a separate number there
 * drifts from what this gate admits — and it drifted to one, which is how a trial
 * accepted a continuation the runtime would then never execute: the delivery stayed
 * admitted, nothing ran, and the wake burned to the shared trial deadline.
 */
export const MAX_EXTERNAL_DELIVERIES = 3;
export const MAX_TRIAL_WAKES = MAX_EXTERNAL_DELIVERIES + 1;

export function verifyExternalSource(source: ExternalInputSource, text: string): void {
  if (!source || Object.keys(source).sort().join(',') !== 'id,kind,sha256' ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u.test(source.id) ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/u.test(source.kind) ||
      source.sha256 !== `sha256:${createHash('sha256').update(text).digest('hex')}`) {
    throw new Error('External input requires an exact bounded source identity and content digest');
  }
}

/**
 * One task, explicitly bounded sequential external deliveries, never autonomous nudges.
 *
 * `maxExecutions` is the runtime's own per-agent execution policy. A budget this
 * gate would admit above it is one whose later continuations could never execute,
 * so it is refused here rather than deadlocking on the wake that cannot run.
 */
export function createDeliveryGate(timeoutMs: number, maxExecutions: number = MAX_TRIAL_WAKES, delivery: 'direct' | 'transport' = 'direct') {
  const wakes = new Set<string>();
  const executions: string[] = [];
  let active = false;
  let deferred = false;
  let maximum = 0;
  let deadline: number | undefined;
  return {
    executions,
    begin(wakeId: string, text: string, controls: DeliveryControls = {}, source?: TransportDeliverySource) {
      if (Object.keys(controls).some(key => !['maxExternalDeliveries', 'source'].includes(key))) throw new Error('Unknown delivery controls');
      if (active || wakes.has(wakeId) || wakes.size > maximum || wakes.size > 0 && !deferred) throw new Error('Worker accepts exactly one native trial delivery unless a bounded deferred continuation is declared');
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(wakeId) || delivery === 'direct' && !text.trim() || Buffer.byteLength(text) > 16384) throw new Error('Invalid bounded trial delivery');
      if (delivery === 'transport') {
        const expected = parseTransportSource(source);
        if (wakes.size && expected.deliveryId === undefined) throw new Error('Transport continuation requires an exact delivery id');
      } else if (source !== undefined) throw new Error('Direct delivery cannot declare a transport source');
      if (!wakes.size) {
        maximum = controls.maxExternalDeliveries ?? 0;
        if (!Number.isSafeInteger(maximum) || maximum < 0 || maximum > MAX_EXTERNAL_DELIVERIES || controls.source) throw new Error('Invalid external delivery bound');
        if (maximum + 1 > maxExecutions) throw new Error('Native execution policy admits fewer executions than the declared delivery budget');
      } else {
        if (controls.maxExternalDeliveries !== undefined || delivery === 'direct' && !controls.source) throw new Error('Continuation requires a source and cannot change its delivery budget');
        if (controls.source) verifyExternalSource(controls.source, text);
      }
      deadline ??= Date.now() + timeoutMs;
      if (Date.now() >= deadline) throw new Error('Native trial deadline exceeded');
      wakes.add(wakeId); active = true; deferred = false;
      return deadline - Date.now();
    },
    finish(executionId: string | undefined, awaitingInput: boolean) {
      if (executionId !== undefined) {
        if (executions.includes(executionId)) throw new Error('Native execution ID was reused');
        executions.push(executionId);
      }
      active = false;
      deferred = awaitingInput;
      return awaitingInput && wakes.size <= maximum;
    },
  };
}
