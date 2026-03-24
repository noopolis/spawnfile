import path from "node:path";
import { cp, mkdir, lstat, readFile, rm, stat, writeFile } from "node:fs/promises";

export interface CopyDirectoryOptions {
  filter?: (sourcePath: string, destinationPath: string) => boolean;
}

export const copyDirectory = async (
  sourcePath: string,
  destinationPath: string,
  options: CopyDirectoryOptions = {}
): Promise<void> => {
  await cp(sourcePath, destinationPath, {
    filter: options.filter,
    force: true,
    recursive: true
  });
};

export const ensureDirectory = async (directoryPath: string): Promise<void> => {
  await mkdir(directoryPath, { recursive: true });
};

export const fileExists = async (filePath: string): Promise<boolean> => {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
};

export const isSymlink = async (filePath: string): Promise<boolean> => {
  try {
    const stats = await lstat(filePath);
    return stats.isSymbolicLink();
  } catch {
    return false;
  }
};

export const readUtf8File = async (filePath: string): Promise<string> =>
  readFile(filePath, "utf8");

export const ensureGitignoreEntry = async (
  directoryPath: string,
  entry: string
): Promise<boolean> => {
  const gitignorePath = path.join(directoryPath, ".gitignore");
  const normalizedEntry = entry.trim();
  if (normalizedEntry.length === 0) {
    return false;
  }

  const existingSource = (await fileExists(gitignorePath)) ? await readUtf8File(gitignorePath) : "";
  const existingEntries = new Set(
    existingSource
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
  );

  if (existingEntries.has(normalizedEntry)) {
    return false;
  }

  const nextSource =
    existingSource.length === 0
      ? `${normalizedEntry}\n`
      : `${existingSource}${existingSource.endsWith("\n") ? "" : "\n"}${normalizedEntry}\n`;

  await writeUtf8File(gitignorePath, nextSource);
  return true;
};

export const removeDirectory = async (directoryPath: string): Promise<void> => {
  await rm(directoryPath, { force: true, recursive: true });
};

export const writeUtf8File = async (
  filePath: string,
  content: string
): Promise<void> => {
  await writeFile(filePath, content, "utf8");
};
