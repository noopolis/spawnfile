import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  MAX_BYTES,
  destinationKey,
  publishImmutable,
} from "./evidenceExportStorePublication.js";

const roots: string[] = [];
const root = async (): Promise<string> => {
  const value = await mkdtemp(path.join(os.tmpdir(), "spawnfile-publication-validation-"));
  roots.push(value);
  return value;
};

afterEach(async () => Promise.all(roots.splice(0).map((value) => rm(value, { force: true, recursive: true }))));

describe("evidence export publication validation", () => {
  it("bounds immutable content and never replaces a conflicting committed value", async () => {
    const directory = await root();
    await expect(publishImmutable(directory, "oversized", "x".repeat(MAX_BYTES + 1)))
      .rejects.toThrow("Evidence-volume export failed");

    await publishImmutable(directory, "immutable.json", "first");
    await expect(publishImmutable(directory, "immutable.json", "second"))
      .rejects.toThrow("Evidence-volume export failed");
    await expect(publishImmutable(directory, "immutable.json", "second", true)).resolves.toBeUndefined();
    expect(await readFile(path.join(directory, "immutable.json"), "utf8")).toBe("first");
  });

  it("rejects nonregular, linked, and wrong-mode immutable destinations", async () => {
    const wrongModeRoot = await root();
    const wrongMode = path.join(wrongModeRoot, "immutable.json");
    await writeFile(wrongMode, "value", { mode: 0o644 });
    await expect(publishImmutable(wrongModeRoot, "immutable.json", "value", true))
      .rejects.toThrow("Evidence-volume export failed");

    const linkedRoot = await root();
    const linked = path.join(linkedRoot, "immutable.json");
    await writeFile(linked, "value", { mode: 0o600 });
    await link(linked, path.join(linkedRoot, "peer-one"));
    await link(linked, path.join(linkedRoot, "peer-two"));
    await expect(publishImmutable(linkedRoot, "immutable.json", "value", true))
      .rejects.toThrow("Evidence-volume export failed");

    const directoryRoot = await root();
    await mkdir(path.join(directoryRoot, "immutable.json"));
    await expect(publishImmutable(directoryRoot, "immutable.json", "value", true))
      .rejects.toThrow("Evidence-volume export failed");

    const symlinkRoot = await root();
    await writeFile(path.join(symlinkRoot, "target"), "value", { mode: 0o600 });
    await symlink("target", path.join(symlinkRoot, "immutable.json"));
    await expect(publishImmutable(symlinkRoot, "immutable.json", "value", true))
      .rejects.toThrow("Evidence-volume export failed");
  });

  it("retries when an exact pending key disappears between lstat and open", async () => {
    const directory = await root();
    const pending = path.join(directory, ".destination-hmac.pending");
    await writeFile(pending, "a".repeat(64), { mode: 0o600 });
    let hookCalls = 0;

    await expect(destinationKey(directory, {
      afterDestinationKeyPendingLstatBeforeOpen: async () => {
        hookCalls += 1;
        await unlink(pending);
      },
    })).resolves.toHaveLength(32);
    expect(hookCalls).toBeGreaterThanOrEqual(1);
  });

  it("rejects pending-key replacement between lstat and open", async () => {
    const directory = await root();
    const pending = path.join(directory, ".destination-hmac.pending");
    await writeFile(pending, "a".repeat(64), { mode: 0o600 });

    await expect(destinationKey(directory, {
      afterDestinationKeyPendingLstatBeforeOpen: async () => {
        await unlink(pending);
        await writeFile(pending, "b".repeat(64), { mode: 0o600 });
      },
    })).rejects.toThrow("Evidence-volume export failed");
    expect(await readFile(pending, "utf8")).toBe("b".repeat(64));
  });

  it("rejects malformed pending keys and invalid final-link topologies", async () => {
    const malformedRoot = await root();
    await writeFile(path.join(malformedRoot, ".destination-hmac.pending"), "not-a-key", { mode: 0o600 });
    await expect(destinationKey(malformedRoot)).rejects.toThrow("Evidence-volume export failed");

    const twoLinkRoot = await root();
    const twoLinkFinal = path.join(twoLinkRoot, ".destination-hmac.key");
    await writeFile(twoLinkFinal, "c".repeat(64), { mode: 0o600 });
    await link(twoLinkFinal, path.join(twoLinkRoot, "foreign-peer"));
    await expect(destinationKey(twoLinkRoot)).rejects.toThrow("Evidence-volume export failed");
    expect((await lstat(twoLinkFinal)).nlink).toBe(2);

    const threeLinkRoot = await root();
    const threeLinkFinal = path.join(threeLinkRoot, ".destination-hmac.key");
    await writeFile(threeLinkFinal, "d".repeat(64), { mode: 0o600 });
    await link(threeLinkFinal, path.join(threeLinkRoot, "foreign-peer-one"));
    await link(threeLinkFinal, path.join(threeLinkRoot, "foreign-peer-two"));
    await expect(destinationKey(threeLinkRoot)).rejects.toThrow("Evidence-volume export failed");
    expect((await lstat(threeLinkFinal)).nlink).toBe(3);
  });

  it("fails closed at both destination-key link crash seams", async () => {
    const beforeLinkRoot = await root();
    await expect(destinationKey(beforeLinkRoot, {
      beforeDestinationKeyLink: async () => { throw new Error("injected crash"); },
    })).rejects.toThrow("Evidence-volume export failed");
    expect((await lstat(path.join(beforeLinkRoot, ".destination-hmac.pending"))).nlink).toBe(1);

    const afterLinkRoot = await root();
    await expect(destinationKey(afterLinkRoot, {
      afterDestinationKeyLinkBeforePendingUnlink: async () => { throw new Error("injected crash"); },
    })).rejects.toThrow("Evidence-volume export failed");
    expect((await lstat(path.join(afterLinkRoot, ".destination-hmac.key"))).nlink).toBe(2);
    expect((await lstat(path.join(afterLinkRoot, ".destination-hmac.pending"))).nlink).toBe(2);
  });

  it("recovers when the observed final disappears before convergence", async () => {
    const directory = await root();
    const final = path.join(directory, ".destination-hmac.key");
    await writeFile(final, "e".repeat(64), { mode: 0o600 });
    let removeOnce = true;

    const recovered = await destinationKey(directory, {
      afterDestinationKeyFinalSnapshot: async () => {
        if (!removeOnce) return;
        removeOnce = false;
        await unlink(final);
      },
    });
    expect(recovered.toString("hex")).not.toBe("e".repeat(64));
    expect(await readFile(final, "utf8")).toBe(recovered.toString("hex"));
  });

  it("adopts a staged generation when a different observed final disappears", async () => {
    const directory = await root();
    const final = path.join(directory, ".destination-hmac.key");
    const pending = path.join(directory, ".destination-hmac.pending");
    await writeFile(final, "e".repeat(64), { mode: 0o600 });
    await writeFile(pending, "f".repeat(64), { mode: 0o600 });
    let removeOnce = true;

    const recovered = await destinationKey(directory, {
      afterDestinationKeyFinalSnapshot: async () => {
        if (!removeOnce) return;
        removeOnce = false;
        await unlink(final);
      },
    });
    expect(recovered.toString("hex")).toBe("f".repeat(64));
    expect(await readFile(final, "utf8")).toBe("f".repeat(64));
  });

  it("converges when an exact concurrent publisher links the final first", async () => {
    const directory = await root();
    const final = path.join(directory, ".destination-hmac.key");
    const pending = path.join(directory, ".destination-hmac.pending");
    let linkOnce = true;

    const recovered = await destinationKey(directory, {
      beforeDestinationKeyLink: async () => {
        if (!linkOnce) return;
        linkOnce = false;
        await link(pending, final);
      },
    });
    expect(await readFile(final, "utf8")).toBe(recovered.toString("hex"));
    await expect(lstat(pending)).rejects.toThrow();
  });

  it("retries when its just-linked final disappears before healing", async () => {
    const directory = await root();
    const final = path.join(directory, ".destination-hmac.key");
    let removeOnce = true;

    const recovered = await destinationKey(directory, {
      afterDestinationKeyPendingLink: async () => {
        if (!removeOnce) return;
        removeOnce = false;
        await unlink(final);
      },
    });
    expect(await readFile(final, "utf8")).toBe(recovered.toString("hex"));
  });

  it("fails closed on a foreign third link introduced before healing", async () => {
    const directory = await root();
    const final = path.join(directory, ".destination-hmac.key");
    const foreign = path.join(directory, "foreign-peer");
    let linkOnce = true;

    await expect(destinationKey(directory, {
      afterDestinationKeyPendingLink: async () => {
        if (!linkOnce) return;
        linkOnce = false;
        await link(final, foreign);
      },
    })).rejects.toThrow("Evidence-volume export failed");
    expect((await lstat(final)).nlink).toBe(2);
    expect((await lstat(foreign)).nlink).toBe(2);
  });

  it("discards its staged generation when a foreign final replaces its link before healing", async () => {
    const directory = await root();
    const final = path.join(directory, ".destination-hmac.key");
    const pending = path.join(directory, ".destination-hmac.pending");
    const foreign = "1".repeat(64);
    let replaceOnce = true;

    const recovered = await destinationKey(directory, {
      afterDestinationKeyPendingLink: async () => {
        if (!replaceOnce) return;
        replaceOnce = false;
        await unlink(final);
        await writeFile(final, foreign, { mode: 0o600 });
      },
    });
    expect(recovered.toString("hex")).toBe(foreign);
    expect(await readFile(final, "utf8")).toBe(foreign);
    await expect(lstat(pending)).rejects.toThrow();
  });

  it("abandons its owned snapshot when a foreign pending generation replaces it", async () => {
    const directory = await root();
    const final = path.join(directory, ".destination-hmac.key");
    const pending = path.join(directory, ".destination-hmac.pending");
    const foreign = "2".repeat(64);
    let replaceOnce = true;

    const recovered = await destinationKey(directory, {
      afterDestinationKeyPendingLink: async () => {
        if (!replaceOnce) return;
        replaceOnce = false;
        await unlink(final);
        await unlink(pending);
        await writeFile(pending, foreign, { mode: 0o600 });
      },
    });
    expect(recovered.toString("hex")).toBe(foreign);
    expect(await readFile(final, "utf8")).toBe(foreign);
    await expect(lstat(pending)).rejects.toThrow();
  });

  it("abandons an owned pending generation that becomes triply linked before healing", async () => {
    const directory = await root();
    const final = path.join(directory, ".destination-hmac.key");
    const pending = path.join(directory, ".destination-hmac.pending");
    const peerOne = path.join(directory, "foreign-peer-one");
    const peerTwo = path.join(directory, "foreign-peer-two");
    let replaceOnce = true;

    const recovered = await destinationKey(directory, {
      afterDestinationKeyPendingLink: async () => {
        if (!replaceOnce) return;
        replaceOnce = false;
        await unlink(final);
        await link(pending, peerOne);
        await link(pending, peerTwo);
      },
    });
    expect(await readFile(final, "utf8")).toBe(recovered.toString("hex"));
    await expect(lstat(pending)).rejects.toThrow();
    expect((await lstat(peerOne)).nlink).toBe(2);
    expect((await lstat(peerTwo)).nlink).toBe(2);
  });

  it("treats an already-disappeared owned temporary as safely cleaned after failure", async () => {
    const directory = await root();
    let temporary = "";

    await expect(publishImmutable(directory, "immutable.json", "value", false, {
      afterImmutableTempIdentity: async (candidate) => {
        temporary = candidate;
        await unlink(candidate);
        throw new Error("injected crash");
      },
    })).rejects.toThrow("Evidence-volume export failed");
    await expect(lstat(temporary)).rejects.toThrow();
  });

  it("fails closed when filesystem policy denies removal of its owned temporary", async () => {
    const directory = await root();
    let temporary = "";
    try {
      await expect(publishImmutable(directory, "immutable.json", "value", false, {
        afterImmutableFinalLinkBeforeTempUnlink: async () => {
          temporary = path.join(directory, (await readdir(directory)).find((name) => name.endsWith(".tmp"))!);
          await chmod(directory, 0o500);
        },
      })).rejects.toThrow("Evidence-volume export failed");
    } finally {
      await chmod(directory, 0o700);
    }
    expect((await lstat(temporary)).nlink).toBe(2);
    expect((await lstat(path.join(directory, "immutable.json"))).nlink).toBe(2);
  });

  it("fails closed when directory policy blocks destination-key lookup", async () => {
    const directory = await root();
    await chmod(directory, 0o000);
    try {
      await expect(destinationKey(directory)).rejects.toThrow("Evidence-volume export failed");
    } finally {
      await chmod(directory, 0o700);
    }
  });
});
