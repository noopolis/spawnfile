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
