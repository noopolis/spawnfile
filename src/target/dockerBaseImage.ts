import { parseImageReference } from "../distribution/index.js";

const CONFIG_DIGEST = /^sha256:[a-f0-9]{64}$/u;
const MAX_REFERENCE_BYTES = 512;

/** Strict portable image-reference grammar shared by target resolution and local helper setup. */
export const parseDockerBaseImageReference = (raw: unknown): string | null => {
  if (typeof raw !== "string" || raw !== raw.trim() || raw.includes("\0")
    || Buffer.byteLength(raw, "utf8") > MAX_REFERENCE_BYTES || CONFIG_DIGEST.test(raw)
    || parseImageReference(raw) === null) return null;
  return raw;
};
