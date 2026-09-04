import { constants } from "node:fs";
import { link, lstat, open, unlink } from "node:fs/promises";

import {
  OrganizationHandoffAuthorityBudget, OrganizationHandoffAuthorityFailure,
  toOrganizationHandoffAuthorityFailureDetail
} from "./organizationHandoffAuthorityFsBudget.js";
import { createAuthorityLeafInspector } from "./organizationHandoffAuthorityFsElection.js";

const VERSION = "spawnfile.organization-handoff-fs-worker.v1";
const MAX_BYTES = 32_768;
// Store keys encode either a 64-character pending key or a 71-character
// `opaque_` handoff handle. No other leaf namespace is reachable.
const NAME = /^(?:[a-f0-9]{128}|[a-f0-9]{142})\.json$/u;
const owner = typeof process.getuid === "function" ? process.getuid() : undefined;
type Request = { readonly version: typeof VERSION; readonly id: number; readonly op: "create" | "read" | "write"; readonly name: string; readonly content?: string };
type Anchor = { readonly dev: number; readonly ino: number; readonly uid?: number; readonly parent_pid: number; };
type Budget = OrganizationHandoffAuthorityBudget;
const fail = (code: string, state?: string): never => {
  throw new OrganizationHandoffAuthorityFailure({ code, ...(state === undefined ? {} : { state }) });
};
/** Fail with the budget's attempt/wall-clock accounting and the contending shape. */
const failBudget = (budget: Budget, code: string, loop: string, state?: string): never => {
  throw new OrganizationHandoffAuthorityFailure(budget.snapshot(code, loop, state));
};
/**
 * Re-raise a race failure that the election check refused to retry, recording
 * the verdict. Without it a fail-closed admission decision is indistinguishable
 * from the underlying race in a log.
 */
const failElection = (error: unknown, election: boolean | null, loop: string): never => {
  const detail = toOrganizationHandoffAuthorityFailureDetail(error);
  throw new OrganizationHandoffAuthorityFailure({
    ...detail,
    state: `${detail.state === undefined ? "" : `${detail.state} `}loop=${loop} election=${String(election)}`
  });
};
const bytes = (value: string): number => Buffer.byteLength(value, "utf8");
const validName = (value: unknown): string => typeof value === "string" && NAME.test(value) ? value : fail("invalid_name");
const validRequest = (raw: unknown): Request => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.getPrototypeOf(raw) !== Object.prototype) return fail("malformed_request");
  const value = raw as Record<string, unknown>;
  if (value.version !== VERSION || !Number.isSafeInteger(value.id) || typeof value.op !== "string" || (value.op !== "read" && value.op !== "write" && value.op !== "create")) return fail("unsupported_request");
  const content = value.content;
  const keys = Object.keys(value).sort(); const expected = value.op === "read" ? ["id", "name", "op", "version"] : ["content", "id", "name", "op", "version"];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) return fail("unexpected_request_keys");
  if (content !== undefined && (typeof content !== "string" || bytes(content) > MAX_BYTES)) return fail("oversized_content");
  return { version: VERSION, id: value.id as number, op: value.op, name: validName(value.name), ...(content === undefined ? {} : { content }) };
};
const send = (value: unknown): void => {
  const serialized = JSON.stringify(value); if (bytes(serialized) > MAX_BYTES || typeof process.send !== "function") process.exit(1);
  process.send(JSON.parse(serialized));
};
const { aliasesOf, expectedElectionState, statFile } = createAuthorityLeafInspector(owner === undefined ? {} : { owner });
const publicationSidecars = (name: string): readonly string[] => [`${name}.pending`, `${name}.recovery`];
/**
 * Structural description of the contending state for a diagnostic. Reports
 * only shape — presence, link count, size, mode. Never record bytes, leaf
 * names, or paths: this is the secret-publication path.
 */
const describeContention = async (name: string): Promise<string> => {
  const roles: readonly (readonly [string, string])[] = [["final", name], ["pending", `${name}.pending`], ["recovery", `${name}.recovery`]];
  const parts = await Promise.all(roles.map(async ([role, leaf]) => {
    const stat = await lstat(leaf).catch(() => null);
    return stat === null
      ? `${role}:absent`
      : `${role}:nlink=${stat.nlink},size=${stat.size},mode=${(stat.mode & 0o777).toString(8)}`;
  }));
  return parts.join(" ");
};
const read = async (name: string): Promise<string | null> => {
  let before = await statFile(name); if (before === null) return null;
  if (before.nlink === 2) {
    let match: string | undefined;
    for (const alias of aliasesOf(name)) {
      const stat = await lstat(alias).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? null : fail("alias_lstat_failed"));
      if (stat && stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 2 && stat.dev === before.dev && stat.ino === before.ino) {
        if (match) return fail("ambiguous_link_alias"); match = alias;
      }
    }
    if (!match) {
      // The counterpart can be unlinked between the two lstat calls by the
      // helper that won this link election. Re-read only if that left this
      // same checked file with its ordinary single link.
      const current = await statFile(name); if (current === null) return null;
      if (current.nlink !== 1) return fail("unresolved_second_link"); before = current;
    }
    // Reading the canonical record completes a crashed publisher. An
    // intermediate-name reader may be racing that publisher, so it merely
    // observes the linked content and lets its normal publish path converge.
    if (match && !name.endsWith(".pending") && !name.endsWith(".recovery")) {
      await unlink(match).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") fail("alias_unlink_failed"); });
      await sync(); before = await statFile(name); if (before === null) return fail("record_vanished_after_join");
    }
  }
  const handle = await open(name, constants.O_RDONLY | constants.O_NOFOLLOW).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? null : fail("open_failed"));
  if (handle === null) return null;
  try {
    const stat = await handle.stat();
    // A simultaneous helper may complete the observed link publication while
    // this descriptor is open, reducing nlink from two to one. That is the
    // sole permitted link-count transition; inode, device, size, and all
    // increases remain fail-closed.
    if (!stat.isFile() || stat.nlink < 1 || stat.nlink > before.nlink || stat.dev !== before.dev || stat.ino !== before.ino || stat.size !== before.size) return fail("record_drifted_while_open");
    return await handle.readFile({ encoding: "utf8" });
  } catch (error) {
    if (error instanceof OrganizationHandoffAuthorityFailure) throw error;
    return fail("read_failed");
  } finally { await handle.close().catch(() => undefined); }
};
const sync = async (): Promise<void> => { const handle = await open(".", constants.O_RDONLY | constants.O_DIRECTORY).catch(() => fail("directory_open_failed")); try { await handle.sync(); } finally { await handle.close().catch(() => undefined); } };
const readDuringPublication = async (name: string, budget: Budget): Promise<string | null> => {
  try { return await read(name); } catch (error) {
    // Re-validate the leaf before retrying. This permits only a checked,
    // ordinary one/two-link publication race; symlinks, mode/owner drift,
    // extra links, and other malformed states still fail immediately.
    const election = await expectedElectionState(name);
    if (election === null) return null;
    if (election !== true) return failElection(error, election, "read");
    if (budget.exhausted()) return failBudget(budget, "read_budget_exhausted", "read", await describeContention(name));
    await budget.wait(); return readDuringPublication(name, budget);
  }
};
type StagingState = "absent" | "exact" | "expected-prefix";
/**
 * A sidecar may change between lstat and fd inspection while another worker
 * publishes. Re-prove an exact immutable final first, then retry the sidecar
 * so cleanup still relies on a stable checked sidecar rather than an inference.
 */
const readStaging = async (
  staging: string, final: string, content: string, budget: Budget
): Promise<StagingState> => {
  try {
    const observed = await read(staging);
    if (observed === null) return "absent";
    if (observed === content) return "exact";
    return content.startsWith(observed) ? "expected-prefix" : fail("staging_content_unrelated");
  } catch (error) {
    if (error instanceof OrganizationHandoffAuthorityFailure && error.detail.budget !== undefined) throw error;
    const published = await readDuringPublication(final, budget);
    if (published !== null) {
      if (published !== content) return fail("published_content_mismatch");
      if (budget.exhausted()) return failBudget(budget, "staging_budget_exhausted", "staging", await describeContention(final));
      await budget.wait(); return readStaging(staging, final, content, budget);
    }
    const election = await expectedElectionState(staging);
    if (election === null) return "absent";
    if (election !== true) return failElection(error, election, "staging");
    if (budget.exhausted()) return failBudget(budget, "staging_budget_exhausted", "staging", await describeContention(final));
    await budget.wait(); return readStaging(staging, final, content, budget);
  }
};
/**
 * A successful link election can race a peer which had already created the
 * other staging leaf.  The final immutable record is authoritative, but the
 * stale leaf must not survive a completed join: it would otherwise be
 * mistaken for an in-progress publication after restart. Delete exact bytes
 * immediately. An incomplete expected prefix may still belong to a publisher,
 * so wait for it first; once the budget's patience expires, removing that
 * proven prefix is safe because the final record already prevents it from
 * winning a later link election.
 */
const settlePublished = async (name: string, content: string, budget: Budget): Promise<void> => {
  if (budget.exhausted()) return failBudget(budget, "settle_budget_exhausted", "settle", await describeContention(name));
  if (await readDuringPublication(name, budget) !== content) return fail("settle_record_mismatch");
  let incomplete = false;
  for (const sidecar of publicationSidecars(name)) {
    const observed = await readStaging(sidecar, name, content, budget);
    if (observed === "absent") continue;
    if (observed === "expected-prefix" && budget.patient()) {
      incomplete = true; continue;
    }
    await unlink(sidecar).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") fail("sidecar_unlink_failed"); });
    await sync();
  }
  if (incomplete) {
    await budget.wait(); return settlePublished(name, content, budget);
  }
  if (await readDuringPublication(name, budget) !== content) return fail("settle_record_mismatch");
  const remaining = await Promise.all(publicationSidecars(name).map(async (sidecar) => readStaging(sidecar, name, content, budget)));
  if (remaining.every((sidecar) => sidecar === "absent")) return;
  if (budget.exhausted()) return failBudget(budget, "settle_budget_exhausted", "settle", await describeContention(name));
  await budget.wait(); return settlePublished(name, content, budget);
};
const readPublished = async (name: string, budget: Budget): Promise<string | null> => {
  const content = await readDuringPublication(name, budget);
  if (content === null) return null;
  await settlePublished(name, content, budget); return content;
};
const write = async (name: string, content: string, budget: Budget): Promise<boolean> => {
  if (budget.exhausted()) return failBudget(budget, "write_budget_exhausted", "write", await describeContention(name));
  const joinOrRetry = async (): Promise<boolean> => {
    const published = await readDuringPublication(name, budget);
    if (published !== null) { if (published !== content) return fail("join_content_mismatch"); await settlePublished(name, content, budget); return false; }
    await budget.wait(); return write(name, content, budget);
  };
  const reproveStaging = async (): Promise<boolean> => {
    const published = await readDuringPublication(name, budget);
    if (published === content) { await settlePublished(name, content, budget); return true; }
    if (published !== null) return fail("reprove_content_mismatch");
    await budget.wait(); return false;
  };
  const existing = await readDuringPublication(name, budget); if (existing !== null) { if (existing !== content) fail("existing_content_mismatch"); await settlePublished(name, content, budget); return false; }
  const pending = `${name}.pending`; const recovery = `${name}.recovery`; const incomplete = await readStaging(pending, name, content, budget);
  if (incomplete === "expected-prefix") {
    let recovered = await readStaging(recovery, name, content, budget);
    if (recovered === "expected-prefix") {
      if (budget.patient()) {
        await budget.wait(); return write(name, content, budget);
      }
      // A crashed recovery publisher can leave the same bounded prefix. It
      // cannot win after this writer links the immutable final record, so
      // retire it only after the budget's patience expires and reconstruct it
      // below.
      await unlink(recovery).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") fail("recovery_unlink_failed"); });
      await sync(); recovered = "absent";
    }
    if (recovered === "absent") {
      const handle = await open(recovery, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600).catch((error: NodeJS.ErrnoException) => error.code === "EEXIST" ? null : fail("recovery_create_failed"));
      if (handle === null) { await budget.wait(); return write(name, content, budget); }
      try { await handle.writeFile(content, "utf8"); await handle.sync(); } finally { await handle.close().catch(() => undefined); }
      const staged = await readStaging(recovery, name, content, budget);
      if (staged !== "exact") {
        if (await reproveStaging()) return false;
        return write(name, content, budget);
      }
      await sync();
    }
    const recoveredLinked = await link(recovery, name).then(() => true).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "EEXIST") return false;
      if (error.code === "ENOENT") return null;
      return fail("recovery_link_failed");
    });
    if (recoveredLinked !== true) return joinOrRetry();
    await sync(); await unlink(recovery).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") fail("recovery_unlink_failed"); }); await sync();
    if (await readDuringPublication(name, budget) !== content) fail("recovery_publish_mismatch"); await settlePublished(name, content, budget); return true;
  }
  if (incomplete === "absent") {
    const handle = await open(pending, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600).catch((error: NodeJS.ErrnoException) => error.code === "EEXIST" ? null : fail("pending_create_failed"));
    if (handle === null) { await budget.wait(); return write(name, content, budget); }
    try { await handle.writeFile(content, "utf8"); await handle.sync(); } finally { await handle.close().catch(() => undefined); }
    const staged = await readStaging(pending, name, content, budget);
    if (staged !== "exact") {
      if (await reproveStaging()) return false;
      return write(name, content, budget);
    }
    await sync();
  }
  const linked = await link(pending, name).then(() => true).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "EEXIST") return false;
    if (error.code === "ENOENT") return null;
    return fail("pending_link_failed");
  });
  if (linked !== true) return joinOrRetry();
  await sync(); await unlink(pending).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") fail("pending_unlink_failed"); }); await sync();
  if (await readDuringPublication(name, budget) !== content) fail("pending_publish_mismatch"); await settlePublished(name, content, budget); return true;
};

let anchor: Anchor | undefined; let queue = Promise.resolve();
const start = async (): Promise<void> => {
  const raw = process.env.SPAWNFILE_AUTHORITY_FS_ANCHOR; if (!raw) return fail("missing_anchor");
  const expected = JSON.parse(raw) as Anchor; const stat = await lstat(".");
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== expected.dev || stat.ino !== expected.ino
    || (stat.mode & 0o077) !== 0 || owner !== undefined && stat.uid !== expected.uid
    || !Number.isSafeInteger(expected.parent_pid) || expected.parent_pid < 1 || process.ppid !== expected.parent_pid) return fail("anchor_mismatch");
  anchor = expected; send({ version: VERSION, ready: true });
};
process.on("message", (raw: unknown) => {
  queue = queue.then(async () => {
    const request = validRequest(raw); if (!anchor) return fail("not_ready"); const stat = await lstat(".");
    if (stat.dev !== anchor.dev || stat.ino !== anchor.ino || (stat.mode & 0o077) !== 0) return fail("anchor_drifted");
    // One budget per request: the request is the thing with a deadline, and
    // the client's own request deadline must exceed it.
    const budget = new OrganizationHandoffAuthorityBudget();
    const result = request.op === "read"
      ? { content: await readPublished(request.name, budget) }
      : { created: request.content === undefined ? fail("missing_content") : await write(request.name, request.content, budget) };
    send({ version: VERSION, id: request.id, ok: true, ...(result.content === null ? {} : { content: result.content }), ...(request.op === "create" ? { created: result.created } : {}) });
  }).catch((error: unknown) => send({
    version: VERSION,
    id: typeof raw === "object" && raw !== null && Number.isSafeInteger((raw as { id?: unknown }).id) ? (raw as { id: number }).id : 0,
    ok: false,
    failure: toOrganizationHandoffAuthorityFailureDetail(error)
  }));
});
process.on("disconnect", () => process.exit(0));
/**
 * Expected parent pid read synchronously at module load, before any await.
 *
 * The watchdog below previously exited whenever `anchor` was still unset. That
 * made a liveness net race the startup path: on a loaded host the interpreter
 * and the anchor's `lstat` can take longer than one 100ms tick, and the helper
 * killed itself before it could ever report ready. Deriving the pid from the
 * environment removes the dependency on startup having finished, without
 * weakening anything: `start` still validates the full anchor independently,
 * and no request is served until it does.
 */
const watchedParentPid = ((): number | undefined => {
  try {
    const value = JSON.parse(process.env.SPAWNFILE_AUTHORITY_FS_ANCHOR ?? "{}") as { parent_pid?: unknown };
    return Number.isSafeInteger(value.parent_pid) ? value.parent_pid as number : undefined;
  } catch { return undefined; }
})();
// IPC disconnect covers a cooperative parent shutdown. ppid surveillance also
// covers abrupt parent death, where an orphan might otherwise retain its cwd.
setInterval(() => { if (watchedParentPid === undefined || process.ppid !== watchedParentPid) process.exit(0); }, 100).unref();
void start().catch(() => process.exit(1));
