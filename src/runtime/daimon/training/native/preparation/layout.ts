import { lstat, realpath, rm, symlink, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { nativeTrialLeaf, within } from '../receipt/index.js';
import type { NativeSubjectEngine } from './types.js';

/**
 * The layout fields a prepared subject (or its launch) already fixes. A
 * `ProvisionedSubject` satisfies it; so does a launch with `roots.control` set
 * to its control root.
 */
export interface NativeSubjectLayout {
  agent: { engine: NativeSubjectEngine };
  projections: readonly { role: string; source: string }[];
  roots: Readonly<Record<string, string>> & { readonly control: string };
  broker?: { evaluatorPaths: readonly { role: string; path: string }[] };
}

export type NativeScratchName = 'memory' | 'transport';

const canonicalDirectory = async (path: string): Promise<void> => {
  if (!isAbsolute(path) || await realpath(path) !== path || !(await lstat(path)).isDirectory()) {
    throw new Error('A leased slot directory must be a canonical real directory');
  }
};

/**
 * Point the evaluator's own trial workspace and runtime home at the slot's fixed
 * directories.
 *
 * A brokered slot pins its workspace and runtime home per container and the
 * projection digest binds both, so they cannot move; the adapter requires
 * `realpath(workspacePath)` and `realpath(runtimeHomePath)` to be exactly them.
 * A symlink is what makes the evaluator's trial paths resolve there. Only the
 * evaluator's own entry is replaced (a previous link is unlinked, never
 * followed) and the slot directories themselves are never written or cleared:
 * the next recycle owns them.
 */
export async function bindTrialPathsToSlot(paths: { workspace: string; runtimeHome: string },
  subject: { roots: { readonly workspace: string; readonly home: string } }): Promise<void> {
  const pairs = [[paths.workspace, subject.roots.workspace], [paths.runtimeHome, subject.roots.home]] as const;
  const [workspace, home] = [subject.roots.workspace, subject.roots.home];
  if (within(workspace, home) || within(home, workspace)) throw new Error('Leased slot workspace and home must be disjoint');
  for (const [trial, slot] of pairs) {
    await canonicalDirectory(slot);
    if (!isAbsolute(trial)) throw new Error('Trial paths must be absolute');
    // The trial entry's own location, resolved without following the entry itself.
    const entry = join(await realpath(dirname(trial)), basename(trial));
    if ([workspace, home].some(root => within(root, entry) || within(entry, root))) {
      throw new Error('A trial path cannot be, contain or sit inside a leased slot directory');
    }
  }
  for (const [trial, slot] of pairs) {
    const existing = await lstat(trial).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error; });
    if (existing?.isSymbolicLink()) await unlink(trial);
    else if (existing) await rm(trial, { recursive: true });
    await symlink(slot, trial, 'dir');
    if (await realpath(trial) !== slot) throw new Error('Trial path does not resolve to its leased slot directory');
  }
}

/**
 * Where one trial's private control inputs (config, token, env file) live.
 *
 * Codex: `inputs/` beside the per-trial control root, inside the trial runtime
 * home the adapter anchors every Codex control input to.
 *
 * Grok: the slot control root is shared and its runtime home is subject-writable,
 * so inputs go into the denied `context` evaluator root the provisioner names in
 * `roots.context`, under `trials/trial-<digest>`. That root must be one of the
 * broker's `context` evaluator paths, which launch.v2 requires to be denied.
 */
export function nativeTrialInputsRoot(subject: NativeSubjectLayout, trialId: string): string {
  if (subject.agent.engine === 'codex') return join(dirname(subject.roots.control), 'inputs');
  const context = subject.roots.context;
  if (!context || !subject.broker?.evaluatorPaths.some(row => row.role === 'context' && row.path === context)) {
    throw new Error('A Grok subject must name a denied context evaluator root for its control inputs');
  }
  return join(context, 'trials', nativeTrialLeaf(trialId));
}

/**
 * Where a subject's private memory or local transport scratch lives.
 *
 * Grok declares exactly one projection, so scratch sits inside that single home
 * projection under `paideia/<name>`; the next recycle wipes it with the home.
 * Codex keeps its own fresh `memory` / `transport` projections.
 */
export function nativeSubjectScratch(subject: NativeSubjectLayout, name: NativeScratchName): string {
  if (subject.agent.engine === 'grok') {
    const homes = subject.projections.filter(row => row.role === 'home');
    if (homes.length !== 1 || subject.projections.length !== 1) throw new Error('A Grok subject projects exactly its slot runtime home');
    return join(homes[0]!.source, 'paideia', name);
  }
  const rows = subject.projections.filter(row => row.role === name);
  if (rows.length !== 1) throw new Error(`A Codex subject must declare exactly one ${name} projection`);
  return rows[0]!.source;
}

