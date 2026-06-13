import { SpawnfileError } from "../shared/index.js";

const BLOCK_SIZE = 512;

export interface ExtractSingleFileOptions {
  maxBytes: number;
}

const parseOctal = (buffer: Buffer, offset: number, length: number): number => {
  const raw = buffer
    .subarray(offset, offset + length)
    .toString("ascii")
    .replace(/\0.*$/, "")
    .trim();
  if (raw === "") {
    return 0;
  }
  const parsed = Number.parseInt(raw, 8);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new SpawnfileError("validation_error", "Malformed tar header: invalid numeric field");
  }
  return parsed;
};

const isZeroBlock = (block: Buffer): boolean => block.every((byte) => byte === 0);

/**
 * Extracts exactly one regular file from a (single-file) tar stream such as the
 * output of `docker cp <container>:<file> -`. Rejects symlinks, hardlinks,
 * directories, path traversal, and oversized payloads, because the stream is
 * untrusted input pulled from a registry.
 */
export const extractSingleFileFromTar = (
  tar: Buffer,
  options: ExtractSingleFileOptions
): Buffer => {
  let offset = 0;
  let result: Buffer | null = null;

  while (offset + BLOCK_SIZE <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK_SIZE);
    if (isZeroBlock(header)) {
      break;
    }
    offset += BLOCK_SIZE;

    const name = header.subarray(0, 100).toString("ascii").replace(/\0.*$/, "");
    const size = parseOctal(header, 124, 12);
    const typeFlag = String.fromCharCode(header[156] ?? 0);

    if (typeFlag === "5") {
      throw new SpawnfileError("validation_error", `Refusing tar directory entry: ${name}`);
    }
    if (typeFlag === "2" || typeFlag === "1") {
      throw new SpawnfileError("validation_error", `Refusing tar link entry: ${name}`);
    }
    if (typeFlag !== "0" && typeFlag !== "\0") {
      // Skip metadata entries (pax headers, global headers) without treating
      // them as the payload.
      offset += Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE;
      continue;
    }
    if (name.includes("..")) {
      throw new SpawnfileError("validation_error", `Refusing tar entry with traversal: ${name}`);
    }
    if (size > options.maxBytes) {
      throw new SpawnfileError(
        "validation_error",
        `Embedded report exceeds the ${options.maxBytes}-byte size cap`
      );
    }
    if (result) {
      throw new SpawnfileError(
        "validation_error",
        "Expected a single-file tar stream but found multiple file entries"
      );
    }

    const contentEnd = offset + size;
    if (contentEnd > tar.length) {
      throw new SpawnfileError("validation_error", "Truncated tar stream");
    }
    result = Buffer.from(tar.subarray(offset, contentEnd));
    offset += Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE;
  }

  if (!result) {
    throw new SpawnfileError("validation_error", "No file entry found in tar stream");
  }

  return result;
};
