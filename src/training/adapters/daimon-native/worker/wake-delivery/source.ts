import type { TransportDeliverySource } from './types.js';

export function parseTransportSource(value: unknown): TransportDeliverySource {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Transport delivery requires an expected source');
  const row = value as Record<string, unknown>;
  const keys = Object.keys(row).sort().join(',');
  const id = row.deliveryId ?? row.deliveryIdPrefix;
  if (row.kind !== 'transport' || !['deliveryId,kind', 'deliveryIdPrefix,kind'].includes(keys) ||
      typeof id !== 'string' || !id.trim() || Buffer.byteLength(id) > 16_384 || [...id].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) {
    throw new Error('Invalid expected transport delivery source');
  }
  return 'deliveryId' in row ? { kind: 'transport', deliveryId: id } : { kind: 'transport', deliveryIdPrefix: id };
}

export function matchTransportSource(source: TransportDeliverySource, deliveryId: string): boolean {
  return source.deliveryId !== undefined ? deliveryId === source.deliveryId : deliveryId.startsWith(source.deliveryIdPrefix);
}
