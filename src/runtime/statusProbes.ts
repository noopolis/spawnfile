import type { ContainerRuntimeInstanceReport } from "../report/index.js";
import type {
  RuntimeProbeObservation,
  RuntimeStatusProbe,
  RuntimeStatusProbeContext
} from "./types.js";

const observation = (
  key: string,
  severity: RuntimeProbeObservation["severity"],
  message: string
): RuntimeProbeObservation => ({ key, message, severity });

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const createRuntimePathProbe = (input: {
  id: string;
  key: string;
  label: string;
  pathFor(instance: ContainerRuntimeInstanceReport): string | null | undefined;
  testFlag: "-d" | "-e" | "-f";
}): RuntimeStatusProbe => ({
  id: input.id,
  label: input.label,
  async run(context: RuntimeStatusProbeContext): Promise<RuntimeProbeObservation[]> {
    const targetPath = input.pathFor(context.instance);
    if (!targetPath) {
      return [
        observation(input.key, "unknown", `${input.label} path is not present in the compile report`)
      ];
    }

    try {
      await context.manager.exec(["test", input.testFlag, targetPath]);
      return [observation(input.key, "ok", `${input.label} exists at ${targetPath}`)];
    } catch (error) {
      return [
        observation(input.key, "error", `${input.label} missing at ${targetPath}: ${errorMessage(error)}`)
      ];
    }
  }
});

export const createRuntimeHttpProbe = (input: {
  id: string;
  key: string;
  label: string;
  path: string;
  portFor(instance: ContainerRuntimeInstanceReport): number | null | undefined;
}): RuntimeStatusProbe => ({
  id: input.id,
  label: input.label,
  async run(context: RuntimeStatusProbeContext): Promise<RuntimeProbeObservation[]> {
    const port = input.portFor(context.instance);
    if (!port) {
      return [
        observation(input.key, "unknown", `${input.label} port is not present in the compile report`)
      ];
    }

    const response = await context.manager.httpGet(port, input.path);
    return [
      response.ok
        ? observation(input.key, "ok", `${input.label} responded on ${input.path}`)
        : observation(
            input.key,
            "error",
            `${input.label} failed on ${input.path}: ${response.error ?? "request failed"}`
          )
    ];
  }
});
