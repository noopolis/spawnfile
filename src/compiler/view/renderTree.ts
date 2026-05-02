import type {
  OrganizationTreeNetworkSummary,
  OrganizationView,
  OrganizationViewTreeEdge,
  OrganizationViewTreeNode,
  RenderOrganizationViewOptions
} from "./types.js";
import { formatSourceMeta } from "./sourcePaths.js";

const color = (
  value: string,
  code: string,
  options: RenderOrganizationViewOptions
): string => options.color ? `\u001b[${code}m${value}\u001b[0m` : value;

const formatNode = (
  node: OrganizationViewTreeNode,
  options: RenderOrganizationViewOptions,
  projectRoot: string | undefined
): string => {
  const kind = color(node.kind, node.kind === "team" ? "36" : "32", options);
  const metadata = node.kind === "team"
    ? [
        node.mode ? `mode=${node.mode}` : undefined,
        node.lead ? `lead=${node.lead}` : undefined,
        node.external && node.external.length > 0
          ? `external=${node.external.join(",")}`
          : undefined
      ]
    : [
        node.runtimeName ? `[${node.runtimeName}]` : undefined,
        node.runtimeName ? `runtime=${node.runtimeName}` : undefined
      ];
  const details = metadata.filter((entry): entry is string => entry !== undefined);
  const source = options.paths ? formatSourceMeta("source", node.source, projectRoot) : "";
  const separator = details[0]?.startsWith("[") ? " " : "  ";

  return `${kind} ${node.displayName}${details.length > 0 ? `${separator}${details.join(" ")}` : ""}${source}`;
};

const formatEdgeLabel = (edge: OrganizationViewTreeEdge): string =>
  edge.relation === "subagent"
    ? `subagent ${edge.label}`
    : edge.label;

const formatNetworkSummary = (
  network: OrganizationTreeNetworkSummary,
  options: RenderOrganizationViewOptions
): string => {
  const id = color(network.id, "36", options);
  const exposed = network.expose ? " exposed" : "";
  const rooms = network.rooms
    .map((room) => `${room.id} [${room.declaredMembers.join(", ")}]`)
    .join("; ");

  return `network ${id} "${network.name}"${exposed}: ${rooms}`;
};

const renderChildren = (
  node: OrganizationViewTreeNode,
  options: RenderOrganizationViewOptions,
  projectRoot: string | undefined,
  prefix = ""
): string[] => {
  const glyphs = options.ascii
    ? { branch: "|-- ", last: "`-- ", pipe: "|   ", space: "    " }
    : { branch: "├── ", last: "└── ", pipe: "│   ", space: "    " };
  const items: Array<
    | { kind: "edge"; edge: OrganizationViewTreeEdge }
    | { kind: "network"; network: OrganizationTreeNetworkSummary }
  > = [
    ...(node.networks ?? []).map((network) => ({ kind: "network" as const, network })),
    ...node.children.map((edge) => ({ kind: "edge" as const, edge }))
  ];

  return items.flatMap((item, index) => {
    const isLast = index === items.length - 1;
    const connector = isLast ? glyphs.last : glyphs.branch;
    const nextPrefix = `${prefix}${isLast ? glyphs.space : glyphs.pipe}`;
    if (item.kind === "network") {
      return [`${prefix}${connector}${formatNetworkSummary(item.network, options)}`];
    }

    const edge = item.edge;
    const line = `${prefix}${connector}${formatEdgeLabel(edge)}: ${formatNode(edge.node, options, projectRoot)}`;

    return [
      line,
      ...renderChildren(edge.node, options, projectRoot, nextPrefix)
    ];
  });
};

export const renderOrganizationTree = (
  view: OrganizationView,
  options: RenderOrganizationViewOptions = {}
): string =>
  [
    formatNode(view.root, options, view.projectRoot),
    ...renderChildren(view.root, options, view.projectRoot)
  ].join("\n");
