import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { chunkExec } from "./fixtures.test-helper.js";
import { createMemoryLedgerParser, createWakeMomentsParser } from "./parse.js";
import { readRecordingJsonl } from "./read.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "recording-read-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const run = promisify(execFile);
const instant = "2026-10-09T08:00:00Z";

it("executes the reader with a real small maxBuffer and reassembles byte-split Unicode and large lines", async () => {
  const file = path.join(root, "events.jsonl");
  const entries = Array.from({ length: 8 }, (_, index) => ({ seq: index + 1, createdAt: instant }));
  const payload = entries.map((entry) => JSON.stringify({ ...entry, content: "🦉文".repeat(60) })).join("\n");
  const maxBuffer = 768;
  await writeFile(file, payload);
  expect(Buffer.byteLength(payload)).toBeGreaterThan(maxBuffer);
  const exec = vi.fn(async (command: string[]) => run(command[0]!, command.slice(1), { maxBuffer, timeout: 3000 }));
  expect(await readRecordingJsonl(exec, file, createMemoryLedgerParser(), 256)).toEqual({ entries, errors: [] });
  expect(exec.mock.calls.length).toBeGreaterThan(1);
});

it("executes default-sized chunks without imposing the gateway cap on the complete file", async () => {
  const file = path.join(root, "large.jsonl");
  await writeFile(file, JSON.stringify({ seq: 42, createdAt: instant, content: "x".repeat(600_000) }));
  const exec = (command: string[]) => run(command[0]!, command.slice(1), { maxBuffer: 400_000, timeout: 3000 });
  expect(await readRecordingJsonl(exec, file, createMemoryLedgerParser())).toEqual({ entries: [{ seq: 42, createdAt: instant }], errors: [] });
});

it("distinguishes an absent runtime file from a failed executable or a non-file", async () => {
  const exec = (command: string[]) => run(command[0]!, command.slice(1), { maxBuffer: 1024, timeout: 3000 });
  expect(await readRecordingJsonl(exec, path.join(root, "missing"), createMemoryLedgerParser(), 128)).toEqual({ entries: [], errors: [] });
  expect(await readRecordingJsonl(exec, root, createMemoryLedgerParser(), 128)).toHaveProperty("failure");
  expect(await readRecordingJsonl(async () => { throw Object.assign(new Error("no such file or directory"), { code: "ENOENT" }); },
    "ledger", createMemoryLedgerParser())).toHaveProperty("failure");
});

it("keeps global invalid-line numbers across chunks and reports a torn last line", async () => {
  const payload = `bad\n${JSON.stringify({ seq: 7, createdAt: instant })}\n\n{"seq":`;
  expect(await readRecordingJsonl(chunkExec(() => payload), "ledger", createMemoryLedgerParser(), 3)).toEqual({
    entries: [{ seq: 7, createdAt: instant }], errors: [
      "memory ledger line 1: invalid JSON or entry", "memory ledger line 3: invalid JSON or entry", "memory ledger line 4: invalid JSON or entry"
    ]
  });
});

it("does not chase appends after the initial file length", async () => {
  const payload = `${JSON.stringify({ seq: 7, createdAt: instant })}\n`;
  let reads = 0;
  const exec = chunkExec(() => { reads += 1; return reads === 1 ? payload : payload + payload; });
  expect(await readRecordingJsonl(exec, "ledger", createMemoryLedgerParser(), 16)).toEqual({ entries: [{ seq: 7, createdAt: instant }], errors: [] });
  expect(reads).toBe(Math.ceil(Buffer.byteLength(payload) / 16));
});

it.each(["replace", "truncate", "remove", "short"])("fails closed if a chunk is %s", async (change) => {
  const payload = `${JSON.stringify({ seq: 7, createdAt: instant })}\n`;
  const base = chunkExec(() => payload);
  let reads = 0;
  const exec = async (command: string[]) => {
    const result = await base(command);
    if (++reads === 1) return result;
    const chunk = JSON.parse(result.stdout) as { size: number; identity: string; data: string };
    if (change === "replace") chunk.identity = "other";
    if (change === "truncate") chunk.size = 1;
    if (change === "short") chunk.data = "";
    return { stderr: "", stdout: JSON.stringify(change === "remove" ? null : chunk) };
  };
  expect(await readRecordingJsonl(exec, "ledger", createMemoryLedgerParser(), 16)).toMatchObject({ entries: [], failure: expect.any(String) });
});

it("discards an oversized wake row incrementally and resumes at the next line", async () => {
  const parser = createWakeMomentsParser();
  for (let index = 0; index < 20; index += 1) parser.write("x".repeat(256 * 1024));
  parser.write("\nnot-json\n");
  expect(parser.finish()).toEqual({ entries: [], errors: ["wake moments line 1: invalid JSON or entry", "wake moments line 2: invalid JSON or entry"] });
});
