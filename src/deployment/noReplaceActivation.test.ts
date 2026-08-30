import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { activateNoReplaceWith } from "./noReplaceActivation.js";

const source = path.join(path.sep, "volumes", "target.migration-1");
const destination = path.join(path.sep, "volumes", "target");

describe("atomic no-replace activation helper", () => {
  it("uses one absolute package helper with bounded execution", async () => {
    const run = vi.fn(async (_file: string, _args: string[], _options: { encoding: "utf8"; maxBuffer: number; timeout: number; windowsHide: true }) => ({ stderr: "", stdout: '{"ok":true}\n' }));
    await activateNoReplaceWith(source, destination, { arch: "x64", platform: "linux", run });
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0]?.[0]).toMatch(/^\/.*\/native\/rename-noreplace-x64$/u);
    expect(run.mock.calls[0]?.[1]).toEqual([path.join(path.sep, "volumes"), "target.migration-1", "target"]);
    expect(run.mock.calls[0]?.[2]).toMatchObject({ maxBuffer: 4096, timeout: 5000 });
  });

  it.each(["EEXIST", "EXDEV", "ENOSYS", "EOPNOTSUPP"])("maps %s without fallback", async (code) => {
    const failure = Object.assign(new Error("helper failed"), { stdout: `${JSON.stringify({ ok: false, error: code })}\n` });
    await expect(activateNoReplaceWith(source, destination, { arch: "arm64", platform: "linux", run: async () => { throw failure; } })).rejects.toMatchObject({ code });
  });

  it("fails closed for missing, timeout, malformed output, and unsupported hosts", async () => {
    await expect(activateNoReplaceWith(source, destination, { arch: "x64", platform: "linux", run: async () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); } })).rejects.toThrow(/helper is missing/u);
    await expect(activateNoReplaceWith(source, destination, { arch: "x64", platform: "linux", run: async () => { throw Object.assign(new Error("timeout"), { killed: true }); } })).rejects.toThrow(/timed out/u);
    await expect(activateNoReplaceWith(source, destination, { arch: "x64", platform: "linux", run: async () => ({ stderr: "", stdout: "garbage\n" }) })).rejects.toThrow(/malformed output/u);
    await expect(activateNoReplaceWith(source, destination, { arch: "x64", platform: "darwin", run: async () => ({ stderr: "", stdout: "" }) })).rejects.toThrow(/unsupported/u);
  });
});
