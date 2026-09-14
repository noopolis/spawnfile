import { lstat, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const limit = 65_536;

/** Protected process output, never a public observation or a model/judge input. */
export async function childDiagnostics(root: string, trialId: string, configSha256: string) {
  const directory = await lstat(root);
  if (!directory.isDirectory() || directory.isSymbolicLink() || await realpath(root) !== root || (directory.mode & 0o777) !== 0o700) {
    throw new Error('Native diagnostics require the protected canonical control directory');
  }
  const file = join(root, 'child-diagnostics.json');
  const streams = { stdout: { bytes: Buffer.alloc(0), truncated: false }, stderr: { bytes: Buffer.alloc(0), truncated: false } };
  let saved: Promise<void> | undefined;
  return {
    file,
    append(chunk: Buffer, stdout: boolean): void {
      if (saved) return;
      const stream = stdout ? streams.stdout : streams.stderr;
      const remaining = limit - stream.bytes.length;
      stream.truncated ||= chunk.length > remaining;
      if (remaining > 0) stream.bytes = Buffer.concat([stream.bytes, chunk.subarray(0, remaining)]);
    },
    save(exitCode: number | null, exitSignal: NodeJS.Signals | null): Promise<void> {
      return saved ??= writeFile(file, JSON.stringify({ schema: 'paideia.daimon-native.child-diagnostics.v1', trialId, configSha256,
        exitCode, exitSignal, limitBytesPerStream: limit,
        stdout: streams.stdout.bytes.toString('utf8'), stderr: streams.stderr.bytes.toString('utf8'),
        truncated: { stdout: streams.stdout.truncated, stderr: streams.stderr.truncated },
      }) + '\n', { flag: 'wx', mode: 0o600 });
    },
  };
}
