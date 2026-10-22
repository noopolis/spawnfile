import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fixtures from './seal-fixtures.json' with { type: 'json' };
import { readSealedGrokTurnSeals } from './index.js';
import { parseNativeTurnSeal } from './seal.js';

const packageName = '@noopolis/daimon/runtime';
let runtime: string | undefined;
try { runtime = import.meta.resolve(packageName); }
catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ERR_MODULE_NOT_FOUND') throw error; }

// This task requires Daimon's actual serializer, which its public index does not export.
// Test-only inspection of the installed bundle; no product import or fallback serializer.
async function installedModule(filename: string): Promise<Record<string, unknown>> {
  // eslint-disable-next-line structure/module-boundaries -- Optional-peer serializer parity needs a URL relative to its resolved public entry point.
  return await import(new URL(filename, runtime).href) as Record<string, unknown>;
}
const writer = runtime ? await installedModule('engineBrokerSealLedger.js') : undefined;
const protocol = runtime ? await installedModule('engineBrokerProtocol.js') : undefined;
const mcp = runtime ? await installedModule('engineBrokerMcpCallLog.js') : undefined;
const limits = runtime ? await installedModule('engineBrokerTurnAccounting.js') : undefined;
if (runtime && (typeof writer?.renderBrokerTurnSealLine !== 'function' || typeof protocol?.parseEngineBrokerResponse !== 'function' ||
    typeof limits?.lowerEngineBrokerTurnLimits !== 'function')) throw new Error('Installed Daimon lacks the required seal contract');
const render = writer?.renderBrokerTurnSealLine as (terminal: unknown, entry: unknown) => string;
const parse = protocol?.parseEngineBrokerResponse as (terminal: unknown) => unknown;

describe.skipIf(!runtime)('Daimon seal writer parity (skipped only when @noopolis/daimon/runtime is absent)', () => {
  it.each(fixtures)('reads real serialized rows: $name', async fixture => {
    const root = await mkdtemp(join(tmpdir(), 'daimon-seal-parity-'));
    try {
      const line = render(parse(fixture.terminal), fixture.entry);
      expect(line.endsWith('\n')).toBe(true);
      expect(JSON.parse(line)).toEqual(fixture.seal);
      expect(Buffer.byteLength(line)).toBeLessThanOrEqual(Number(writer!.TURN_SEAL_MAX_LINE_BYTES));
      await writeFile(join(root, 'turns.jsonl'), line);
      expect(await readSealedGrokTurnSeals(join(root, 'turns.jsonl'), fixture.entry.agent, fixture.seal.model)).toEqual([fixture.seal]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('pins every refusal reason and both collection bounds to the installed writer', () => {
    expect(mcp!.ENGINE_BROKER_MCP_REFUSAL_REASONS).toEqual(Object.keys(fixtures[0]!.seal.mcp!.refusals));
    expect(mcp!.ENGINE_BROKER_MCP_OUTSTANDING_MAX).toBe(16);
    expect(mcp!.ENGINE_BROKER_MCP_TUNNEL_MAX).toBe(8);
    expect(writer!.TURN_SEAL_MAX_LINE_BYTES).toBe(8192);
  });

  it('distinguishes the protocol cleanup diagnostic from fields actually written to the seal', () => {
    const fixture = fixtures[0]!;
    const terminal = parse(fixture.terminal) as Record<string, unknown>;
    expect(terminal.cleanupDiagnostic).toBe('task clock reset failed; slot fenced until restart');
    const row = JSON.parse(render(terminal, fixture.entry)) as Record<string, unknown>;
    expect(row).not.toHaveProperty('cleanupDiagnostic');
    expect(row).not.toHaveProperty('cleanup_diagnostic');
    expect(parseNativeTurnSeal(row, fixture.entry.agent, fixture.seal.model)).not.toHaveProperty('cleanupDiagnostic');
  });

  it('accepts lowered overrides and proves the original trial-wide override is refused by the real broker', () => {
    const lower = limits!.lowerEngineBrokerTurnLimits as (declared: unknown, overrides: unknown) => unknown;
    const declared = { maxRequests: 24, maxTokens: 400000, timeoutMs: 1800000 };
    expect(() => lower(declared, { timeoutMs: 3600000 })).toThrow('may only be lowered');
    expect(() => lower(declared, { maxTokens: 1000000 })).toThrow('may only be lowered');
    expect(lower(declared, { timeoutMs: 1800000, maxTokens: 400000 })).toEqual(declared);
    expect(lower(declared, { timeoutMs: 1000, maxTokens: 100 })).toEqual({ ...declared, timeoutMs: 1000, maxTokens: 100 });
  });
});
