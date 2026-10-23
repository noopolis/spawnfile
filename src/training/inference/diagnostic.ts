import { createHash } from 'node:crypto';
import { inferenceDiagnosticCodes, type InferenceDiagnostic } from '../contracts/execution.js';

/** Call only after a provider has verified its whole completion and isolation envelope. */
export function captureInferenceDiagnostic(code: InferenceDiagnostic['code'], text?: string): InferenceDiagnostic {
  if (!inferenceDiagnosticCodes.includes(code) || (text !== undefined && (code !== 'response-schema' || typeof text !== 'string'))) {
    throw new Error('Invalid protected inference diagnostic');
  }
  if (text === undefined) return Object.freeze({ code });
  const bytes = Buffer.byteLength(text), omitted = bytes > 65_536;
  return Object.freeze({ code, response: Object.freeze({ bytes, sha256: `sha256:${createHash('sha256').update(text).digest('hex')}`,
    omitted, ...(omitted ? {} : { text }) }) });
}
