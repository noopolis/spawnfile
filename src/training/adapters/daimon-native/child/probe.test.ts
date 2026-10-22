import { expect, it, vi } from 'vitest';
import { runInNewContext } from 'node:vm';
import { nativeChildProbe } from './probe.js';

it.each(['denied', 'readable', 'wrong-input', 'network', 'timeout', 'late-error'])('requires actual filesystem and network evidence: %s', mode => {
  const handlers = new Map<string, () => void>(); const write = vi.fn(); const process = { exitCode: 0 };
  const socket = { once: (name: string, callback: () => void) => handlers.set(name, callback),
    setTimeout: (_ms: number, callback: () => void) => handlers.set('timeout', callback), destroy: vi.fn() };
  const fs = { readFileSync: () => mode === 'wrong-input' ? 'wrong' : 'NATIVE_READ',
    openSync: () => { if (mode !== 'readable') throw new Error('Denied'); return 3; }, closeSync: vi.fn(), writeFileSync: write };
  const execute = () => runInNewContext(nativeChildProbe('/input', '/complete', ['/protected'], 1234), {
    require: (name: string) => name === 'node:fs' ? fs : { connect: () => socket }, process,
  });
  if (mode === 'readable' || mode === 'wrong-input') { expect(execute).toThrow(); expect(write).not.toHaveBeenCalled(); return; }
  execute(); handlers.get(mode === 'denied' ? 'error' : mode === 'timeout' ? 'timeout' : 'connect')!();
  if (mode === 'late-error') handlers.get('error')!();
  if (mode === 'denied') expect(write).toHaveBeenCalledWith('/complete', 'NATIVE_POLICY_COMPLETE');
  else { expect(write).not.toHaveBeenCalled(); expect(process.exitCode).toBe(1); }
});
