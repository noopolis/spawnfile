import { existsSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

export const implementationRoots = new Set(['src', 'viewer', 'tooling']);
export const generatedDirectories = new Set(['node_modules', 'dist', '.astro', '.venv', 'coverage', '.runtime', '.spawnfile-training', '__pycache__', '.pytest_cache']);
export const generatedFilePatterns = [...generatedDirectories].map((name) => `**/${name}/**`).concat('.tmp/**', '**/*.egg-info/**');

export function canonicalPath(filename: string): string {
  const absolute = path.resolve(filename);
  if (existsSync(absolute)) return realpathSync(absolute);
  return path.join(canonicalPath(path.dirname(absolute)), path.basename(absolute));
}

export function pathParts(root: string, filename: string): string[] {
  const parts = path.relative(root, filename).split(path.sep);
  // Preserve Training's module owners inside the imported Spawnfile subtree.
  if (parts[0] === 'src' && parts[1] === 'training') {
    return parts[2] === 'viewer' ? parts.slice(2) : ['src', ...parts.slice(2)];
  }
  if (parts[0] === 'src' && parts[1] === 'runtime' && parts[3] === 'training') {
    const adapter = parts[2] === 'codex-exec' ? ['codex', ...parts.slice(4)]
      : [parts[4] === 'native' ? 'daimon-native' : 'daimon', ...parts.slice(5)];
    return ['src', 'adapters', ...adapter];
  }
  return parts[0] === 'tooling' && parts[1] === 'training' ? ['tooling', ...parts.slice(2)] : parts;
}

export function implementationDirectories(root: string): string[] {
  return existsSync(path.join(root, 'src/training'))
    ? ['src/training', 'src/runtime/daimon/training', 'src/runtime/codex-exec/training', 'tooling/training'] : [...implementationRoots];
}

export function inside(root: string, filename: string): boolean {
  const relative = path.relative(root, filename);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export function importTarget(filename: string, specifier: string): string {
  const target = path.resolve(path.dirname(filename), specifier);
  // Runtime .js specifiers resolve to maintained TypeScript sources in this repo.
  const variants = [target.replace(/\.([cm]?)js(x?)$/, '.$1ts$2'), target, `${target}.ts`, path.join(target, 'index.ts')];
  const existing = variants.find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
  return existing === undefined ? canonicalPath(target) : realpathSync(existing);
}

export function owner(parts: readonly string[]): string | undefined {
  if (parts[0] === 'src') return parts.length > 2 ? `src/${parts[1]}` : 'src';
  return implementationRoots.has(parts[0] ?? '') ? parts[0] : undefined;
}
