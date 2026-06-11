import type { OrganizationView, OrganizationViewTreeNode } from "../compiler/index.js";
import type { StatusInputFailure, StatusSelection, StatusSelectorKind } from "./types.js";
import { flattenOrganizationNodes } from "./traversal.js";

export interface StatusSelectorInput {
  kind: StatusSelectorKind;
  value: string;
}

export type StatusSelectorResult =
  | { kind: "failure"; failure: StatusInputFailure }
  | { kind: "selected"; selection: StatusSelection };

const failure = (message: string): StatusSelectorResult => ({
  failure: { exitCode: 2, message },
  kind: "failure"
});

const validValuesMessage = (label: string, values: string[]): string =>
  values.length > 0 ? `${label}: ${values.join(", ")}` : `${label}: none`;

const selectNode = (
  nodes: OrganizationViewTreeNode[],
  kind: "agent" | "team",
  value: string
): StatusSelectorResult => {
  const candidates = nodes.filter((node) => node.kind === kind);
  const exactId = candidates.filter((node) => node.id === value);
  if (exactId.length === 1) {
    const [node] = exactId;
    return {
      kind: "selected",
      selection: { kind, label: node!.displayName, subjectKeys: [node!.id], value }
    };
  }

  const named = candidates.filter((node) => node.name === value || node.slug === value);
  if (named.length === 1) {
    const [node] = named;
    return {
      kind: "selected",
      selection: { kind, label: node!.displayName, subjectKeys: [node!.id], value }
    };
  }

  if (named.length > 1 || exactId.length > 1) {
    const matches = [...exactId, ...named].map((node) => node.id).sort();
    return failure(`Ambiguous ${kind} selector "${value}". Candidates: ${matches.join(", ")}`);
  }

  return failure(`Unknown ${kind} selector "${value}". ${validValuesMessage(
    `Valid ${kind} ids`,
    candidates.map((node) => node.id).sort()
  )}`);
};

const selectNetwork = (view: OrganizationView, value: string): StatusSelectorResult => {
  const exactId = view.networks.filter((network) => network.id === value);
  if (exactId.length === 1) {
    const [network] = exactId;
    return {
      kind: "selected",
      selection: {
        kind: "network",
        label: network!.name,
        subjectKeys: [`network:${network!.id}`],
        value
      }
    };
  }

  const named = view.networks.filter((network) => network.name === value);
  if (named.length === 1) {
    const [network] = named;
    return {
      kind: "selected",
      selection: {
        kind: "network",
        label: network!.name,
        subjectKeys: [`network:${network!.id}`],
        value
      }
    };
  }

  if (named.length > 1 || exactId.length > 1) {
    const matches = [...exactId, ...named].map((network) => network.id).sort();
    return failure(`Ambiguous network selector "${value}". Candidates: ${matches.join(", ")}`);
  }

  return failure(`Unknown network selector "${value}". ${validValuesMessage(
    "Valid network ids",
    view.networks.map((network) => network.id).sort()
  )}`);
};

const selectRuntime = (view: OrganizationView, value: string): StatusSelectorResult => {
  const runtime = view.runtimes.find((entry) => entry.name === value);
  if (!runtime) {
    return failure(`Unknown runtime selector "${value}". ${validValuesMessage(
      "Valid runtime names",
      view.runtimes.map((entry) => entry.name).sort()
    )}`);
  }

  return {
    kind: "selected",
    selection: {
      kind: "runtime",
      label: runtime.name,
      subjectKeys: [`runtime:${runtime.name}`, ...runtime.nodeIds],
      value
    }
  };
};

export const resolveStatusSelector = (
  view: OrganizationView,
  selector: StatusSelectorInput | null
): StatusSelectorResult | null => {
  if (!selector) {
    return null;
  }

  if (selector.kind === "network") {
    return selectNetwork(view, selector.value);
  }

  if (selector.kind === "runtime") {
    return selectRuntime(view, selector.value);
  }

  return selectNode(flattenOrganizationNodes(view), selector.kind, selector.value);
};
