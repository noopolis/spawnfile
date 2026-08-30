import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import { stageWorkspaceBundles, validateWorkspaceBundleTar } from "./workspaceBundleArtifacts.js";

const run = promisify(execFile);

describe("offline workspace bundles", () => {
  it("returns false without declarations and rejects unsafe archive identities", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "spawnfile-bundle-invalid-")); try {
      expect(await stageWorkspaceBundles(root, { nodes: [] } as never)).toBe(false);
      expect(await stageWorkspaceBundles(path.join(root, "undefined-resources"), { nodes: [{ kind: "agent", value: {} }] } as never)).toBe(false);
      expect(await stageWorkspaceBundles(path.join(root, "non-bundle"), { nodes: [{ kind: "agent", value: { workspaceResources: [{ kind: "volume" }] } }] } as never)).toBe(false);
      await writeFile(path.join(root, "empty.tar"), Buffer.alloc(1024));
      const resource = { id: "bad", kind: "bundle", mode: "readonly", mount: "./bad", sha256: `sha256:${createHash("sha256").update(Buffer.alloc(1024)).digest("hex")}`, source: "empty.tar", sharing: "per_agent", scope: { kind: "agent", key: path.join(root, "Agentfile"), name: "agent" } };
      await expect(stageWorkspaceBundles(path.join(root, "out"), { nodes: [{ kind: "agent", value: { workspaceResources: [resource] } }] } as never)).rejects.toThrow(/empty/u);
      await expect(stageWorkspaceBundles(path.join(root, "out2"), { nodes: [{ kind: "agent", value: { workspaceResources: [{ ...resource, source: "missing.tar" }] } }] } as never)).rejects.toThrow();
      await expect(stageWorkspaceBundles(path.join(root, "out3"), { nodes: [{ kind: "agent", value: { workspaceResources: [resource, { ...resource, source: "other.tar" }] } }] } as never)).rejects.toThrow(/multiple sources/u);
      const unsafe = Buffer.alloc(1024); unsafe.write("../escape", 0, "ascii"); unsafe.write("00000000000", 124, "ascii"); unsafe[156] = "2".charCodeAt(0); await writeFile(path.join(root, "unsafe.tar"), unsafe);
      const unsafeResource = { ...resource, source: "unsafe.tar", sha256: `sha256:${createHash("sha256").update(unsafe).digest("hex")}` };
      await expect(stageWorkspaceBundles(path.join(root, "out4"), { nodes: [{ kind: "agent", value: { workspaceResources: [unsafeResource] } }] } as never)).rejects.toThrow(/unsafe tar entry/u);
      const link = Buffer.from(unsafe); link.fill(0, 0, 100); link.write("link", 0, "ascii"); const linkResource = { ...resource, source: "link.tar", sha256: `sha256:${createHash("sha256").update(link).digest("hex")}` }; await writeFile(path.join(root, "link.tar"), link);
      await expect(stageWorkspaceBundles(path.join(root, "out-link"), { nodes: [{ kind: "agent", value: { workspaceResources: [linkResource] } }] } as never)).rejects.toThrow(/unsafe tar entry/u);
      const absolute = Buffer.from(unsafe); absolute.fill(0, 0, 100); absolute.write("/absolute", 0, "ascii"); absolute[156] = "0".charCodeAt(0); const absoluteResource = { ...resource, source: "absolute.tar", sha256: `sha256:${createHash("sha256").update(absolute).digest("hex")}` }; await writeFile(path.join(root, "absolute.tar"), absolute);
      await expect(stageWorkspaceBundles(path.join(root, "out-absolute"), { nodes: [{ kind: "agent", value: { workspaceResources: [absoluteResource] } }] } as never)).rejects.toThrow(/unsafe tar entry/u);
      const unnamed = Buffer.alloc(1024); unnamed[156] = "0".charCodeAt(0); const unnamedResource = { ...resource, source: "unnamed.tar", sha256: `sha256:${createHash("sha256").update(unnamed).digest("hex")}` }; await writeFile(path.join(root, "unnamed.tar"), unnamed);
      await expect(stageWorkspaceBundles(path.join(root, "out-unnamed"), { nodes: [{ kind: "agent", value: { workspaceResources: [unnamedResource] } }] } as never)).rejects.toThrow(/unsafe tar entry/u);
      const truncated = Buffer.alloc(1024); truncated.write("file", 0, "ascii"); truncated.write("00000002000", 124, "ascii"); truncated[156] = "0".charCodeAt(0); const truncatedResource = { ...resource, source: "truncated.tar", sha256: `sha256:${createHash("sha256").update(truncated).digest("hex")}` }; await writeFile(path.join(root, "truncated.tar"), truncated);
      await expect(stageWorkspaceBundles(path.join(root, "out-truncated"), { nodes: [{ kind: "agent", value: { workspaceResources: [truncatedResource] } }] } as never)).rejects.toThrow(/invalid|truncated/u);
      const directoryResource = { ...resource, source: ".", sha256: `sha256:${"0".repeat(64)}` };
      await expect(stageWorkspaceBundles(path.join(root, "out5"), { nodes: [{ kind: "agent", value: { workspaceResources: [directoryResource] } }] } as never)).rejects.toThrow(/regular tar/u);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("stages only the exact checksum-pinned all-input tar bytes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "spawnfile-bundle-"));
    try {
      await writeFile(path.join(root, "tracked.txt"), "tracked"); await writeFile(path.join(root, "untracked.txt"), "untracked");
      await run("tar", ["--format=ustar", "-cf", "bundle.tar", "tracked.txt", "untracked.txt"], { cwd: root });
      const bytes = await readFile(path.join(root, "bundle.tar")); const sha256 = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
      const rewriteHeader = (source: Buffer, offset: number, mutate: (header: Buffer) => void): Buffer => { const result = Buffer.from(source), header = result.subarray(offset, offset + 512); mutate(header); header.fill(32, 148, 156); let sum = 0; for (const byte of header) sum += byte; header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "ascii"); return result; };
      const hostile = [
        rewriteHeader(bytes, 0, (header) => { header.fill(0, 345, 500); header.write("..", 345, "ascii"); }),
        rewriteHeader(bytes, 0, (header) => { header.fill(0, 0, 100); header.write("/absolute", 0, "ascii"); }),
        rewriteHeader(bytes, 1024, (header) => { header.copy(header, 0, 0, 100); header.fill(0, 0, 100); header.write("tracked.txt", 0, "ascii"); }),
        rewriteHeader(bytes, 0, (header) => { header[156] = "2".charCodeAt(0); }),
        rewriteHeader(bytes, 0, (header) => { header.write("z", 124, "ascii"); }),
        Buffer.concat([bytes, Buffer.from([1])])
      ];
      const badChecksum = Buffer.from(bytes); badChecksum[0] ^= 1; hostile.push(badChecksum);
      for (const candidate of hostile) expect(() => validateWorkspaceBundleTar(candidate)).toThrow();
      const emptyNumeric = rewriteHeader(bytes, 0, (header) => header.fill(0, 108, 116)); expect(() => validateWorkspaceBundleTar(emptyNumeric)).not.toThrow();
      const nullType = rewriteHeader(bytes, 0, (header) => { header[156] = 0; }); expect(() => validateWorkspaceBundleTar(nullType)).not.toThrow();
      const fullName = rewriteHeader(bytes, 0, (header) => { header.fill("a".charCodeAt(0), 0, 100); }); expect(() => validateWorkspaceBundleTar(fullName)).not.toThrow();
      const directoryHeader = rewriteHeader(bytes, 0, (header) => { header.fill(0, 0, 100); header.write("directory/", 0, "ascii"); header.fill(0, 124, 136); header.write("00000000000", 124, "ascii"); header[156] = "5".charCodeAt(0); }).subarray(0, 512);
      expect(() => validateWorkspaceBundleTar(Buffer.concat([directoryHeader, Buffer.alloc(1024)]))).not.toThrow();
      const directoryWithData = rewriteHeader(bytes, 0, (header) => { header[156] = "5".charCodeAt(0); }); expect(() => validateWorkspaceBundleTar(directoryWithData)).toThrow();
      const oversizedEntry = rewriteHeader(bytes, 0, (header) => { header.fill(0, 124, 136); header.write("77777777777", 124, "ascii"); }); expect(() => validateWorkspaceBundleTar(oversizedEntry)).toThrow(/truncated/u);
      const unterminated = oversizedEntry.subarray(0, 1024); expect(() => validateWorkspaceBundleTar(unterminated)).toThrow(/truncated/u);
      const trailingGarbage = Buffer.from(bytes); trailingGarbage[trailingGarbage.length - 1] = 1; expect(() => validateWorkspaceBundleTar(trailingGarbage)).toThrow(/trailing/u);
      const resource = { id: "project", kind: "bundle", mode: "readonly", mount: "./project", sha256, source: "bundle.tar", sharing: "per_agent", scope: { kind: "agent", key: path.join(root, "Agentfile"), name: "agent" } };
      const output = path.join(root, "out");
      expect(await stageWorkspaceBundles(output, { nodes: [{ kind: "agent", value: { workspaceResources: [resource] } }] } as never)).toBe(true);
      expect(await stageWorkspaceBundles(path.join(root, "duplicate-source"), { nodes: [{ kind: "agent", value: { workspaceResources: [resource, resource] } }] } as never)).toBe(true);
      expect(await readFile(path.join(output, "container/workspace-bundles", `${sha256.slice(7)}.tar`))).toEqual(bytes);
      await writeFile(path.join(root, "bundle.tar"), Buffer.concat([bytes, Buffer.from("drift")]));
      await expect(stageWorkspaceBundles(path.join(root, "bad"), { nodes: [{ kind: "agent", value: { workspaceResources: [resource] } }] } as never)).rejects.toThrow(/checksum mismatch/u);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
