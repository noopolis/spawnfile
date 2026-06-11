import {
  createRuntimeHttpProbe,
  createRuntimePathProbe
} from "../statusProbes.js";
import type { RuntimeStatusProbe } from "../types.js";

export const openClawStatusProbes: RuntimeStatusProbe[] = [
  createRuntimePathProbe({
    id: "home",
    key: "runtime.home",
    label: "OpenClaw home",
    pathFor: (instance) => instance.home_path,
    testFlag: "-d"
  }),
  createRuntimePathProbe({
    id: "workspace",
    key: "runtime.workspace",
    label: "OpenClaw workspace",
    pathFor: (instance) => instance.workspace_path,
    testFlag: "-d"
  }),
  createRuntimePathProbe({
    id: "config",
    key: "runtime.config",
    label: "OpenClaw config",
    pathFor: (instance) => instance.config_path,
    testFlag: "-f"
  }),
  createRuntimeHttpProbe({
    id: "healthz",
    key: "runtime.health",
    label: "OpenClaw gateway",
    path: "/healthz",
    portFor: (instance) => instance.internal_port
  })
];
