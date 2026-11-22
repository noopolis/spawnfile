import { isSpawnfileError } from "../shared/index.js";

export const isCommanderError = (error: unknown): error is { code: string; exitCode: number } => {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const candidate = error as { code?: unknown; exitCode?: unknown };
  return typeof candidate.code === "string"
    && candidate.code.startsWith("commander.")
    && typeof candidate.exitCode === "number";
};

export const formatCliErrorMessage = (error: unknown): string => {
  if (isSpawnfileError(error)) {
    // Surface the human message only; the internal code is not user-facing.
    return error.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
};
