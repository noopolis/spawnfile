export type SpawnfileErrorCode =
  | "adapter_error"
  | "compile_error"
  | "invalid_manifest"
  | "io_error"
  | "runtime_error"
  | "validation_error";

export class SpawnfileError extends Error {
  public readonly code: SpawnfileErrorCode;

  public constructor(code: SpawnfileErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "SpawnfileError";
  }
}

export const isSpawnfileError = (value: unknown): value is SpawnfileError =>
  value instanceof SpawnfileError;

// Codes that mean the input itself was bad (usage/input errors → exit 2).
// Everything else is a runtime failure that surfaced after validation (→ exit 1).
const USAGE_ERROR_CODES = new Set<SpawnfileErrorCode>(["validation_error", "invalid_manifest"]);

/**
 * Maps an error to the shared CLI exit-code convention: 2 for usage/input
 * errors, 1 for runtime failures. Used wherever the CLI turns a caught error
 * into a process exit code, so every path agrees (see specs/SPEC.md §9.1).
 */
export const errorExitCode = (error: unknown): 1 | 2 =>
  isSpawnfileError(error) && USAGE_ERROR_CODES.has(error.code) ? 2 : 1;
