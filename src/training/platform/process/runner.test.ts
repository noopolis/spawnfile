import { describe, expect, it, vi } from 'vitest';
import { runProcess, type ProcessOptions } from './index.js';

function options(code: string, patch: Partial<ProcessOptions> = {}): ProcessOptions {
  return { command: process.execPath, args: ['-e', code], cwd: process.cwd(), env: {}, stdin: '',
    timeoutMs: 3_000, onLine: () => undefined, ...patch };
}

describe('bounded process protocol', () => {
  it('delivers async lines in order, including the final unterminated line', async () => {
    const lines: string[] = [];
    const result = await runProcess(options('process.stdout.write("one\\n\\ntwo");process.stderr.write("diagnostic")', {
      onLine: async (line) => { await new Promise((resolve) => setTimeout(resolve, 5)); lines.push(line); },
    })).completion;
    expect(lines).toEqual(['one', 'two']);
    expect(result).toMatchObject({ exitCode: 0, stderr: 'diagnostic', cancelled: false });
  });

  it('rejects invalid bounds before launch and reports failed executable launch', async () => {
    expect(() => runProcess(options('', { timeoutMs: 0 }))).toThrow('positive');
    const missing = runProcess(options('', { command: '/missing-paideia-executable' }));
    const result = await missing.completion;
    expect(result.error).toContain('ENOENT');
    expect((await missing.stop('cleanup')).quiescence).toBe('confirmed');
  });

  it('kills a live process after an observation sink throws', async () => {
    const result = await runProcess(options('console.log("event");setInterval(()=>{},10)', {
      onLine: () => { throw new Error('capture disk failed'); },
    })).completion;
    expect(result.error).toBe('capture disk failed');
    expect(result.cancelled).toBe(true);
    expect(result.stop).toMatchObject({ state: 'acknowledged', quiescence: 'confirmed' });
  });

  it('enforces an output byte limit and a process deadline', async () => {
    const large = await runProcess(options('console.log("too big");setInterval(()=>{},10)', { maxBytes: 2 })).completion;
    expect(large.error).toContain('byte limit');
    const timeout = await runProcess(options('setInterval(()=>{},10)', { timeoutMs: 40 })).completion;
    expect(timeout.error).toContain('timed out');
    expect(timeout.cancelled).toBe(true);
  });

  it('handles an already-aborted signal and returns the same bounded stop request', async () => {
    const controller = new AbortController();
    controller.abort();
    const process = runProcess(options('setInterval(()=>{},10)', { signal: controller.signal }));
    const first = process.stop('operator');
    const second = process.stop('operator');
    expect(first).toBe(second);
    expect((await process.completion).cancelled).toBe(true);
  });

  it('escalates to kill when a process ignores termination', async () => {
    let ready!: () => void;
    const readiness = new Promise<void>((resolve) => { ready = resolve; });
    const process = runProcess(options('process.on("SIGTERM",()=>{});console.log("ready");setInterval(()=>{},10)', {
      onLine: () => ready(),
    }));
    await readiness;
    const receipt = await process.stop('test');
    expect(receipt).toMatchObject({ state: 'acknowledged', scope: 'process-group', remoteWork: 'unknown' });
    expect((await process.completion).cancelled).toBe(true);
  });

  it('does not report quiescence when process inspection cannot establish it', async () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    try {
      const native = runProcess(options(''));
      const receipt = await native.stop('uncertain observation');
      expect(receipt).toMatchObject({ state: 'unknown', quiescence: 'unknown' });
      expect((await native.completion).stop?.state).toBe('unknown');
    } finally { kill.mockRestore(); }
  });

  it('retains signaling permission errors and distinguishes them from an exited group', async () => {
    const original = process.kill.bind(process);
    let denied = false;
    const kill = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (signal === 'SIGTERM' && !denied) { denied = true; throw Object.assign(new Error('denied'), { code: 'EPERM' }); }
      return original(pid, signal);
    });
    try {
      const native = runProcess(options(''));
      await native.stop('operator');
      expect((await native.completion).error).toBe('Unable to signal owned process');
    } finally { kill.mockRestore(); }
  });

  it('reports process-only scope on platforms without owned process groups', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    let native: ReturnType<typeof runProcess>;
    try { native = runProcess(options('')); }
    finally { Object.defineProperty(process, 'platform', descriptor); }
    const receipt = await native.stop('operator');
    expect(receipt.scope).toBe('process');
    await native.completion;
  });

  it('supports a duplex protocol and rejects writes after input is closed', async () => {
    const received: string[] = [];
    const native = runProcess(options('process.stdin.on("data", chunk=>process.stdout.write(chunk))', {
      keepStdinOpen: true, onLine: (line) => { received.push(line); },
    }));
    await native.write('reply\n');
    native.endInput();
    await native.completion;
    expect(received).toEqual(['reply']);
    await expect(native.write('too late')).rejects.toThrow('closed');
  });

  it('can require terminated JSONL frames without changing native vendor defaults', async () => {
    const result = await runProcess(options('process.stdout.write("partial")', { requireLineTerminator: true })).completion;
    expect(result.error).toContain('line terminator');
  });

  it('never signals a retained numeric process identity after its leader was reaped', async () => {
    const native = runProcess(options(''));
    await native.completion;
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    try {
      const receipt = await native.stop('delayed cleanup');
      expect(receipt.quiescence).toBe('unknown');
      expect(kill.mock.calls.every((call) => call[1] === 0)).toBe(true);
    } finally { kill.mockRestore(); }
  });

  it('also avoids post-reap signals while escaped descendants still hold output pipes open', async () => {
    let ready!: () => void;
    const started = new Promise<void>((resolve) => { ready = resolve; });
    const native = runProcess(options('const {spawn}=require("node:child_process");spawn(process.execPath,["-e","setTimeout(()=>{},500)"],{detached:true,stdio:["ignore",1,2]});console.log("ready");process.exit(0)', {
      onLine: () => ready(),
    }));
    await started;
    await new Promise((resolve) => setTimeout(resolve, 80));
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    try {
      expect((await native.stop('cleanup during output drain')).quiescence).toBe('unknown');
      expect(kill.mock.calls.every((call) => call[1] === 0)).toBe(true);
    } finally { kill.mockRestore(); }
    await native.completion;
  });

  it('bounds callbacks ignoring abort when a native process times out or closes', async () => {
    const signals: AbortSignal[] = [];
    for (const code of ['console.log("pending");setInterval(()=>{},10)', 'console.log("pending")']) {
      const native = runProcess(options(code, { timeoutMs: 150, closureDrainMs: 30,
        onLine: (_line, signal) => { signals.push(signal); return new Promise(() => undefined); },
      }));
      const result = await native.completion;
      expect(result.error).toMatch(/did not settle|timed out/u);
    }
    expect(signals).toHaveLength(2);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });
});
