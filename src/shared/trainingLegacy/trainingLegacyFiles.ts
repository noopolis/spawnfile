import { constants, closeSync, existsSync, fstatSync, openSync, readFileSync } from 'node:fs';

/** Explicit legacy file selections keep their original bytes and source identity. */
export function checkTrainingFilename(path: string): void {
  const legacy = /\.paideia(?=\.(?:ya?ml|json)$)/u;
  const current = /\.spawnfile-training(?=\.(?:ya?ml|json)$)/u;
  const oldName = legacy.test(path);
  if (!oldName && !current.test(path)) return;
  const counterpart = oldName ? path.replace(legacy, '.spawnfile-training') : path.replace(current, '.paideia');
  if (existsSync(path) && existsSync(counterpart)) {
    throw new Error('Both legacy and current training files exist; remove or rename one before continuing');
  }
  if (oldName && existsSync(path)) {
    process.stderr.write('Deprecated legacy training filename; use .spawnfile-training.yaml (or matching JSON suffix).\n');
  }
}

/** Bound and freeze the exact file bytes; legacy selections retain their source digest. */
export function readTrainingBytes(path: string, maximum: number): Buffer {
  checkTrainingFilename(path);
  const file = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(file);
    if (!stat.isFile() || stat.size > maximum) throw new Error('CLI input must be a bounded regular text file');
    const bytes = readFileSync(file);
    if (bytes.length > maximum) throw new Error('CLI input grew beyond its byte bound');
    return bytes;
  } finally { closeSync(file); }
}
