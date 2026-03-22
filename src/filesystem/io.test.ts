import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import {
  copyDirectory,
  ensureDirectory,
  fileExists,
  readUtf8File,
  removeDirectory,
  writeUtf8File
} from "./io.js";

const createdDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(createdDirectories.splice(0).map((directory) => removeDirectory(directory)));
});

describe("io", () => {
  it("writes and reads utf8 files", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-io-"));
    createdDirectories.push(directory);

    const filePath = path.join(directory, "note.txt");
    await writeUtf8File(filePath, "hello");

    await expect(readUtf8File(filePath)).resolves.toBe("hello");
    await expect(fileExists(filePath)).resolves.toBe(true);
  });

  it("creates directories recursively", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-dir-"));
    createdDirectories.push(directory);

    const nestedDirectory = path.join(directory, "a", "b");
    await ensureDirectory(nestedDirectory);

    await expect(fileExists(nestedDirectory)).resolves.toBe(true);
  });

  it("copies directories recursively with filtering", async () => {
    const sourceDirectory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-copy-src-"));
    const destinationDirectory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-copy-dst-"));
    createdDirectories.push(sourceDirectory, destinationDirectory);

    await writeUtf8File(path.join(sourceDirectory, "keep.txt"), "keep");
    await ensureDirectory(path.join(sourceDirectory, ".git"));
    await writeUtf8File(path.join(sourceDirectory, ".git", "ignored.txt"), "ignored");

    await copyDirectory(sourceDirectory, path.join(destinationDirectory, "copy"), {
      filter: (sourcePath) => !sourcePath.includes(`${path.sep}.git`)
    });

    await expect(fileExists(path.join(destinationDirectory, "copy", "keep.txt"))).resolves.toBe(true);
    await expect(
      fileExists(path.join(destinationDirectory, "copy", ".git", "ignored.txt"))
    ).resolves.toBe(false);
  });
});
