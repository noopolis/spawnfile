import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createDockerContextSnapshot } from "./dockerContextSnapshot.js";
import { selectTarget } from "./dockerTarget.js";

const endpoint = "ssh://snapshot-validation.example";
const roots: string[] = [];
const selected = async () => selectTarget({
  context: "target_1",
  execFile: async () => ({ stderr: "", stdout: JSON.stringify(endpoint) }),
});
const inspection = (changes: Record<string, unknown> = {}) => ([{
  Endpoints: { docker: { Host: endpoint, SkipTLSVerify: false } },
  Metadata: {},
  Name: "target_1",
  Storage: { MetadataPath: "<IN MEMORY>", TLSPath: "<IN MEMORY>" },
  TLSMaterial: {},
  ...changes,
}]);
const rejects = async (stdout: unknown, stderr = ""): Promise<void> => {
  await expect(createDockerContextSnapshot({
    context: "target_1",
    executor: async () => ({ stderr, stdout: stdout as string }),
    selectedTarget: await selected(),
    timeoutMs: 10_000,
  })).rejects.toThrow("Docker context snapshot failed");
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("Docker context snapshot hostile inspection validation", () => {
  it("rejects invalid context and timeout scalars before invoking Docker", async () => {
    const target = await selected();
    let calls = 0;
    const executor = async () => {
      calls += 1;
      return { stderr: "", stdout: JSON.stringify(inspection()) };
    };
    for (const context of ["", "UPPER", "a".repeat(65)]) {
      await expect(createDockerContextSnapshot({
        context,
        executor,
        selectedTarget: target,
        timeoutMs: 10_000,
      })).rejects.toThrow("Docker context snapshot failed");
    }
    for (const timeoutMs of [0, 1.5, 120_001]) {
      await expect(createDockerContextSnapshot({
        context: "target_1",
        executor,
        selectedTarget: target,
        timeoutMs,
      })).rejects.toThrow("Docker context snapshot failed");
    }
    expect(calls).toBe(0);
  });

  it("rejects transport and top-level inspection corruption", async () => {
    await rejects(JSON.stringify(inspection()), "warning");
    await rejects(null);
    await rejects("x".repeat(32_769));
    await rejects("{");
    for (const value of [null, {}, [], [null], inspection({ Name: "other" })]) {
      await rejects(JSON.stringify(value));
    }
  });

  it("requires exact context inspection object keys and nested records", async () => {
    const extra = inspection()[0]!;
    const cases = [
      [{ ...extra, Extra: true }],
      [{ ...extra, Endpoints: null }],
      [{ ...extra, Metadata: null }],
      [{ ...extra, Storage: null }],
      [{ ...extra, TLSMaterial: null }],
      [{ ...extra, Endpoints: {} }],
      [{ ...extra, TLSMaterial: { extra: [] } }],
      [{ ...extra, Storage: { TLSPath: "x" } }],
    ];
    for (const value of cases) await rejects(JSON.stringify(value));
  });

  it("rejects malformed endpoints and TLS file declarations", async () => {
    const base = inspection()[0]!;
    const tls = (docker: unknown, tlsPath: unknown = "/tmp") => ([{
      ...base,
      Storage: { MetadataPath: "ignored", TLSPath: tlsPath },
      TLSMaterial: { docker },
    }]);
    const cases = [
      [{ ...base, Endpoints: { docker: null } }],
      [{ ...base, Endpoints: { docker: { Host: endpoint, SkipTLSVerify: false, Extra: true } } }],
      [{ ...base, Endpoints: { docker: { Host: 7, SkipTLSVerify: false } } }],
      [{ ...base, Endpoints: { docker: { Host: endpoint, SkipTLSVerify: "false" } } }],
      tls("ca.pem"),
      tls(Array.from({ length: 9 }, (_, index) => `${index}.pem`)),
      tls(["ca.pem", "ca.pem"]),
      tls([7]),
      tls(["unsafe/path"]),
      tls(["ca.pem"], null),
      tls(["ca.pem"], ""),
      tls(["ca.pem"], "x".repeat(4_097)),
    ];
    for (const value of cases) await rejects(JSON.stringify(value));
  });

  it("rejects missing and non-directory TLS roots after cleaning its snapshot", async () => {
    const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "spawnfile-context-invalid-tls-"));
    roots.push(sourceRoot);
    const file = path.join(sourceRoot, "not-a-directory");
    await writeFile(file, "x", "utf8");
    const value = (tlsPath: string) => JSON.stringify(inspection({
      Storage: { MetadataPath: "ignored", TLSPath: tlsPath },
      TLSMaterial: { docker: ["ca.pem"] },
    }));
    await rejects(value(path.join(sourceRoot, "missing")));
    await rejects(value(file));
    const incomplete = path.join(sourceRoot, "incomplete");
    await mkdir(incomplete);
    await rejects(value(incomplete));
  });
});
