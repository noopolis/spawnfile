import { constants, closeSync, fstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { parseDatasetYaml, resolveDataset } from '../cases/index.js';
import type { ResolvedDataset, ResolutionOptions } from '../contracts/index.js';

export function readCliBytes(path: string, maximum: number): Buffer {
  const file = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(file);
    if (!stat.isFile() || stat.size > maximum) throw new Error('CLI input must be a bounded regular text file');
    const bytes = readFileSync(file);
    if (bytes.length > maximum) throw new Error('CLI input grew beyond its byte bound');
    return bytes;
  } finally { closeSync(file); }
}

export function readCliText(path: string, maximum: number): string {
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(readCliBytes(path, maximum));
}

/** Sidecar bytes are resolved and frozen before a native subject can run. */
export class CliDatasets {
  private readonly sidecars = new Map<string, string>();
  readonly protectedDirectories = new Set<string>();

  constructor(private readonly judges: Readonly<Record<string, string>>, private readonly cwd: string,
    private readonly preparation: Pick<ResolutionOptions, 'registry' | 'unlockedSetupPaths' | 'subject'> = {},
    private readonly versions: Record<string, { version: string }> = {},
    private readonly frozen?: { path: string; sourceDigest: string }) {}

  load(file: string, groups: boolean): ResolvedDataset {
    const path = resolve(this.cwd, file);
    const root = realpathSync(dirname(path));
    this.protectedDirectories.add(root);
    const document = parseDatasetYaml(readCliText(path, 2_000_000), { sourceName: path });
    if (this.frozen?.path === path && this.frozen.sourceDigest !== document.sourceDigest) {
      throw new Error('Dataset changed after authored configuration was selected');
    }
    return resolveDataset(document, {
      requireGroups: groups,
      ...this.preparation,
      registry: { ...this.preparation.registry, judges: Object.fromEntries(Object.keys(this.judges).map((name) => [name, this.versions[name] ?? { version: 'cli.claude-subscription.v1' }])) },
      readCriterionFile: (selected) => {
        // Dataset resolution has already validated a contained relative selector.
        const canonical = realpathSync(resolve(root, selected));
        const within = relative(root, canonical);
        if (isAbsolute(within) || within === '..' || within.startsWith(`..${sep}`)) throw new Error('Criterion sidecar escapes its dataset directory');
        const text = readCliText(canonical, 2_000_000);
        if (this.sidecars.has(selected) && this.sidecars.get(selected) !== text) throw new Error(`Ambiguous criterion sidecar ${selected} across datasets`);
        this.sidecars.set(selected, text);
        return text;
      },
    });
  }

  async readCriterion(path: string): Promise<string> {
    const value = this.sidecars.get(path);
    if (value === undefined) throw new Error(`Criterion sidecar was not frozen: ${path}`);
    return value;
  }
}
