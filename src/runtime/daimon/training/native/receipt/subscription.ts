import type { NativeLaunch } from './schema.js';

/** The caller supplies one persistent account directory, never a per-trial auth copy. */
export function nativeCodexAccount(launch: NativeLaunch) {
  if (launch.agent.engine !== 'codex') return undefined;
  const rows = launch.projections.filter(row => row.role === 'subscription');
  if (rows.length !== 1) throw new Error('Codex requires exactly one shared subscription realm projection');
  if (launch.credentials.length !== 1) {
    throw new Error('Codex requires one shared subscription bootstrap ingress');
  }
  return { realm: rows[0]!, bootstrap: launch.credentials[0]! };
}
