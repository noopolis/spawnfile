import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, expect, it } from "vitest";

import { copyDirectory, fileExists } from "../filesystem/index.js";
import { compileProject } from "./compileProject.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});
const newRoot = async (): Promise<string> => {
  const root = await mkdtemp(path.join(os.tmpdir(), "spawnfile-output-root-"));
  roots.push(root);
  return root;
};
const example = path.resolve(process.cwd(), "examples", "single-agent");
const agentConfig = path.join("runtimes", "openclaw", "agents", "analyst", "openclaw.json");

const listFiles = async (directory: string): Promise<string[]> =>
  (await readdir(directory, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(directory, path.join(entry.parentPath, entry.name)))
    .sort();

it("compiles through an --out link to a real directory like a real output directory", async () => {
  const root = await newRoot();
  const baseline = path.join(root, "baseline");
  await compileProject(example, { outputDirectory: baseline });

  const real = path.join(root, "real");
  await mkdir(path.join(real, "deployments"), { recursive: true });
  await writeFile(path.join(real, "deployments", "record.json"), "{}\n");
  await writeFile(path.join(real, "stale.txt"), "old\n");
  const linked = path.join(root, "out");
  await symlink(real, linked);

  const result = await compileProject(example, { outputDirectory: linked });
  expect(result.outputDirectory).toBe(linked);
  expect(result.report.output_directory).toBe(linked);
  expect(result.reportPath).toBe(path.join(linked, "spawnfile-report.json"));
  await expect(fileExists(path.join(real, agentConfig))).resolves.toBe(true);
  await expect(fileExists(path.join(real, "stale.txt"))).resolves.toBe(false);
  expect(await readFile(path.join(real, "deployments", "record.json"), "utf8")).toBe("{}\n");
  expect((await listFiles(real)).filter((file) => !file.startsWith("deployments")))
    .toEqual(await listFiles(baseline));
}, 60000);

it("compiles into an existing default .spawn link to a real directory", async () => {
  const root = await newRoot();
  const project = path.join(root, "project");
  await copyDirectory(example, project);
  const real = path.join(root, "spawn-output");
  await mkdir(real);
  await symlink(real, path.join(project, ".spawn"));

  const result = await compileProject(project);
  expect(result.outputDirectory).toBe(path.join(project, ".spawn"));
  await expect(fileExists(path.join(real, agentConfig))).resolves.toBe(true);
  await expect(fileExists(path.join(real, "spawnfile-report.json"))).resolves.toBe(true);
}, 60000);

it.each(["file", "file-link", "dangling"])("refuses an unusable %s output target without changing it", async (kind) => {
  const root = await newRoot();
  const file = path.join(root, "target.txt");
  await writeFile(file, "keep\n");
  const target = path.join(root, kind);
  if (kind === "file") await writeFile(target, "keep\n");
  if (kind === "file-link") await symlink(file, target);
  if (kind === "dangling") await symlink(path.join(root, "missing"), target);
  await expect(compileProject(example, { outputDirectory: target })).rejects.toThrow(/real directory/u);
  expect(await readFile(file, "utf8")).toBe("keep\n");
  await expect(fileExists(path.join(root, "missing"))).resolves.toBe(false);
});

it("refuses a reused output whose descendant directory is a link", async () => {
  const root = await newRoot();
  const output = path.join(root, "out");
  const elsewhere = path.join(root, "elsewhere");
  await mkdir(output);
  await mkdir(elsewhere);
  await symlink(elsewhere, path.join(output, "runtimes"));
  await expect(compileProject(example, { clean: false, outputDirectory: output })).rejects.toThrow(/real directory/u);
  expect(await readdir(elsewhere)).toEqual([]);
}, 60000);
