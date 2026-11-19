import { appendFileSync, existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

type DockerfileImage = { runtime: string; context: string; image: string; version: string; build_args: string[] };
type ScriptedImage = { runtime: string; publisher: string; local_builder: string };
type RuntimeImageCatalog = { dockerfiles: DockerfileImage[]; scripted: ScriptedImage[] };

export const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

const runtimeDirectory = "src/runtime";
const runtimeNamePattern = /^[a-z0-9][a-z0-9-]*$/u;
const scriptNamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]*\.ts$/u;
const imageNamePattern = /^[a-z0-9][a-z0-9._/-]+$/u;
const imageTagPattern = /^[\w][\w.-]{0,127}$/u;
const buildArgPattern = /^[A-Z_][A-Z0-9_]*=[^\u0000-\u001f\u007f]*$/u;

const requireFile = (root: string, file: string): void => {
  if (!lstatSync(path.join(root, file)).isFile()) throw new Error(`Expected a repository file at ${file}`);
};

const readImageMetadata = (root: string, file: string): Record<string, unknown> => {
  requireFile(root, file);
  const value: unknown = JSON.parse(readFileSync(path.join(root, file), "utf8"));
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid image metadata: ${file}`);
  return value as Record<string, unknown>;
};

export const discoverRuntimeImages = (root: string, selection = "all"): RuntimeImageCatalog => {
  const catalog: RuntimeImageCatalog = { dockerfiles: [], scripted: [] };
  const entries = readdirSync(path.join(root, runtimeDirectory), { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || (selection !== "all" && entry.name !== selection)) continue;
    const runtime = entry.name;
    const context = `${runtimeDirectory}/${runtime}/image`;
    const file = `${context}/build.json`;
    if (!existsSync(path.join(root, file))) continue;
    if (!lstatSync(path.join(root, context)).isDirectory()) throw new Error(`Expected a repository directory at ${context}`);
    if (!runtimeNamePattern.test(runtime)) throw new Error(`Invalid runtime image name: ${runtime}`);
    const metadata = readImageMetadata(root, file);
    if ("publisher" in metadata) {
      const { publisher, local_builder } = metadata;
      if (Object.keys(metadata).length !== 2 || typeof publisher !== "string" || !scriptNamePattern.test(publisher)
        || typeof local_builder !== "string" || !scriptNamePattern.test(local_builder)) {
        throw new Error(`Invalid scripted image metadata: ${file}`);
      }
      const item = { runtime, publisher: `${context}/${publisher}`, local_builder: `${context}/${local_builder}` };
      requireFile(root, item.publisher);
      requireFile(root, item.local_builder);
      catalog.scripted.push(item);
    } else {
      const { image, version, build_args = [] } = metadata;
      if (Object.keys(metadata).some((key) => !["image", "version", "build_args"].includes(key))
        || typeof image !== "string" || !imageNamePattern.test(image) || typeof version !== "string" || !imageTagPattern.test(version)
        || !Array.isArray(build_args) || !build_args.every((value: unknown) => typeof value === "string" && buildArgPattern.test(value))) {
        throw new Error(`Invalid Dockerfile image metadata: ${file}`);
      }
      requireFile(root, `${context}/Dockerfile`);
      catalog.dockerfiles.push({ runtime, context, image, version, build_args });
    }
  }
  if (selection !== "all" && catalog.dockerfiles.length + catalog.scripted.length === 0) {
    throw new Error(`Unknown repository runtime image: ${selection}`);
  }
  return catalog;
};

const imageStepOutputs = (catalog: RuntimeImageCatalog, selection: string, lane: string): string => {
  if (selection === "all") throw new Error("Image build steps must select one runtime");
  if (lane === "dockerfile" && catalog.dockerfiles.length === 1) {
    const { context, image, version, build_args } = catalog.dockerfiles[0]!;
    return [
      `context=${context}`,
      `image=${image}`,
      `version=${version}`,
      "build_args<<EOF",
      ...build_args,
      "EOF",
      ""
    ].join("\n");
  }
  if (lane === "scripted" && catalog.scripted.length === 1) {
    return `publisher=${catalog.scripted[0]!.publisher}\n`;
  }
  throw new Error(`Runtime ${selection} does not supply a ${lane} image build`);
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [selection = "all", option, lane, ...extra] = process.argv.slice(2);
  const catalog = discoverRuntimeImages(repositoryRoot, selection);
  const output = process.env.GITHUB_OUTPUT;
  if (option !== undefined) {
    if (option !== "--job-metadata" || (lane !== "dockerfile" && lane !== "scripted") || extra.length > 0 || !output) {
      throw new Error("Usage: runtime-image-catalog.ts <runtime> --job-metadata <dockerfile|scripted> (requires GITHUB_OUTPUT)");
    }
    appendFileSync(output, imageStepOutputs(catalog, selection, lane));
  } else if (output) {
    const dockerfiles = catalog.dockerfiles.map(({ runtime }) => runtime);
    const scripted = catalog.scripted.map(({ runtime }) => runtime);
    appendFileSync(output, `dockerfiles=${JSON.stringify(dockerfiles)}\nscripted=${JSON.stringify(scripted)}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(catalog)}\n`);
  }
}
