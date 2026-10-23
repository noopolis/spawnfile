import { constants } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TRAINING_TYPESAFE_SECRET_FILE as target, TRAINING_TYPESAFE_SECRET_INGRESS as source } from "../container/evaluators.js";

// A permission-enforcing inode model exercises root ingress -> uid2000 delivery on non-Linux hosts.
const storage = vi.hoisted(() => ({ nodes: new Map<string, {
  uid: number; gid: number; mode: number; size: number; nlink: number; directory: boolean; symlink: boolean; bytes: Buffer;
}>(), operations: [] as { operation: string; file: string; uid?: number }[] }));
vi.mock("node:fs/promises", () => {
  const node = (file: string) => { const value = storage.nodes.get(file); if (!value) throw Error("ENOENT"); return value; };
  const stat = (file: string) => ({ ...node(file), mtimeMs: 1, ctimeMs: 1,
    isFile: () => !node(file).directory, isDirectory: () => node(file).directory, isSymbolicLink: () => node(file).symlink });
  return {
    lstat: async (file: string) => stat(file),
    chmod: async (file: string, mode: number) => { node(file).mode = mode; storage.operations.push({ operation: "chmod", file }); },
    chown: async (file: string, uid: number, gid: number) => {
      node(file).uid = uid; node(file).gid = gid; storage.operations.push({ operation: "chown", file, uid });
    },
    mkdir: async (file: string, options: { mode: number }) => {
      if (storage.nodes.has(file)) throw Error("EEXIST");
      storage.nodes.set(file, { uid: 0, gid: 0, mode: options.mode, size: 0, nlink: 1, directory: true, symlink: false, bytes: Buffer.alloc(0) });
    },
    open: async (file: string, flags: number, mode?: number) => {
      storage.operations.push({ operation: "open", file });
      if (flags & constants.O_CREAT) {
        if (storage.nodes.has(file)) throw Error("EEXIST");
        storage.nodes.set(file, { uid: 0, gid: 0, mode: mode!, size: 0, nlink: 1, directory: false, symlink: false, bytes: Buffer.alloc(0) });
      }
      if (node(file).symlink && flags & constants.O_NOFOLLOW) throw Error("ELOOP");
      return { stat: async () => stat(file), close: async () => {}, sync: async () => {},
        read: async (buffer: Buffer) => ({ bytesRead: node(file).bytes.copy(buffer) }),
        writeFile: async (bytes: Buffer) => { node(file).bytes = Buffer.from(bytes); node(file).size = bytes.length; },
        chown: async (uid: number, gid: number) => {
          node(file).uid = uid; node(file).gid = gid; storage.operations.push({ operation: "chown", file, uid });
        }
      };
    }
  };
});
import { stageTrainingEvaluatorSecret } from "./evaluatorSecrets.js";

const ingress = source.slice(0, source.lastIndexOf("/")), destination = target.slice(0, target.lastIndexOf("/"));
beforeEach(() => {
  vi.spyOn(process as { getuid: () => number }, "getuid").mockReturnValue(0);
  storage.nodes.clear(); storage.operations.length = 0;
  storage.nodes.set(ingress, { uid: 0, gid: 0, mode: 0o755, size: 0, nlink: 1, directory: true, symlink: false, bytes: Buffer.alloc(0) });
  const bytes = Buffer.from("test-only-secret-marker");
  storage.nodes.set(source, { uid: 501, gid: 20, mode: 0o600, size: bytes.length, nlink: 1, directory: false, symlink: false, bytes });
});
afterEach(() => { vi.restoreAllMocks(); });
const canRead = (file: string, parent: string, uid: number) => {
  const directory = storage.nodes.get(parent)!, leaf = storage.nodes.get(file)!;
  return (directory.mode & (directory.uid === uid ? 0o100 : 0o001)) !== 0 &&
    (leaf.mode & (leaf.uid === uid ? 0o400 : 0o004)) !== 0;
};

it("delivers a host-private leaf only to uid2000 without altering the readonly source or environment", async () => {
  const original = { ...storage.nodes.get(source)! }, env = { SPAWNFILE_TRAINING_TYPESAFE_SECRET_FILE: target };
  const failure = await stageTrainingEvaluatorSecret(env).then(() => undefined, error => error);
  expect(failure, "evaluator secret ownership delivery guarantee").toBeUndefined();
  expect(storage.nodes.get(target), "evaluator secret ownership delivery guarantee").toMatchObject({ uid: 2000, gid: 2000, mode: 0o600 });
  expect(storage.nodes.get(destination)).toMatchObject({ uid: 2000, gid: 2000, mode: 0o700 });
  expect(storage.nodes.get(ingress)).toMatchObject({ uid: 0, mode: 0o700 });
  expect(canRead(target, destination, 2000), "evaluator secret ownership delivery guarantee").toBe(true);
  expect(canRead(source, ingress, 2000)).toBe(false);
  expect(canRead(target, destination, 2200)).toBe(false);
  expect(storage.nodes.get(target)!.bytes.toString()).toBe("test-only-secret-marker");
  expect(storage.nodes.get(source)).toEqual(original);
  expect(storage.operations.some(op => ["chown", "chmod"].includes(op.operation) && op.file === source)).toBe(false);
  expect(env).toEqual({ SPAWNFILE_TRAINING_TYPESAFE_SECRET_FILE: target });
});

it("refuses unbounded linked or symlink ingress and emits no credential bytes", async () => {
  for (const change of [{ size: 0 }, { size: 65537 }, { nlink: 2 }, { symlink: true }]) {
    Object.assign(storage.nodes.get(source)!, change);
    if ("size" in change) storage.nodes.get(source)!.bytes = Buffer.alloc(change.size!);
    const failure = await stageTrainingEvaluatorSecret({ SPAWNFILE_TRAINING_TYPESAFE_SECRET_FILE: target }).then(() => undefined, error => error);
    expect(failure?.message, "evaluator secret ingress safety guarantee").toBe("Evaluator secret staging failed");
    expect(storage.nodes.has(target)).toBe(false);
    Object.assign(storage.nodes.get(source)!, { size: 23, nlink: 1, symlink: false });
    storage.nodes.get(source)!.bytes = Buffer.from("test-only-secret-marker");
  }
});

it("rejects nonroot or redirected declarations and does nothing without a secret binding", async () => {
  await stageTrainingEvaluatorSecret({}); expect(storage.operations).toEqual([]);
  await expect(stageTrainingEvaluatorSecret({ SPAWNFILE_TRAINING_TYPESAFE_SECRET_FILE: "/tmp/arbitrary" })).rejects.toThrow("Invalid evaluator secret");
  vi.spyOn(process as { getuid: () => number }, "getuid").mockReturnValue(2000);
  await expect(stageTrainingEvaluatorSecret({ SPAWNFILE_TRAINING_TYPESAFE_SECRET_FILE: target })).rejects.toThrow("Invalid evaluator secret");
});
