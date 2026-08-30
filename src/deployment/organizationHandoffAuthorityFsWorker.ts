import { constants } from "node:fs";
import { link, lstat, open, unlink } from "node:fs/promises";

const VERSION = "spawnfile.organization-handoff-fs-worker.v1";
const MAX_BYTES = 32_768;
const PUBLICATION_READ_ATTEMPTS = 64;
const PUBLICATION_SETTLE_ATTEMPTS = 64;
// Store keys encode either a 64-character pending key or a 71-character
// `opaque_` handoff handle. No other leaf namespace is reachable.
const NAME = /^(?:[a-f0-9]{128}|[a-f0-9]{142})\.json$/u;
const owner = typeof process.getuid === "function" ? process.getuid() : undefined;
type Request = { readonly version: typeof VERSION; readonly id: number; readonly op: "create" | "read" | "write"; readonly name: string; readonly content?: string };
type Anchor = { readonly dev: number; readonly ino: number; readonly uid?: number; readonly parent_pid: number; };
const fail = (): never => { throw new Error("Organization handoff authority failed"); };
const bytes = (value: string): number => Buffer.byteLength(value, "utf8");
const waitForPublisher = async (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 2));
const validName = (value: unknown): string => typeof value === "string" && NAME.test(value) ? value : fail();
const validRequest = (raw: unknown): Request => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.getPrototypeOf(raw) !== Object.prototype) return fail();
  const value = raw as Record<string, unknown>;
  if (value.version !== VERSION || !Number.isSafeInteger(value.id) || typeof value.op !== "string" || (value.op !== "read" && value.op !== "write" && value.op !== "create")) return fail();
  const content = value.content;
  const keys = Object.keys(value).sort(); const expected = value.op === "read" ? ["id", "name", "op", "version"] : ["content", "id", "name", "op", "version"];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) return fail();
  if (content !== undefined && (typeof content !== "string" || bytes(content) > MAX_BYTES)) return fail();
  return { version: VERSION, id: value.id as number, op: value.op, name: validName(value.name), ...(content === undefined ? {} : { content }) };
};
const send = (value: unknown): void => {
  const serialized = JSON.stringify(value); if (bytes(serialized) > MAX_BYTES || typeof process.send !== "function") process.exit(1);
  process.send(JSON.parse(serialized));
};
const statFile = async (name: string) => {
  const stat = await lstat(name).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? null : fail());
  if (stat === null) return null;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 2 || stat.size > MAX_BYTES || (stat.mode & 0o077) !== 0
    || owner !== undefined && stat.uid !== owner) return fail();
  return stat;
};
const read = async (name: string): Promise<string | null> => {
  let before = await statFile(name); if (before === null) return null;
  if (before.nlink === 2) {
    const aliases = [
      `${name}.pending`, `${name}.recovery`,
      ...(name.endsWith(".pending") ? [name.slice(0, -".pending".length)] : []),
      ...(name.endsWith(".recovery") ? [name.slice(0, -".recovery".length)] : [])
    ]; let match: string | undefined;
    for (const alias of aliases) {
      const stat = await lstat(alias).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? null : fail());
      if (stat && stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 2 && stat.dev === before.dev && stat.ino === before.ino) {
        if (match) return fail(); match = alias;
      }
    }
    if (!match) {
      // The counterpart can be unlinked between the two lstat calls by the
      // helper that won this link election. Re-read only if that left this
      // same checked file with its ordinary single link.
      const current = await statFile(name); if (current === null) return null;
      if (current.nlink !== 1) return fail(); before = current;
    }
    // Reading the canonical record completes a crashed publisher. An
    // intermediate-name reader may be racing that publisher, so it merely
    // observes the linked content and lets its normal publish path converge.
    if (match && !name.endsWith(".pending") && !name.endsWith(".recovery")) {
      await unlink(match).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") fail(); });
      await sync(); before = await statFile(name); if (before === null) return fail();
    }
  }
  const handle = await open(name, constants.O_RDONLY | constants.O_NOFOLLOW).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? null : fail());
  if (handle === null) return null;
  try {
    const stat = await handle.stat();
    // A simultaneous helper may complete the observed link publication while
    // this descriptor is open, reducing nlink from two to one. That is the
    // sole permitted link-count transition; inode, device, size, and all
    // increases remain fail-closed.
    if (!stat.isFile() || stat.nlink < 1 || stat.nlink > before.nlink || stat.dev !== before.dev || stat.ino !== before.ino || stat.size !== before.size) return fail();
    return await handle.readFile({ encoding: "utf8" });
  } catch { return fail(); } finally { await handle.close().catch(() => undefined); }
};
const sync = async (): Promise<void> => { const handle = await open(".", constants.O_RDONLY | constants.O_DIRECTORY).catch(fail); try { await handle.sync(); } finally { await handle.close().catch(() => undefined); } };
const expectedElectionState = async (name: string): Promise<boolean | null> => {
  let stat = await statFile(name); if (stat === null) return null;
  if (stat.nlink === 1) return true;
  const aliases = [
    `${name}.pending`, `${name}.recovery`,
    ...(name.endsWith(".pending") ? [name.slice(0, -".pending".length)] : []),
    ...(name.endsWith(".recovery") ? [name.slice(0, -".recovery".length)] : [])
  ];
  for (const alias of aliases) {
    const counterpart = await lstat(alias).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? null : fail());
    if (counterpart?.isFile() && !counterpart.isSymbolicLink() && counterpart.nlink === 2 && counterpart.dev === stat.dev && counterpart.ino === stat.ino) return true;
  }
  // The counterpart may have disappeared just before this check. Accept only
  // the resulting ordinary single-link state, never an unknown hard link.
  stat = await statFile(name); return stat?.nlink === 1;
};
const readDuringPublication = async (name: string, attempt = 0): Promise<string | null> => {
  try { return await read(name); } catch {
    // Re-validate the leaf before retrying. This permits only a checked,
    // ordinary one/two-link publication race; symlinks, mode/owner drift,
    // extra links, and other malformed states still fail immediately.
    const election = await expectedElectionState(name);
    if (election === null) return null;
    if (attempt >= PUBLICATION_READ_ATTEMPTS || election !== true) return fail();
    await waitForPublisher(); return readDuringPublication(name, attempt + 1);
  }
};
type StagingState = "absent" | "exact" | "expected-prefix";
/**
 * A sidecar may change between lstat and fd inspection while another worker
 * publishes. Re-prove an exact immutable final first, then retry the sidecar
 * so cleanup still relies on a stable checked sidecar rather than an inference.
 */
const readStaging = async (
  staging: string, final: string, content: string, attempt = 0
): Promise<StagingState> => {
  try {
    const observed = await read(staging);
    if (observed === null) return "absent";
    if (observed === content) return "exact";
    return content.startsWith(observed) ? "expected-prefix" : fail();
  } catch {
    const published = await readDuringPublication(final);
    if (published !== null) {
      if (published !== content || attempt >= PUBLICATION_READ_ATTEMPTS) return fail();
      await waitForPublisher(); return readStaging(staging, final, content, attempt + 1);
    }
    const election = await expectedElectionState(staging);
    if (election === null) return "absent";
    if (election !== true || attempt >= PUBLICATION_READ_ATTEMPTS) return fail();
    await waitForPublisher(); return readStaging(staging, final, content, attempt + 1);
  }
};
const publicationSidecars = (name: string): readonly string[] => [`${name}.pending`, `${name}.recovery`];
/**
 * A successful link election can race a peer which had already created the
 * other staging leaf.  The final immutable record is authoritative, but the
 * stale leaf must not survive a completed join: it would otherwise be
 * mistaken for an in-progress publication after restart. Delete exact bytes
 * immediately. An incomplete expected prefix may still belong to a publisher,
 * so wait for it first; once that bounded wait expires, removing that proven
 * prefix is safe because the final record already prevents it from winning a
 * later link election.
 */
const settlePublished = async (name: string, content: string, attempt = 0): Promise<void> => {
  if (attempt > PUBLICATION_SETTLE_ATTEMPTS || await readDuringPublication(name) !== content) return fail();
  let incomplete = false;
  for (const sidecar of publicationSidecars(name)) {
    const observed = await readStaging(sidecar, name, content);
    if (observed === "absent") continue;
    if (observed === "expected-prefix" && attempt < PUBLICATION_SETTLE_ATTEMPTS) {
      incomplete = true; continue;
    }
    await unlink(sidecar).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") fail(); });
    await sync();
  }
  if (incomplete) {
    await waitForPublisher(); return settlePublished(name, content, attempt + 1);
  }
  if (await readDuringPublication(name) !== content) return fail();
  const remaining = await Promise.all(publicationSidecars(name).map(async (sidecar) => readStaging(sidecar, name, content)));
  if (remaining.every((sidecar) => sidecar === "absent")) return;
  if (attempt >= PUBLICATION_SETTLE_ATTEMPTS) return fail();
  await waitForPublisher(); return settlePublished(name, content, attempt + 1);
};
const readPublished = async (name: string): Promise<string | null> => {
  const content = await readDuringPublication(name);
  if (content === null) return null;
  await settlePublished(name, content); return content;
};
const write = async (name: string, content: string, attempt = 0): Promise<boolean> => {
  if (attempt > PUBLICATION_SETTLE_ATTEMPTS) return fail();
  const joinOrRetry = async (): Promise<boolean> => {
    const published = await readDuringPublication(name);
    if (published !== null) { if (published !== content) return fail(); await settlePublished(name, content); return false; }
    await waitForPublisher(); return write(name, content, attempt + 1);
  };
  const reproveStaging = async (): Promise<boolean> => {
    const published = await readDuringPublication(name);
    if (published === content) { await settlePublished(name, content); return true; }
    if (published !== null) return fail();
    await waitForPublisher(); return false;
  };
  const nextAttempt = (): number => attempt + 1;
  const existing = await readDuringPublication(name); if (existing !== null) { if (existing !== content) fail(); await settlePublished(name, content); return false; }
  const pending = `${name}.pending`; const recovery = `${name}.recovery`; const incomplete = await readStaging(pending, name, content);
  if (incomplete === "expected-prefix") {
    let recovered = await readStaging(recovery, name, content);
    if (recovered === "expected-prefix") {
      if (attempt < PUBLICATION_SETTLE_ATTEMPTS) {
        await waitForPublisher(); return write(name, content, attempt + 1);
      }
      // A crashed recovery publisher can leave the same bounded prefix. It
      // cannot win after this writer links the immutable final record, so
      // retire it only after the full wait budget and reconstruct it below.
      await unlink(recovery).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") fail(); });
      await sync(); recovered = "absent";
    }
    if (recovered === "absent") {
      const handle = await open(recovery, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600).catch((error: NodeJS.ErrnoException) => error.code === "EEXIST" ? null : fail());
      if (handle === null) { await waitForPublisher(); return write(name, content, attempt + 1); }
      try { await handle.writeFile(content, "utf8"); await handle.sync(); } finally { await handle.close().catch(() => undefined); }
      const staged = await readStaging(recovery, name, content);
      if (staged !== "exact") {
        if (await reproveStaging()) return false;
        return write(name, content, nextAttempt());
      }
      await sync();
    }
    const recoveredLinked = await link(recovery, name).then(() => true).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "EEXIST") return false;
      if (error.code === "ENOENT") return null;
      return fail();
    });
    if (recoveredLinked !== true) return joinOrRetry();
    await sync(); await unlink(recovery).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") fail(); }); await sync();
    if (await readDuringPublication(name) !== content) fail(); await settlePublished(name, content); return true;
  }
  if (incomplete === "absent") {
    const handle = await open(pending, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600).catch((error: NodeJS.ErrnoException) => error.code === "EEXIST" ? null : fail());
    if (handle === null) { await waitForPublisher(); return write(name, content, attempt + 1); }
    try { await handle.writeFile(content, "utf8"); await handle.sync(); } finally { await handle.close().catch(() => undefined); }
    const staged = await readStaging(pending, name, content);
    if (staged !== "exact") {
      if (await reproveStaging()) return false;
      return write(name, content, nextAttempt());
    }
    await sync();
  }
  const linked = await link(pending, name).then(() => true).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "EEXIST") return false;
    if (error.code === "ENOENT") return null;
    return fail();
  });
  if (linked !== true) return joinOrRetry();
  await sync(); await unlink(pending).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") fail(); }); await sync();
  if (await readDuringPublication(name) !== content) fail(); await settlePublished(name, content); return true;
};

let anchor: Anchor | undefined; let queue = Promise.resolve();
const start = async (): Promise<void> => {
  const raw = process.env.SPAWNFILE_AUTHORITY_FS_ANCHOR; if (!raw) return fail();
  const expected = JSON.parse(raw) as Anchor; const stat = await lstat(".");
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== expected.dev || stat.ino !== expected.ino
    || (stat.mode & 0o077) !== 0 || owner !== undefined && stat.uid !== expected.uid
    || !Number.isSafeInteger(expected.parent_pid) || expected.parent_pid < 1 || process.ppid !== expected.parent_pid) return fail();
  anchor = expected; send({ version: VERSION, ready: true });
};
process.on("message", (raw: unknown) => {
  queue = queue.then(async () => {
    const request = validRequest(raw); if (!anchor) return fail(); const stat = await lstat(".");
    if (stat.dev !== anchor.dev || stat.ino !== anchor.ino || (stat.mode & 0o077) !== 0) return fail();
    const result = request.op === "read"
      ? { content: await readPublished(request.name) }
      : { created: request.content === undefined ? fail() : await write(request.name, request.content) };
    send({ version: VERSION, id: request.id, ok: true, ...(result.content === null ? {} : { content: result.content }), ...(request.op === "create" ? { created: result.created } : {}) });
  }).catch(() => send({ version: VERSION, id: typeof raw === "object" && raw !== null && Number.isSafeInteger((raw as { id?: unknown }).id) ? (raw as { id: number }).id : 0, ok: false }));
});
process.on("disconnect", () => process.exit(0));
// IPC disconnect covers a cooperative parent shutdown. ppid surveillance also
// covers abrupt parent death, where an orphan might otherwise retain its cwd.
setInterval(() => { if (!anchor || process.ppid !== anchor.parent_pid) process.exit(0); }, 100).unref();
void start().catch(() => process.exit(1));
