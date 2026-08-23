import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { canonicalEvidenceArchive } from "../target/evidenceExportArchive.js";
import { EVIDENCE_EXPORT_HELPER_PATH } from "../target/evidenceExportProvider.js";
import { loadLocalEvidenceHelperRecipe } from "./recipe.js";

const execute = promisify(execFile);
const roots: string[] = [];
const tarModes = (archive: Uint8Array): ReadonlyMap<string, number> => {
  const bytes = Buffer.from(archive);
  const modes = new Map<string, number>();
  let offset = 0;
  while (offset + 512 <= bytes.byteLength && bytes[offset] !== 0) {
    const header = bytes.subarray(offset, offset + 512);
    const name = header.subarray(0, 100).toString("utf8").split("\0", 1)[0]!;
    const mode = Number.parseInt(header.subarray(100, 108).toString("ascii").replace(/\0.*$/u, ""), 8);
    const size = Number.parseInt(header.subarray(124, 136).toString("ascii").replace(/\0.*$/u, ""), 8);
    modes.set(name, mode);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return modes;
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })));
});

describe("local evidence helper recipe", () => {
  it("ships one canonical bounded build context with the exact image contract", async () => {
    const recipe = await loadLocalEvidenceHelperRecipe();
    const modes = tarModes(recipe.context);

    expect([...modes.keys()]).toEqual([
      "Dockerfile", "helperProgram.mjs",
    ]);
    expect(modes).toEqual(new Map([
      ["Dockerfile", 0o444], ["helperProgram.mjs", 0o555],
    ]));
    expect(modes.get("helperProgram.mjs")! & 0o111).toBe(0o111);
    expect(Buffer.from(recipe.context).subarray(257, 265).toString()).toBe("ustar\0" + "00");
    const source = await readFile(new URL("./helperProgram.mjs", import.meta.url), "utf8");
    const dockerfile = Buffer.from(recipe.context).toString("utf8");
    expect(source.startsWith("#!/usr/local/bin/node")).toBe(true);
    expect(dockerfile).toContain("LABEL spawnfile.target.evidence-export.helper-contract=\"v1\"");
    expect(dockerfile).toContain(`ENV PATH=${EVIDENCE_EXPORT_HELPER_PATH}`);
    expect(dockerfile).toContain("USER 65534:65534");
    expect(dockerfile).toContain("ENTRYPOINT [\"/bin/spawnfile-export-helper\"]");
    expect(dockerfile).toContain("COPY helperProgram.mjs /bin/spawnfile-export-helper");
    expect(dockerfile).not.toContain("--chmod");
    expect(dockerfile).not.toContain("# syntax=");
    await expect(loadLocalEvidenceHelperRecipe()).resolves.toEqual(recipe);
  });

  it("runs the shipped program into an archive accepted by the strict parser", async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "spawnfile-helper-program-")));
    roots.push(root);
    const evidence = path.join(root, "evidence");
    await mkdir(path.join(evidence, "nested"), { recursive: true });
    await writeFile(path.join(evidence, "a.txt"), "alpha");
    await writeFile(path.join(evidence, "nested", "b.json"), "{}\n");
    const original = await readFile(new URL("./helperProgram.mjs", import.meta.url), "utf8");
    const program = path.join(root, "helper.mjs");
    await writeFile(program, original.replace(
      'const ROOT = "/spawnfile/evidence";',
      `const ROOT = ${JSON.stringify(evidence)};`,
    ));
    const { stdout } = await execute(process.execPath, [program], {
      encoding: "buffer", maxBuffer: 70_000_000,
    });
    const parsed = canonicalEvidenceArchive(Uint8Array.from(stdout));

    expect(parsed.itemCount).toBe(3);
    expect(parsed.files.map(({ path: filePath }) => filePath)).toEqual([
      "a.txt", "nested/b.json",
    ]);
  });
});
