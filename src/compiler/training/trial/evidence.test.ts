import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

import { afterEach, beforeEach, expect, it } from "vitest";

import { captureTrialEvidence, createTrialDockerStream, TRIAL_EVIDENCE_MANIFEST, type TrialDockerStream, type TrialEvidenceManifest } from "./evidence.js";

let root = "";
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "spawnfile-trial-evidence-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

const SECRET = "control-token-0123456789abcdef";
/** A Docker CLI whose every call is answered from a table keyed by its first argument. */
const fake = (answers: Record<string, { stdout?: string; stderr?: string; code?: number }>, calls: string[][] = []): TrialDockerStream => (args) => {
  calls.push([...args]);
  const answer = answers[args[0]!] ?? { code: 1, stderr: "no such container" };
  return { stdout: Readable.from([Buffer.from(answer.stdout ?? "")]), stderr: Readable.from([Buffer.from(answer.stderr ?? "")]),
    exit: Promise.resolve(answer.code ?? 0), kill: () => undefined };
};
const manifestOf = async (directory: string): Promise<TrialEvidenceManifest> =>
  JSON.parse(await readFile(path.join(directory, TRIAL_EVIDENCE_MANIFEST), "utf8")) as TrialEvidenceManifest;

it("keeps the whole container log, far past any in-memory buffer, through the real Docker call path", async () => {
  // 40 MiB on each stream: more than the 16 MiB a buffered Docker call may hold, so a tail or a buffer cannot pass.
  const script = path.join(root, "docker");
  await writeFile(script, `#!/bin/sh\nhead -c 41943040 /dev/zero | tr '\\0' 'o'\nhead -c 41943040 /dev/zero | tr '\\0' 'e' >&2\n`);
  await chmod(script, 0o755);
  const directory = path.join(root, "evidence");
  const manifest = await captureTrialEvidence({ directory, container: "c", secrets: [], stream: createTrialDockerStream(script) });
  expect((await stat(path.join(directory, "container.stdout.log"))).size).toBe(41_943_040);
  expect((await stat(path.join(directory, "container.stderr.log"))).size).toBe(41_943_040);
  expect(manifest.captures.map(({ file, bytes, complete }) => ({ file, bytes, complete }))).toEqual([
    { file: "container.stdout.log", bytes: 41_943_040, complete: true }, { file: "container.stderr.log", bytes: 41_943_040, complete: true }]);
  expect(await manifestOf(directory)).toEqual(manifest);
}, 60_000);

it("asks Docker for every line with timestamps, never a tail, and masks secrets in both streams", async () => {
  const calls: string[][] = [];
  const directory = path.join(root, "evidence");
  await captureTrialEvidence({ directory, container: "trial-1", secrets: [SECRET],
    stream: fake({ logs: { stdout: `ready ${SECRET}\n`, stderr: `daimon: wake failed Bearer abcdefghijklmnopqrstu\n` } }, calls) });
  expect(calls).toEqual([["logs", "--timestamps", "trial-1"]]);
  expect(await readFile(path.join(directory, "container.stdout.log"), "utf8")).toBe(`ready ${"*".repeat(SECRET.length)}\n`);
  expect(await readFile(path.join(directory, "container.stderr.log"), "utf8")).toBe(`daimon: wake failed Bearer ${"*".repeat(21)}\n`);
  expect((await stat(path.join(directory, "container.stderr.log"))).mode & 0o777).toBe(0o600);
});

it("records a reached bound instead of cutting silently", async () => {
  const directory = path.join(root, "evidence");
  const manifest = await captureTrialEvidence({ directory, container: "c", secrets: [], boundBytes: 10, stream: fake({ logs: { stdout: "0123456789abcdef\n", stderr: "short\n" } }) });
  expect(manifest.captures).toEqual([
    { file: "container.stdout.log", source: "container log", bytes: 10, complete: false, boundBytes: 10 },
    { file: "container.stderr.log", source: "container log", bytes: 6, complete: true }]);
  expect(await readFile(path.join(directory, "container.stdout.log"), "utf8")).toBe("0123456789");
});

it("records a capture that could not be made and never throws", async () => {
  const directory = path.join(root, "evidence");
  const manifest = await captureTrialEvidence({ directory, container: "gone", secrets: [SECRET], stream: fake({ logs: { code: 1, stderr: `Error: No such container: gone ${SECRET}` } }) });
  expect(manifest.captures[0]).toMatchObject({ file: "container.stdout.log", complete: false });
  expect(manifest.captures[0]!.error).toContain("docker logs exited 1");
  expect(JSON.stringify(await manifestOf(directory))).not.toContain(SECRET);
});

it("collects each declared engine path as one archive and refuses any that holds a login file", async () => {
  const calls: string[][] = [];
  const directory = path.join(root, "evidence");
  const home = "/var/lib/spawnfile/instances/daimon/org/home/writer";
  const manifest = await captureTrialEvidence({ directory, container: "c", secrets: [SECRET],
    diagnostics: [{ agentId: "agent:writer", home, paths: [".codex/sessions", ".codex", ".codex/auth.json", ".gemini/antigravity-cli/log", "../other"] }],
    loginPaths: [`${home}/.codex/auth.json`, `${home}/.gemini/antigravity-cli/antigravity-oauth-token`],
    stream: fake({ logs: {}, cp: { stdout: `tar-bytes ${SECRET}` } }, calls) });
  expect(calls.filter((call) => call[0] === "cp")).toEqual([
    ["cp", `c:${home}/.codex/sessions`, "-"], ["cp", `c:${home}/.gemini/antigravity-cli/log`, "-"]]);
  expect(manifest.refused).toEqual([
    { source: `${home}/.codex`, reason: "holds a login file" }, { source: `${home}/.codex/auth.json`, reason: "holds a login file" },
    { source: "/var/lib/spawnfile/instances/daimon/org/home/other", reason: "outside the agent's runtime home" }]);
  expect(await readFile(path.join(directory, "engine/0-.codex_sessions.tar"), "utf8")).toBe(`tar-bytes ${"*".repeat(SECRET.length)}`);
  expect(manifest.captures.filter((capture) => capture.file.startsWith("engine/")).map((capture) => capture.complete)).toEqual([true, true]);
});

it("keeps the runtime's own notes whole, masked, beside the logs", async () => {
  const directory = path.join(root, "evidence");
  const manifest = await captureTrialEvidence({ directory, container: "c", secrets: [SECRET], stream: fake({ logs: {} }),
    notes: { "runtime-failure.txt": `engine_failed: refused ${SECRET}` } });
  expect(await readFile(path.join(directory, "runtime-failure.txt"), "utf8")).toBe(`engine_failed: refused ${"*".repeat(SECRET.length)}\n`);
  expect(manifest.captures[0]).toMatchObject({ file: "runtime-failure.txt", complete: true });
});
