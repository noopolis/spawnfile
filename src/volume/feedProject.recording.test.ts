import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { stringify } from "yaml";
import { afterEach, expect, it } from "vitest";

import { DEFAULT_RECORD_KEEP_MS } from "../shared/index.js";
import { findDeclaredVolumeFeeds, resolveFeedTarget } from "./feedProject.js";
import { createFeedFixture, type FeedFixture } from "./feedTestKit.js";

let fixture: FeedFixture;
afterEach(() => fixture?.cleanup());

it("uses effective recording only from agents consuming a feed, taking the maximum window", async () => {
  fixture = createFeedFixture();
  const root = path.join(fixture.root, "org");
  mkdirSync(root);
  const resource = (id: string) => ({ id, kind: "volume", name: `${id}-vol`, mode: "mutable", mount: `./${id}`, feed: { directory: fixture.source } });
  for (const [name, keep] of [["short", "2h"], ["long", "4d"], ["off", undefined]]) {
    mkdirSync(path.join(root, name!));
    writeFileSync(path.join(root, name!, "Spawnfile"), stringify({
      spawnfile_version: "0.1", kind: "agent", name, runtime: "openclaw",
      ...(keep ? { training: { record: { keep } } } : { workspace: { resources: [resource("private")] } })
    }));
  }
  const team = (record: { keep?: string } | undefined) => ({
    spawnfile_version: "0.1", kind: "team", name: "news", mode: "swarm",
    shared: { workspace: { resources: [resource("shared")] }, ...(record ? { training: { record } } : {}) },
    members: ["short", "long", "off"].map((id) => ({ id, ref: id }))
  });
  writeFileSync(path.join(root, "Spawnfile"), stringify(team(undefined)));
  expect((await findDeclaredVolumeFeeds(root)).map(({ id, record }) => ({ id, record }))).toEqual([
    { id: "private", record: undefined }, { id: "shared", record: { keepMs: 4 * 86_400_000 } }
  ]);
  expect((await resolveFeedTarget(root, "shared", { volumePath: fixture.volume })).record).toEqual({ keepMs: 4 * 86_400_000 });
  writeFileSync(path.join(root, "Spawnfile"), stringify(team({})));
  expect((await findDeclaredVolumeFeeds(root)).every((feed) => feed.record?.keepMs === DEFAULT_RECORD_KEEP_MS)).toBe(true);
});
