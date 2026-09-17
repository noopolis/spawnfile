import { execFileSync } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { normalizeTrainingContext, readableClosure, TRAINING_CONTEXT_MTIME } from "./contextModes.js";
import { buildTrainingImage, planTrainingImage } from "./image.js";
import { imageDocker, preparationFixture } from "./fixtures.test-helper.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function temporary() { const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "training-context-modes-"))); roots.push(root); return root; }
const recipe = () => readFile(new URL("../../../../runtime-images/training/Dockerfile", import.meta.url), "utf8");

/** Modes staged before normalization: private dirs from `mkdir 0700` and assorted source file modes. */
async function assortedTree(root: string): Promise<void> {
  const files: [string, number][] = [["train-broker", 0o700], ["train", 0o600], ["bridge/requirements.lock", 0o600], ["bridge/pkg/tool.py", 0o640],
    ["bridge/pkg/run.sh", 0o710], ["integration/entry.ts", 0o400], ["integration/bin/partial", 0o100], ["paideia/dist/main.js", 0o644],
    ["paideia/dist/exec.js", 0o755], ["paideia/dist/owner-exec.js", 0o744], ["bootstrap/start.ts", 0o604], ["sticky/file", 0o4750]];
  for (const [file, mode] of files) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true, mode: 0o700 });
    await writeFile(path.join(root, file), file); await chmod(path.join(root, file), mode);
  }
  for (const [directory, mode] of [["bridge", 0o700], ["bridge/pkg", 0o711], ["integration/bin", 0o750], ["sticky", 0o2700]] as const) {
    await chmod(path.join(root, directory), mode);
  }
}
async function modes(root: string): Promise<Record<string, string>> {
  const found: Record<string, string> = {};
  const walk = async (directory: string) => {
    for (const name of (await readdir(directory)).sort()) {
      const entry = path.join(directory, name), stat = await lstat(entry);
      found[path.relative(root, entry)] = (stat.mode & 0o7777).toString(8);
      if (stat.isDirectory()) await walk(entry);
    }
  };
  await walk(root); return found;
}

it("renders a closure that is exactly `chmod -R a+rX` for every staged mode shape", async () => {
  const dockerfile = await recipe();
  const idioms = [...dockerfile.matchAll(/find (\S+) (\\\( \\\( -type d .*? -exec chmod a\+rX \{\} \+)/gu)];
  expect(idioms.map(match => match[1])).toEqual(["/opt/training", "/opt/training/paideia/bridges/dspy"]);
  expect(new Set(idioms.map(match => match[2])).size).toBe(1);
  const root = await temporary(), reference = path.join(root, "reference"), candidate = path.join(root, "candidate");
  await assortedTree(reference); await assortedTree(candidate);
  execFileSync("chmod", ["-R", "a+rX", reference]);
  execFileSync("/bin/sh", ["-c", `find ${JSON.stringify(candidate)} ${idioms[0]![2]!.replaceAll("\\(", "'('").replaceAll("\\)", "')'")}`]);
  expect(await modes(candidate)).toEqual(await modes(reference));
});

it("stages COPY content with the modes the former chmod 0555 train/train-broker plus chmod -R a+rX produced", async () => {
  const root = await temporary(), reference = path.join(root, "reference"), candidate = path.join(root, "candidate");
  await assortedTree(reference); await assortedTree(candidate);
  await chmod(path.join(reference, "train-broker"), 0o555); await chmod(path.join(reference, "train"), 0o555);
  execFileSync("chmod", ["-R", "a+rX", reference]);
  await normalizeTrainingContext(candidate);
  const expected = await modes(reference);
  expect(await modes(candidate)).toEqual(expected);
  // Documented expectation: directories 0755, readable files 0644, executables 0755, train/train-broker 0555.
  expect(expected).toMatchObject({ bridge: "755", "bridge/pkg": "755", "bridge/requirements.lock": "644", "bridge/pkg/run.sh": "755",
    "integration/entry.ts": "444", "integration/bin/partial": "555", "train-broker": "555", train: "555", sticky: "2755", "sticky/file": "4755" });
  expect((await lstat(path.join(candidate, "bridge/pkg/tool.py"))).mtime).toEqual(TRAINING_CONTEXT_MTIME);
  expect(readableClosure(0o600, false)).toBe(0o644);
});

it("hands Docker a normalized context and never runs a layer after the distribution copies", async () => {
  const f = await preparationFixture(); roots.push(f.root); if (!("build" in f.config.image)) throw Error("build expected");
  await chmod(path.join(f.root, "integration/entry.ts"), 0o600);
  const plan = await planTrainingImage(f.config.image.build, f.root, [], path.join(f.root, "own")), docker = imageDocker();
  let staged: Record<string, string> = {}, mtimes = new Set<number>();
  await buildTrainingImage(plan, { parent: f.root, dockerContext: "local", timeoutMs: 1000, streams: { stdout() {}, stderr() {} },
    process: async (args, options) => {
      if (args[2] === "build") {
        const context = args.at(-1)!; staged = await modes(context);
        mtimes = new Set(await Promise.all(Object.keys(staged).filter(file => file !== "Dockerfile").map(async file => (await lstat(path.join(context, file))).mtimeMs)));
      }
      return docker.process(args, options);
    } });
  expect(staged).toMatchObject({ "train-broker": "555", train: "555", integration: "755", "integration/entry.ts": "644", bridge: "755", "paideia/dist/src/cli": "755" });
  expect(Object.entries(staged).filter(([, mode]) => !["755", "644", "555"].includes(mode))).toEqual([]);
  expect([...mtimes]).toEqual([TRAINING_CONTEXT_MTIME.getTime()]);

  const dockerfile = await recipe();
  const instructions = dockerfile.split(/\n(?! )/u).map(line => line.trim()).filter(line => line && !line.startsWith("#"));
  expect(instructions.join("\n")).not.toMatch(/chmod (-R|0)/u);
  const firstLate = instructions.indexOf("COPY train /opt/training/bin/train");
  expect(instructions.slice(firstLate).map(line => line.split(" ")[0])).toEqual(["COPY", "COPY", "COPY", "COPY", "COPY", "COPY", "COPY", "COPY", "COPY", "ENV", "ENV", "WORKDIR", "ENTRYPOINT"]);
  const copies = instructions.filter(line => line.startsWith("COPY ") && !line.startsWith("COPY --from"));
  expect(copies.flatMap(line => line.split(/\s+/u).slice(1, -1)).sort()).toEqual(["bootstrap", "bridge", "bridge/requirements.lock", "claude/package-lock.json", "claude/package.json",
    "compiler/dist", "compiler/moltnet-releases.json", "compiler/package-lock.json", "compiler/package.json", "compiler/runtimes.yaml", "integration",
    "paideia/dist", "paideia/package-lock.json", "paideia/package.json", "spawnfile/dist", "spawnfile/moltnet-releases.json", "spawnfile/package-lock.json",
    "spawnfile/package.json", "spawnfile/runtimes.yaml", "train", "train-broker"]);
  expect(instructions.filter(line => line.startsWith("COPY --from"))).toHaveLength(2);
  expect(dockerfile.match(/ln -s \S+ \S+/gu)).toEqual([
    "ln -s /opt/spawnfile/runtime-installs/daimon/node_modules/@noopolis/daimon node_modules/@noopolis/daimon",
    "ln -s /opt/training/claude/node_modules/.bin/claude /opt/training/bin/claude",
    "ln -s /opt/training/paideia/dist/src/cli/main.js /opt/training/bin/paideia",
    "ln -s /opt/training/spawnfile/dist/cli/index.js /opt/training/bin/spawnfile",
    "ln -s /opt/training/paideia /opt/training/integration/node_modules/@noopolis/paideia",
    "ln -s /opt/training/spawnfile /opt/training/integration/node_modules/spawnfile",
    "ln -s /opt/spawnfile/runtime-installs/daimon/node_modules/@noopolis/daimon /opt/training/integration/node_modules/@noopolis/daimon"]);
});
