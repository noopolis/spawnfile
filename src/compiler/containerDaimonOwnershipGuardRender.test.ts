import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { renderDaimonOwnershipProgram } from "./containerDaimonOwnershipGuardRender.js";

const execFileAsync = promisify(execFile);

const encodedProgram = (immutableRuntimeRoots: string[] = []) =>
  Buffer.from(renderDaimonOwnershipProgram([], [], immutableRuntimeRoots, [], [], [], [], []), "utf8").toString("base64");

describe("renderDaimonOwnershipProgram", () => {
  it("preserves mutable state symlink leaves without touching targets", async () => {
    const { stdout } = await execFileAsync("docker", [
      "run", "--rm", "--env", `PROGRAM=${encodedProgram()}`, "node:24-bookworm-slim", "bash", "-ceu",
      [
        "install -d -o root -g root -m 711 /var/lib/spawnfile /var/lib/spawnfile/daimon",
        "install -d -o root -g root -m 755 /var/lib/spawnfile/state/nested /external",
        "printf keep > /external/sentinel",
        "chmod 600 /external/sentinel",
        "ln -s /external/sentinel /var/lib/spawnfile/state/current",
        "printf data > /var/lib/spawnfile/state/nested/file",
        "printf %s \"$PROGRAM\" | base64 -d > /tmp/guard.js",
        "node /tmp/guard.js 2000 /var/lib/spawnfile/state",
        "printf 'root=%s\n' \"$(stat -c '%u:%g:%a' /var/lib/spawnfile/state)\"",
        "printf 'file=%s\n' \"$(stat -c '%u:%g:%a' /var/lib/spawnfile/state/nested/file)\"",
        "printf 'link=%s:%s\n' \"$(stat -c '%F' /var/lib/spawnfile/state/current)\" \"$(readlink /var/lib/spawnfile/state/current)\"",
        "printf 'target=%s:%s\n' \"$(stat -c '%u:%g:%a' /external/sentinel)\" \"$(cat /external/sentinel)\""
      ].join("\n")
    ], { timeout: 60_000 });

    expect(stdout).toContain("root=2000:2000:755\n");
    expect(stdout).toContain("file=2000:2000:644\n");
    expect(stdout).toContain("link=symbolic link:/external/sentinel\n");
    expect(stdout).toContain("target=0:0:600:keep\n");
  }, 60_000);

  it("keeps root path, immutable tree, and unsupported state entries strict", async () => {
    const { stdout } = await execFileAsync("docker", [
      "run", "--rm",
      "--env", `MUTABLE=${encodedProgram()}`,
      "--env", `IMMUTABLE=${encodedProgram(["/opt/runtime"])}`,
      "node:24-bookworm-slim", "bash", "-ceu",
      [
        "set +e",
        "install -d -o root -g root -m 711 /var/lib/spawnfile /var/lib/spawnfile/daimon",
        "install -d -o root -g root -m 755 /external-root /var/lib/spawnfile/socket-state",
        "install -d -o root -g root -m 711 /opt/runtime",
        "ln -s /external-root /var/lib/spawnfile/root-link",
        "printf %s \"$MUTABLE\" | base64 -d > /tmp/mutable.js",
        "printf %s \"$IMMUTABLE\" | base64 -d > /tmp/immutable.js",
        "root_err=$(node /tmp/mutable.js 2000 /var/lib/spawnfile/root-link 2>&1 >/dev/null); root_status=$?",
        "ln -s /external-root /opt/runtime/link",
        "immutable_err=$(node /tmp/immutable.js 2000 /var/lib/spawnfile/socket-state 2>&1 >/dev/null); immutable_status=$?",
        "node -e \"const net=require('node:net'); const s=net.createServer(); s.listen('/var/lib/spawnfile/socket-state/sock',()=>setTimeout(()=>{},10000));\" & socket_pid=$!",
        "for i in $(seq 1 50); do [ -S /var/lib/spawnfile/socket-state/sock ] && break; sleep 0.1; done",
        "socket_err=$(node /tmp/mutable.js 2000 /var/lib/spawnfile/socket-state 2>&1 >/dev/null); socket_status=$?",
        "kill $socket_pid 2>/dev/null || true",
        "printf 'root=%s:%s\n' \"$root_status\" \"$root_err\"",
        "printf 'immutable=%s:%s\n' \"$immutable_status\" \"$immutable_err\"",
        "printf 'socket=%s:%s\n' \"$socket_status\" \"$socket_err\""
      ].join("\n")
    ], { timeout: 60_000 });

    expect(stdout).toContain("root=1:Daimon ownership guard: root has a symbolic-link or unavailable path component\n");
    expect(stdout).toContain("immutable=1:Daimon ownership guard: immutable runtime contains a symbolic link or unavailable entry\n");
    expect(stdout).toContain("socket=1:Daimon ownership guard: state tree contains an unsupported entry\n");
  }, 60_000);
});
