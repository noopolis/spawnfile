import { describe, expect, it, vi } from "vitest";

const upProject = vi.fn(
  async (_inputPath: string, _options: Record<string, unknown> = {}) => ({ imageTag: "test" })
);

vi.mock("../compiler/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../compiler/index.js")>();
  return { ...actual, upProject };
});

const { devUpProject } = await import("./project.js");
const { DEV_DEPLOYMENT_LINEAGE_NAMESPACE } = await import("../compiler/deploymentLineage.js");

describe("devUpProject lineage wiring", () => {
  // The separation is only real if `devUpProject` actually hands the namespace
  // to `upProject`; without this the helper could be correct and unused, which
  // is exactly how the shared-lineage bug survived.
  it("hands upProject the dev lineage namespace", async () => {
    upProject.mockClear();
    await devUpProject("/tmp/does-not-matter", { outputDirectory: "/tmp/out" });

    expect(upProject).toHaveBeenCalledTimes(1);
    const options = upProject.mock.calls[0]![1] as Record<string, unknown>;
    expect(options.deploymentLineageNamespace).toBe(DEV_DEPLOYMENT_LINEAGE_NAMESPACE);
  });

  it("forwards the operator's declared-volume override untouched", async () => {
    upProject.mockClear();
    await devUpProject("/tmp/does-not-matter", {
      allowDeclaredVolumeNames: true,
      outputDirectory: "/tmp/out"
    });

    const options = upProject.mock.calls[0]![1] as Record<string, unknown>;
    expect(options.allowDeclaredVolumeNames).toBe(true);
  });
});
