import { createHash } from "node:crypto";

import { SpawnfileError } from "../../shared/index.js";
import type { ResolvedSkill } from "../../compiler/types.js";

/**
 * Mirror of Daimon's `grokWorkerSkills.ts` (`@noopolis/daimon/runtime` 0.2.2):
 * the engine-neutral skills input, its `noopolis.daimon.grok-worker-skills.v1`
 * digest and the `$GROK_HOME/skills` tree root provisioning writes. Pinned to
 * Daimon's own output by `DAIMON_GROK_WORKER_SKILLS_SAMPLES`
 * (`scripts/vendor-daimon-grok-contract.ts`), exactly as the sandbox profile
 * mirror is: production renders `service.json` at compile time and never
 * loads Daimon, while the broker re-hashes the provisioned tree before every
 * turn, so one byte of drift here refuses every Grok turn rather than
 * degrading quietly. Training additionally cross-checks this digest against
 * Daimon's projection (`training/broker/projection.ts`).
 */
export const DAIMON_GROK_WORKER_SKILLS_LAYOUT = {
  relativePath: "skills", uid: 0, gid: 0, directoryMode: 0o555, fileMode: 0o444,
  digestVersion: "noopolis.daimon.grok-worker-skills.v1"
} as const;
export const DAIMON_AGENT_SKILLS_BOUNDS = { skills: 64, filesPerSkill: 64, fileBytes: 262_144, totalBytes: 4_194_304, depth: 8 } as const;

export interface DaimonAgentSkillFile { path: string; content: string }
export interface DaimonAgentSkill { name: string; files: DaimonAgentSkillFile[] }
export interface DaimonGrokWorkerSkillsEntry { path: string; kind: "directory" | "file"; uid: number; gid: number; mode: number; content?: string }
/** What a registration carries when its agent declares skills; absent otherwise. */
export interface DaimonGrokWorkerSkills { sha256: string; tree: DaimonGrokWorkerSkillsEntry[] }

/** Daimon's skill name and path component rule (vendored as `DAIMON_AGENT_SKILLS_RULES.componentPattern`). */
export const DAIMON_AGENT_SKILL_COMPONENT = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/u;
const COMPONENT = DAIMON_AGENT_SKILL_COMPONENT;
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u;
const invalid = (detail: string): never => { throw new SpawnfileError("compile_error", `Invalid Daimon agent skills: ${detail}`); };
const compare = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
const byteLength = (content: string): number => Buffer.byteLength(content, "utf8");

/** Daimon's `parseAgentSkills`: the same refusals, sorted by name and path so equal sets digest equally. */
export const parseDaimonAgentSkills = (skills: readonly DaimonAgentSkill[]): DaimonAgentSkill[] => {
  if (skills.length > DAIMON_AGENT_SKILLS_BOUNDS.skills) invalid("too many skills");
  let total = 0;
  const names = new Set<string>();
  const parsed = skills.map((skill) => {
    if (!COMPONENT.test(skill.name)) invalid(`skill name ${JSON.stringify(skill.name)}`);
    if (names.has(skill.name)) invalid(`duplicate skill ${skill.name}`);
    names.add(skill.name);
    if (skill.files.length === 0 || skill.files.length > DAIMON_AGENT_SKILLS_BOUNDS.filesPerSkill) invalid(`files of ${skill.name}`);
    const paths = new Set<string>();
    for (const file of skill.files) {
      const parts = file.path.split("/");
      if (parts.length > DAIMON_AGENT_SKILLS_BOUNDS.depth || parts.some((part) => !COMPONENT.test(part))) invalid(`path ${JSON.stringify(`${skill.name}/${file.path}`)}`);
      const bytes = byteLength(file.content);
      if (bytes > DAIMON_AGENT_SKILLS_BOUNDS.fileBytes) invalid(`size of ${skill.name}/${file.path}`);
      total += bytes;
      if (paths.has(file.path)) invalid(`duplicate path ${skill.name}/${file.path}`);
      paths.add(file.path);
      if (LONE_SURROGATE.test(file.content)) invalid(`content of ${skill.name}/${file.path} is not Unicode text`);
    }
    for (const candidate of paths) if ([...paths].some((other) => other.startsWith(`${candidate}/`))) invalid(`path collision ${skill.name}/${candidate}`);
    if (!paths.has("SKILL.md")) invalid(`${skill.name} has no SKILL.md`);
    return { name: skill.name, files: skill.files.map((file) => ({ path: file.path, content: file.content })).sort((a, b) => compare(a.path, b.path)) };
  });
  if (total > DAIMON_AGENT_SKILLS_BOUNDS.totalBytes) invalid("total size");
  return parsed.sort((a, b) => compare(a.name, b.name));
};

/** Daimon's `grokWorkerSkillsSha256`: sha256 over the canonical (key-sorted) description of the tree. */
export const daimonGrokWorkerSkillsSha256 = (skills: readonly DaimonAgentSkill[]): string => {
  // Keys are written in canonical (sorted) order, so plain JSON.stringify is Daimon's canonicalJson here.
  const description = {
    skills: parseDaimonAgentSkills(skills).map((skill) => ({
      files: skill.files.map((file) => ({ bytes: byteLength(file.content), path: file.path, sha256: createHash("sha256").update(file.content, "utf8").digest("hex") })),
      name: skill.name
    })),
    version: DAIMON_GROK_WORKER_SKILLS_LAYOUT.digestVersion
  };
  return createHash("sha256").update(JSON.stringify(description)).digest("hex");
};

/** Daimon's `renderGrokWorkerSkillsTree`: every entry under `$GROK_HOME`, parents before children; none for no skills. */
export const renderDaimonGrokWorkerSkillsTree = (skills: readonly DaimonAgentSkill[]): DaimonGrokWorkerSkillsEntry[] => {
  const parsed = parseDaimonAgentSkills(skills);
  if (parsed.length === 0) return [];
  const { relativePath, uid, gid, directoryMode, fileMode } = DAIMON_GROK_WORKER_SKILLS_LAYOUT;
  const directory = (entry: string): DaimonGrokWorkerSkillsEntry => ({ path: entry, kind: "directory", uid, gid, mode: directoryMode });
  const entries = [directory(relativePath)];
  const seen = new Set<string>([relativePath]);
  for (const skill of parsed) {
    for (const file of skill.files) {
      const parts = [relativePath, skill.name, ...file.path.split("/")];
      for (let depth = 2; depth < parts.length; depth += 1) {
        const relative = parts.slice(0, depth).join("/");
        if (!seen.has(relative)) { seen.add(relative); entries.push(directory(relative)); }
      }
      entries.push({ path: parts.join("/"), kind: "file", uid, gid, mode: fileMode, content: file.content });
    }
  }
  return entries;
};

/** Spawnfile's declared skills are one `SKILL.md` each, emitted verbatim into `<workspace>/.agents/skills/<name>/`. */
export const daimonAgentSkillsFromResolved = (skills: readonly Pick<ResolvedSkill, "name" | "content">[]): DaimonAgentSkill[] =>
  skills.map((skill) => ({ name: skill.name, files: [{ path: "SKILL.md", content: skill.content }] }));

/** The registration's skills member: `undefined` for none, so a skill-less registration stays byte-identical. */
export const resolveDaimonGrokWorkerSkills = (skills: readonly DaimonAgentSkill[] | undefined): DaimonGrokWorkerSkills | undefined =>
  skills === undefined || skills.length === 0 ? undefined
    : { sha256: daimonGrokWorkerSkillsSha256(skills), tree: renderDaimonGrokWorkerSkillsTree(skills) };
