import { describe, expect, it } from "vitest";

import {
  TARGET_OPERATION_DISPATCH,
  targetOperationDispatch
} from "./targetOperationDispatch.js";

describe("target operation dispatch metadata", () => {
  it("exhaustively names the fourteen reviewed operations", () => {
    expect(Object.keys(TARGET_OPERATION_DISPATCH).sort()).toEqual([
      "attach_organization", "cleanup_run", "create_data_network", "create_evidence_volume",
      "create_world_service", "detach_organization", "export_evidence_volume",
      "prepare_secret_bindings", "recover_operation", "resolve_world_artifact",
      "revoke_secret_bindings", "select_target", "start_world_service", "stop_world_service"
    ]);
  });

  it("keeps selection distinct and classifies the other thirteen as mutation seams", () => {
    expect(TARGET_OPERATION_DISPATCH.select_target).toEqual({
      kind: "selection",
      operation: "select_target"
    });
    expect(Object.values(TARGET_OPERATION_DISPATCH).filter(({ kind }) => kind === "mutation"))
      .toHaveLength(13);
    expect(targetOperationDispatch({
      idempotency_key: "idem_aaaaaaaaaaaaaaaa",
      operation: "select_target",
      target_reference: "gpu-4090",
      version: "spawnfile.target-resource.request.v1"
    })).toBe(TARGET_OPERATION_DISPATCH.select_target);
  });
});
