import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { VOLUME_RESOURCE_SENTINEL } from "./feedLayout.js";
import { DEFAULT_FEED_HEAL_LIMIT, type FeedTarget } from "./feedTarget.js";

export interface FeedFixture {
  cleanup: () => void;
  root: string;
  source: string;
  target: FeedTarget;
  volume: string;
}

/** A volume shaped like one a container has initialized: mode 0755 with its resource sentinel. */
export const createFeedFixture = (overrides: Partial<FeedTarget> = {}): FeedFixture => {
  const root = mkdtempSync(path.join(tmpdir(), "spawnfile-feed-"));
  const volume = path.join(root, "volume", "_data"), source = path.join(root, "source");
  mkdirSync(volume, { recursive: true });
  chmodSync(volume, 0o755);
  writeFileSync(path.join(volume, VOLUME_RESOURCE_SENTINEL), "sha256:fixture\n", { mode: 0o644 });
  mkdirSync(source);
  writeFileSync(path.join(source, "a.txt"), "alpha\n");
  const target: FeedTarget = {
    healLimit: DEFAULT_FEED_HEAL_LIMIT, keep: 1, resourceId: "shared-data", source: { directory: source, kind: "directory" },
    stateDir: path.join(root, "volume", "spawnfile-feed"), volume, volumeName: "shared-data-vol", ...overrides
  };
  const cleanup = (): void => {
    // Frozen trees are a-w; restore write so the temp root can be removed.
    const thaw = (directory: string): void => {
      try { if (!lstatSync(directory).isDirectory()) return; chmodSync(directory, 0o755); } catch { return; }
      for (const name of readdirSync(directory)) thaw(path.join(directory, name));
    };
    thaw(root);
    rmSync(root, { force: true, recursive: true });
  };
  return { cleanup, root, source, target, volume };
};

export const writeSourceFiles = (directory: string, files: Record<string, string>): void => {
  rmSync(directory, { force: true, recursive: true });
  mkdirSync(directory, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(directory, name)), { recursive: true });
    writeFileSync(path.join(directory, name), content);
  }
};
