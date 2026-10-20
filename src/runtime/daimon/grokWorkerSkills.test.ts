import { describe, expect, it } from "vitest";

import { DAIMON_AGENT_SKILLS_RULES, DAIMON_GROK_WORKER_SKILLS_SAMPLES } from "./grokWorkerConfigBytes.js";
import {
  DAIMON_AGENT_SKILL_COMPONENT,
  DAIMON_AGENT_SKILLS_BOUNDS,
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

  it("uses exactly Daimon's vendored bounds and name rule, at and past every limit", () => {
    const bounds = DAIMON_AGENT_SKILLS_RULES.bounds;
    expect(DAIMON_AGENT_SKILLS_BOUNDS).toEqual(bounds);
    expect(DAIMON_AGENT_SKILL_COMPONENT.source).toBe(DAIMON_AGENT_SKILLS_RULES.componentPattern);
    const ok = (skills: DaimonAgentSkill[]) => expect(() => parseDaimonAgentSkills(skills)).not.toThrow();
    const refused = (skills: DaimonAgentSkill[]) => expect(() => parseDaimonAgentSkills(skills)).toThrow(/Invalid Daimon agent skills/u);
    const skillMd = { path: "SKILL.md", content: "x" };
    const named = (count: number) => Array.from({ length: count }, (_, index) => ({ name: `s${index}`, files: [skillMd] }));
    ok(named(bounds.skills)); refused(named(bounds.skills + 1));
    const files = (count: number) => [{ name: "a", files: [skillMd, ...Array.from({ length: count - 1 }, (_, index) => ({ path: `f${index}`, content: "" }))] }];
    ok(files(bounds.filesPerSkill)); refused(files(bounds.filesPerSkill + 1));
    ok([{ name: "a", files: [{ path: "SKILL.md", content: "x".repeat(bounds.fileBytes) }] }]);
    refused([{ name: "a", files: [{ path: "SKILL.md", content: "x".repeat(bounds.fileBytes + 1) }] }]);
    const total = (extra: number) => Array.from({ length: bounds.totalBytes / bounds.fileBytes }, (_, index) =>
      ({ name: `t${index}`, files: [{ path: "SKILL.md", content: "x".repeat(bounds.fileBytes) }] }))
      .concat(extra ? [{ name: "over", files: [{ path: "SKILL.md", content: "x".repeat(extra) }] }] : []);
    ok(total(0)); refused(total(1));
    const deep = (depth: number) => [{ name: "a", files: [skillMd, { path: Array.from({ length: depth }, (_, index) => `d${index}`).join("/"), content: "" }] }];
    ok(deep(bounds.depth)); refused(deep(bounds.depth + 1));
    ok([{ name: `a${"b".repeat(127)}`, files: [skillMd] }]); refused([{ name: `a${"b".repeat(128)}`, files: [skillMd] }]);
    for (const name of ["-lead", ".dot", "has space", "slash/inside", ""]) refused([{ name, files: [skillMd] }]);
  });
});
