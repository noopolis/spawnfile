#!/usr/local/bin/node

import { constants } from "node:fs";
import { lstat, open, opendir } from "node:fs/promises";
import path from "node:path";

const ROOT = "/spawnfile/evidence";
const BLOCK = 512;
const MAX_BYTES = 67_108_864;
const MAX_ENTRIES = 10_000;
const MAX_DEPTH = 32;
const MAX_PATH_BYTES = 255;

const fail = () => { throw new Error("Evidence export helper failed"); };
const pad = (size) => Math.ceil(size / BLOCK) * BLOCK;
const same = (left, right) => left.dev === right.dev && left.ino === right.ino
  && left.size === right.size && left.mode === right.mode;

const safePath = (value) => {
  const bytes = Buffer.from(value, "utf8");
  if (value.length < 1 || bytes.toString("utf8") !== value
    || bytes.byteLength > MAX_PATH_BYTES || value.startsWith("/")
    || value.includes("\\") || value.includes("\0") || value.includes("//")) fail();
  const parts = value.split("/");
  if (parts.length > MAX_DEPTH || parts.some((part) => part === "" || part === "." || part === "..")) fail();
  for (const part of parts) {
    for (let index = 0; index < part.length; index += 1) {
      const code = part.charCodeAt(index);
      if (code < 0x20 || code === 0x7f) fail();
    }
  }
  return value;
};

const comparePaths = (left, right) => Buffer.compare(
  Buffer.from(left.path, "utf8"),
  Buffer.from(right.path, "utf8"),
);

const collect = async (directory, prefix, entries) => {
  const before = await lstat(directory);
  if (!before.isDirectory() || before.isSymbolicLink()) fail();
  const handle = await opendir(directory);
  const names = [];
  try {
    for await (const item of handle) names.push(item.name);
  } finally {
    await handle.close().catch(() => undefined);
  }
  names.sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
  for (const name of names) {
    const relative = safePath(prefix ? `${prefix}/${name}` : name);
    const absolute = path.join(directory, name);
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) fail();
    if (info.isDirectory()) {
      entries.push({ info, path: relative, type: "directory" });
      await collect(absolute, relative, entries);
    } else if (info.isFile()) {
      entries.push({ info, path: relative, type: "file" });
    } else fail();
    if (entries.length > MAX_ENTRIES) fail();
  }
  const after = await lstat(directory);
  if (!same(before, after)) fail();
};

const octal = (value, width) => {
  const raw = value.toString(8);
  if (!Number.isSafeInteger(value) || value < 0 || raw.length > width - 1) fail();
  return Buffer.from(`${raw.padStart(width - 1, "0")}\0`, "ascii");
};

const storedPath = (entry) => entry.type === "directory" ? `${entry.path}/` : entry.path;
const splitPath = (stored) => {
  const bytes = Buffer.from(stored, "utf8");
  if (bytes.byteLength <= 100) return { name: bytes, prefix: Buffer.alloc(0) };
  for (let split = stored.lastIndexOf("/"); split > 0; split = stored.lastIndexOf("/", split - 1)) {
    const prefix = Buffer.from(stored.slice(0, split), "utf8");
    const name = Buffer.from(stored.slice(split + 1), "utf8");
    if (prefix.byteLength <= 155 && name.byteLength > 0 && name.byteLength <= 100) {
      return { name, prefix };
    }
  }
  return fail();
};

const header = (entry) => {
  const stored = storedPath(entry);
  const { name, prefix } = splitPath(stored);
  const output = Buffer.alloc(BLOCK);
  output.set(name, 0);
  output.set(octal(entry.type === "directory" ? 0o755 : 0o644, 8), 100);
  output.set(octal(0, 8), 108);
  output.set(octal(0, 8), 116);
  output.set(octal(entry.type === "file" ? entry.info.size : 0, 12), 124);
  output.set(octal(0, 12), 136);
  output[156] = entry.type === "directory" ? 53 : 48;
  output.set(Buffer.from("ustar\0", "ascii"), 257);
  output.set(Buffer.from("00", "ascii"), 263);
  output.set(octal(0, 8), 329);
  output.set(octal(0, 8), 337);
  output.set(prefix, 345);
  output.fill(0x20, 148, 156);
  let sum = 0;
  for (const byte of output) sum += byte;
  if (sum > 0o777777) fail();
  output.set(Buffer.from(`${sum.toString(8).padStart(6, "0")}\0 `, "ascii"), 148);
  return output;
};

const write = async (bytes) => {
  if (process.stdout.write(bytes)) return;
  await new Promise((resolve, reject) => {
    process.stdout.once("drain", resolve);
    process.stdout.once("error", reject);
  });
};

const main = async () => {
  const root = await lstat(ROOT);
  if (!root.isDirectory() || root.isSymbolicLink()) fail();
  const entries = [];
  await collect(ROOT, "", entries);
  entries.sort(comparePaths);
  if (entries.length < 1) fail();
  let total = BLOCK * 2;
  for (const entry of entries) {
    total += BLOCK + (entry.type === "file" ? pad(entry.info.size) : 0);
    if (!Number.isSafeInteger(total) || total > MAX_BYTES) fail();
  }
  for (const entry of entries) {
    await write(header(entry));
    if (entry.type !== "file") continue;
    const absolute = path.join(ROOT, entry.path);
    const file = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await file.stat();
      if (!before.isFile() || !same(before, entry.info)) fail();
      const bytes = await file.readFile();
      const after = await file.stat();
      if (!same(before, after) || bytes.byteLength !== before.size) fail();
      await write(bytes);
      const padding = pad(bytes.byteLength) - bytes.byteLength;
      if (padding > 0) await write(Buffer.alloc(padding));
    } finally {
      await file.close().catch(() => undefined);
    }
  }
  await write(Buffer.alloc(BLOCK * 2));
};

main().catch(() => {
  process.stderr.write("Evidence export helper failed\n");
  process.exitCode = 1;
});
