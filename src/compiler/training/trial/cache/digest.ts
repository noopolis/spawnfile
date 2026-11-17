import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

/** Bumped whenever what a cached trial means changes; every older entry is then unreachable. */
export const TRIAL_CACHE_VERSION = "spawnfile.training.trial-cache.v1";

/** Compile reports: generation time and lineage bookkeeping, never part of the organization the agent runs in. */
const REPORTS = new Set(["spawnfile-report.json", "distribution-report.json"]);

/**
 * The compiled organization with what names the trial, its run and where the project lives taken out: the
 * trial's own slug, the run id (a causal-ledger label, fresh every run) and the run-scoped volume names it
 * derives, the volume name each durable-mount guard prints (trials rename every volume anyway), the lineage
 * hash of each durable volume name, the team resource directory derived from the project's absolute path, and
 * the compile fingerprint label (a hash of that path).
 * Everything else (the prompt, every workspace file, skills, MCP tools, the runtime pins, the model and effort)
 * stays byte for byte.
 */
export const normalizeCompiled = (text: string, slug: string, runId?: string): string => (runId ? text.split(runId).join("{run}") : text)
  .split(slug).join("{trial}")
  .replace(/\{run\}-[0-9a-f]{8}\b/gu, "{run}")
  .replace(/(require_backed_mount '[^']*' '[^']*' '[^']*' )'[^']*'/gu, "$1'{volume}'")
  .replace(/(spawnfile-exclusive-[a-z0-9-]+?)-[0-9a-f]{16}\b/gu, "$1")
  .replace(/(resources\/teams\/)[a-z0-9-]+/gu, "$1{team}")
  .replace(/(com\.spawnfile\.compile_fingerprint=')sf1:[0-9a-f]+/gu, "$1sf1:{fingerprint}");

const files = async (root: string): Promise<string[]> => (await readdir(root, { recursive: true, withFileTypes: true })
  .catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return []; throw error; }))
  .filter((entry) => entry.isFile() || entry.isSymbolicLink())
  .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"))
  .filter((file) => !REPORTS.has(file))
  .sort();

/** Content digest of everything a compiled trial organization holds: every file the agent sees and runs with. */
export const compiledAgentDigest = async (outputDirectory: string, slug: string, runId = process.env.NOOPOLIS_RUN_ID): Promise<string> => {
  const hash = createHash("sha256").update(TRIAL_CACHE_VERSION);
  for (const file of await files(outputDirectory)) {
    hash.update(`\0${normalizeCompiled(file, slug, runId)}\0`);
    hash.update(normalizeCompiled((await readFile(path.join(outputDirectory, file))).toString("latin1"), slug, runId), "latin1");
  }
  return hash.digest("hex");
};

/** JSON with sorted keys, so equal values digest equally. */
export const canonicalJson = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) =>
  item !== null && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0))
    : item);

/** A moment's fills name content by revision; where that content sits on this disk (`directory`, `repo`) is not part of it. */
const momentContent = (moment: unknown): unknown => JSON.parse(JSON.stringify(moment ?? null, (key, item: unknown) =>
  key === "directory" || key === "repo" ? undefined : item));

const sha = (value: string): string => createHash("sha256").update(value).digest("hex");

/** The trial before its first wake: the compiled agent and the moment it boots into. */
export const trialBaseKey = (agentDigest: string, moment: unknown): string =>
  sha(canonicalJson([TRIAL_CACHE_VERSION, agentDigest, momentContent(moment)]));

/** The first wake: its text and the deadline it runs under. */
export const trialWakeKey = (text: string, timeoutMs: number): string => sha(canonicalJson([text, timeoutMs]));
