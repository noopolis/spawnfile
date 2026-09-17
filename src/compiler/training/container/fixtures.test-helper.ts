import { mkdtemp, mkdir, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { TrainingContext } from "../contract.js";
import type { TrainingDockerProcess } from "./process.js";

export const image = `sha256:${"a".repeat(64)}`;
export const id = "b".repeat(64);
export const fixture = async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "spawnfile-container-test-")));
  const project = path.join(root, "project"), output = path.join(root, "output");
  await mkdir(project); await mkdir(output);
  await writeFile(path.join(project, "Spawnfile"), "fixture");
  await writeFile(path.join(project, "train.yaml"), "fixture");
  await writeFile(path.join(output, "index.json"), "{}");
  await writeFile(path.join(root, "auth-leaf"), "fake-fixture-token");
  const source = { sourcePath: path.join(project, "Spawnfile"), destinationPath: "Spawnfile", sha256: image };
  const context: TrainingContext = { version: "spawnfile.training-context.v1", producer: { package: "spawnfile", version: "test" },
    project: { root: project, manifest: source.sourcePath, sourceDigest: image },
    agent: { id: "agent:a", name: "a", source: source.sourcePath, runtime: "daimon", engine: null, model: null },
    sources: [source], documents: [{ ...source, role: "system" }], skills: [{ ...source, name: "skill", ref: "skill", requiresMcp: [] }], resources: [],
    requirements: { nativeCompilation: true, isolatedPreparation: true } };
  const config = { version: "spawnfile.training-container.v1", dockerContext: "desktop-linux", inputs: [{ source: project, destination: "/run/training/inputs/project" }],
    output: { source: output, destination: "/run/training/output" }, auth: [{ source: path.join(root, "auth-leaf"), provider: "codex" }] };
  const configPath = path.join(root, "launch.json"); await writeFile(configPath, JSON.stringify(config));
  const args = ["--train", path.join(project, "train.yaml"), "--out", output];
  return { root, project, output, context, config, configPath, args };
};
export const dockerFixture = (override?: (args: readonly string[], options: Parameters<TrainingDockerProcess>[1]) => Promise<{code:number;stdout:string;stderr:string} | undefined>) => {
  const calls: string[][] = []; let name = "";
  const process: TrainingDockerProcess = async (args, options) => {
    calls.push([...args]);
    const custom = await override?.(args, options); if (custom) return custom;
    const result = (stdout: string, code = 0) => ({ stdout, code, stderr: "" });
    if (args[0] === "context") return result(JSON.stringify("unix:///var/run/docker.sock"));
    const command = args[2];
    if (command === "image") return result(image);
    if (command === "create") { name = args[args.indexOf("--name") + 1]!; return result(id); }
    if (command === "inspect") {
      if (args[4] === "{{json .State}}") return result(JSON.stringify({ Running: false, ExitCode: 0 }));
      return result([id, `/${name}`, image, { "com.spawnfile.training.owner": name }].map((part) => JSON.stringify(part)).join("\n"));
    }
    if (command === "start") { options.stdout?.('measuring'); options.stdout?.('{"status":"completed","index":"/run/training/output/index.json"}'); return result(""); }
    if (command === "rm" || command === "container") return result("");
    throw Error(`Unexpected fake Docker command ${args}`);
  };
  return { process, calls };
};
