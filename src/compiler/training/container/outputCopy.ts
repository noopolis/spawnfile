/** Runs only in the verified Linux training image. No project code is imported. */
export const trainingOutputCopyProgram = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const [source, destination, owner, group] = process.argv.slice(1);
const uid = Number(owner), gid = Number(group);
const limits = { entries: 1_000_000, bytes: 64 * 1024 ** 3, depth: 64 };
let entries = 0, bytes = 0;
const links = new Map();
const buffer = Buffer.alloc(1024 * 1024);
// Linux fd-relative traversal keeps renamed directories and symlink swaps from
// redirecting reads/writes outside the two mounts. The fallback permits local QA.
const fdPath = (fd, file) => process.platform === 'linux' ? '/proc/self/fd/' + fd : file;
const directory = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW;
function copy(src, dst, depth) {
  if (++entries > limits.entries || depth > limits.depth) throw Error('Output tree exceeds entry/depth limit');
  const info = fs.lstatSync(src);
  if (info.isSymbolicLink()) {
    const target = fs.readlinkSync(src);
    bytes += Buffer.byteLength(target);
    if (bytes > limits.bytes) throw Error('Output exceeds 64 GiB');
    fs.symlinkSync(target, dst); fs.lchownSync(dst, uid, gid);
    fs.lutimesSync(dst, info.atime, info.mtime);
    return;
  }
  if (info.isDirectory()) {
    const input = fs.openSync(src, directory);
    let output;
    try {
      if (depth !== 0) fs.mkdirSync(dst, { mode: 0o700 });
      output = fs.openSync(dst, directory);
      fs.fchownSync(output, uid, gid);
      const from = fdPath(input, src), to = fdPath(output, dst);
      if (depth === 0 && fs.readdirSync(to).length) throw Error('Output copy destination must be empty');
      for (const name of fs.readdirSync(from)) copy(path.join(from, name), path.join(to, name), depth + 1);
      fs.fchownSync(output, uid, gid); fs.fchmodSync(output, info.mode & 0o7777);
      fs.futimesSync(output, info.atime, info.mtime); fs.fsyncSync(output);
    } finally { if (output !== undefined) fs.closeSync(output); fs.closeSync(input); }
    return;
  }
  if (!info.isFile()) throw Error('Output contains a special file');
  const input = fs.openSync(src, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  let output;
  try {
    const opened = fs.fstatSync(input);
    if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino) throw Error('Output changed during copy');
    const key = info.dev + ':' + info.ino;
    // Store a path rooted at the destination mount, not an fd that closes after recursion.
    const previous = links.get(key);
    if (previous) { fs.linkSync(previous, dst); return; }
    bytes += info.size;
    if (bytes > limits.bytes) throw Error('Output exceeds 64 GiB');
    output = fs.openSync(dst, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    fs.fchownSync(output, uid, gid);
    let position = 0;
    while (position < info.size) {
      const count = fs.readSync(input, buffer, 0, Math.min(buffer.length, info.size - position), position);
      if (!count) throw Error('Output truncated during copy');
      let written = 0;
      while (written < count) written += fs.writeSync(output, buffer, written, count - written);
      position += count;
    }
    const after = fs.fstatSync(input);
    if (after.size !== info.size || after.mtimeMs !== info.mtimeMs) throw Error('Output changed during copy');
    fs.fchownSync(output, uid, gid); fs.fchmodSync(output, info.mode & 0o7777);
    fs.futimesSync(output, info.atime, info.mtime); fs.fsyncSync(output);
    links.set(key, fs.realpathSync(dst));
  } finally { if (output !== undefined) fs.closeSync(output); fs.closeSync(input); }
}
copy(source, destination, 0);
console.log('spawnfile-output-copy-complete');
`;
