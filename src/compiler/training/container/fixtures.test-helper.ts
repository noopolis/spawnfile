import { chmod, cp, mkdtemp, mkdir, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
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
type DockerOverride = (args: readonly string[], options: Parameters<TrainingDockerProcess>[1]) => Promise<{code:number;stdout:string;stderr:string} | undefined>;
export const dockerFixture = (override?: DockerOverride, storageOverride?: DockerOverride) => {
  const volumes = new Map<string, { owner: string; root?: string; host?: string }>();
  const helpers = new Map<string, { id: string; args: readonly string[] }>();
  let sequence = 0;
  const calls: string[][] = []; let name = "";
  const process: TrainingDockerProcess = async (args, options) => {
    calls.push([...args]);
    const result = (stdout: string, code = 0) => ({ stdout, code, stderr: "" });
    if (args[0] === "context") return result(JSON.stringify("unix:///var/run/docker.sock"));
    const command = args[2];
    if (command === "volume" || (command === "container" && args[3] !== "ls") ||
      (command === "container" && args.some(value => /name=.+-output-(seed|export)/u.test(value)))) {
      const custom = await storageOverride?.(args, options); if (custom) return custom;
      if (command === "volume") {
        const name = args[3] === "inspect" ? args[4]! : args.at(-1)!;
        if (args[3] === "create") { volumes.set(name, { owner: args[args.indexOf("--label") + 1]!.split("=")[1]! }); return result(name); }
        if (args[3] === "inspect") {
          const volume = volumes.get(name);
          return volume ? result(JSON.stringify({ Name: name, Driver: "local", Options: null, Labels: { "com.spawnfile.training.owner": volume.owner } })) : result("", 1);
        }
        if (args[3] === "rm") { const volume = volumes.get(name); if (volume?.root) await rm(volume.root, { recursive: true, force: true }); volumes.delete(name); return result(name); }
        if (args[3] === "ls") return result("");
      }
      if (args[3] === "create") {
        const helperName = args[args.indexOf("--name") + 1]!;
        const helper = { id: "c" + String(++sequence).padStart(63, "0"), args };
        helpers.set(helperName, helper); return result(helper.id);
      }
      const entry = [...helpers.entries()].find(([name, helper]) => name === args.at(-1) || helper.id === args.at(-1));
      if (args[3] === "inspect") {
        if (!entry) return result("", 1);
        if (args[5] === "{{json .State}}") return result(JSON.stringify({ Running: false, ExitCode: 0 }));
        return result([entry[1].id, `/${entry[0]}`, image, { "com.spawnfile.training.owner": entry[0] }].map(part => JSON.stringify(part)).join("\n"));
      }
      if (args[3] === "start" && entry) {
        const helperArgs = entry[1].args;
        const volumeMount = helperArgs.find(value => value.startsWith("type=volume,"))!;
        const hostMount = helperArgs.find(value => value.startsWith("type=bind,"))!;
        const volume = volumes.get(/src=([^,]+)/u.exec(volumeMount)![1]!)!;
        const host = /src=([^,]+)/u.exec(hostMount)![1]!;
        const seed = entry[0].endsWith("-seed");
        if (seed) volume.host = host;
        if (!volume.root) volume.root = await mkdtemp(path.join(path.dirname(host), ".fake-volume-"));
        const source = seed ? host : volume.root, destination = seed ? volume.root : host;
        for (const file of await readdir(source)) await cp(path.join(source, file), path.join(destination, file), { recursive: true, dereference: false, verbatimSymlinks: true, preserveTimestamps: true });
        await chmod(destination, (await stat(source)).mode & 0o7777);
        return result("spawnfile-output-copy-complete");
      }
      if (args[3] === "rm" && entry) { helpers.delete(entry[0]); return result(""); }
      if (args[3] === "ls") return result("");
      throw Error(`Unexpected fake storage command ${args}`);
    }
    const custom = await override?.(args, options); if (custom) return custom;
    if (command === "image") return result(args.at(-1)?.includes("com.spawnfile.training.execution")
      ? JSON.stringify("spawnfile.training-execution.v1") : image);
    if (command === "create") { name = args[args.indexOf("--name") + 1]!; return result(id); }
    if (command === "inspect") {
      if (args[4] === "{{json .State}}") return result(JSON.stringify({ Running: false, ExitCode: 0 }));
      return result([id, `/${name}`, image, { "com.spawnfile.training.owner": name }].map((part) => JSON.stringify(part)).join("\n"));
    }
    if (command === "start") { options.stdout?.('measuring'); options.stdout?.('{"status":"completed","index":"/run/training/output/index.json"}'); return result(""); }
    if (command === "rm" || command === "container" || command === "stop") return result("");
    throw Error(`Unexpected fake Docker command ${args}`);
  };
  return { process, calls, volumes, helpers, output: () => {
    const volume = [...volumes.values()].at(-1);
    if (!volume?.root || !volume.host) throw Error("Fake output volume has not been seeded");
    return { host: volume.host, live: volume.root };
  } };
};
