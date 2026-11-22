import type { z } from "zod";

export interface RecordingJsonlRead<T> { entries: T[]; errors: string[] }
export interface RecordingJsonlParser<T> {
  write: (chunk: string) => void;
  finish: () => RecordingJsonlRead<T>;
}

export const createRecordingJsonlParser = <T>(label: string, schema: z.ZodType<T>, maxBytes?: number): RecordingJsonlParser<T> => {
  const entries: T[] = [], errors: string[] = [];
  let pending = "", lineNumber = 0, oversized = false;
  const parseLine = (line: string): void => {
    lineNumber += 1;
    try {
      if (oversized || (maxBytes !== undefined && Buffer.byteLength(line, "utf8") + 1 > maxBytes)) throw new Error("row size limit");
      entries.push(schema.parse(JSON.parse(line)));
    } catch {
      errors.push(`${label} line ${lineNumber}: invalid JSON or entry`);
    }
    oversized = false;
  };
  return {
    write(chunk) {
      const lines = chunk.split("\n");
      for (let index = 0; index < lines.length; index += 1) {
        if (!oversized) pending += lines[index]!;
        if (maxBytes !== undefined && Buffer.byteLength(pending, "utf8") + 1 > maxBytes) {
          oversized = true; pending = "";
        }
        if (index < lines.length - 1) { parseLine(pending); pending = ""; }
      }
    },
    finish() {
      if (pending || oversized) { parseLine(pending); pending = ""; }
      return { entries, errors };
    }
  };
};
