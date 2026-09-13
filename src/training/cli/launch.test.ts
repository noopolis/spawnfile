import { afterEach, describe, expect, it, vi } from 'vitest';
import * as commands from './commands.js';
import { launch } from './launch.js';

const previousExit = process.exitCode;
afterEach(() => { vi.restoreAllMocks(); process.exitCode = previousExit; });

describe('native CLI launch lifecycle', () => {
  it('maps argv, stdout/stderr and signals to main, then removes owned signal listeners', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const before = process.listenerCount('SIGINT');
    vi.spyOn(commands, 'main').mockImplementation(async (argv, io) => {
      expect(argv).toEqual(['--help']); expect(io.cwd).toBe(process.cwd());
      io.stdout('out'); io.stderr('err'); process.emit('SIGINT'); expect(io.signal!.aborted).toBe(true);
      return 130;
    });
    await launch(['--help']);
    expect(stdout).toHaveBeenCalledWith('out'); expect(stderr).toHaveBeenCalledWith('err');
    expect(process.exitCode).toBe(130); expect(process.listenerCount('SIGINT')).toBe(before);
  });
  it('uses process arguments by default and cleans up even if the IO facade throws', async () => {
    const before = process.listenerCount('SIGTERM');
    const run = vi.spyOn(commands, 'main').mockRejectedValue(new Error('unexpected host IO failure'));
    await expect(launch()).rejects.toThrow('unexpected host IO failure');
    expect(run.mock.calls[0]![0]).toEqual(process.argv.slice(2));
    expect(process.listenerCount('SIGTERM')).toBe(before);
  });
});
