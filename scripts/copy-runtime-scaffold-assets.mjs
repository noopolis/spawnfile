import { cp, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = path.join(repoRoot, "src", "runtime");
const destinationRoot = path.join(repoRoot, "dist", "runtime");

const entries = await readdir(sourceRoot, { withFileTypes: true });

for (const entry of entries) {
  if (!entry.isDirectory()) {
    continue;
  }

  const sourcePath = path.join(sourceRoot, entry.name, "scaffold-assets");
  const destinationPath = path.join(destinationRoot, entry.name, "scaffold-assets");

  try {
    await cp(sourcePath, destinationPath, { force: true, recursive: true });
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  }
}
