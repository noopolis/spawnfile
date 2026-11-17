import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { expect, it } from "vitest";

import { compiledAgentDigest, trialBaseKey, trialWakeKey } from "./digest.js";

const compiled = async (slug: string, files: Record<string, string>): Promise<string> => {
  const out = await mkdtemp(path.join(os.tmpdir(), "spawnfile-digest-"));
  for (const [file, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(out, file)), { recursive: true });
    await writeFile(path.join(out, file), text.split("{slug}").join(slug));
  }
  return compiledAgentDigest(out, slug);
};

const organization = (team: string, volume: string, fingerprint: string, prompt = "Write the story.") => ({
  "entrypoint.sh": `require_backed_mount 'm' '/m' '/m' 'spawnfile-exclusive-daimon-wake-fuse-${volume}' # {slug}`,
  "Dockerfile": `LABEL com.spawnfile.compile_fingerprint='sf1:${fingerprint}'\nRUN mkdir -p '/var/lib/spawnfile/resources/teams/${team}/corpus-1'`,
  "runtimes/daimon/agents/a/workspace/AGENTS.md": prompt,
  "spawnfile-report.json": `{"generated_at":"${Math.random()}"}`
});

it("digests the organization, not the trial's name, its volume lineage or where the project lives", async () => {
  const one = await compiled("trial-one-1234abcd", organization("team-x-private-tmp-a-11111111", "c1fafc1cf3e2ea53", "ff46a8d8a452"));
  const two = await compiled("trial-two-9876fedc", organization("team-x-private-tmp-b-22222222", "622430e1b05dec5a", "ffdaca8c40fa"));
  expect(two).toBe(one);
});

it("changes with any byte the agent sees", async () => {
  const base = await compiled("t-1", organization("t", "c1fafc1cf3e2ea53", "aa"));
  expect(await compiled("t-1", organization("t", "c1fafc1cf3e2ea53", "aa", "Write the story!"))).not.toBe(base);
  expect(await compiled("t-1", { ...organization("t", "c1fafc1cf3e2ea53", "aa"), "skills/new/SKILL.md": "x" })).not.toBe(base);
});

it("keys a moment by its content, never by where its directory or repository sits", () => {
  const moment = (directory: string, text: string) => ({ at: "x", wake: { text }, resources: [{ id: "r", fill: { kind: "directory", directory, revision: "f".repeat(64) } }] });
  expect(trialBaseKey("d", moment("/a", "w"))).toBe(trialBaseKey("d", moment("/b", "w")));
  expect(trialBaseKey("d", moment("/a", "w"))).not.toBe(trialBaseKey("d", moment("/a", "v")));
  expect(trialBaseKey("d", undefined)).not.toBe(trialBaseKey("e", undefined));
  expect(trialWakeKey("go", 1)).not.toBe(trialWakeKey("go", 2));
});
