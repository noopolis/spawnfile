import { chmod, lstat, mkdtemp, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { destinationKey, publishImmutable } from "./evidenceExportStorePublication.js";

const roots: string[] = [];
const root = async (): Promise<string> => {
  const value = await mkdtemp(path.join(os.tmpdir(), "spawnfile-publication-ownership-"));
  roots.push(value);
  return value;
};
const temporary = async (directory: string, prefix: string): Promise<string> => {
  const found = (await readdir(directory)).find((file) => file.startsWith(prefix) && file.endsWith(".tmp"));
  if (!found) throw new Error("temporary file missing");
  return path.join(directory, found);
};

afterEach(async () => Promise.all(roots.splice(0).map((value) => rm(value, { force: true, recursive: true }))));

describe("evidence export publication temporary ownership", () => {
  it("retains a foreign immutable temporary created before exclusive open", async () => {
    const directory = await root();
    let foreign = "";
    await publishImmutable(directory, "admission.json", "{\"v\":1}", false, {
      beforeImmutableTempOpen: async (candidate) => {
        if (foreign) return;
        foreign = candidate;
        await writeFile(foreign, "foreign", "utf8");
        await chmod(foreign, 0o600);
      },
    });
    expect(await readFile(foreign, "utf8")).toBe("foreign");
    expect(await readFile(path.join(directory, "admission.json"), "utf8")).toBe("{\"v\":1}");
  });

  it("removes its immutable temporary after identity capture fails before write", async () => {
    const directory = await root();
    let captured = "";
    await expect(publishImmutable(directory, "admission.json", "{\"v\":1}", false, {
      afterImmutableTempIdentity: async (temporaryPath) => {
        captured = temporaryPath;
        throw new Error("injected failure");
      },
    })).rejects.toThrow("Evidence-volume export failed");
    await expect(lstat(captured)).rejects.toThrow();
    expect(await readdir(directory)).toEqual([]);
  });

  it("retains a replaced immutable temporary and fails closed", async () => {
    const directory = await root();
    let foreign = "";
    await expect(publishImmutable(directory, "admission.json", "{\"v\":1}", false, {
      afterImmutableFinalLinkBeforeTempUnlink: async () => {
        foreign = await temporary(directory, ".admission.json.");
        await unlink(foreign);
        await writeFile(foreign, "foreign", "utf8");
        await chmod(foreign, 0o600);
      },
    })).rejects.toThrow("Evidence-volume export failed");
    expect(await readFile(foreign, "utf8")).toBe("foreign");
    expect(await readFile(path.join(directory, "admission.json"), "utf8")).toBe("{\"v\":1}");
  });

  it("retains a foreign destination-key temporary created before exclusive open", async () => {
    const directory = await root();
    let foreign = "";
    await expect(destinationKey(directory, {
      beforeDestinationKeyTempOpen: async (candidate) => {
        if (foreign) return;
        foreign = candidate;
        await writeFile(foreign, "foreign", "utf8");
        await chmod(foreign, 0o600);
      },
    })).resolves.toHaveLength(32);
    expect(await readFile(foreign, "utf8")).toBe("foreign");
  });

  it("removes its destination-key temporary after identity capture fails before write", async () => {
    const directory = await root();
    let captured = "";
    await expect(destinationKey(directory, {
      afterDestinationKeyTempIdentity: async (temporaryPath) => {
        captured = temporaryPath;
        throw new Error("injected failure");
      },
    })).rejects.toThrow("Evidence-volume export failed");
    await expect(lstat(captured)).rejects.toThrow();
    expect(await readdir(directory)).toEqual([]);
  });

  it("retains a replaced destination-key temporary and fails closed", async () => {
    const directory = await root();
    let foreign = "";
    await expect(destinationKey(directory, {
      afterDestinationKeyPendingLinkBeforeTempUnlink: async () => {
        foreign = await temporary(directory, ".destination-hmac.");
        await unlink(foreign);
        await writeFile(foreign, "foreign", "utf8");
        await chmod(foreign, 0o600);
      },
    })).rejects.toThrow("Evidence-volume export failed");
    expect(await readFile(foreign, "utf8")).toBe("foreign");
    expect((await lstat(path.join(directory, ".destination-hmac.pending"))).nlink).toBe(1);
  });
});
