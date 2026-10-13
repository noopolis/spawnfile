import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { afterEach, expect, it } from "vitest";
import { DAIMON_BROKER_REALM, renderDaimonBrokerProvisioningProgram } from "./containerDaimonBrokerRender.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const credential = (day: number) => JSON.stringify({ "https://auth.x.ai::fixture": { key: "synthetic", refresh_token: "synthetic", expires_at: `2030-01-${String(day).padStart(2, "0")}T00:00:00Z` } });
const digest = (bytes: string) => createHash("sha256").update(bytes).digest("hex");
const fixture = async (state: string, bootstrapDay: number, realmDay = 2) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "grok-lineage-")); roots.push(root);
  const realm = path.join(root, "realm"), bootstrap = path.join(root, "bootstrap");
  await mkdir(path.join(realm, ".daimon-broker"), { recursive: true, mode: 0o700 });
  await writeFile(bootstrap, credential(bootstrapDay), { mode: 0o600 });
  const auth = path.join(realm, "auth.json"), journal = path.join(realm, ".daimon-broker/credential-journal.json");
  await writeFile(auth, credential(realmDay), { mode: 0o600 });
  await writeFile(journal, JSON.stringify({ version: "noopolis.daimon.broker-credential-journal.v1", state, generation: 7,
    sourceDigest: digest(credential(realmDay)), promotedDigest: digest(credential(realmDay)) }), { mode: 0o600 });
  const all = renderDaimonBrokerProvisioningProgram([], []).join("\n");
  const script = all.slice(all.indexOf("const bootstrap ="), all.indexOf("\n", all.indexOf("try { const journalPath =")))
    .replaceAll(DAIMON_BROKER_REALM, realm).replaceAll("/var/lib/spawnfile/daimon/grok-bootstrap-auth", bootstrap);
  const owners = new Map<string, { uid: number; gid: number }>();
  const run = () => runInNewContext(script, { Buffer, process, crypto: createRequire(import.meta.url)("node:crypto"), require: createRequire(import.meta.url),
    fs: { ...fs, chownSync: (file: string, uid: number, gid: number) => { owners.set(file, { uid, gid }); }, fchownSync: () => {}, lstatSync: (file: string) => Object.assign(fs.lstatSync(file), owners.get(file) ?? { uid: 2100, gid: 2100 }) } });
  return { auth, journal, bootstrap, run };
};

it("replays the production startup/recycle program without replacing a newer promoted realm", async () => {
  const f = await fixture("promoted", 1);
  f.run(); f.run();
  expect(await readFile(f.auth, "utf8")).toBe(credential(2));
  expect(JSON.parse(await readFile(f.journal, "utf8")).generation).toBe(7);
});
it.each([1, 2])("refuses stale recovery from older/equal bootstrap expiry (%i) without changing auth or generation", async (day) => {
  const f = await fixture("stale", day);
  if (day === 2) await writeFile(f.bootstrap, credential(day).replace('"key":"synthetic"', '"key":"synthetic-other"'));
  const before = await readFile(f.journal, "utf8");
  expect(f.run).toThrow(/older broker bootstrap|unsafe broker credential recovery/u);
  expect(await readFile(f.auth, "utf8")).toBe(credential(2));
  expect(await readFile(f.journal, "utf8")).toBe(before);
});
it("recovers only a strictly newer bootstrap and advances the durable generation once", async () => {
  const f = await fixture("stale", 3);
  f.run(); f.run();
  expect(await readFile(f.auth, "utf8")).toBe(credential(3));
  expect(JSON.parse(await readFile(f.journal, "utf8"))).toMatchObject({ state: "promoted", generation: 8, promotedDigest: digest(credential(3)) });
});
it("does not seed a missing authority from an old bootstrap when a journal survives", async () => {
  const f = await fixture("promoted", 1);
  await rm(f.auth);
  expect(f.run).toThrow(/refusing bootstrap rollback/u);
  await expect(readFile(f.auth)).rejects.toMatchObject({ code: "ENOENT" });
});
it("seeds a genuinely empty realm once", async () => {
  const f = await fixture("promoted", 1);
  await rm(f.auth); await rm(f.journal);
  f.run(); f.run();
  expect(await readFile(f.auth, "utf8")).toBe(credential(1));
});

it("restores broker ownership after rejecting rollback so an operator can later supply fresh auth", async () => {
  const f = await fixture("stale", 1);
  expect(f.run).toThrow(/older broker bootstrap/u);
  await writeFile(f.bootstrap, credential(3));
  f.run();
  expect(await readFile(f.auth, "utf8")).toBe(credential(3));
});
