import os from "node:os";
import path from "node:path";
import {
  chmod,
  link,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  admitLifecyclePlan,
  claimLifecycleInvocation,
  completeLifecycleInvocation,
  findExactLifecycleCompletion,
  lookupLifecycleCompletion,
  resolveLifecycleCompletionPath,
  type LifecycleInvocation,
  type LifecycleOwnerCapability,
} from "./lifecycleCompletion.js";
import {
  findLifecycleUpReservation,
  findLifecycleUpStart,
  recordLifecycleUpCleanup,
  recordLifecycleUpReservation,
  recordLifecycleUpStart,
} from "./lifecycleUpRecords.js";
import { setLifecycleStoreTestHook } from "./lifecycleCompletionStore.js";
import { matchesSettledLifecyclePublication } from "./lifecycleCompletionPublication.js";

const originalHome = process.env.SPAWNFILE_HOME;
let home = "";

const invocation = (
  overrides: Partial<LifecycleInvocation> = {},
): LifecycleInvocation => ({
  correlation: {
    deployment: "default",
    fingerprint: "sf1:test",
    run_id: "run-test",
  },
  id: `lci_${"a".repeat(16)}`,
  operation: "down",
  request_policy: { force: false, remove_volumes: false },
  version: "spawnfile.lifecycle-invocation.v1",
  ...overrides,
});
const claimOwner = async (
  value: LifecycleInvocation,
): Promise<LifecycleOwnerCapability> => {
  const claim = await claimLifecycleInvocation(value);
  expect(claim.status).toBe("owner");
  if (claim.status !== "owner") throw new Error("expected lifecycle owner");
  return claim.capability;
};

beforeEach(async () => {
  home = await mkdtemp(
    path.join(os.tmpdir(), "spawnfile-lifecycle-completion-"),
  );
  process.env.SPAWNFILE_HOME = home;
});

afterEach(async () => {
  setLifecycleStoreTestHook(null);
  if (originalHome === undefined) delete process.env.SPAWNFILE_HOME;
  else process.env.SPAWNFILE_HOME = originalHome;
  await rm(home, { force: true, recursive: true });
});

describe("lifecycle completion store", () => {
  it("returns not_applied without needing a deployment or provider lookup", async () => {
    await expect(lookupLifecycleCompletion(invocation().id)).resolves.toEqual({
      invocation_id: invocation().id,
      status: "not_applied",
      version: "spawnfile.lifecycle-lookup.v1",
    });
  });

  it("leaves a missing completion root absent for read-only lookup", async () => {
    await lookupLifecycleCompletion(invocation().id);
    await expect(
      lstat(path.join(home, "lifecycle-completions")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("accepts a normal secure temporary home and rejects a writable home ancestor", async () => {
    const capability = await claimOwner(invocation());
    expect(capability.role).toBe("initial");
    await chmod(home, 0o777);
    await expect(lookupLifecycleCompletion(invocation().id)).rejects.toThrow(
      /unsafe root/,
    );
  });

  it("accepts secure SPAWNFILE_HOME below sticky /tmp and the macOS /var alias", async () => {
    await rm(home, { force: true, recursive: true });
    home = await mkdtemp("/tmp/spawnfile-lifecycle-authority-");
    process.env.SPAWNFILE_HOME = home;
    await expect(claimOwner(invocation())).resolves.toMatchObject({
      role: "initial",
    });
    if (process.platform === "darwin") {
      expect(os.tmpdir().startsWith("/var/")).toBe(true);
    }
  });

  it("rejects configured-home replacement and arbitrary symlink substitution", async () => {
    await claimOwner(invocation());
    const prior = `${home}-prior`;
    await rename(home, prior);
    await mkdir(home, { mode: 0o700 });
    await expect(lookupLifecycleCompletion(invocation().id)).rejects.toThrow(
      /root changed/,
    );
    await rm(home, { recursive: true });
    await symlink(prior, home);
    await expect(lookupLifecycleCompletion(invocation().id)).rejects.toThrow(
      /unsafe root|root changed/,
    );
    await rm(home);
    await rename(prior, home);
  });

  it("rejects a configured symlink before creating anything in its target", async () => {
    await rm(home, { recursive: true });
    const target = `${home}-symlink-target`;
    await mkdir(target, { mode: 0o700 });
    await symlink(target, home);
    await expect(claimLifecycleInvocation(invocation())).rejects.toThrow(
      /unsafe root/,
    );
    await expect(
      lstat(path.join(target, "lifecycle-completions")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await rm(home);
    await rm(target, { recursive: true });
    await mkdir(home, { mode: 0o700 });
  });

  it.each([
    "before_missing_return",
    "before_record_open",
    "before_publish_temp_open",
    "before_publish_link",
    "before_publish_unlink",
  ] as const)(
    "detects root replacement at %s before touching the substitute tree",
    async (point) => {
      const root = path.join(home, "lifecycle-completions");
      const prior = `${root}-prior`;
      if (
        point === "before_missing_return" ||
        point === "before_record_open"
      ) {
        await claimOwner(invocation());
      }
      let swapped = false;
      setLifecycleStoreTestHook(async (current) => {
        if (swapped || current !== point) return;
        swapped = true;
        await rename(root, prior);
        await mkdir(root, { mode: 0o700 });
        await writeFile(path.join(root, "substitute-sentinel"), "untouched", {
          mode: 0o600,
        });
      });
      const action =
        point === "before_missing_return"
          ? lookupLifecycleCompletion(
              invocation({ id: `lci_${"m".repeat(16)}` }).id,
            )
          : point === "before_record_open"
            ? lookupLifecycleCompletion(invocation().id)
            : claimLifecycleInvocation(
                invocation({ id: `lci_${point.at(-1)!.repeat(16)}` }),
              );
      await expect(action).rejects.toThrow(/root changed/);
      expect(swapped).toBe(true);
      expect(
        await readFile(path.join(root, "substitute-sentinel"), "utf8"),
      ).toBe("untouched");
      expect((await (await import("node:fs/promises")).readdir(root)).sort()).toEqual([
        "substitute-sentinel",
      ]);
      setLifecycleStoreTestHook(null);
      await rm(root, { recursive: true });
      await rename(prior, root);
    },
  );

  it("persists and reads exact machine outcome bytes", async () => {
    const bytes = JSON.stringify(
      {
        deployment: "default",
        errors: [],
        retained_volumes: [],
        units_stopped: [],
        version: "spawnfile.down-receipt.v1",
      },
      null,
      2,
    );
    const capability = await claimOwner(invocation());
    await completeLifecycleInvocation(invocation(), bytes, capability);

    await expect(
      findExactLifecycleCompletion(invocation()),
    ).resolves.toMatchObject({ outcome_bytes: bytes });
    await expect(
      lookupLifecycleCompletion(invocation().id),
    ).resolves.toMatchObject({
      operation: "down",
      outcome_bytes: bytes,
      status: "completed",
    });
  });

  it("elects one owner and reports pending/replay without executing another owner", async () => {
    const bytes = JSON.stringify(
      {
        deployment: "default",
        errors: [],
        retained_volumes: [],
        units_stopped: [],
        version: "spawnfile.down-receipt.v1",
      },
      null,
      2,
    );
    const [first, second] = await Promise.all([
      claimLifecycleInvocation(invocation()),
      claimLifecycleInvocation(invocation()),
    ]);
    expect([first.status, second.status].sort()).toEqual(["owner", "pending"]);
    const owner = first.status === "owner" ? first : second;
    if (owner.status !== "owner") throw new Error("expected owner");
    await completeLifecycleInvocation(invocation(), bytes, owner.capability);
    await expect(claimLifecycleInvocation(invocation())).resolves.toMatchObject(
      {
        status: "replay",
      },
    );
  });

  it("atomically resolves a conflicting plan-versus-admission race", async () => {
    const planned = invocation({
      request_policy: { force: true, remove_volumes: false },
    });
    const executing = invocation({
      request_policy: { force: false, remove_volumes: true },
    });
    const results = await Promise.allSettled([
      admitLifecyclePlan(planned),
      claimLifecycleInvocation(executing),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(
      1,
    );
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(
      1,
    );
  });

  it("fails closed for reused ids, redeploy/request drift, divergent outcomes, and corrupt files", async () => {
    const bytes = JSON.stringify(
      {
        deployment: "default",
        errors: [],
        retained_volumes: [],
        units_stopped: [],
        version: "spawnfile.down-receipt.v1",
      },
      null,
      2,
    );
    const capability = await claimOwner(invocation());
    await completeLifecycleInvocation(invocation(), bytes, capability);
    await expect(
      findExactLifecycleCompletion(
        invocation({
          request_policy: { force: true, remove_volumes: false },
        }),
      ),
    ).rejects.toThrow(/invocation id drift/);
    await expect(
      completeLifecycleInvocation(
        invocation(),
        '{"version":"different"}',
        capability,
      ),
    ).rejects.toThrow();

    await writeFile(
      resolveLifecycleCompletionPath(invocation().id),
      "{corrupt",
      "utf8",
    );
    await expect(lookupLifecycleCompletion(invocation().id)).rejects.toThrow(
      /corrupt terminal/,
    );
  });

  it("fails closed for symlink, hardlink, mode, and crash-prefix records", async () => {
    const file = resolveLifecycleCompletionPath(invocation().id);
    await claimLifecycleInvocation(invocation());
    await writeFile(file, "{}", { mode: 0o600 });
    await expect(lookupLifecycleCompletion(invocation().id)).rejects.toThrow();
    await rm(file);
    await symlink("/etc/passwd", file);
    await expect(lookupLifecycleCompletion(invocation().id)).rejects.toThrow(
      /unsafe record/,
    );
    await rm(file);
    await writeFile(file, "{}", { mode: 0o600 });
    await link(file, `${file}.linked`);
    await expect(lookupLifecycleCompletion(invocation().id)).rejects.toThrow(
      /publication did not settle/,
    );
    await rm(file, { force: true });
    await rm(`${file}.linked`, { force: true });
    await claimLifecycleInvocation(invocation());
    await chmod(path.dirname(file), 0o755);
    await expect(lookupLifecycleCompletion(invocation().id)).rejects.toThrow(
      /unsafe root/,
    );
  });

  it("rejects hostile admissions and completion records without their admission", async () => {
    const admission = path.join(
      home,
      "lifecycle-completions",
      `${invocation().id}.admission`,
    );
    await claimLifecycleInvocation(invocation());
    await rm(admission);
    await symlink("/etc/passwd", admission);
    await expect(claimLifecycleInvocation(invocation())).rejects.toThrow(
      /unsafe record/,
    );
    await rm(admission);
    await writeFile(admission, "{}", { mode: 0o600 });
    await link(admission, `${admission}.linked`);
    await expect(findExactLifecycleCompletion(invocation())).rejects.toThrow(
      /publication did not settle/,
    );
    await rm(admission, { force: true });
    await rm(`${admission}.linked`, { force: true });
    const completion = resolveLifecycleCompletionPath(invocation().id);
    await writeFile(completion, "{}", { mode: 0o600 });
    await expect(lookupLifecycleCompletion(invocation().id)).rejects.toThrow(
      /completion without admission/,
    );
  });

  it("accepts only the complete export wrapper and canonical operation outcomes", async () => {
    const exported = invocation({
      id: `lci_${"b".repeat(16)}`,
      operation: "artifacts_export",
    });
    const index = {
      deployment: "default",
      exported_at: "2026-01-01T00:00:00.000Z",
      files: [],
      run_id: "run-test",
      version: "spawnfile.export-index.v1",
    };
    const valid = JSON.stringify(
      {
        deployment: "default",
        failed_files: [],
        index,
        index_path: "/tmp/index.json",
        missing_optional_files: [],
      },
      null,
      2,
    );
    const exportCapability = await claimOwner(exported);
    await expect(
      completeLifecycleInvocation(exported, valid, exportCapability),
    ).resolves.toBeDefined();
    for (const [id, bytes] of [
      ["c", "{}"],
      [
        "d",
        JSON.stringify(
          {
            deployment: "default",
            failed_files: [],
            index,
            index_path: "/tmp/index.json",
          },
          null,
          2,
        ),
      ],
      [
        "e",
        JSON.stringify(
          {
            deployment: "default",
            failed_files: Array.from({ length: 10_001 }, () => "x"),
            index,
            index_path: "/tmp/index.json",
            missing_optional_files: [],
          },
          null,
          2,
        ),
      ],
    ]) {
      const bad = invocation({
        id: `lci_${id.repeat(16)}`,
        operation: "artifacts_export",
      });
      const capability = await claimOwner(bad);
      await expect(
        completeLifecycleInvocation(bad, bytes, capability),
      ).rejects.toThrow();
    }
    for (const [id, operation, bytes] of [
      ["f", "up", "{}"],
      ["g", "down", "{}"],
      [
        "h",
        "down",
        '{"deployment":"default","errors":[],"retained_volumes":[],"units_stopped":[],"version":"spawnfile.down-receipt.v1"}',
      ],
    ] as const) {
      const bad = invocation({ id: `lci_${id.repeat(16)}`, operation });
      const capability = await claimOwner(bad);
      await expect(
        completeLifecycleInvocation(bad, bytes, capability),
      ).rejects.toThrow();
    }
  });

  it("rejects a completion copied from a different immutable admission", async () => {
    const left = invocation({ id: `lci_${"i".repeat(16)}` });
    const right = invocation({ id: `lci_${"j".repeat(16)}` });
    const bytes = JSON.stringify(
      {
        deployment: "default",
        errors: [],
        retained_volumes: [],
        units_stopped: [],
        version: "spawnfile.down-receipt.v1",
      },
      null,
      2,
    );
    await claimOwner(left);
    const rightCapability = await claimOwner(right);
    await completeLifecycleInvocation(right, bytes, rightCapability);
    await writeFile(
      resolveLifecycleCompletionPath(left.id),
      await readFile(resolveLifecycleCompletionPath(right.id)),
      { mode: 0o600 },
    );
    await expect(lookupLifecycleCompletion(left.id)).rejects.toThrow(
      /admission drift/,
    );
  });

  it("settles nlink=2 after several yields and second claims stay pending/replay", async () => {
    const transient = invocation({ id: `lci_${"k".repeat(16)}` });
    const transientCapability = await claimOwner(transient);
    const file = path.join(
      home,
      "lifecycle-completions",
      `${transient.id}.admission`,
    );
    const copy = `${file}.copy`;
    await link(file, copy);
    expect((await lstat(file)).nlink).toBe(2);
    // This deliberately exceeds the former short settle window. A real
    // competing publisher can be delayed by unrelated lifecycle work, but its
    // exact temporary link must still settle before a second claimant fails.
    const delayedUnlink = new Promise<void>((resolve, reject) => {
      setTimeout(() => rm(copy).then(resolve, reject), 200);
    });
    await expect(claimLifecycleInvocation(transient)).resolves.toMatchObject({
      status: "pending",
    });
    await delayedUnlink;

    const bytes = JSON.stringify(
      {
        deployment: "default",
        errors: [],
        retained_volumes: [],
        units_stopped: [],
        version: "spawnfile.down-receipt.v1",
      },
      null,
      2,
    );
    await completeLifecycleInvocation(transient, bytes, transientCapability);
    await expect(claimLifecycleInvocation(transient)).resolves.toMatchObject({
      status: "replay",
    });
  });

  it("rereads an existing publication after transient nlink=2 settles", async () => {
    const file = path.join(home, "existing-publication");
    const copy = `${file}.copy`;
    const content = "exact\n";
    await writeFile(file, content, { mode: 0o600 });
    await link(file, copy);
    let reads = 0;
    const delayedUnlink = new Promise<void>((resolve, reject) => {
      setTimeout(() => rm(copy).then(resolve, reject), 20);
    });
    await expect(
      matchesSettledLifecyclePublication(file, content, async (candidate) => {
        reads += 1;
        return readFile(candidate, "utf8");
      }),
    ).resolves.toBe(true);
    await delayedUnlink;
    expect(reads).toBe(2);
  });

  it("fails persistent nlink=2 with the exact unsettled-publication error", async () => {
    const permanent = invocation({ id: `lci_${"l".repeat(16)}` });
    await claimLifecycleInvocation(permanent);
    const hostile = path.join(
      home,
      "lifecycle-completions",
      `${permanent.id}.admission`,
    );
    await link(hostile, `${hostile}.copy`);
    expect((await lstat(hostile)).nlink).toBe(2);
    await expect(claimLifecycleInvocation(permanent)).rejects.toThrow(
      "Lifecycle completion store refused: publication did not settle",
    );
  });

  it("binds a detached up start to its pre-effect reservation and permits an exact cleaned retry", async () => {
    const up = invocation({
      id: `lci_${"u".repeat(16)}`,
      operation: "up",
      request_policy: { detach: true },
    });
    const capability = await claimOwner(up);
    const reservation = {
      container_name: "detached-organization",
      docker_command: "docker",
      docker_context: null,
      label_authority: {
        permitted_extra_labels: "image-config-labels" as const,
        required: { "dev.spawnfile.deployment": "default" },
      },
    };
    const start = {
      container_id: "c".repeat(64),
      container_name: "detached-organization",
      image_id: `sha256:${"d".repeat(64)}`,
      label_authority: reservation.label_authority,
    };
    await recordLifecycleUpReservation(up, reservation, capability);
    await expect(findLifecycleUpReservation(up)).resolves.toMatchObject(reservation);
    await recordLifecycleUpStart(up, start, capability);
    await expect(findLifecycleUpStart(up)).resolves.toMatchObject({ attempt: 0, start });
    await expect(recordLifecycleUpStart(up, { ...start, container_name: "other" }, capability))
      .rejects.toThrow("up start authority drift");
    const active = await findLifecycleUpStart(up);
    if (!active) throw new Error("expected active up start");
    await recordLifecycleUpCleanup(up, active, capability);
    await recordLifecycleUpStart(up, { ...start, container_id: "e".repeat(64) }, capability);
    await expect(findLifecycleUpStart(up)).resolves.toMatchObject({
      attempt: 1,
      start: { ...start, attempt: 1, container_id: "e".repeat(64) },
    });
  });
});
