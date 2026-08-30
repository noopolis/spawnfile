import { migrateWorkspaceResource, type WorkspaceResourceMigrationReceipt } from "../deployment/workspaceResourceMigration.js";

export const isWorkspaceResourceMigrationInvocation = (argv: readonly string[]): boolean =>
  argv[0] === "workspace-resource" && argv[1] === "migrate";

export interface WorkspaceResourceMigrationCommandDependencies {
  migrate?: typeof migrateWorkspaceResource;
  stderr?: (message: string) => void;
  stdout?: (message: string) => void;
}

const usage = "usage: spawnfile workspace-resource migrate <source> <destination> --manifest <path> --resolved-identity <sha256> --source-quiesced [--json]";

export const runWorkspaceResourceMigrationCommand = async (
  argv: readonly string[],
  dependencies: WorkspaceResourceMigrationCommandDependencies = {}
): Promise<number> => {
  const stdout = dependencies.stdout ?? ((message) => process.stdout.write(`${message}\n`));
  const stderr = dependencies.stderr ?? ((message) => process.stderr.write(`${message}\n`));
  if (!isWorkspaceResourceMigrationInvocation(argv)) return 2;
  const sourcePath = argv[2]; const destinationPath = argv[3];
  const manifestIndex = argv.indexOf("--manifest"); const manifestPath = manifestIndex < 0 ? undefined : argv[manifestIndex + 1];
  const identityIndex = argv.indexOf("--resolved-identity"); const resolvedIdentity = identityIndex < 0 ? undefined : argv[identityIndex + 1];
  const quiescedIndex = argv.indexOf("--source-quiesced");
  const allowed = new Set([0, 1, 2, 3, manifestIndex, manifestIndex + 1, identityIndex, identityIndex + 1, quiescedIndex, argv.indexOf("--json")].filter((index) => index >= 0));
  if (!sourcePath || !destinationPath || !manifestPath || !resolvedIdentity || quiescedIndex < 0 || argv.some((_value, index) => !allowed.has(index))) { stderr(usage); return 2; }
  try {
    const receipt = await (dependencies.migrate ?? migrateWorkspaceResource)({ destinationPath, manifestPath, resolvedIdentity, sourcePath, sourceQuiesced: true });
    stdout(argv.includes("--json") ? JSON.stringify(receipt) : render(receipt));
    return receipt.status === "activated" ? 0 : 1;
  } catch (error) {
    stderr(error instanceof Error ? error.message : String(error));
    return 1;
  }
};

const render = (receipt: WorkspaceResourceMigrationReceipt): string => [
  `workspace resource migration: ${receipt.status}`,
  `active: ${receipt.active_path}`,
  `source retained: ${receipt.source_retained ? "yes" : "no"}`,
  `rollback: ${receipt.rollback ? "yes" : "no"}`
].join("\n");
