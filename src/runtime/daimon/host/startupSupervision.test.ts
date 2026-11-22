import { describe, expect, it } from "vitest";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { DAIMON_BROKER_STARTUP_TIMEOUT_SECONDS, renderDaimonBrokerSocketWait } from "./uidEntrypointRender.js";

const execFile = promisify(execFileCallback);

describe("Daimon broker socket startup wait", () => {
  const nodeSocketServer = `const net=require("node:net");const socket=process.argv[1];const delay=Number(process.argv[2]);setTimeout(()=>{const server=net.createServer();server.listen(socket,()=>setTimeout(()=>server.close(),500));},delay);`;

  it("uses the production cold-start budget and remains fail-fast and bounded", async () => {
    expect(DAIMON_BROKER_STARTUP_TIMEOUT_SECONDS).toBe(60);
    const root = await mkdtemp(path.join(os.tmpdir(), "spawnfile-broker-wait-"));
    const waitProgram = renderDaimonBrokerSocketWait(2, 0.02).join("\n");
    const delayedSocket = path.join(root, "delayed.sock");
    await expect(execFile("bash", ["-ceu", `${waitProgram}\nnode -e "$0" "$1" 120 & child=$!\nwait_for_broker_socket "$1" "$child" delayed\nkill "$child" 2>/dev/null || true\nwait "$child" 2>/dev/null || true`, nodeSocketServer, delayedSocket])).resolves.toBeDefined();

    const earlyStarted = Date.now();
    await expect(execFile("bash", ["-ceu", `${waitProgram}\nnode -e 'process.exit(7)' & child=$!\nwait_for_broker_socket "$1" "$child" early`, "", path.join(root, "early.sock")])).rejects.toThrow(/early exited before readiness \(status 7\)/u);
    expect(Date.now() - earlyStarted).toBeLessThan(1_000);

    const timeoutStarted = Date.now();
    await expect(execFile("bash", ["-ceu", `${renderDaimonBrokerSocketWait(1, 0.02).join("\n")}\nsleep 5 & child=$!\ntrap 'kill "$child" 2>/dev/null || true' EXIT\nwait_for_broker_socket "$1" "$child" never`, "", path.join(root, "never.sock")])).rejects.toThrow(/never readiness timed out after 1s/u);
    expect(Date.now() - timeoutStarted).toBeLessThan(2_500);
    await rm(root, { recursive: true, force: true });
  });

  it("waits for the exact post-drop process identity within the shared budget", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "spawnfile-broker-identity-"));
    const waitProgram = renderDaimonBrokerSocketWait(2, 0.02).join("\n");
    const delayed = `${waitProgram}\nbroker_process_status_root="$1"\nsleep 5 & child=$!\ntrap 'kill "$child" 2>/dev/null || true' EXIT\nmkdir -p "$1/$child"\nprintf 'Uid:\\t0\\nCapBnd:\\t00000000000000c1\\n' > "$1/$child/status"\n(sleep 0.12; printf 'Uid:\\t2100\\nCapBnd:\\t0000000000000000\\n' > "$1/$child/status") &\nwait_for_broker_identity "$child" 2100 0000000000000000 relay`;
    await expect(execFile("bash", ["-ceu", delayed, "", root])).resolves.toBeDefined();

    const never = `${renderDaimonBrokerSocketWait(1, 0.02).join("\n")}\nbroker_process_status_root="$1"\nsleep 5 & child=$!\ntrap 'kill "$child" 2>/dev/null || true' EXIT\nmkdir -p "$1/$child"\nprintf 'Uid:\\t0\\nCapBnd:\\t00000000000000c1\\n' > "$1/$child/status"\nwait_for_broker_identity "$child" 2100 0000000000000000 relay`;
    await expect(execFile("bash", ["-ceu", never, "", root])).rejects.toThrow(/relay identity readiness timed out after 1s/u);

    const exited = `${waitProgram}\nbroker_process_status_root="$1"\nnode -e 'process.exit(9)' & child=$!\nwait_for_broker_identity "$child" 2100 0000000000000000 relay`;
    await expect(execFile("bash", ["-ceu", exited, "", root])).rejects.toThrow(/relay exited before identity readiness \(status 9\)/u);
    await rm(root, { recursive: true, force: true });
  });
});
