import { cp, mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const readAssetList = async (metadata: string): Promise<string[]> => {
  const contents = await readFile(metadata, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "[]";
    throw error;
  });
  const files: unknown = JSON.parse(contents);
  if (!Array.isArray(files) || !files.every((file: unknown) => (
    typeof file === "string" && /^[\w.-]+(?:\/[\w.-]+)*$/u.test(file)
      && file.split("/").every((part) => part !== ".." && part !== ".")
  ))) {
    throw new Error(`Invalid runtime package asset list: ${metadata}`);
  }
  return files;
};

const copyRuntimePackageAssets = async (sourceRoot: string, destinationRoot: string): Promise<void> => {
  for (const entry of await readdir(sourceRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const sourceDirectory = path.join(sourceRoot, entry.name);
    const destinationDirectory = path.join(destinationRoot, entry.name);
    const files = await readAssetList(path.join(sourceDirectory, "package-assets.json"));
    for (const file of files) {
      const destination = path.join(destinationDirectory, file);
      await mkdir(path.dirname(destination), { recursive: true });
      await cp(path.join(sourceDirectory, file), destination, {
        filter: (source) => !["AGENTS.md", "CLAUDE.md"].includes(path.basename(source)),
        force: true,
        recursive: true
      });
    }
  }
};

const sourceRoot = fileURLToPath(new URL(".", import.meta.url));
await copyRuntimePackageAssets(sourceRoot, path.resolve(sourceRoot, "../../dist/runtime"));
