import type { GraderProviderRegistry, InferenceProviderRegistry } from "../training/contracts/index.js";

export interface RuntimeTrainingInferenceContribution extends Pick<InferenceProviderRegistry, "providers" | "brokerAdmissionLabel"> {
  /** Presentation order for existing authored-provider diagnostics. */
  providerOrder?: readonly string[];
}

export interface RuntimeTrainingGraderContribution {
  providers: GraderProviderRegistry["providers"];
  council?: GraderProviderRegistry["council"];
}
