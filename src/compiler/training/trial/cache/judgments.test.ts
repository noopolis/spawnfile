import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { expect, it } from "vitest";

import { openJudgmentCacheStore } from "./judgments.js";

it("hands the n-th recorded reply to the n-th identical request of a process, and keeps the first writer", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "spawnfile-judgments-"));
  const first = openJudgmentCacheStore(root);
  expect(await first.take("k")).toEqual({ occurrence: 0 });
  await first.put("k", 0, "a");
  await first.put("k", 0, "late");
  expect(await first.take("k")).toEqual({ occurrence: 1 });
  await first.put("k", 1, "b");
  const second = openJudgmentCacheStore(root);
  expect([await second.take("k"), await second.take("k"), await second.take("k")]).toEqual([{ occurrence: 0, reply: "a" }, { occurrence: 1, reply: "b" }, { occurrence: 2 }]);
  expect(await openJudgmentCacheStore(root, false).take("k")).toEqual({ occurrence: 0 });
});
