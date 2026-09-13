import { existsSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

export const implementationRoots = new Set(['src', 'viewer', 'tooling']);
export const generatedDirectories = new Set(['node_modules', 'dist', '.astro', '.venv', 'coverage', '.runtime', '.paideia']);
export const generatedFilePatterns = [...generatedDirectories].map((name) => `**/${name}/**`);

export function canonicalPath(filename: string): string {
  const absolute = path.resolve(filename);
  if (existsSync(absolute)) return realpathSync(absolute);
  return path.join(canonicalPath(path.dirname(absolute)), path.basename(absolute));
}

export function pathParts(root: string, filename: string): string[] {
  return path.relative(root, filename).split(path.sep);
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
