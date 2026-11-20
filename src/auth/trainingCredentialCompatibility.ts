import { findTrainingCredentialOperations } from "../runtime/trainingSelection.js";

/** Public compatibility entry for the historical Codex account ingress. */
export const prepareTrainingCodexAuthority = async (source: string, dockerContext: string): Promise<string> => {
  const operations = await findTrainingCredentialOperations("codex");
  if (!operations?.prepareAuthority) throw new Error("No runtime provides Codex training credential authority");
  return operations.prepareAuthority(source, dockerContext);
};

/** Public compatibility entry for the historical Grok rotation journal. */
export const writeBackTrainingGrokCredential = async (profile: string, candidate: string, journalFile: string): Promise<boolean> => {
  const operations = await findTrainingCredentialOperations("grok");
  if (!operations?.writeBack) throw new Error("No runtime provides Grok training credential writeback");
  return operations.writeBack(profile, candidate, journalFile);
};
