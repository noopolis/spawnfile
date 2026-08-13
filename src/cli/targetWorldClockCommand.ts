import type { Command } from "commander";

import {
  createCanonicalTargetWorldClockReceiptBytes,
  verifyTargetWorldClockReceipt,
  type TargetWorldClockReceipt,
  type TargetWorldClockRequest,
} from "../target/worldClock.js";
import { formatCaughtTargetCliError } from "./targetReceiptOutput.js";
import { readTargetWorldClockRequestFile } from "./targetRequestFile.js";

export interface TargetWorldClockSession {
  queryWorldClock?(request: TargetWorldClockRequest): Promise<TargetWorldClockReceipt>;
}
export type TargetWorldClockSessionLoader = (
  configInput: unknown,
) => Promise<TargetWorldClockSession>;

export const registerTargetWorldClockCommand = (
  target: Command,
  session: TargetWorldClockSession | TargetWorldClockSessionLoader,
  streams: { readonly stderr: (message: string) => void; readonly stdout: (message: string) => void },
  setExitCode: (exitCode: 1 | 2) => void,
): void => {
  target.command("query_world_clock")
    .description("Query one exact activated world's observed public clock")
    .argument("<request-file>", "Strict world clock request JSON file")
    .action(async (requestFile: string) => {
      let request: TargetWorldClockRequest;
      try { request = await readTargetWorldClockRequestFile(requestFile); }
      catch {
        streams.stderr("error: Invalid world clock request");
        setExitCode(2);
        return;
      }
      let active: TargetWorldClockSession;
      try {
        active = typeof session === "function"
          ? await session((target.opts() as { config?: unknown }).config as string)
          : session;
        if (typeof active.queryWorldClock !== "function") throw new TypeError();
      } catch {
        streams.stderr("error: Invalid target configuration");
        setExitCode(2);
        return;
      }
      try {
        const receipt = verifyTargetWorldClockReceipt({
          receipt: await active.queryWorldClock(request), request,
        });
        streams.stdout(createCanonicalTargetWorldClockReceiptBytes(receipt));
      } catch (error) {
        streams.stderr(formatCaughtTargetCliError(error, "Target world clock query crashed"));
        setExitCode(1);
      }
    });
};
