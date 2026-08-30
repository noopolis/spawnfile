import { describe, expect, it } from "vitest";

import { USAGE_TURN_RECORD_VERSION, type UsageRecord } from "./usageLedger.js";
import { readUsageLedgerViaExec } from "./usageLedgerRead.js";

const record = (overrides: Partial<UsageRecord> = {}): UsageRecord => ({
  agent: "cogsworth",
  at: "2026-08-29T01:12:04.000Z",
  cache_read: 5760,
  cache_write: 0,
  calls: 1,
  complete: true,
  engine: "grok",
  input: 8746,
  notional_usd: 0.0035,
  output: 29,
  total: 14535,
  v: USAGE_TURN_RECORD_VERSION,
  wake: "wake-1",
  ...overrides
});

const line = (overrides: Partial<UsageRecord> = {}): string => JSON.stringify(record(overrides));

describe("readUsageLedgerViaExec", () => {
  const paths = {
    filePath: "/var/lib/spawnfile/daimon/usage/usage.jsonl",
    rotatedFilePath: "/var/lib/spawnfile/daimon/usage/usage.jsonl.1"
  };

  it("merges both generations, rotated (older) first", async () => {
    const exec = async (command: string[]) => {
      const target = command[1];
      if (target === paths.rotatedFilePath) {
        return { stderr: "", stdout: `${line({ agent: "rotated-agent" })}\n` };
      }
      if (target === paths.filePath) {
        return { stderr: "", stdout: `${line({ agent: "current-agent" })}\n` };
      }
      throw new Error(`unexpected cat target: ${target}`);
    };

    const read = await readUsageLedgerViaExec(exec, paths);
    expect(read.records.map((r) => r.agent)).toEqual(["rotated-agent", "current-agent"]);
    expect(read.unreadable).toEqual([]);
  });

  it("renders a missing ledger as EMPTY, never an error (ENOENT before the first turn)", async () => {
    const exec = async () => {
      throw Object.assign(new Error("cat: /var/lib/spawnfile/daimon/usage/usage.jsonl: No such file or directory"), {
        code: 1
      });
    };

    await expect(readUsageLedgerViaExec(exec, paths)).resolves.toEqual({ records: [], unreadable: [] });
  });

  it("treats a missing rotated generation as empty while still reading the current one", async () => {
    const exec = async (command: string[]) => {
      if (command[1] === paths.rotatedFilePath) {
        throw new Error("No such file or directory");
      }
      return { stderr: "", stdout: `${line({ agent: "cogsworth" })}\n` };
    };

    const read = await readUsageLedgerViaExec(exec, paths);
    expect(read.records.map((r) => r.agent)).toEqual(["cogsworth"]);
    expect(read.unreadable).toEqual([]);
  });

  it("reports a rotated generation that overran maxBuffer as UNREADABLE, never as empty", async () => {
    // The exact failure `spawnfile usage` must never swallow: a rotated
    // generation larger than the read buffer. Reading it as "" silently
    // deletes a whole generation of turns from the report.
    const exec = async (command: string[]) => {
      if (command[1] === paths.rotatedFilePath) {
        throw Object.assign(new Error("stdout maxBuffer length exceeded"), {
          code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
        });
      }
      return { stderr: "", stdout: `${line({ agent: "cogsworth" })}\n` };
    };

    const read = await readUsageLedgerViaExec(exec, paths);
    expect(read.records.map((r) => r.agent)).toEqual(["cogsworth"]);
    expect(read.unreadable).toEqual([
      { filePath: paths.rotatedFilePath, reason: "stdout maxBuffer length exceeded" }
    ]);
  });

  it("reports a timed-out read as UNREADABLE, never as empty", async () => {
    const exec = async () => {
      throw Object.assign(new Error("Command failed: docker exec container-0 cat usage.jsonl"), {
        killed: true,
        signal: "SIGTERM",
        stderr: ""
      });
    };

    const read = await readUsageLedgerViaExec(exec, paths);
    expect(read.records).toEqual([]);
    expect(read.unreadable.map((entry) => entry.filePath).sort()).toEqual([
      paths.filePath,
      paths.rotatedFilePath
    ]);
  });

  it("reports a daemon failure as UNREADABLE, never as empty", async () => {
    const exec = async () => {
      throw Object.assign(new Error("Command failed"), {
        code: 1,
        stderr: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock."
      });
    };

    const read = await readUsageLedgerViaExec(exec, paths);
    expect(read.records).toEqual([]);
    expect(read.unreadable).toHaveLength(2);
    expect(read.unreadable[0]!.reason).toContain("Cannot connect to the Docker daemon");
  });

  it("bounds and redacts the failure reason it surfaces", async () => {
    const exec = async () => {
      throw Object.assign(new Error("Command failed"), {
        code: 1,
        stderr: `denied Authorization: Bearer super-secret-token ${"y".repeat(600)}`
      });
    };

    const read = await readUsageLedgerViaExec(exec, paths);
    expect(read.unreadable[0]!.reason).not.toContain("super-secret-token");
    expect(read.unreadable[0]!.reason.length).toBeLessThanOrEqual(240);
  });
});
