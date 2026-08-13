import { createHash, randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { resolveSpawnfileHome } from "../auth/index.js";
import { ensureDirectory } from "../filesystem/index.js";

export const BUILD_IMAGE_CACHE_VERSION = "spawnfile.build-image-cache.v1" as const;

export const buildImageCacheEntrySchema = z.object({
  compileFingerprint: z.string().min(1),
  contextDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  dockerContext: z.string().min(1).nullable(),
  imageId: z.string().min(1),
  imageTag: z.string().min(1),
  projectRoot: z.string().min(1),
  version: z.literal(BUILD_IMAGE_CACHE_VERSION),
  writtenAt: z.string().min(1)
}).strict();

export type BuildImageCacheEntry = z.infer<typeof buildImageCacheEntrySchema>;

export interface BuildImageCacheKeyInput {
  dockerContext?: string | null;
  imageTag: string;
  projectRoot: string;
}

export const createBuildImageCacheKey = (
  input: BuildImageCacheKeyInput
): string =>
  createHash("sha256")
    .update(`${input.projectRoot}\0${input.imageTag}\0${input.dockerContext ?? ""}`)
    .digest("hex");

export const resolveBuildImageCacheDirectory = (): string =>
  path.join(resolveSpawnfileHome(), "build-image-cache");

export const resolveBuildImageCachePath = (
  input: BuildImageCacheKeyInput
): string =>
  path.join(resolveBuildImageCacheDirectory(), `${createBuildImageCacheKey(input)}.json`);

export const readBuildImageCacheEntry = async (
  input: BuildImageCacheKeyInput
): Promise<BuildImageCacheEntry | null> => {
  try {
    const source = await readFile(resolveBuildImageCachePath(input), "utf8");
    return buildImageCacheEntrySchema.parse(JSON.parse(source));
  } catch {
    return null;
  }
};

export const writeBuildImageCacheEntry = async (
  entry: BuildImageCacheEntry
): Promise<boolean> => {
  let temporaryPath: string | null = null;
  try {
    const parsed = buildImageCacheEntrySchema.parse(entry);
    const directory = resolveBuildImageCacheDirectory();
    await ensureDirectory(directory);
    const destinationPath = resolveBuildImageCachePath(parsed);
    temporaryPath = path.join(
      directory,
      `.${path.basename(destinationPath)}.${process.pid}.${randomUUID()}.tmp`
    );
    await writeFile(temporaryPath, `${JSON.stringify(parsed, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600
    });
    await rename(temporaryPath, destinationPath);
    temporaryPath = null;
    return true;
  } catch {
    if (temporaryPath) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
    return false;
  }
};
