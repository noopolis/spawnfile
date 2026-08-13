import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  createDockerContextSnapshot,
  setDockerContextSnapshotRemoveForTests
} from "./dockerContextSnapshot.js";
import { selectTarget } from "./dockerTarget.js";

const endpoint = "ssh://snapshot.example";
const source = (host = endpoint) => JSON.stringify([{
  Endpoints: { docker: { Host: host, SkipTLSVerify: false } },
  Metadata: {}, Name: "target_1", Storage: { MetadataPath: "<IN MEMORY>", TLSPath: "<IN MEMORY>" }, TLSMaterial: {}
}]);
const createSnapshot = async () => {
  const selected = await selectTarget({
    context: "target_1",
    execFile: async () => ({ stderr: "", stdout: JSON.stringify(endpoint) })
  });
  return createDockerContextSnapshot({
    context: "target_1",
    executor: async () => ({ stderr: "", stdout: source() }),
    selectedTarget: selected,
    timeoutMs: 10_000
  });
};

describe("private Docker context snapshot", () => {
  it("accepts the exact empty TLS map used by the gpu context, then removes the private snapshot", async () => {
    const selected = await selectTarget({ context: "target_1", execFile: async () => ({ stderr: "", stdout: JSON.stringify(endpoint) }) });
    const snapshot = await createDockerContextSnapshot({
      context: "target_1", executor: async () => ({ stderr: "", stdout: source() }), selectedTarget: selected, timeoutMs: 10_000
    });
    expect(snapshot.args[0]).toBe("--config");
    expect(snapshot.args[2]).toBe("--context");
    expect(snapshot.args[3]).toMatch(/^spfn_[a-f0-9]{32}$/u);
    const id = createHash("sha256").update(snapshot.args[3]!, "utf8").digest("hex");
    const meta = await readFile(`${snapshot.args[1]}/contexts/meta/${id}/meta.json`, "utf8");
    expect(meta).toContain(endpoint);
    const root = snapshot.args[1];
    await snapshot.dispose();
    await expect(lstat(root)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects context/selected-target drift before creating a snapshot", async () => {
    const selected = await selectTarget({ context: "target_1", execFile: async () => ({ stderr: "", stdout: JSON.stringify(endpoint) }) });
    await expect(createDockerContextSnapshot({
      context: "target_1", executor: async () => ({ stderr: "", stdout: source("ssh://other.example") }), selectedTarget: selected, timeoutMs: 10_000
    })).rejects.toThrow("Docker context snapshot failed");
  });

  it("copies only declared bounded TLS material into the synthetic context", async () => {
    const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "spawnfile-source-tls-"));
    try {
      await mkdir(path.join(sourceRoot, "docker"), { recursive: true });
      await writeFile(path.join(sourceRoot, "docker", "ca.pem"), "certificate", { mode: 0o600 });
      const selected = await selectTarget({ context: "target_1", execFile: async () => ({ stderr: "", stdout: JSON.stringify(endpoint) }) });
      const snapshot = await createDockerContextSnapshot({
        context: "target_1", executor: async () => ({ stderr: "", stdout: JSON.stringify([{
          Endpoints: { docker: { Host: endpoint, SkipTLSVerify: false } },
          Metadata: { ignored: "value" }, Name: "target_1",
          Storage: { MetadataPath: "ignored", TLSPath: sourceRoot }, TLSMaterial: { docker: ["ca.pem"] }
        }]) }), selectedTarget: selected, timeoutMs: 10_000
      });
      const id = createHash("sha256").update(snapshot.args[3]!, "utf8").digest("hex");
      await expect(readFile(`${snapshot.args[1]}/contexts/tls/${id}/docker/ca.pem`, "utf8")).resolves.toBe("certificate");
      await expect(readFile(`${snapshot.args[1]}/contexts/meta/${id}/meta.json`, "utf8")).resolves.not.toContain("ignored");
      await snapshot.dispose();
    } finally {
      await rm(sourceRoot, { force: true, recursive: true });
    }
  });

  it("retries a transient snapshot removal failure before marking disposal complete", async () => {
    const snapshot = await createSnapshot();
    const root = snapshot.args[1];
    let calls = 0;
    const restore = setDockerContextSnapshotRemoveForTests(async (...args) => {
      calls += 1;
      if (calls === 1) throw new Error("transient");
      return rm(...args);
    });
    try {
      await expect(snapshot.dispose()).resolves.toBeUndefined();
      expect(calls).toBe(2);
      await expect(lstat(root)).rejects.toMatchObject({ code: "ENOENT" });
      await snapshot.dispose();
      expect(calls).toBe(2);
    } finally {
      restore();
    }
  });

  it("rejects permanent removal failure and keeps disposal retryable", async () => {
    const snapshot = await createSnapshot();
    const root = snapshot.args[1];
    let calls = 0;
    const restoreFailure = setDockerContextSnapshotRemoveForTests(async () => {
      calls += 1;
      throw new Error("permanent");
    });
    await expect(snapshot.dispose()).rejects.toThrow("Docker context snapshot failed");
    expect(calls).toBe(3);
    await expect(lstat(root)).resolves.toBeDefined();
    restoreFailure();
    await expect(snapshot.dispose()).resolves.toBeUndefined();
    await expect(lstat(root)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
