import type { TargetResourceRequest } from "../target/contracts.js";

export type TargetOperation = TargetResourceRequest["operation"];
export type TargetMutationOperation = Exclude<TargetOperation, "select_target">;

export interface TargetSelectionDispatch {
  readonly kind: "selection";
  readonly operation: "select_target";
}

export interface TargetMutationDispatch {
  readonly kind: "mutation";
  readonly operation: TargetMutationOperation;
}

export type TargetOperationDispatch = TargetSelectionDispatch | TargetMutationDispatch;

const mutation = <Operation extends TargetMutationOperation>(
  operation: Operation
): TargetMutationDispatch & { readonly operation: Operation } => ({
  kind: "mutation",
  operation
});

export const TARGET_OPERATION_DISPATCH = Object.freeze({
  attach_organization: mutation("attach_organization"),
  cleanup_run: mutation("cleanup_run"),
  create_data_network: mutation("create_data_network"),
  create_evidence_volume: mutation("create_evidence_volume"),
  create_world_service: mutation("create_world_service"),
  detach_organization: mutation("detach_organization"),
  export_evidence_volume: mutation("export_evidence_volume"),
  prepare_secret_bindings: mutation("prepare_secret_bindings"),
  recover_operation: mutation("recover_operation"),
  resolve_world_artifact: mutation("resolve_world_artifact"),
  revoke_secret_bindings: mutation("revoke_secret_bindings"),
  select_target: { kind: "selection", operation: "select_target" },
  start_world_service: mutation("start_world_service"),
  stop_world_service: mutation("stop_world_service")
} satisfies Record<TargetOperation, TargetOperationDispatch>);

export const targetOperationDispatch = (
  request: TargetResourceRequest
): TargetOperationDispatch => TARGET_OPERATION_DISPATCH[request.operation];
