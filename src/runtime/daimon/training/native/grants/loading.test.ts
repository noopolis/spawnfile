import { expect, test, vi } from 'vitest';
import { loadDaimonGrokGrantAuthority } from './authority.js';
import { scriptedBrokerSocket } from './test-socket.js';

test('loads the optional container runtime only on demand and fails closed when it is absent', async () => {
  const broker = await scriptedBrokerSocket(() => undefined);
  vi.doMock('@noopolis/daimon/runtime', () => { throw new Error('Runtime is absent in the host install'); });
  try {
    await expect(loadDaimonGrokGrantAuthority(broker.socketPath)).rejects.toThrow('Install optional @noopolis/daimon');
  } finally {
    vi.doUnmock('@noopolis/daimon/runtime');
    await broker.close();
  }
});
