import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

import type { Command } from "commander";

import {
  buildProvisionedWorldBindings,
  disposeProvisionedMaterials,
  finalizeCredentialProvisioningReceipt,
  readCredentialProvisioningRequestFile,
  writeProvisionedEnvFile,
  type ProvisionedCredentialMaterials,
  type ResolvedAuthProfile
} from "../auth/index.js";
import { createCanonicalTargetSecretSourceJson } from "../auth/targetSecretSourceRecordCommon.js";
import { renderSimfileWorldBindings } from "../compiler/worldBindings.js";
import {
  MAX_TARGET_SECRET_SOURCE_SECRET_BYTES,
  TARGET_SECRET_SOURCE_ERROR
} from "../auth/targetSecretSourceRecordCommon.js";
import type { CliHandlers, CliStreams } from "./runCli.js";
import {
  createTargetSecretSourceReceiptBytes,
  readBoundedTargetSecretStdin,
  readTargetSecretSourceGrantRequestFile,
  readTargetSecretSourceRequestFile,
  type TargetSecretSourceCommandKind
} from "./targetSecretSourceInput.js";

type AuthCommandHandlers = Pick<
  CliHandlers,
  | "importClaudeCodeAuth"
  | "importCodexAuth"
  | "importEnvFile"
  | "initializeTargetSecretSourceLifecycle"
  | "provisionCredentials"
  | "requireAuthProfile"
  | "syncProjectAuth"
>;

const formatAuthProfileSummary = (profile: ResolvedAuthProfile): string[] => {
  const envKeys = Object.keys(profile.env).sort();
  const importedKinds = Object.keys(profile.imports).sort();

  return [
    `profile: ${profile.name}`,
    `env: ${envKeys.length > 0 ? envKeys.join(", ") : "none"}`,
    `imports: ${importedKinds.length > 0 ? importedKinds.join(", ") : "none"}`
  ];
};

const emitLines = (streams: CliStreams, lines: string[]): void =>
  lines.forEach((line) => streams.stdout(line));
const emitTargetSecretReceipt = (
  streams: CliStreams,
  kind: TargetSecretSourceCommandKind,
  sourceHandle: unknown
): void => {
  const bytes = createTargetSecretSourceReceiptBytes({ kind, source_handle: sourceHandle });
  try { streams.stdout(new TextDecoder().decode(bytes)); } finally { bytes.fill(0); }
};
const targetSecretAction = async (work: () => Promise<void>): Promise<void> => {
  try { await work(); } catch { throw new Error(TARGET_SECRET_SOURCE_ERROR); }
};
const emitCredentialProvisioningReceipt = (streams: CliStreams, receipt: unknown): void => {
  const bytes = createCanonicalTargetSecretSourceJson(receipt);
  try { streams.stdout(new TextDecoder().decode(bytes)); } finally { bytes.fill(0); }
};
const readResolvedGrantsFile = async (filePath: string): Promise<unknown> => {
  let bytes: Buffer | undefined;
  try {
    bytes = await readFile(filePath);
    if (bytes.length < 1 || bytes.length > 65_536) throw new Error();
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error(TARGET_SECRET_SOURCE_ERROR);
  } finally {
    bytes?.fill(0);
  }
};
const writeWorldBindingsFile = async (
  filePath: string,
  artifact: Parameters<typeof renderSimfileWorldBindings>[0]
): Promise<string> => {
  const bytes = new TextEncoder().encode(renderSimfileWorldBindings(artifact));
  try {
    await writeFile(filePath, bytes, { flag: "wx", mode: 0o600 });
    return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  } finally {
    bytes.fill(0);
  }
};

export const registerAuthCommands = (
  program: Command,
  handlers: AuthCommandHandlers,
  streams: CliStreams,
  stdin: AsyncIterable<unknown>
): void => {
  const authCommand = program.command("auth").description("Manage local Spawnfile auth profiles");
  const authImportCommand = authCommand
    .command("import")
    .description("Import auth material into a local auth profile");

  authImportCommand
    .command("env")
    .description("Import secrets from an env file into a profile")
    .argument("<file>", "Path to an env file")
    .option("-p, --profile <name>", "Auth profile name", "default")
    .action(async (filePath: string, options: { profile: string }) => {
      const profile = await handlers.importEnvFile(options.profile, filePath);
      emitLines(streams, formatAuthProfileSummary(profile));
    });

  authImportCommand
    .command("claude-code")
    .description("Import Claude Code subscription credentials into a profile")
    .option("-p, --profile <name>", "Auth profile name", "default")
    .option("--from <directory>", "Source Claude Code config directory")
    .action(async (options: { from?: string; profile: string }) => {
      const profile = await handlers.importClaudeCodeAuth(options.profile, options.from);
      emitLines(streams, formatAuthProfileSummary(profile));
    });

  authImportCommand
    .command("codex")
    .description("Import Codex subscription credentials into a profile")
    .option("-p, --profile <name>", "Auth profile name", "default")
    .option("--from <directory>", "Source Codex config directory")
    .action(async (options: { from?: string; profile: string }) => {
      const profile = await handlers.importCodexAuth(options.profile, options.from);
      emitLines(streams, formatAuthProfileSummary(profile));
    });

  authCommand
    .command("sync")
    .description("Provision auth material a project requires into a profile")
    .argument("[path]", "Project directory or Spawnfile path", process.cwd())
    .option("-p, --profile <name>", "Auth profile name", "default")
    .option("--env-file <file>", "Path to an env file with model keys and runtime secrets")
    .option("--claude-from <directory>", "Source Claude Code config directory")
    .option("--codex-from <directory>", "Source Codex config directory")
    .action(
      async (
        inputPath: string,
        options: {
          claudeFrom?: string;
          codexFrom?: string;
          envFile?: string;
          profile: string;
        }
      ) => {
        const profile = await handlers.syncProjectAuth(inputPath, {
          claudeCodeDirectory: options.claudeFrom,
          codexDirectory: options.codexFrom,
          envFilePath: options.envFile,
          profileName: options.profile
        });
        emitLines(streams, formatAuthProfileSummary(profile));
      }
    );

  authCommand
    .command("show")
    .description("Show the contents of a local auth profile")
    .option("-p, --profile <name>", "Auth profile name", "default")
    .action(async (options: { profile: string }) => {
      const profile = await handlers.requireAuthProfile(options.profile);
      emitLines(streams, formatAuthProfileSummary(profile));
    });

  authCommand
    .command("provision")
    .description("Provision a declarative batch of target credentials")
    .argument("<request-file>", "Secret-free credential provisioning request JSON")
    .option("--env-file <path>", "Create a 0600 environment file")
    .option("--world-bindings <path>", "Create a resolved world-bindings artifact")
    .option("--resolved-grants <path>", "Resolved world grants used to derive world bindings")
    .action((
      requestFile: string,
      options: {
        envFile?: string;
        resolvedGrants?: string;
        worldBindings?: string;
      }
    ) => targetSecretAction(async () => {
      let materials: ProvisionedCredentialMaterials | undefined;
      try {
        const request = await readCredentialProvisioningRequestFile(requestFile);
        if ((options.worldBindings === undefined) !== (options.resolvedGrants === undefined)) {
          throw new Error(TARGET_SECRET_SOURCE_ERROR);
        }
        const provisioned = await handlers.provisionCredentials(request);
        materials = provisioned.materials;
        let modelEngineAuth = false;
        if (request.model_engine_auth) {
          await handlers.importCodexAuth(
            request.model_engine_auth.profile,
            request.model_engine_auth.from
          );
          modelEngineAuth = true;
        }
        const envFile = options.envFile === undefined
          ? undefined
          : await writeProvisionedEnvFile({
              materials,
              path: options.envFile,
              receipt: provisioned.receipt
            });
        let worldBindingsDigest: string | undefined;
        if (options.worldBindings !== undefined && options.resolvedGrants !== undefined) {
          const resolved = await readResolvedGrantsFile(options.resolvedGrants);
          const artifact = buildProvisionedWorldBindings({
            receipt: provisioned.receipt,
            request,
            resolved
          });
          worldBindingsDigest = await writeWorldBindingsFile(options.worldBindings, artifact);
        }
        emitCredentialProvisioningReceipt(streams, finalizeCredentialProvisioningReceipt(
          provisioned.receipt,
          {
            ...(envFile === undefined ? {} : { env_file_digest: envFile.digest }),
            model_engine_auth: modelEngineAuth,
            ...(worldBindingsDigest === undefined ? {} : { world_bindings_digest: worldBindingsDigest })
          }
        ));
      } finally {
        if (materials) disposeProvisionedMaterials(materials);
      }
    }));

  const targetSecret = authCommand.command("target-secret").description("Manage opaque target secret sources");
  targetSecret.command("author").description("Author a secret read only from stdin").action(() => targetSecretAction(async () => {
    const secret = await readBoundedTargetSecretStdin(stdin, MAX_TARGET_SECRET_SOURCE_SECRET_BYTES);
    try {
      const lifecycle = await handlers.initializeTargetSecretSourceLifecycle();
      const result = await lifecycle.author(secret);
      emitTargetSecretReceipt(streams, "author", result.source_handle);
    } finally { secret.fill(0); }
  }));
  targetSecret.command("grant").description("Grant one exact public source capability")
    .argument("<request-file>", "Canonical secret-free grant request JSON")
    .action((filePath: string) => targetSecretAction(async () => {
      const request = await readTargetSecretSourceGrantRequestFile(filePath);
      const lifecycle = await handlers.initializeTargetSecretSourceLifecycle();
      const result = await lifecycle.grant(request);
      emitTargetSecretReceipt(streams, "grant", result.source_handle);
    }));
  targetSecret.command("rotate").description("Author a replacement from stdin without revoking the old source")
    .argument("<request-file>", "Canonical old-source request JSON")
    .action((filePath: string) => targetSecretAction(async () => {
      const request = await readTargetSecretSourceRequestFile(filePath);
      const secret = await readBoundedTargetSecretStdin(stdin, MAX_TARGET_SECRET_SOURCE_SECRET_BYTES);
      try {
        const lifecycle = await handlers.initializeTargetSecretSourceLifecycle();
        const result = await lifecycle.rotate(request.source_handle, secret);
        emitTargetSecretReceipt(streams, "rotate", result.source_handle);
      } finally { secret.fill(0); }
    }));
  for (const [command, kind] of [["revoke-grant", "grant"], ["revoke-version", "version"]] as const) {
    targetSecret.command(command).description(`Revoke one ${kind} capability`)
      .argument("<request-file>", "Canonical source request JSON")
      .action((filePath: string) => targetSecretAction(async () => {
        const request = await readTargetSecretSourceRequestFile(filePath);
        const lifecycle = await handlers.initializeTargetSecretSourceLifecycle();
        const result = kind === "grant"
          ? await lifecycle.revokeGrant(request.source_handle)
          : await lifecycle.revokeVersion(request.source_handle);
        emitTargetSecretReceipt(streams, command, result.source_handle);
      }));
  }
};
