import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** Test-only broker control socket speaking Daimon's length-prefixed JSON frames with scripted answers. */
export async function scriptedBrokerSocket(answer: (request: Record<string, unknown>) => Record<string, unknown> | undefined) {
  const dir = await mkdtemp(path.join(tmpdir(), 'paideia-broker-'));
  const socketPath = path.join(dir, 'control.sock');
  const received: Record<string, unknown>[] = [];
  const server: Server = createServer(connection => {
    let buffered = Buffer.alloc(0);
    connection.on('data', chunk => {
      buffered = Buffer.concat([buffered, chunk]);
      while (buffered.length >= 4 && buffered.length >= buffered.readUInt32BE(0) + 4) {
        const length = buffered.readUInt32BE(0);
        const request = JSON.parse(buffered.subarray(4, 4 + length).toString('utf8')) as Record<string, unknown>;
        buffered = buffered.subarray(4 + length);
        received.push(request);
        const response = answer(request);
        if (response === undefined) { connection.destroy(); return; }
        const body = Buffer.from(JSON.stringify({ version: request['version'], requestId: request['requestId'], ...response }));
        const frame = Buffer.alloc(4 + body.length); frame.writeUInt32BE(body.length); body.copy(frame, 4);
        connection.write(frame);
      }
    });
  });
  await new Promise<void>(resolve => server.listen(socketPath, resolve));
  return { socketPath, received, close: async () => { await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }); } };
}
