import path from "node:path";
import { constants } from "node:fs";
import { open } from "node:fs/promises";

import { SpawnfileError } from "../shared/index.js";

import type { CompilePlan } from "./types.js";
import {
  resolveWorldBindings,
  SIMFILE_WORLD_BINDINGS_VERSION,
  type ResolvedWorldBindings
} from "./worldBindings.js";

export const MAX_WORLD_BINDINGS_FILE_BYTES = 1_048_576;

class DuplicateJsonKeyError extends Error {}

const fail = (message: string): never => {
  throw new SpawnfileError(
    "validation_error",
    `invalid ${SIMFILE_WORLD_BINDINGS_VERSION} file: ${message}`
  );
};

const assertNoDuplicateJsonKeys = (source: string): void => {
  let offset = 0;
  const whitespace = (): void => {
    while (/\s/u.test(source[offset] ?? "")) offset += 1;
  };
  const string = (): string => {
    const start = offset;
    offset += 1;
    while (offset < source.length) {
      if (source[offset] === "\\") {
        offset += 2;
      } else if (source[offset] === "\"") {
        offset += 1;
        return JSON.parse(source.slice(start, offset)) as string;
      } else {
        offset += 1;
      }
    }
    return fail("JSON is malformed");
  };
  const value = (): void => {
    whitespace();
    if (source[offset] === "{") {
      object();
      return;
    }
    if (source[offset] === "[") {
      array();
      return;
    }
    if (source[offset] === "\"") {
      string();
      return;
    }
    while (offset < source.length && !/[\s,\]}]/u.test(source[offset] ?? "")) {
      offset += 1;
    }
  };
  const object = (): void => {
    offset += 1;
    whitespace();
    const keys = new Set<string>();
    if (source[offset] === "}") {
      offset += 1;
      return;
    }
    while (offset < source.length) {
      const key = string();
      if (keys.has(key)) throw new DuplicateJsonKeyError();
      keys.add(key);
      whitespace();
      offset += 1;
      value();
      whitespace();
      if (source[offset] === "}") {
        offset += 1;
        return;
      }
      offset += 1;
      whitespace();
    }
  };
  const array = (): void => {
    offset += 1;
    whitespace();
    if (source[offset] === "]") {
      offset += 1;
      return;
    }
    while (offset < source.length) {
      value();
      whitespace();
      if (source[offset] === "]") {
        offset += 1;
        return;
      }
      offset += 1;
      whitespace();
    }
  };

  value();
  whitespace();
  if (offset !== source.length) fail("JSON must contain exactly one value");
};

const decodeJson = (bytes: Uint8Array): unknown => {
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return fail("content must be valid UTF-8");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch {
    return fail("content must be exactly one valid JSON value");
  }
  try {
    assertNoDuplicateJsonKeys(source);
  } catch (error) {
    if (error instanceof DuplicateJsonKeyError) return fail("duplicate JSON keys are not allowed");
    throw error;
  }
  return parsed;
};

export const readSimfileWorldBindingsFile = async (inputPath: string): Promise<unknown> => {
  const filePath = path.resolve(inputPath);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(filePath, constants.O_RDONLY | constants.O_NONBLOCK);
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size <= 0
      || metadata.size > MAX_WORLD_BINDINGS_FILE_BYTES) {
      return fail(`content must be a non-empty regular file no larger than ${MAX_WORLD_BINDINGS_FILE_BYTES} bytes`);
    }
    const buffer = new Uint8Array(MAX_WORLD_BINDINGS_FILE_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, 0);
    const afterRead = await handle.stat();
    if (bytesRead !== metadata.size || afterRead.size !== metadata.size
      || bytesRead > MAX_WORLD_BINDINGS_FILE_BYTES) {
      return fail("content changed while it was being read or exceeds the byte limit");
    }
    return decodeJson(buffer.subarray(0, bytesRead));
  } catch (error) {
    if (error instanceof SpawnfileError) throw error;
    return fail("content could not be read");
  } finally {
    await handle?.close().catch(() => undefined);
  }
};

export const loadWorldBindingsForCompile = async (
  plan: CompilePlan,
  inputPath: string,
  expectedRunId: string | undefined
): Promise<ResolvedWorldBindings> => {
  if (!expectedRunId) return fail("NOOPOLIS_RUN_ID must be set before compile");
  const resolved = resolveWorldBindings(plan, await readSimfileWorldBindingsFile(inputPath));
  if (resolved.artifact.bindings[0]?.run_id !== expectedRunId) {
    return fail("binding run_id does not match the compile NOOPOLIS_RUN_ID");
  }
  return resolved;
};
