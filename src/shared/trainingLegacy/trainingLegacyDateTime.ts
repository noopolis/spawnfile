import { z } from 'zod';

/** Preserve historical minute, second and fractional-second ISO timestamps. */
export const compatibleIsoDateTimeSchema = (options: { offset?: boolean } = {}) => z.union([
  z.iso.datetime(options),
  z.iso.datetime({ ...options, precision: -1 }),
]);
