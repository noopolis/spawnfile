import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout } from "node:timers/promises";

export type RunCommand = (
  command: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv
) => Promise<{ stdout: string; stderr: string }>;

const portInContainer = "19986";
const plugin = "@spawnfile-fixtures/echo-adapter";
const ownerLabel = "org.spawnfile.packed-acp-proof";
const conversations = [
  {
    target: { kind: "room", room_id: "adapter-proof" },
    request: "@echo SPAWNFILE_EXTERNAL_PING", reply: "SPAWNFILE_EXTERNAL_PONG", mentions: ["echo"],
    historyPath: "/v1/rooms/adapter-proof/messages?limit=40"
  },
  {
    target: { kind: "dm", dm_id: "adapter-proof-dm", participant_ids: ["operator", "echo"] },
    request: "SPAWNFILE_EXTERNAL_DM_PING", reply: "SPAWNFILE_EXTERNAL_DM_PONG", mentions: [],
    historyPath: "/v1/dms/adapter-proof-dm/messages?limit=40"
  }
];

type Conversation = typeof conversations[number];
type History = { messages?: Array<{ id?: string; from?: { id?: string }; parts?: Array<{ text?: string }> }> };
type Agents = { agents?: Array<{ id?: string; status?: string }> };

const waitFor = async <T>(label: string, read: () => Promise<T | undefined>): Promise<T> => {
  const deadline = Date.now() + 45_000;
  let lastError: unknown;
  do {
    try {
      const result = await read();
      if (result !== undefined) return result;
    } catch (error) {
      lastError = error;
    }
    await setTimeout(400);
  } while (Date.now() < deadline);
  throw new Error(`Packed ACP check timed out waiting for ${label}`, { cause: lastError });
};

const get = async <T>(url: string, route: string): Promise<T> => {
  const response = await fetch(url + route, { redirect: "error", signal: AbortSignal.timeout(2_000) });
  if (!response.ok) throw new Error(`GET ${route} returned ${response.status}`);
  return await response.json() as T;
};

const replyIds = async (url: string, conversation: Conversation): Promise<string[]> =>
  (await get<History>(url, conversation.historyPath)).messages?.flatMap((message) =>
    typeof message.id === "string" && message.from?.id === "echo" &&
      message.parts?.some(({ text }) => text === conversation.reply) ? [message.id] : []) ?? [];

const exchange = async (url: string, conversation: Conversation, previous?: string): Promise<string> => {
  const response = await fetch(url + "/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(5_000),
    body: JSON.stringify({
      from: { id: "operator", type: "human", name: "Packed ACP fixture" },
      target: conversation.target,
      parts: [{ kind: "text", text: conversation.request }],
      mentions: conversation.mentions
    })
  });
  if (!response.ok) throw new Error(`Fixture send returned ${response.status}: ${await response.text()}`);
  await response.body?.cancel();
  return waitFor(conversation.reply, async () => (await replyIds(url, conversation)).find((id) => id !== previous));
};

/** Only the separately packed adapter and installed CLI are used for this opt-in proof. */
export const verifyExternalAcpDocker = async (
  executable: string, consumer: string, fixture: string, releaseDirectory: string, run: RunCommand
): Promise<void> => {
  assert.ok(path.isAbsolute(releaseDirectory), "SPAWNFILE_VERIFY_ACP_RELEASE_DIR must be absolute");
  const root = await mkdtemp(path.join(consumer, "acp-docker-"));
  const id = `packed-acp-${randomUUID()}`;
  const emitterImage = `spawnfile-fixture/echo-harness:${id}`;
  const teamImage = `spawnfile-fixture/echo-team:${id}`;
  const label = `${ownerLabel}=${id}`;
  const docker = async (...args: string[]): Promise<string> => (await run("docker", args, root)).stdout.trim();
  const cleanup: (() => Promise<unknown>)[] = [];
  let container: string | undefined;

  // Check the effective endpoint before any Docker mutation. The proof sends
  // fixtures only to a loopback port owned by a local daemon.
  const endpoint = (process.env.DOCKER_CONTEXT || !process.env.DOCKER_HOST)
    ? await docker("context", "inspect", "--format", "{{.Endpoints.docker.Host}}")
    : process.env.DOCKER_HOST;
  assert.match(endpoint, /^(?:unix|npipe):\/\//u, "packed ACP proof requires a local Docker context");
  const rawArch = await docker("info", "--format", "{{.Architecture}}");
  const arch = /^(x86_64|amd64)$/u.test(rawArch) ? "amd64" : /^(aarch64|arm64)$/u.test(rawArch) ? "arm64" : undefined;
  assert.ok(arch, `Unsupported fixture Docker architecture: ${rawArch}`);
  const stamp = JSON.parse(await readFile(path.join(releaseDirectory, `local_moltnet_release_stamp_${arch}.json`), "utf8")) as { capabilities?: string[] };
  assert.ok(stamp.capabilities?.includes("acp-bridge"), "the explicit local Moltnet release must be stamped with acp-bridge");

  const ensureUnusedImage = async (image: string): Promise<void> => {
    try {
      await docker("image", "inspect", image);
    } catch (error) {
      if (error instanceof Error && /No such image|No such object/iu.test(error.message)) return;
      throw error;
    }
    throw new Error(`Refusing to replace existing fixture image ${image}`);
  };
  const imageLabel = `{{index .Config.Labels "${ownerLabel}"}}`;
  const build = async (image: string, context: string): Promise<void> => {
    await ensureUnusedImage(image);
    cleanup.push(async () => {
      try {
        if (await docker("image", "inspect", "--format", imageLabel, image) !== id) return;
      } catch (error) {
        if (error instanceof Error && /No such image|No such object/iu.test(error.message)) return;
        throw error;
      }
      await docker("image", "rm", image);
    });
    await docker("build", "--platform", `linux/${arch}`, "--label", label, "--tag", image, context);
    assert.equal(await docker("image", "inspect", "--format", imageLabel, image), id);
  };

  let failed = false;
  try {
    const project = path.join(root, "team");
    const compiled = path.join(root, "compiled");
    await mkdir(path.join(project, "echo"), { recursive: true });
    await copyFile(path.join(fixture, "Teamfile"), path.join(project, "Spawnfile"));
    await copyFile(path.join(fixture, "Spawnfile"), path.join(project, "echo", "Spawnfile"));
    await build(emitterImage, fixture);
    await run(executable, ["--adapter", plugin, "compile", project, "--out", compiled], root, {
      ...process.env,
      SPAWNFILE_HOME: path.join(root, "spawnfile-home"),
      SPAWNFILE_ACP_FIXTURE_TAG: id,
      SPAWNFILE_LOCAL_MOLTNET_RELEASE_DIR: releaseDirectory,
      SPAWNFILE_ALLOW_LOCAL_E2E: "1",
      SPAWNFILE_MOLTNET_TARGET_ARCH: arch
    });
    const dockerfile = await readFile(path.join(compiled, "Dockerfile"), "utf8");
    assert.ok(dockerfile.includes(`COPY --from=${emitterImage} `), "packed plugin did not select the isolated fixture image");
    await build(teamImage, compiled);

    const report = JSON.parse(await readFile(path.join(compiled, "spawnfile-report.json"), "utf8")) as {
      container?: { persistent_mounts?: Array<{ mount_path: string }> };
    };
    const mounts = report.container?.persistent_mounts;
    assert.ok(mounts?.length, "fixture compile report is missing durable mounts");
    const mountArgs: string[] = [];
    for (const [index, mount] of mounts.entries()) {
      const name = `${id}-${index}`;
      assert.match(mount.mount_path, /^\/var\/lib\/spawnfile\/moltnet\/[\w/-]+$/u, "unexpected fixture mount");
      await docker("volume", "create", "--label", label, name);
      const volumeLabel = `{{index .Labels "${ownerLabel}"}}`;
      const volumeOwner = () => docker("volume", "inspect", "--format", volumeLabel, name);
      cleanup.push(async () => {
        if (await volumeOwner() === id) await docker("volume", "rm", name);
      });
      assert.equal(await volumeOwner(), id, "volume is not owned by this proof");
      mountArgs.push("--mount", `type=volume,source=${name},target=${mount.mount_path}`);
    }
    const created = await docker("create", "--name", id, "--label", label,
      "--publish", `127.0.0.1::${portInContainer}`, ...mountArgs, teamImage);
    container = created;
    cleanup.push(() => docker("rm", "--force", created));

    const ready = async (): Promise<string> => {
      const started = await docker("inspect", "--format", "{{.State.StartedAt}}", created);
      const published = await docker("port", created, `${portInContainer}/tcp`);
      const address = /^127\.0\.0\.1:([0-9]+)$/u.exec(published);
      assert.ok(address, "expected exactly one published loopback port");
      const url = `http://127.0.0.1:${address[1]}`;
      await waitFor("native startup and node readiness", async () => {
        if (!(await docker("logs", "--since", started, created)).includes("external harness ready for echo")) return;
        await docker("exec", created, "test", "-s", "/run/spawnfile/moltnet-readiness/adapter_net-echo.json");
        if ((await get<Agents>(url, "/v1/agents")).agents?.some(({ id, status }) => id === "echo" && typeof status === "string" && status !== "offline")) return true;
      });
      return url;
    };
    await docker("start", created);
    const url = await ready();
    const before: string[] = [];
    for (const conversation of conversations) before.push(await exchange(url, conversation));

    await docker("restart", "--time", "2", created);
    const restartedUrl = await ready();
    for (const [index, conversation] of conversations.entries()) {
      const previous = before[index];
      assert.ok(previous && (await replyIds(restartedUrl, conversation)).includes(previous), "reply did not persist across restart");
      await exchange(restartedUrl, conversation, previous);
    }
  } catch (error) {
    failed = true;
    if (container) {
      try { process.stderr.write(`${await docker("logs", "--tail", "16", container)}\n`); } catch { /* Preserve the proof error. */ }
    }
    throw error;
  } finally {
    const errors: unknown[] = [];
    for (const remove of cleanup.reverse()) {
      try { await remove(); } catch (error) { errors.push(error); }
    }
    if (errors.length && !failed) throw new AggregateError(errors, "Could not clean up packed ACP fixture resources");
    if (errors.length) process.stderr.write(`Packed ACP fixture cleanup had ${errors.length} error(s)\n`);
  }
  process.stderr.write("Packed ACP Docker proof passed: native startup, room and DM replies, persistence, and fresh replies after restart\n");
};
