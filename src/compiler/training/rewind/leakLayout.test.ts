import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanTrainingProjects } from "../plan/fixtures.test-helper.js";
import { AT, rewindFixture } from "./fixtures.test-helper.js";
import { leakCheckTrainingMoment } from "./leakCheck.js";
import { finalizeTrainingMoment, materializeTrainingMoment } from "./materialize.js";
import { stampTree } from "./timestamps.js";

afterEach(cleanTrainingProjects);
describe("closed rewind payload layouts", () => {
  it.each(["root", "wrapper", "memory-root", "memory-ledger", "moltnet", "feed-root", "feed-tree"])
    ("rejects a stamped extra entry at %s", async (location) => {
      const f = await rewindFixture(), moment = await materializeTrainingMoment(f.options);
      expect(moment.status, JSON.stringify(moment.inputs)).toBe("materialized");
      const input = moment.inputs.find((entry) => entry.kind === (location.startsWith("memory") ? "memory"
        : location.startsWith("feed") ? "feed" : "moltnet"))!;
      let directory = location === "root" ? f.options.out : location === "wrapper" ? path.join(f.options.out, "resources")
        : path.join(f.options.out, input.path!, location === "memory-ledger" ? "memory" : location === "feed-tree" ? "trees" : "");
      if (location === "feed-tree") {
        directory = path.join(directory, "a".repeat(64)); await mkdir(directory);
      }
      await writeFile(path.join(directory, "unrelated.txt"), "post-instant bytes");
      await stampTree(f.options.out, AT, AT);
      const report = await leakCheckTrainingMoment(f.options.out, { historyDir: f.historyDir });
      const expectedClass = location === "root" || location === "wrapper" ? "bundle-entry"
        : location.startsWith("memory") ? "memory-event" : location.startsWith("feed") ? "feed-identity" : "moltnet-message";
      expect(report.findings).toContainEqual(expect.objectContaining({ class: expectedClass, detail: expect.stringMatching(/Unexpected/u) }));
      expect(report.findings.some((finding) => finding.class === "file-time")).toBe(false);
      const out = path.join(f.root, "refused");
      expect((await finalizeTrainingMoment(f.options.out, out, { historyDir: f.historyDir })).status).toBe("refused");
      expect(await readdir(out)).toEqual(["leak-check.json", "moment.json"]);
      expect(JSON.parse(await readFile(path.join(out, "leak-check.json"), "utf8")).ok).toBe(false);
    });
});
