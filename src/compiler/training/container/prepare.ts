import { lstat, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { trainingContextSchema, type TrainingContext } from "../contract.js";
import { trainingContainerConfigSchema, type TrainingContainerConfig } from "./contract.js";

const inside = (root: string, value: string): boolean => value === root || value.startsWith(`${root}/`);
export const prepareTrainingContainer = async (raw: unknown, context: TrainingContext, args: readonly string[]): Promise<{
  config: TrainingContainerConfig; context: TrainingContext; args: string[]; viewerPort?: number;
}> => {
  const config = trainingContainerConfigSchema.parse(raw);
  const entries = [...config.inputs, config.output];
  const home = path.resolve(os.homedir());
  const globalConfigRoots = [".codex", ".claude", ".grok", ".ssh", ".config"].map((name) => path.join(home, name));
  for (const entry of [...entries, ...config.auth]) {
    const canonical = await realpath(entry.source);
    if (canonical !== entry.source) throw Error("Training bind sources must be canonical, without symlink aliases");
    const stat = await lstat(canonical);
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw Error("Training binds require regular files or directories");
    if (config.auth.includes(entry as TrainingContainerConfig["auth"][number]) && !stat.isFile()) throw Error("Auth must be a single regular leaf file");
    if (entries.includes(entry as TrainingContainerConfig["output"])) {
      if (["/", "/etc", "/var", "/run", "/tmp", "/opt", "/usr", "/Users", "/home", home].includes(canonical) || globalConfigRoots.some((root) => inside(root, canonical))) throw Error("Host homes, configuration and system roots cannot be training inputs");
      if (config.auth.some((auth) => inside(canonical, auth.source))) throw Error("Auth must not be exposed through input or output mounts");
    }
  }
  if (config.inputs.some((entry, index) => config.inputs.some((other, otherIndex) => index !== otherIndex && inside(entry.source, other.source)))) throw Error("Training input source roots must not overlap");
  if (!(await lstat(config.output.source)).isDirectory()) throw Error("Training output must be an existing directory");
  if (config.inputs.some((entry) => inside(entry.source, config.output.source) || inside(config.output.source, entry.source))) throw Error("Training output and inputs must not overlap");
  const map = (value: string): string => {
    const absolute = path.resolve(value);
    const entry = entries.find((item) => inside(item.source, absolute));
    if (!entry) throw Error(`Training path is not covered by a declared mount: ${value}`);
    return path.posix.join(entry.destination, path.relative(entry.source, absolute).split(path.sep).join("/"));
  };
  const source = <T extends { sourcePath: string }>(entry: T): T => ({ ...entry, sourcePath: map(entry.sourcePath) });
  const mapped = trainingContextSchema.parse({ ...context,
    project: { ...context.project, root: map(context.project.root), manifest: map(context.project.manifest) },
    agent: { ...context.agent, source: map(context.agent.source) },
    sources: context.sources.map(source), documents: context.documents.map(source), skills: context.skills.map(source)
  });
  const mappedArgs = [...args];
  let viewerPort: number | undefined;
  for (let index = 0; index < mappedArgs.length; index++) {
    const flag = mappedArgs[index];
    if (["--train", "--test", "--out", "--cost-config"].includes(flag!)) {
      const value = mappedArgs[++index];
      if (!value) throw Error(`Missing ${flag} path`);
      mappedArgs[index] = map(value);
      if (flag === "--out" && !inside("/run/training/output", mappedArgs[index]!)) throw Error("Training --out must use the writable output mount");
    } else if (flag === "--resource") {
      const value = mappedArgs[++index] ?? "", equals = value.indexOf("=");
      if (equals < 1) throw Error("Expected resource=id path mapping");
      mappedArgs[index] = `${value.slice(0, equals)}=${map(value.slice(equals + 1))}`;
    } else if (flag === "--bridge-command") {
      const value = mappedArgs[++index] ?? "";
      if (!/^\/opt\/training\/[A-Za-z0-9._/-]+$/u.test(value) || path.posix.normalize(value) !== value) throw Error("Bridge must be an installed executable under /opt/training");
    } else if (flag === "--view") {
      const value = mappedArgs[++index] ?? "";
      const port = Number(value);
      if (viewerPort !== undefined || !/^\d+$/u.test(value) || !Number.isSafeInteger(port) || port < 1 || port > 65535) throw Error("Container --view requires one explicit port from 1 to 65535");
      viewerPort = port;
      mappedArgs[index] = String(port);
    }
  }
  return { config, context: mapped, args: mappedArgs, ...(viewerPort === undefined ? {} : { viewerPort }) };
};
