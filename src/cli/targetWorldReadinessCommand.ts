import type { Command } from "commander";

import {
  createCanonicalTargetWorldReadinessReceiptBytes,
  verifyTargetWorldReadinessReceipt,
  type TargetWorldReadinessRequest,
  type TargetWorldReadinessReceipt
} from "../target/worldReadiness.js";
import { formatCaughtTargetCliError } from "./targetReceiptOutput.js";
import { readTargetWorldReadinessRequestFile } from "./targetRequestFile.js";

export interface TargetWorldReadinessSession {
  queryWorldReadiness?(
    request: TargetWorldReadinessRequest
  ): Promise<TargetWorldReadinessReceipt>;
}

export type TargetWorldReadinessSessionLoader = (
  configInput: unknown
) => Promise<TargetWorldReadinessSession>;

export const registerTargetWorldReadinessCommand = (
  target: Command,
  session: TargetWorldReadinessSession | TargetWorldReadinessSessionLoader,
  streams: { readonly stderr: (message: string) => void; readonly stdout: (message: string) => void },
  setExitCode: (exitCode: 1 | 2) => void
): void => {
  target.command("query_world_readiness")
    .description("Query one exact running world's public readiness document")
    .argument("<request-file>", "Strict world readiness request JSON file")
    .action(async (requestFile: string) => {
      let request: TargetWorldReadinessRequest;
      try { request = await readTargetWorldReadinessRequestFile(requestFile); }
      catch {
        streams.stderr("error: Invalid world readiness request");
        setExitCode(2);
        return;
      }
      let activeSession: TargetWorldReadinessSession;
      try {
        activeSession = typeof session === "function"
          ? await session((target.opts() as { config?: unknown }).config as string)
          : session;
        if (typeof activeSession.queryWorldReadiness !== "function") throw new TypeError();
      } catch {
        streams.stderr("error: Invalid target configuration");
        setExitCode(2);
        return;
      }
      try {
        const receipt = verifyTargetWorldReadinessReceipt({
          receipt: await activeSession.queryWorldReadiness(request),
          request
        });
        streams.stdout(createCanonicalTargetWorldReadinessReceiptBytes(
          receipt
        ));
      } catch (error) {
        streams.stderr(formatCaughtTargetCliError(error, "Target world readiness query crashed"));
        setExitCode(1);
      }
    });
};
