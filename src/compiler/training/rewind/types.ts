import type { MemoryBank, TeamNetwork, TeamWorkspaceResource } from "../../../manifest/index.js";
import type { ResolvedMemoryBank } from "../../types.js";
import type { MomentRecord, MaterializedInput } from "./contract.js";
import type { History } from "./history.js";

export interface InputIdentity { section: "resources" | "memory" | "networks"; id: string; declaredBy: string }
interface InputBase extends InputIdentity { overridden: boolean; declarationBase: string }
export type RewindInput = InputBase & (
  | { section: "resources"; declaration: TeamWorkspaceResource }
  | { section: "memory"; declaration: MemoryBank | ResolvedMemoryBank }
  | { section: "networks"; declaration: TeamNetwork }
);
export interface InputContext {
  input: RewindInput;
  at: string;
  record: MomentRecord | null;
  history: History | undefined;
  destination: string;
}
export interface InputResult {
  fidelity: "exact" | "approximate" | "overridden";
  basis: string;
  source: MaterializedInput["source"];
  notes: string[];
  instant: string;
  build?: "deferred";
}
