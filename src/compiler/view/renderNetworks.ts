import type {
  OrganizationNetworkDeclarationView,
  OrganizationNetworkMemberView,
  OrganizationNetworkView,
  OrganizationView,
  RenderOrganizationViewOptions
} from "./types.js";
import { formatSourceMeta } from "./sourcePaths.js";

const color = (
  value: string,
  code: string,
  options: RenderOrganizationViewOptions
): string => options.color ? `\u001b[${code}m${value}\u001b[0m` : value;

const glyphsFor = (options: RenderOrganizationViewOptions) =>
  options.ascii
    ? { branch: "|-- ", last: "`-- ", pipe: "|   ", space: "    " }
    : { branch: "├── ", last: "└── ", pipe: "│   ", space: "    " };

const formatPolicy = (member: OrganizationNetworkMemberView): string[] => {
  if (!member.policy) {
    return [];
  }

  return [
    member.policy.read ? `read=${member.policy.read}` : undefined,
    member.policy.reply ? `reply=${member.policy.reply}` : undefined
  ].filter((entry): entry is string => entry !== undefined);
};

const formatMember = (
  member: OrganizationNetworkMemberView,
  options: RenderOrganizationViewOptions,
  projectRoot: string | undefined
): string => {
  const metadata = member.representedSlot
    ? [
        `represents=${member.representedSlot}`,
        member.representedTeamName && member.representedTeamName !== member.representedSlot
          ? `team=${member.representedTeamName}`
          : undefined,
        `member=${member.concreteMemberId}`
      ]
    : [
        `team=${member.directTeamName}`,
        `member=${member.concreteMemberId}`
      ];
  const source = options.paths
    ? formatSourceMeta("source", member.agentSource, projectRoot)
    : "";
  const details = [
    ...metadata,
    ...formatPolicy(member)
  ].filter((entry): entry is string => entry !== undefined);

  return `${member.agentName}  ${details.join(" ")}${source}`;
};

const formatNetwork = (
  network: OrganizationNetworkView,
  options: RenderOrganizationViewOptions
): string => {
  const id = color(network.id, "36", options);

  return `${network.provider} ${id}`;
};

const getDeclarations = (
  network: OrganizationNetworkView
): OrganizationNetworkDeclarationView[] =>
  network.declarations ?? [
    {
      declaringTeamName: network.declaringTeamName,
      declaringTeamSource: network.declaringTeamSource,
      expose: network.expose,
      name: network.name,
      rooms: network.rooms
    }
  ];

const formatDeclaration = (
  network: OrganizationNetworkView,
  declaration: OrganizationNetworkDeclarationView,
  options: RenderOrganizationViewOptions,
  projectRoot: string | undefined
): string => {
  const exposed = declaration.expose ? " exposed" : "";
  const source = options.paths
    ? formatSourceMeta("declared_source", declaration.declaringTeamSource, projectRoot)
    : "";

  return `${network.id} "${declaration.name}" on ${declaration.declaringTeamName}${exposed}${source}`;
};

export const renderOrganizationNetworks = (
  view: OrganizationView,
  options: RenderOrganizationViewOptions = {}
): string => {
  if (view.networks.length === 0) {
    return "No Moltnet networks.";
  }

  const glyphs = glyphsFor(options);
  const lines = ["Moltnet networks"];

  view.networks.forEach((network, networkIndex) => {
    const networkLast = networkIndex === view.networks.length - 1;
    const networkPrefix = networkLast ? glyphs.space : glyphs.pipe;
    lines.push(
      `${networkLast ? glyphs.last : glyphs.branch}${formatNetwork(network, options)}`
    );

    const declarations = getDeclarations(network);
    declarations.forEach((declaration, declarationIndex) => {
      const declarationLast = declarationIndex === declarations.length - 1;
      const declarationPrefix = `${networkPrefix}${declarationLast ? glyphs.space : glyphs.pipe}`;
      lines.push(
        `${networkPrefix}${declarationLast ? glyphs.last : glyphs.branch}${formatDeclaration(network, declaration, options, view.projectRoot)}`
      );

      declaration.rooms.forEach((room, roomIndex) => {
        const roomLast = roomIndex === declaration.rooms.length - 1;
        const roomPrefix = `${declarationPrefix}${roomLast ? glyphs.space : glyphs.pipe}`;
        const legacyDeclared = options.declared && !view.projectRoot
          ? ` room ${room.id} declared [${room.declaredMembers.join(", ")}]`
          : "";
        lines.push(
          `${declarationPrefix}${roomLast ? glyphs.last : glyphs.branch}#${room.id}${legacyDeclared}`
        );

        if (options.declared) {
          const declaredMembers = room.declaredMembers.length > 0
            ? room.declaredMembers.join(", ")
            : "(none)";
          lines.push(`${roomPrefix}${glyphs.branch}declared members: ${declaredMembers}`);
        }

        room.members.forEach((member, memberIndex) => {
          const memberLast = memberIndex === room.members.length - 1;
          lines.push(
            `${roomPrefix}${memberLast ? glyphs.last : glyphs.branch}${formatMember(member, options, view.projectRoot)}`
          );
        });
      });
    });
  });

  return lines.join("\n");
};
