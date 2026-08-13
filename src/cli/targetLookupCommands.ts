import type { Command } from "commander";

import {
  parseTargetOperationLookup,
  type TargetMutationRequest,
  type TargetOperationLookup
} from "../target/contracts.js";
import {
  createCanonicalTargetOperationLookupBytes,
  createTargetReceiptDigest,
  createTargetRequestDigest
} from "../target/handles.js";
import { lookupTargetOperation } from "../target/journal.js";
import { resolveTargetDefaultJournalRoot } from "../target/journalRoot.js";
import { readTargetLookupConfigStdin } from "./targetDefaultConfigStdin.js";
import { readTargetRequestFile } from "./targetRequestFile.js";

export interface TargetLookupCommandStreams {
  stderr(message: string): void;
  stdout(message: string): void;
}
export type TargetOperationLookupHandler = (
  request: TargetMutationRequest
) => Promise<TargetOperationLookup>;
export type TargetOperationLookupLoader = (
  configInput: unknown
) => Promise<TargetOperationLookupHandler>;
type SetExitCode = (exitCode: 1 | 2) => void;

const same = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

const emitLookup = (
  raw: unknown,
  request: TargetMutationRequest,
  streams: TargetLookupCommandStreams
): void => {
  const result = parseTargetOperationLookup(raw);
  const requestDigest = createTargetRequestDigest(request);
  if (result.idempotency_key !== request.idempotency_key
    || result.operation !== request.operation
    || result.request_digest !== requestDigest) throw new TypeError();
  if (result.status === "completed"
    && (result.receipt.receipt_digest !== createTargetReceiptDigest(result.receipt)
      || result.receipt.descriptor_digest !== request.descriptor_digest
      || result.receipt.run_id !== request.run_id
      || !same(result.receipt.selected_target, request.selected_target)
      || result.receipt.resulting_revision !== request.expected_revision + 1)) {
    throw new TypeError();
  }
  streams.stdout(createCanonicalTargetOperationLookupBytes(result));
};

export const registerTargetOperationLookup = (
  target: Command,
  loader: TargetOperationLookupLoader,
  streams: TargetLookupCommandStreams,
  setExitCode: SetExitCode
): void => {
  target.command("lookup_operation")
    .description("Read the state of one exact target mutation")
    .argument("<request-file>", "Original strict target-resource mutation request JSON file")
    .action(async (requestFile: string) => {
      let request: TargetMutationRequest;
      try {
        const parsed = await readTargetRequestFile(requestFile);
        if (parsed.operation === "select_target") throw new TypeError();
        request = parsed;
      } catch {
        streams.stderr("error: Invalid target lookup request"); setExitCode(2); return;
      }
      let lookup: TargetOperationLookupHandler;
      try { lookup = await loader((target.opts() as { config?: unknown }).config); }
      catch {
        streams.stderr("error: Invalid target lookup configuration"); setExitCode(2); return;
      }
      try { emitLookup(await lookup(request), request, streams); }
      catch { streams.stderr("error: Target operation lookup failed"); setExitCode(1); }
    });
};

export const createProductionTargetLookupLoader = (
  stdin: AsyncIterable<unknown>
): TargetOperationLookupLoader => async (configInput) => {
  if (configInput !== "-") throw new TypeError();
  const config = await readTargetLookupConfigStdin(stdin);
  return (request) => lookupTargetOperation({
    context: config.context,
    request,
    root: resolveTargetDefaultJournalRoot()
  });
};
