import { afterEach, describe, expect, it, vi } from "vitest";

import type { RuntimeTargetPlan } from "./containerArtifactsTypes.js";
import { renderDockerfile } from "./containerArtifactsRender.js";
import {
  DOCKER_BUILD_CONTEXT_IGNORE_PATTERNS,
  extractDockerBuildContextSources,
  findIgnoredDockerBuildSources
} from "./dockerBuildContext.js";

const createRuntimePlan = (): RuntimeTargetPlan => ({
  envFiles: [],
  id: "pi-target",
  instancePaths: {
    configPath: "/var/lib/spawnfile/pi/config.json",
    homePath: "/var/lib/spawnfile/pi/home",
    workspacePath: "/var/lib/spawnfile/pi/workspace"
  },
  meta: {
    configFileName: "pi-app.json",
    instancePaths: {
      configPathTemplate: "<instance-root>/pi-app.json",
      homePathTemplate: "<instance-root>/home",
      workspacePathTemplate: "<instance-root>/workspace"
    },
    standaloneBaseImage: "node:22-bookworm-slim",
    startCommand: ["node", "<runtime-root>/app.mjs"],
    systemDeps: []
  },
  modelAuthMethods: {},
  modelSecretsRequired: [],
  runtimeName: "pi",
  runtimeRoot: "/opt/spawnfile/runtime-installs/pi",
  targetFiles: []
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Docker build context ignore safety", () => {
  it("keeps every rendered context source visible across supported configurations", async () => {
    vi.stubEnv("SPAWNFILE_PI_RUNTIME_BASE_IMAGE", "");
    const plan = createRuntimePlan();
    const configurations = [
      {
        dockerfile: await renderDockerfile([plan]),
        name: "plain"
      },
      {
        dockerfile: await renderDockerfile([plan], {
          hasMoltnet: true,
          hasStagedMoltnetBinaries: true
        }),
        name: "moltnet with staged binaries"
      },
      {
        dockerfile: await renderDockerfile([plan], {
          runtimePackageOverrides: {
            "@noopolis/daimon": { filename: "noopolis-daimon-test.tgz" }
          }
        }),
        name: "runtime package override"
      },
      {
        dockerfile: await renderDockerfile([plan], {
          distribution: {
            labels: {
              "com.spawnfile.compile_fingerprint": "sf1:test",
              "com.spawnfile.project": "test"
            },
            reportOutputFile: "distribution-report.json",
            worldBindingsOutputFile: "world-bindings.json"
          }
        }),
        name: "world bindings"
      }
    ];

    for (const configuration of configurations) {
      const sources = extractDockerBuildContextSources(configuration.dockerfile);
      expect(sources, configuration.name).not.toEqual([]);
      expect(
        findIgnoredDockerBuildSources(
          configuration.dockerfile,
          DOCKER_BUILD_CONTEXT_IGNORE_PATTERNS
        ),
        configuration.name
      ).toEqual([]);
    }
    expect(configurations[1]!.dockerfile).toContain("COPY moltnet-bin/");
    expect(configurations[2]!.dockerfile).toContain("COPY container/vendor/");
    expect(configurations[3]!.dockerfile).toContain("COPY world-bindings.json");
  });

  it("reports an ignored COPY source and skips multi-stage or remote sources", () => {
    const dockerfile = [
      "COPY --from=builder /opt/runtime /opt/runtime",
      "ADD https://example.test/archive.tgz /tmp/archive.tgz",
      "COPY runtimes/ /x"
    ].join("\n");

    expect(extractDockerBuildContextSources(dockerfile)).toEqual(["runtimes/"]);
    expect(findIgnoredDockerBuildSources(dockerfile)).toEqual([
      { pattern: "runtimes/", source: "runtimes/" }
    ]);
  });

  it("reports every ignored path swallowed by COPY from the dot context root", () => {
    expect(findIgnoredDockerBuildSources("COPY . /x")).toEqual([
      { pattern: "runtimes/", source: "." },
      { pattern: "spawnfile-report.json", source: "." },
      { pattern: "deployments/", source: "." }
    ]);
  });

  it("reports every ignored path swallowed by COPY from the slash-suffixed context root", () => {
    expect(findIgnoredDockerBuildSources("COPY ./ /x")).toEqual([
      { pattern: "runtimes/", source: "" },
      { pattern: "spawnfile-report.json", source: "" },
      { pattern: "deployments/", source: "" }
    ]);
  });
});
