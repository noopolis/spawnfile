import {
  lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  parseTargetOperationLookup
} from "../target/contracts.js";
import {
  createCanonicalTargetOperationLookupBytes,
  createTargetRequestDigest
} from "../target/handles.js";
import { initializeTargetJournal } from "../target/journal.js";
import { runTargetLookupCli } from "./targetLookupCli.js";
import { TARGET_LOOKUP_CONFIG_STDIN_VERSION } from "./targetDefaultConfigStdin.js";

const roots: string[] = [];
const originalHome = process.env.SPAWNFILE_HOME;
const descriptor = `sha256:${"a".repeat(64)}`;
const selected = {
  fingerprint: `sha256:${"b".repeat(32)}`,
  handle: "opaque_cccccccccccccccc",
  version: "spawnfile.target-resource.selected-target.v1"
} as const;
const request = {
  descriptor_digest: descriptor,
  expected_revision: 0,
  idempotency_key: "idem_aaaaaaaaaaaaaaaa",
  operation: "create_data_network",
  run_id: "run-one",
  selected_target: { fingerprint: selected.fingerprint, handle: selected.handle },
  version: "spawnfile.target-resource.request.v1"
} as const;
const stdin = () => (async function* (): AsyncGenerator<string> {
  yield JSON.stringify({
    context: "production",
    version: TARGET_LOOKUP_CONFIG_STDIN_VERSION
  });
})();
const setupHome = async (): Promise<string> => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "spawnfile-target-lookup-")));
  roots.push(root);
  const home = path.join(root, "home");
  await mkdir(home, { mode: 0o700 });
  process.env.SPAWNFILE_HOME = home;
  return home;
};
const requestFile = async (home: string): Promise<string> => {
  const file = path.join(path.dirname(home), "request.json");
  await writeFile(file, JSON.stringify(request), { mode: 0o600 });
  return file;
};
const invoke = async (file: string) => {
  const stdout: string[] = []; const stderr: string[] = [];
  const code = await runTargetLookupCli(
    ["target", "--config", "-", "lookup_operation", file],
    stdin(),
    { stderr: (message) => stderr.push(message), stdout: (message) => stdout.push(message) }
  );
  return { code, stderr, stdout };
};

afterEach(async () => {
  if (originalHome === undefined) delete process.env.SPAWNFILE_HOME;
  else process.env.SPAWNFILE_HOME = originalHome;
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("target lookup_operation command", () => {
  it("returns canonical not_applied without creating a target root", async () => {
    const home = await setupHome(); const file = await requestFile(home);
    const before = await readdir(home);
    const result = await invoke(file);
    expect(result).toMatchObject({ code: 0, stderr: [] });
    const parsed = parseTargetOperationLookup(JSON.parse(result.stdout[0]!));
    expect(parsed).toEqual({
      idempotency_key: request.idempotency_key,
      operation: request.operation,
      request_digest: createTargetRequestDigest(request),
      status: "not_applied",
      version: "spawnfile.target-resource.operation-lookup.v1"
    });
    expect(result.stdout).toEqual([createCanonicalTargetOperationLookupBytes(parsed)]);
    expect(await readdir(home)).toEqual(before);
  });

  it("reads pending state repeatedly without locks, provider calls, or journal writes", async () => {
    const home = await setupHome(); const file = await requestFile(home);
    const journal = await initializeTargetJournal({
      context: "production", descriptorDigest: descriptor,
      root: path.join(home, "target", "journals"),
      runId: request.run_id, selectedTarget: selected
    });
    const reservation = await journal.reserve(request);
    expect(reservation.kind).toBe("owner");
    if (reservation.kind !== "owner") return;
    const journalRoot = path.join(home, "target", "journals");
    const journalFile = path.join(
      journalRoot,
      (await readdir(journalRoot)).find((entry) => entry.endsWith(".json"))!
    );
    const bytes = await readFile(journalFile, "utf8"); const stats = await lstat(journalFile);
    const entries = await readdir(journalRoot);
    const first = await invoke(file); const second = await invoke(file);
    expect(first).toEqual(second);
    expect(parseTargetOperationLookup(JSON.parse(first.stdout[0]!))).toMatchObject({
      operation_handle: reservation.claim.operationHandle,
      request_digest: reservation.claim.requestDigest,
      status: "pending"
    });
    expect(await readFile(journalFile, "utf8")).toBe(bytes);
    expect((await lstat(journalFile)).mtimeMs).toBe(stats.mtimeMs);
    expect(await readdir(journalRoot)).toEqual(entries);
  });
});
