import { StringDecoder } from "node:string_decoder";
import { z } from "zod";

import type { UsageLedgerExec } from "../runtime/usageLedgerRead.js";
import type { RecordingJsonlParser, RecordingJsonlRead } from "./parse.js";

// Daimon's generated organization image uses its Node standalone base (runtime metadata),
// and runs the Node daimon-runtime launcher. No optional container executable is required.
const readChunkScript = `
const fs = require('node:fs');
try {
  const fd = fs.openSync(process.argv[1], 'r');
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw {code:'NOT_REGULAR_FILE'};
    const bytes = Buffer.alloc(Number(process.argv[3]));
    const count = fs.readSync(fd, bytes, 0, bytes.length, Number(process.argv[2]));
    process.stdout.write(JSON.stringify({size:stat.size, identity:stat.dev+':'+stat.ino, data:bytes.subarray(0,count).toString('base64')}));
  } finally { fs.closeSync(fd); }
} catch (error) {
  if (error.code === 'ENOENT') process.stdout.write('null');
  else { process.stderr.write(String(error.code || 'READ_FAILED')); process.exitCode = 1; }
}`;
const chunkSchema = z.object({
  size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), identity: z.string().min(1),
  data: z.string().regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u)
}).strict().nullable();

/** Each exec response is bounded (base64 adds 1/3); decode UTF-8 across byte boundaries.
 * Pin the initial length/inode so appends cannot make sync chase a growing ledger forever. */
export const readRecordingJsonl = async <T>(
  exec: UsageLedgerExec, file: string, parser: RecordingJsonlParser<T>, chunkBytes = 256 * 1024
): Promise<RecordingJsonlRead<T> & { failure?: string }> => {
  const decoder = new StringDecoder("utf8");
  let offset = 0, length: number | undefined, identity: string | undefined;
  try {
    if (!Number.isSafeInteger(chunkBytes) || chunkBytes <= 0 || chunkBytes > 256 * 1024) throw new Error("Invalid recording chunk size");
    do {
      const count = Math.min(chunkBytes, length === undefined ? chunkBytes : length - offset);
      const { stdout } = await exec(["node", "-e", readChunkScript, file, String(offset), String(count)]);
      const chunk = chunkSchema.parse(JSON.parse(stdout));
      if (chunk === null) {
        if (length !== undefined) throw new Error("Runtime file disappeared during read");
        return parser.finish();
      }
      length ??= chunk.size; identity ??= chunk.identity;
      if (identity !== chunk.identity || chunk.size < length) throw new Error("Runtime file replaced or truncated during read");
      const bytes = Buffer.from(chunk.data, "base64");
      if (bytes.length > count || bytes.length < Math.min(count, length - offset)) throw new Error("Incomplete runtime file chunk");
      const bounded = bytes.subarray(0, length - offset);
      parser.write(decoder.write(bounded));
      offset += bounded.length;
    } while (offset < length);
    parser.write(decoder.end());
    return parser.finish();
  } catch (error) {
    // The remote script emits codes only. Do not expose raw exec messages or partial stdout.
    const reason = error instanceof Error && /^(?:Invalid recording|Runtime file|Incomplete runtime)/u.test(error.message)
      ? error.message : "Runtime file exec or chunk decoding failed";
    return { entries: [], errors: [], failure: reason };
  }
};
