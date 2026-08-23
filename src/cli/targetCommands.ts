import type { Command } from "commander";
import {
  createCanonicalTargetTopologyReceiptBytes,
  createCanonicalSelectedTargetReceiptBytes,
  createTargetTopologyReceiptDigest
} from "../target/handles.js";
import {
  createCanonicalTargetPublicArtifactSnapshotResultBytes,
  type TargetPublicArtifactSnapshotRequest,
  type TargetPublicArtifactSnapshotResult
} from "../target/publicArtifactSnapshot.js";
import {
  createCanonicalTargetTopologyActivationReceiptBytes,
  createTargetTopologyActivationReceiptDigest,
  parseTargetTopologyActivationReceipt,
  type TargetTopologyActivationResult
} from "../target/topologyActivation.js";
import {
  parseSelectedTargetReceipt,
  parseTargetTopologyReceipt,
  type SelectedTargetReceipt,
  type TargetResourceRequest,
  type TargetTopologyAttestationRequest
} from "../target/contracts.js";
import {
  TARGET_OPERATION_DISPATCH,
  type TargetOperation
} from "./targetOperationDispatch.js";
import {
  emitCanonicalTargetMutationReceipt,
  formatCaughtTargetCliError,
  formatTargetCliError,
  type TargetMutationResult
} from "./targetReceiptOutput.js";
import {
  readTargetRequestFile,
  readTargetPublicArtifactSnapshotRequestFile,
  readTargetTopologyAttestationRequestFile
} from "./targetRequestFile.js";
import {
  registerTargetOperationLookup,
  type TargetOperationLookupLoader
} from "./targetLookupCommands.js";
import type { TargetTopologyAttestationResult } from "../target/topologyAttestation.js";
import { registerTargetWorldClockCommand, type TargetWorldClockSession } from "./targetWorldClockCommand.js";
import {
  registerTargetWorldReadinessCommand,
  type TargetWorldReadinessSession,
} from "./targetWorldReadinessCommand.js";
import { registerTargetComposedPreparationCommand } from "./targetComposedPreparationCommand.js";

type RequestFor<Operation extends TargetOperation> =
  Extract<TargetResourceRequest, { operation: Operation }>;

export type TargetCommandHandlers = {
  [Operation in TargetOperation]: (
    request: RequestFor<Operation>
  ) => Promise<Operation extends "select_target" ? SelectedTargetReceipt : TargetMutationResult>;
};

export type TargetCommandSessionLoader = (configInput: unknown) => Promise<TargetCommandHandlerSession>;

export interface TargetCommandHandlerSession extends TargetWorldReadinessSession, TargetWorldClockSession {
  run<Result>(invoke: (handlers: TargetCommandHandlers) => Promise<Result>): Promise<Result>;
  activateTopology?(request: TargetTopologyAttestationRequest): Promise<TargetTopologyActivationResult>;
  attestTopology?(request: TargetTopologyAttestationRequest): Promise<TargetTopologyAttestationResult>;
  snapshotPublicArtifact?(
    request: TargetPublicArtifactSnapshotRequest
  ): Promise<TargetPublicArtifactSnapshotResult>;
}

export interface TargetCommandStreams {
  stderr(message: string): void;
  stdout(message: string): void;
}

export type SetTargetCommandExitCode = (exitCode: 1 | 2) => void;

const operations = Object.keys(TARGET_OPERATION_DISPATCH) as TargetOperation[];

const invoke = async (
  handlers: TargetCommandHandlers,
  request: TargetResourceRequest
): Promise<unknown> => {
  const handler = handlers[request.operation] as (
    value: TargetResourceRequest
  ) => Promise<unknown>;
  return handler(request);
};

const emitSelection = (raw: unknown, streams: TargetCommandStreams): void => {
  const receipt = parseSelectedTargetReceipt(raw);
  streams.stdout(createCanonicalSelectedTargetReceiptBytes(receipt));
};

const registerOperation = (
  target: Command,
  operation: TargetOperation,
  session: TargetCommandHandlerSession | TargetCommandSessionLoader,
  streams: TargetCommandStreams,
  setExitCode: SetTargetCommandExitCode
): void => {
  target.command(operation)
    .description(`Execute the ${operation} target operation`)
    .argument("<request-file>", "Strict target-resource request JSON file")
    .action(async (requestFile: string) => {
      let request: TargetResourceRequest;
      try {
        request = await readTargetRequestFile(requestFile);
        if (request.operation !== operation) throw new TypeError("operation mismatch");
      } catch {
        streams.stderr(formatTargetCliError("request"));
        setExitCode(2);
        return;
      }

      let activeSession: TargetCommandHandlerSession;
      try {
        activeSession = typeof session === "function"
          ? await session((target.opts() as { config?: unknown }).config as string)
          : session;
      } catch {
        streams.stderr("error: Invalid target configuration");
        setExitCode(2);
        return;
      }

      try {
        const result = await activeSession.run((handlers) => invoke(handlers, request));
        if (operation === "select_target") {
          emitSelection(result, streams);
        } else {
          emitCanonicalTargetMutationReceipt(result as TargetMutationResult, streams.stdout);
        }
      } catch (error) {
        streams.stderr(formatCaughtTargetCliError(error, "Target operation crashed"));
        setExitCode(1);
      }
    });
};

const emitTopologyReceipt = (
  raw: TargetTopologyAttestationResult,
  streams: TargetCommandStreams
): void => {
  const receipt = parseTargetTopologyReceipt(raw.receipt);
  const bytes = createCanonicalTargetTopologyReceiptBytes(receipt);
  if (typeof raw.receiptBytes !== "string" || raw.receiptBytes !== bytes
    || receipt.receipt_digest !== createTargetTopologyReceiptDigest(receipt)) {
    throw new TypeError("Target attestation returned a non-canonical receipt");
  }
  streams.stdout(bytes);
};

const emitTopologyActivationReceipt = (
  raw: TargetTopologyActivationResult,
  streams: TargetCommandStreams
): void => {
  const receipt = parseTargetTopologyActivationReceipt(raw.receipt);
  const bytes = createCanonicalTargetTopologyActivationReceiptBytes(receipt);
  if (typeof raw.receiptBytes !== "string" || raw.receiptBytes !== bytes
    || receipt.receipt_digest !== createTargetTopologyActivationReceiptDigest(receipt)) {
    throw new TypeError("Target activation returned a non-canonical receipt");
  }
  streams.stdout(bytes);
};

const registerTopologyActivation = (
  target: Command,
  session: TargetCommandHandlerSession | TargetCommandSessionLoader,
  streams: TargetCommandStreams,
  setExitCode: SetTargetCommandExitCode
): void => {
  target.command("activate_topology")
    .description("Release one exact attested target topology")
    .argument("<request-file>", "Strict target topology-attestation request JSON file")
    .action(async (requestFile: string) => {
      let request: TargetTopologyAttestationRequest;
      try { request = await readTargetTopologyAttestationRequestFile(requestFile); }
      catch {
        streams.stderr("error: Invalid target activation request");
        setExitCode(2);
        return;
      }
      let activeSession: TargetCommandHandlerSession;
      try {
        activeSession = typeof session === "function"
          ? await session((target.opts() as { config?: unknown }).config as string)
          : session;
        if (typeof activeSession.activateTopology !== "function") throw new TypeError();
      } catch {
        streams.stderr("error: Invalid target configuration");
        setExitCode(2);
        return;
      }
      try {
        emitTopologyActivationReceipt(
          await activeSession.activateTopology(request),
          streams
        );
      } catch (error) {
        streams.stderr(formatCaughtTargetCliError(error, "Target topology activation crashed"));
        setExitCode(1);
      }
    });
};

const registerTopologyAttestation = (
  target: Command,
  session: TargetCommandHandlerSession | TargetCommandSessionLoader,
  streams: TargetCommandStreams,
  setExitCode: SetTargetCommandExitCode
): void => {
  target.command("attest_topology")
    .description("Attest one exact composed target topology")
    .argument("<request-file>", "Strict target topology-attestation request JSON file")
    .action(async (requestFile: string) => {
      let request: TargetTopologyAttestationRequest;
      try { request = await readTargetTopologyAttestationRequestFile(requestFile); }
      catch {
        streams.stderr("error: Invalid target attestation request");
        setExitCode(2);
        return;
      }
      let activeSession: TargetCommandHandlerSession;
      try {
        activeSession = typeof session === "function"
          ? await session((target.opts() as { config?: unknown }).config as string)
          : session;
        if (typeof activeSession.attestTopology !== "function") throw new TypeError();
      } catch {
        streams.stderr("error: Invalid target configuration");
        setExitCode(2);
        return;
      }
      try {
        emitTopologyReceipt(await activeSession.attestTopology(request), streams);
      } catch (error) {
        streams.stderr(formatCaughtTargetCliError(error, "Target topology attestation crashed"));
        setExitCode(1);
      }
    });
};

const registerPublicArtifactSnapshot = (
  target: Command,
  session: TargetCommandHandlerSession | TargetCommandSessionLoader,
  streams: TargetCommandStreams,
  setExitCode: SetTargetCommandExitCode
): void => {
  target.command("snapshot_public_artifact")
    .description("Read one exact bounded public artifact from a world service")
    .argument("<request-file>", "Strict public artifact snapshot request JSON file")
    .action(async (requestFile: string) => {
      let request: TargetPublicArtifactSnapshotRequest;
      try { request = await readTargetPublicArtifactSnapshotRequestFile(requestFile); }
      catch {
        streams.stderr("error: Invalid public artifact snapshot request");
        setExitCode(2);
        return;
      }
      let activeSession: TargetCommandHandlerSession;
      try {
        activeSession = typeof session === "function"
          ? await session((target.opts() as { config?: unknown }).config as string)
          : session;
        if (typeof activeSession.snapshotPublicArtifact !== "function") throw new TypeError();
      } catch {
        streams.stderr("error: Invalid target configuration");
        setExitCode(2);
        return;
      }
      try {
        streams.stdout(createCanonicalTargetPublicArtifactSnapshotResultBytes(
          await activeSession.snapshotPublicArtifact(request)
        ));
      } catch (error) {
        streams.stderr(formatCaughtTargetCliError(error, "Target public artifact snapshot crashed"));
        setExitCode(1);
      }
    });
};

export const registerTargetCommands = (
  program: Command,
  session: TargetCommandHandlerSession | TargetCommandSessionLoader,
  streams: TargetCommandStreams,
  setExitCode: SetTargetCommandExitCode,
  lookupLoader?: TargetOperationLookupLoader,
  worldReadinessSession?: (
    configInput: unknown
  ) => Promise<TargetWorldReadinessSession & TargetWorldClockSession>,
  configFreeCommands: readonly string[] = []
): Command => {
  const target = program.command("target").description("Execute target-resource operations");
  if (typeof session === "function") {
    if (configFreeCommands.length === 0) {
      target.requiredOption("--config <config-input>", "Strict target configuration JSON stdin; use -");
    } else {
      target.option("--config <config-input>", "Strict target configuration JSON stdin; use -");
      target.hook("preAction", (_command, actionCommand) => {
        if (!configFreeCommands.includes(actionCommand.name())
          && (target.opts() as { config?: unknown }).config === undefined) {
          target.error("required option '--config <config-input>' not specified");
        }
      });
    }
  }
  for (const operation of operations) {
    registerOperation(target, operation, session, streams, setExitCode);
  }
  registerTargetComposedPreparationCommand(target, session, streams, setExitCode);
  if (typeof session === "function" || typeof session.attestTopology === "function") {
    registerTopologyAttestation(target, session, streams, setExitCode);
  }
  if (typeof session === "function" || typeof session.snapshotPublicArtifact === "function") {
    registerPublicArtifactSnapshot(target, session, streams, setExitCode);
  }
  if (typeof session === "function" || typeof session.queryWorldReadiness === "function") {
    registerTargetWorldReadinessCommand(
      target,
      worldReadinessSession ?? session,
      streams,
      setExitCode
    );
  }
  if (typeof session === "function" || typeof session.queryWorldClock === "function") {
    registerTargetWorldClockCommand(
      target,
      worldReadinessSession ?? session,
      streams,
      setExitCode
    );
  }
  if (typeof session === "function" || typeof session.activateTopology === "function") {
    registerTopologyActivation(target, session, streams, setExitCode);
  }
  if (lookupLoader) registerTargetOperationLookup(target, lookupLoader, streams, setExitCode);
  return target;
};
