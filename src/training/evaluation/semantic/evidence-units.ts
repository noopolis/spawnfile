import { createHash } from 'node:crypto';

export interface EvidenceUnit {
  id: string;
  source: string;
  pointer: string;
  chunk: number;
  digest: string;
  value: string | number | boolean | null | unknown[] | Record<string, never>;
}
export interface EvidencePacket { schema: 'paideia.evidence-units.v1'; units: EvidenceUnit[] }
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

/** Lossless, deterministic primitive leaves. IDs attest pointers, never factual support. */
export function evidenceUnits(sources: Readonly<Record<string, unknown>>): EvidencePacket {
  const units: EvidenceUnit[] = [], ids = new Set<string>(), ancestors = new Set<object>();
  let bytes = 64; // Packet envelope and array delimiters are included conservatively.
  const add = (source: string, pointer: string, chunk: number, value: EvidenceUnit['value']) => {
    const encoded = JSON.stringify(value);
    const id = `e-${hash(JSON.stringify([source, pointer, chunk, value])).slice(0, 20)}`;
    if (ids.has(id)) throw new Error('Evidence unit identity collision');
    const unit = { id, source, pointer, chunk, digest: `sha256:${hash(encoded)}`, value };
    bytes += Buffer.byteLength(JSON.stringify(unit)) + 1;
    if (units.length >= 256 || bytes > 128 * 1024) throw new Error('Evidence units exceed bounded packet; select narrower evidence');
    ids.add(id); units.push(unit);
  };
  const walk = (value: unknown, source: string, pointer: string, depth: number) => {
    if (depth > 64) throw new Error('Evidence nesting exceeds bound');
    if (typeof value === 'string') {
      let text = '', size = 0, chunk = 0;
      for (const character of value) {
        text += character;
        if (++size === 2048) { add(source, pointer, chunk++, text); text = ''; size = 0; }
      }
      if (size || !chunk) add(source, pointer, chunk, text);
    } else if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) add(source, pointer, 0, value);
    else if (typeof value === 'object') {
      if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new Error('Evidence must contain plain JSON objects');
      if (ancestors.has(value)) throw new Error('Cyclic evidence is unsupported');
      ancestors.add(value);
      const entries = Array.isArray(value) ? Array.from(value.entries()).map(([key, child]) => [String(key), child] as const)
        : Object.keys(value).sort().map(key => [key, (value as Record<string, unknown>)[key]] as const);
      if (!entries.length) add(source, pointer, 0, Array.isArray(value) ? [] : {});
      for (const [key, child] of entries) walk(child, source, `${pointer}/${key.replace(/~/gu, '~0').replace(/\//gu, '~1')}`, depth + 1);
      ancestors.delete(value);
    } else throw new Error('Evidence must contain finite JSON values');
  };
  for (const source of Object.keys(sources).sort()) walk(sources[source], source, '', 0);
  return { schema: 'paideia.evidence-units.v1', units };
}
