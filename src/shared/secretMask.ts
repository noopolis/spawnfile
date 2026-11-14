import { Transform } from "node:stream";

/**
 * Credential shapes masked wherever they appear in captured evidence. Each
 * pattern's first group, when present, is kept (a scheme word); the rest of the
 * match is the credential.
 */
const TOKEN_SHAPES: readonly RegExp[] = [
  /\b(Bearer[ \t]+)[A-Za-z0-9._~+/=-]{12,}/giu,
  /\b(?:sk|sk-proj|sk-ant|xai|gsk)-[A-Za-z0-9_-]{20,}/gu,
  /\bmagt_v1_[A-Za-z0-9_-]{16,}/gu,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]{8,})?/gu,
  /\bya29\.[A-Za-z0-9._-]{20,}/gu,
  /\b1\/\/[A-Za-z0-9_-]{30,}/gu,
  /\bAIza[A-Za-z0-9_-]{35}/gu,
  /\brt_[A-Za-z0-9._-]{20,}/gu,
  /\b(?:ghp|gho|ghs|ghu|github_pat)_[A-Za-z0-9_]{20,}/gu
];

const MASK = "*";
/** A secret shorter than this is too likely to be ordinary text to mask by value. */
const MIN_SECRET_LENGTH = 8;

/**
 * Masks every known secret value and every credential shape with `*`, byte for
 * byte: the result has the length of the input, so the same mask is safe on a
 * log and on an archive whose headers record its members' sizes.
 */
export const maskSecrets = (text: string, secrets: readonly string[] = []): string => {
  let masked = text;
  for (const secret of [...new Set(secrets)].filter((value) => value.length >= MIN_SECRET_LENGTH).sort((left, right) => right.length - left.length)) {
    masked = masked.replaceAll(secret, MASK.repeat(secret.length));
  }
  for (const shape of TOKEN_SHAPES) {
    masked = masked.replace(shape, (match: string, kept?: unknown) => {
      const prefix = typeof kept === "string" ? kept : "";
      return `${prefix}${MASK.repeat(match.length - prefix.length)}`;
    });
  }
  return masked;
};

/** The longest stretch held back waiting for a line end; no credential is longer. */
export const SECRET_MASK_WINDOW_BYTES = 64 * 1024;
const SEPARATOR = /[^A-Za-z0-9._~+/=\- \t]/gu;

/**
 * {@link maskSecrets} over a byte stream of any size, in constant memory. Bytes
 * pass through one to one (never decoded as text), masked a whole line at a
 * time so no credential is ever split across two writes. A stretch with no line
 * end inside the window (binary content) is cut after its last byte that cannot
 * be part of a credential.
 */
export const createSecretMaskStream = (secrets: readonly string[] = []): Transform => {
  let held = "";
  const emit = (stream: Transform, text: string): void => { if (text) stream.push(Buffer.from(maskSecrets(text, secrets), "latin1")); };
  return new Transform({
    transform(chunk: Buffer, _encoding, done) {
      held += chunk.toString("latin1");
      let cut = held.lastIndexOf("\n") + 1;
      if (cut === 0 && held.length > SECRET_MASK_WINDOW_BYTES) {
        let last = -1;
        for (const match of held.matchAll(SEPARATOR)) last = match.index;
        cut = last < 0 ? held.length : last + 1;
      }
      emit(this, held.slice(0, cut));
      held = held.slice(cut);
      done();
    },
    flush(done) {
      emit(this, held);
      held = "";
      done();
    }
  });
};
