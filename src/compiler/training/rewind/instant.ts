import { trainingInstantSchema } from "../../../manifest/index.js";

/** RFC3339Nano ordering, including offsets and fractions Date.parse would truncate. */
export const instantNanos = (value: string): bigint => {
  trainingInstantSchema.parse(value);
  const match = /^(.*T\d{2}:\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:\d{2})$/u.exec(value);
  if (!match) throw new Error(`Unsupported instant ${value}: at most nanosecond precision is required`);
  const seconds = Date.parse(`${match[1]}:${match[2] ?? "00"}${match[4]}`);
  if (!Number.isFinite(seconds)) throw new Error(`Invalid instant ${value}`);
  return BigInt(seconds) * 1_000_000n + BigInt((match[3] ?? "").padEnd(9, "0"));
};
export const compareInstants = (left: string, right: string): number => {
  const a = instantNanos(left), b = instantNanos(right);
  return a < b ? -1 : a > b ? 1 : 0;
};
export const normalizeInstant = (value: string): string => {
  const ns = instantNanos(value), seconds = ns / 1_000_000_000n;
  const fraction = (ns % 1_000_000_000n + 1_000_000_000n) % 1_000_000_000n;
  const floorSeconds = ns < 0n && fraction !== 0n ? seconds - 1n : seconds;
  const base = new Date(Number(floorSeconds * 1000n)).toISOString().replace(/\.000Z$/u, "");
  const tail = fraction.toString().padStart(9, "0").replace(/0+$/u, "");
  return `${base}${tail ? `.${tail}` : ""}Z`;
};
