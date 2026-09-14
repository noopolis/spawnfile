import { createHash } from 'node:crypto';

export interface ExternalInputSource { kind: string; id: string; sha256: string }
export interface DeliveryControls { maxExternalDeliveries?: number; source?: ExternalInputSource }

export function verifyExternalSource(source: ExternalInputSource, text: string): void {
  if (!source || Object.keys(source).sort().join(',') !== 'id,kind,sha256' ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u.test(source.id) ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/u.test(source.kind) ||
      source.sha256 !== `sha256:${createHash('sha256').update(text).digest('hex')}`) {
    throw new Error('External input requires an exact bounded source identity and content digest');
  }
}

/** One task, explicitly bounded sequential external deliveries, never autonomous nudges. */
export function createDeliveryGate(timeoutMs: number) {
  const wakes = new Set<string>();
  const executions: string[] = [];
  let active = false;
  let deferred = false;
  let maximum = 0;
  let deadline: number | undefined;
  return {
    executions,
    begin(wakeId: string, text: string, controls: DeliveryControls = {}) {
      if (Object.keys(controls).some(key => !['maxExternalDeliveries', 'source'].includes(key))) throw new Error('Unknown delivery controls');
      if (active || wakes.has(wakeId) || wakes.size > maximum || wakes.size > 0 && !deferred) throw new Error('Worker accepts exactly one native trial delivery unless a bounded deferred continuation is declared');
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(wakeId) || !text.trim() || Buffer.byteLength(text) > 16384) throw new Error('Invalid bounded trial delivery');
      if (!wakes.size) {
        maximum = controls.maxExternalDeliveries ?? 0;
        if (!Number.isSafeInteger(maximum) || maximum < 0 || maximum > 3 || controls.source) throw new Error('Invalid external delivery bound');
      } else {
        if (controls.maxExternalDeliveries !== undefined || !controls.source) throw new Error('Continuation requires a source and cannot change its delivery budget');
        verifyExternalSource(controls.source, text);
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
