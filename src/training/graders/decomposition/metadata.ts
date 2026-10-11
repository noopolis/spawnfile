import type { AtomicUnit } from './format.js';
import { normalizeWhitespace } from './spans.js';

export interface DroppedField { id: string; field: string; value: string; reason: string }
export function dropUnboundFields(unit: AtomicUnit): DroppedField[] {
  const dropped: DroppedField[] = [];
  for (const [field, value] of Object.entries(unit.fields ?? {})) {
    if (value === undefined) continue;
    if (!normalizeWhitespace(value) || !normalizeWhitespace(unit.text).includes(normalizeWhitespace(value))) {
      dropped.push({ id: unit.id, field, value, reason: 'field value is not a verbatim unit span' });
      delete unit.fields![field as keyof NonNullable<AtomicUnit['fields']>];
    }
  }
  return dropped;
}
