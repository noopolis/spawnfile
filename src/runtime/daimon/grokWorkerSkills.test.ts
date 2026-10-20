import { describe, expect, it } from "vitest";

import { DAIMON_GROK_WORKER_SKILLS_SAMPLES } from "./grokWorkerConfigBytes.js";
import {
  daimonAgentSkillsFromResolved,
  daimonGrokWorkerSkillsSha256,
  parseDaimonAgentSkills,
  renderDaimonGrokWorkerSkillsTree,
  resolveDaimonGrokWorkerSkills,
  type DaimonAgentSkill
} from "./grokWorkerSkills.js";

const clone = (skills: readonly { name: string; files: readonly { path: string; content: string }[] }[]): DaimonAgentSkill[] =>
  skills.map((skill) => ({ name: skill.name, files: skill.files.map((file) => ({ ...file })) }));

describe("Daimon Grok worker skills mirror", () => {
  it("reproduces Daimon's own digest and tree for every vendored sample", () => {
    expect(DAIMON_GROK_WORKER_SKILLS_SAMPLES.length).toBeGreaterThan(2);
    for (const sample of DAIMON_GROK_WORKER_SKILLS_SAMPLES) {
      expect(daimonGrokWorkerSkillsSha256(clone(sample.skills))).toBe(sample.sha256);
      expect(renderDaimonGrokWorkerSkillsTree(clone(sample.skills))).toEqual(sample.tree);
    }
  });

  it("renders nothing and carries no registration member for no skills", () => {
    expect(renderDaimonGrokWorkerSkillsTree([])).toEqual([]);
    expect(resolveDaimonGrokWorkerSkills([])).toBeUndefined();
    expect(resolveDaimonGrokWorkerSkills(undefined)).toBeUndefined();
  });

  it("lowers declared skills to one SKILL.md each and digests them order-independently", () => {
    const skills = daimonAgentSkillsFromResolved([{ name: "b", content: "B\n" }, { name: "a", content: "A\n" }]);
    expect(skills).toEqual([{ name: "b", files: [{ path: "SKILL.md", content: "B\n" }] }, { name: "a", files: [{ path: "SKILL.md", content: "A\n" }] }]);
    const resolved = resolveDaimonGrokWorkerSkills(skills)!;
    expect(resolved.sha256).toBe(daimonGrokWorkerSkillsSha256([...skills].reverse()));
    expect(resolved.tree.map((entry) => [entry.path, entry.kind, entry.mode])).toEqual([
      ["skills", "directory", 0o555], ["skills/a", "directory", 0o555], ["skills/a/SKILL.md", "file", 0o444],
      ["skills/b", "directory", 0o555], ["skills/b/SKILL.md", "file", 0o444]
    ]);
  });

  it("refuses what Daimon's parser refuses", () => {
    const file = [{ path: "SKILL.md", content: "x" }];
    for (const skills of [
      [{ name: ".hidden", files: file }],
      [{ name: "a", files: file }, { name: "a", files: file }],
      [{ name: "a", files: [{ path: "README.md", content: "x" }] }],
      [{ name: "a", files: [...file, { path: "../escape", content: "x" }] }],
      [{ name: "a", files: [...file, { path: "ref", content: "x" }, { path: "ref/inner", content: "x" }] }],
      [{ name: "a", files: [{ path: "SKILL.md", content: "\ud800" }] }],
      [{ name: "a", files: [{ path: "SKILL.md", content: "x".repeat(262_145) }] }],
      [{ name: "a", files: [] }]
    ]) expect(() => parseDaimonAgentSkills(skills)).toThrow(/Invalid Daimon agent skills/u);
  });
});
