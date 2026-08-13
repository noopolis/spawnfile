import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import path from "node:path";

import { resolveSpawnfileHome } from "../auth/index.js";
import { failLifecycleStore } from "./lifecycleCompletionPaths.js";

const OWNER = process.getuid?.() ?? -1;

interface PathIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly path: string;
}

export interface LifecycleRootAuthority {
  readonly canonicalHome: string;
  readonly configuredHome: string;
  readonly identities: readonly PathIdentity[];
  readonly root: string;
}

const authorities = new Map<string, LifecycleRootAuthority>();

const chain = (value: string): string[] => {
  const parsed = path.parse(value);
  const result = [parsed.root];
  let current = parsed.root;
  for (const part of value.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    result.push(current);
  }
  return result;
};

const isKnownDarwinAlias = async (value: string): Promise<boolean> => {
  if (process.platform !== "darwin" || (value !== "/var" && value !== "/tmp")) return false;
  const resolved = await realpath(value).catch(() => "");
  return resolved === (value === "/var" ? "/private/var" : "/private/tmp");
};

const validateConfiguredAliases = async (
  configuredHome: string,
  canonicalHome: string
): Promise<void> => {
  for (const value of chain(configuredHome)) {
    const info = await lstat(value).catch(() => failLifecycleStore("unsafe root"));
    if (info.isSymbolicLink()) {
      if (info.uid !== 0 || (info.mode & 0o022) !== 0 || !(await isKnownDarwinAlias(value))) {
        failLifecycleStore("unsafe root");
      }
    } else if (!info.isDirectory()) {
      failLifecycleStore("unsafe root");
    }
  }
  if ((await realpath(configuredHome).catch(() => "")) !== canonicalHome) {
    failLifecycleStore("root changed");
  }
};

const captureCanonicalChain = async (
  canonicalHome: string,
  root: string
): Promise<PathIdentity[]> => {
  const identities: PathIdentity[] = [];
  for (const value of chain(root)) {
    const info = await lstat(value).catch(() => failLifecycleStore("unsafe root"));
    const writable = (info.mode & 0o022) !== 0;
    const stickyRootTemp = info.uid === 0 && writable && (info.mode & 0o1000) !== 0;
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (info.uid !== OWNER && info.uid !== 0) ||
      (writable && !stickyRootTemp)
    ) failLifecycleStore("unsafe root");
    if (
      (value === canonicalHome || value === root) &&
      (info.uid !== OWNER || (info.mode & 0o777) !== 0o700)
    ) failLifecycleStore("unsafe root");
    identities.push({ dev: info.dev, ino: info.ino, path: value });
  }
  return identities;
};

const revalidateIdentities = async (identities: readonly PathIdentity[]): Promise<void> => {
  for (const expected of identities) {
    const current = await lstat(expected.path).catch(() => failLifecycleStore("root changed"));
    const writable = (current.mode & 0o022) !== 0;
    const stickyRootTemp = current.uid === 0 && writable && (current.mode & 0o1000) !== 0;
    if (
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      (current.uid !== OWNER && current.uid !== 0) ||
      (writable && !stickyRootTemp)
    ) failLifecycleStore("unsafe root");
    if (current.dev !== expected.dev || current.ino !== expected.ino) {
      failLifecycleStore("root changed");
    }
  }
};

const captureSafeExistingChain = async (value: string): Promise<PathIdentity[]> => {
  const identities: PathIdentity[] = [];
  for (const current of chain(value)) {
    const info = await lstat(current).catch(() => failLifecycleStore("unsafe root"));
    const writable = (info.mode & 0o022) !== 0;
    const stickyRootTemp = info.uid === 0 && writable && (info.mode & 0o1000) !== 0;
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (info.uid !== OWNER && info.uid !== 0) ||
      (writable && !stickyRootTemp)
    ) failLifecycleStore("unsafe root");
    identities.push({ dev: info.dev, ino: info.ino, path: current });
  }
  return identities;
};

const resolveOrCreateConfiguredHome = async (
  configuredHome: string,
  create: boolean
): Promise<string | null> => {
  const logical = chain(configuredHome);
  let existing = logical[0]!;
  let missingAt = logical.length;
  for (let index = 0; index < logical.length; index += 1) {
    const current = logical[index]!;
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") failLifecycleStore("unsafe root");
      missingAt = index;
      break;
    }
    if (info.isSymbolicLink()) {
      if (info.uid !== 0 || (info.mode & 0o022) !== 0 || !(await isKnownDarwinAlias(current))) {
        failLifecycleStore("unsafe root");
      }
    } else if (!info.isDirectory()) {
      failLifecycleStore("unsafe root");
    }
    existing = current;
  }
  if (missingAt === logical.length) {
    return realpath(configuredHome).catch(() => failLifecycleStore("unsafe root"));
  }
  if (!create) return null;

  let canonicalParent = await realpath(existing).catch(() => failLifecycleStore("unsafe root"));
  let identities = await captureSafeExistingChain(canonicalParent);
  for (let index = missingAt; index < logical.length; index += 1) {
    const name = path.basename(logical[index]!);
    const next = path.join(canonicalParent, name);
    await revalidateIdentities(identities);
    await mkdir(next, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") failLifecycleStore("unsafe root");
    });
    await revalidateIdentities(identities);
    const created = await lstat(next).catch(() => failLifecycleStore("unsafe root"));
    if (
      !created.isDirectory() ||
      created.isSymbolicLink() ||
      created.uid !== OWNER ||
      (created.mode & 0o777) !== 0o700
    ) failLifecycleStore("unsafe root");
    canonicalParent = next;
    identities = [...identities, { dev: created.dev, ino: created.ino, path: next }];
  }
  return canonicalParent;
};

export const revalidateLifecycleRootAuthority = async (
  authority: LifecycleRootAuthority
): Promise<void> => {
  await validateConfiguredAliases(authority.configuredHome, authority.canonicalHome);
  for (const expected of authority.identities) {
    const current = await lstat(expected.path).catch(() => failLifecycleStore("root changed"));
    const writable = (current.mode & 0o022) !== 0;
    const stickyRootTemp = current.uid === 0 && writable && (current.mode & 0o1000) !== 0;
    if (
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      (current.uid !== OWNER && current.uid !== 0) ||
      (writable && !stickyRootTemp) ||
      ((expected.path === authority.canonicalHome || expected.path === authority.root) &&
        (current.uid !== OWNER || (current.mode & 0o777) !== 0o700))
    ) failLifecycleStore("unsafe root");
    if (current.dev !== expected.dev || current.ino !== expected.ino) {
      failLifecycleStore("root changed");
    }
  }
};

export const validateLifecycleRoot = async (
  create: boolean
): Promise<LifecycleRootAuthority | null> => {
  const configuredHome = resolveSpawnfileHome();
  const cached = authorities.get(configuredHome);
  if (cached) {
    await revalidateLifecycleRootAuthority(cached);
    return cached;
  }
  const canonicalHome = await resolveOrCreateConfiguredHome(configuredHome, create);
  if (canonicalHome === null) return null;
  await validateConfiguredAliases(configuredHome, canonicalHome);
  const homeIdentities = await captureSafeExistingChain(canonicalHome);
  const homeInfo = await lstat(canonicalHome).catch(() => failLifecycleStore("unsafe root"));
  if (homeInfo.uid !== OWNER || (homeInfo.mode & 0o777) !== 0o700) {
    failLifecycleStore("unsafe root");
  }
  const root = path.join(canonicalHome, "lifecycle-completions");
  if (create) {
    await revalidateIdentities(homeIdentities);
    await mkdir(root, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") failLifecycleStore("unsafe root");
    });
    await revalidateIdentities(homeIdentities);
  } else {
    try {
      await lstat(root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      failLifecycleStore("unsafe root");
    }
  }
  const authority: LifecycleRootAuthority = {
    canonicalHome,
    configuredHome,
    identities: await captureCanonicalChain(canonicalHome, root),
    root
  };
  const prior = authorities.get(configuredHome);
  if (prior) {
    await revalidateLifecycleRootAuthority(prior);
    return prior;
  }
  authorities.set(configuredHome, authority);
  return authority;
};

export const lifecycleRoot = async (): Promise<string> =>
  (await validateLifecycleRoot(true))?.root ?? failLifecycleStore("unsafe root");

export const existingLifecycleRoot = async (): Promise<string | null> =>
  (await validateLifecycleRoot(false))?.root ?? null;

export const requireLifecycleRootAuthority = async (): Promise<LifecycleRootAuthority> =>
  (await validateLifecycleRoot(true)) ?? failLifecycleStore("unsafe root");

export const openLifecycleAuthorityRoot = async (authority: LifecycleRootAuthority) => {
  await revalidateLifecycleRootAuthority(authority);
  const handle = await open(
    authority.root,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
  ).catch(() => failLifecycleStore("root changed"));
  const expected = authority.identities.at(-1)!;
  const info = await handle.stat();
  if (info.dev !== expected.dev || info.ino !== expected.ino) {
    await handle.close().catch(() => undefined);
    failLifecycleStore("root changed");
  }
  return handle;
};

export const revalidateHeldLifecycleRoot = async (
  authority: LifecycleRootAuthority,
  handle: Awaited<ReturnType<typeof open>>
): Promise<void> => {
  const expected = authority.identities.at(-1)!;
  const info = await handle.stat();
  if (info.dev !== expected.dev || info.ino !== expected.ino) failLifecycleStore("root changed");
  await revalidateLifecycleRootAuthority(authority);
};

export const syncLifecycleDirectory = async (directory: string): Promise<void> => {
  const authority = await requireLifecycleRootAuthority();
  if (path.resolve(directory) !== authority.root) failLifecycleStore("unsafe root");
  const handle = await openLifecycleAuthorityRoot(authority);
  try {
    await revalidateHeldLifecycleRoot(authority, handle);
    await handle.sync();
    await revalidateHeldLifecycleRoot(authority, handle);
  } finally {
    await handle.close();
  }
  await revalidateLifecycleRootAuthority(authority);
};
