import { mkdtemp, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import type { TrainingPreparationConfig } from "./contract.js";
import type { TrainingContext } from "../contract.js";
import type { TrainingDockerProcess } from "../container/process.js";

export const image = `sha256:${"a".repeat(64)}`;
export const sha = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
export async function preparationFixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "spawnfile-preparation-")));
  const put = async (file: string, value = "fixture") => { await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), value); };
  await put("project/Spawnfile", 'spawnfile_version: "0.1"\nkind: agent\nname: author\nruntime: daimon\n');
  await put("project/train.yaml"); await put("settings/settings.json", "{}"); await put("auth", "fake-subscription");
  for (const target of ["own", "paideia", "claude"]) {
    const manifest = { name: target, version: "1.0.0", dependencies: {} };
    await put(`${target}/package.json`, JSON.stringify(manifest));
    await put(`${target}/package-lock.json`, JSON.stringify({ lockfileVersion: 3, packages: { "": manifest } }));
  }
  await put("own/dist/cli/index.js"); await put("own/runtimes.yaml"); await put("own/moltnet-releases.json");
  await put("own/runtime-images/training/Dockerfile", "ARG NATIVE_IMAGE\nFROM ${NATIVE_IMAGE}\nCOPY train /opt/training/bin/train\n");
  await put("paideia/dist/src/cli/main.js"); await put("bridge/pyproject.toml"); await put("bridge/requirements.lock");
  await put("bridge/paideia_dspy/__init__.py"); await put("integration/entry.ts"); await put("bootstrap/start.ts"); await put("grok", "native-binary");
  const config: TrainingPreparationConfig = {
    version: "spawnfile.training-container.v2", dockerContext: "local",
    image: { build: { recipe: "daimon-dspy.v1", nativeImage: image, pythonImage: image, platform: "linux/arm64",
      paideia: "paideia", bridge: "bridge", claude: "claude", grok: { source: "grok", sha256: sha("native-binary") },
      integration: { source: "integration", entry: "entry.ts" }, bootstrap: "bootstrap" } },
    integration: { settings: { input: "settings", path: "settings.json" } },
    inputs: [{ id: "project", source: "project", destination: "/run/training/inputs/project" }, { id: "settings", source: "settings", destination: "/run/training/inputs/settings" }],
    output: { source: "output", destination: "/run/training/output" }, auth: [{ source: "auth", provider: "claude" }]
  };
  const sourcePath = path.join(root, "project/Spawnfile");
  const source = { sourcePath, destinationPath: "Spawnfile", sha256: sha(await readFile(sourcePath, "utf8")) };
  const context: TrainingContext = { version: "spawnfile.training-context.v1", producer: { package: "spawnfile", version: "test" },
    project: { root: path.join(root, "project"), manifest: sourcePath, sourceDigest: source.sha256 },
    agent: { id: "agent:author", name: "author", source: sourcePath, runtime: "daimon", engine: null, model: null },
    sources: [source], documents: [], skills: [], resources: [], requirements: { nativeCompilation: true, isolatedPreparation: true } };
  const configPath = path.join(root, "training.json");
  const save = () => writeFile(configPath, JSON.stringify(config)); await save();
  return { root, config, configPath, context, put, save,
    args: ["--train", path.join(root, "project/train.yaml"), "--out", path.join(root, "output")] };
}

export function imageDocker() {
  const calls: string[][] = []; const images = new Map<string, string>(); let builtContext: string | undefined;
  const process: TrainingDockerProcess = async args => {
    calls.push([...args]);
    if (args[0] === "context") return { code: 0, stdout: JSON.stringify("unix:///socket"), stderr: "" };
    if (args[2] === "build") {
      builtContext = args.at(-1)!;
      const dockerfile = await readFile(path.join(builtContext, "Dockerfile"), "utf8");
      const digest = JSON.parse(dockerfile.split("LABEL com.spawnfile.training.recipe=")[1]!.trim());
      images.set(args[args.indexOf("--tag") + 1]!, digest);
      return { code: 0, stdout: "built", stderr: "" };
    }
    const target = args[4]!;
    if (target === image) return { code: 0, stdout: image, stderr: "" };
    const digest = images.get(target);
    return digest ? { code: 0, stdout: `${JSON.stringify(image)}\n${JSON.stringify(digest)}`, stderr: "" } : { code: 1, stdout: "", stderr: "missing" };
  };
  return { calls, images, process, get builtContext() { return builtContext; } };
}
