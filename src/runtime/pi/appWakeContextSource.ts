export const renderPiWakeContextSource = (): string => String.raw`const TEAM_CONTEXTS_FILE = ".spawnfile/team-contexts.yaml";
const TEAM_CONTEXT_INDEX_CACHE = new Map();
const TEAM_CONTEXT_INDEX_PROMISES = new Map();

const asString = (value) => (typeof value === "string" ? value.trim() : "");
const asStringOrUndefined = (value) => {
  const text = asString(value);
  return text.length > 0 ? text : undefined;
};

const asStringList = (value) => {
  if (!Array.isArray(value)) {
    return [];
  }
  return [...new Set(value.map(asString).filter((entry) => entry.length > 0))];
};

const asObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;

const asMemoryScopeText = (value) => {
  const scope = asStringOrUndefined(value?.scope);
  const qualifier = asStringOrUndefined(value?.qualifier);
  if (!scope || !qualifier) {
    return undefined;
  }
  return scope + ":" + qualifier;
};

const parseLegacyMoltnetContextId = (contextId) => {
  const value = asString(contextId);
  const match = /^moltnet:([^:]+):room:([^:]+)(?::thread:([^:]+))?$/u.exec(value);
  if (!match) {
    return undefined;
  }

  return {
    networkId: asString(match[1]),
    roomId: asString(match[2]),
    threadId: asString(match[3] ?? "")
  };
};

const parseWakeContext = (payload) => {
  const context = asObject(payload.context) ? payload.context : {};
  const legacy = parseLegacyMoltnetContextId(payload.context_id);
  const senderId = asStringOrUndefined(context.sender_id ?? context.senderId ?? context.from ?? payload.from);

  const networkId = asStringOrUndefined(context.networkId ?? context.network ?? legacy?.networkId);
  const roomId = asStringOrUndefined(context.roomId ?? context.room ?? context.channel ?? legacy?.roomId);
  const threadId = asStringOrUndefined(context.threadId ?? context.thread ?? legacy?.threadId);

  const resolved = {
    artifactPaths: asStringList(context.artifactPaths ?? context.artifacts),
    from: asStringOrUndefined(context.from),
    networkId,
    roomId,
    surface: asStringOrUndefined(context.surface) || (networkId ? "moltnet" : undefined),
    taskId: asStringOrUndefined(context.taskId ?? context.task),
    teamId: asStringOrUndefined(context.teamId ?? context.team),
    threadId,
    roleId: asStringOrUndefined(context.roleId ?? context.role),
    pairPeers: asStringList(context.pairPeers ?? context.participants),
    participants: asStringList(context.participants ?? context.pairPeers)
  };

  if (senderId) {
    if (resolved.pairPeers.length === 0) {
      resolved.pairPeers = [senderId];
      resolved.participants = [senderId];
    }
    if (resolved.from === undefined) {
      resolved.from = senderId;
    }
  }

  return {
    senderId,
    context: resolved
  };
};

const readTeamContextIndex = async (workspacePath) => {
  if (TEAM_CONTEXT_INDEX_CACHE.has(workspacePath)) {
    return TEAM_CONTEXT_INDEX_CACHE.get(workspacePath);
  }

  if (TEAM_CONTEXT_INDEX_PROMISES.has(workspacePath)) {
    return TEAM_CONTEXT_INDEX_PROMISES.get(workspacePath);
  }

  const load = (async () => {
    try {
      const indexPath = path.join(workspacePath, TEAM_CONTEXTS_FILE);
      const text = await readFile(indexPath, "utf8");
      const { parse: parseYaml } = await import("yaml");
      const parsed = parseYaml(text);
      const index = asObject(parsed) ? parsed : {};
      TEAM_CONTEXT_INDEX_CACHE.set(workspacePath, index);
      return index;
    } catch {
      TEAM_CONTEXT_INDEX_CACHE.set(workspacePath, undefined);
      return undefined;
    } finally {
      TEAM_CONTEXT_INDEX_PROMISES.delete(workspacePath);
    }
  })();

  TEAM_CONTEXT_INDEX_PROMISES.set(workspacePath, load);
  return load;
};

const resolveRoomEnvironmentFromIndex = (index, networkId, roomId, threadId) => {
  const activeRooms = asObject(asObject(index)?.active_environments)?.moltnet;
  const activeEntry = asObject(activeRooms?.[networkId]?.rooms?.[roomId]);
  if (activeEntry) {
    return {
      teamId: asStringOrUndefined(activeEntry.team_id),
      team_doc: asStringOrUndefined(activeEntry.team_doc),
      roster: asStringOrUndefined(activeEntry.roster),
      session_key: asStringOrUndefined(activeEntry.session_key),
      context_key: asStringOrUndefined(activeEntry.context_key),
      member_slot: asStringOrUndefined(activeEntry.member_slot),
      team_scope: asMemoryScopeText(activeEntry.memory?.durable_scope),
      room_scope: asMemoryScopeText(activeEntry.memory?.ephemeral_scope),
      thread_scope: threadId ? "thread:" + networkId + ":" + roomId + ":" + threadId : undefined
    };
  }

  const membershipEntries = [
    ...(Array.isArray(index?.direct_memberships) ? index.direct_memberships : []),
    ...(Array.isArray(index?.representations) ? index.representations : [])
  ];

  for (const entry of membershipEntries) {
    const resolvedEntry = asObject(entry);
    if (!resolvedEntry) {
      continue;
    }

    const bindings = Array.isArray(resolvedEntry.surfaces?.moltnet)
      ? resolvedEntry.surfaces.moltnet
      : [];

    for (const binding of bindings) {
      const resolvedBinding = asObject(binding);
      if (!resolvedBinding) {
        continue;
      }
      const bindingNetwork = asStringOrUndefined(resolvedBinding.network);
      const rooms = asStringList(resolvedBinding.rooms);
      if (bindingNetwork !== networkId || !rooms.includes(roomId)) {
        continue;
      }

      return {
        teamId: asStringOrUndefined(resolvedEntry.team),
        team_doc: asStringOrUndefined(resolvedEntry.team_doc),
        roster: asStringOrUndefined(resolvedEntry.roster),
        team_scope: asStringOrUndefined(resolvedEntry.team)
          ? "team:" + asStringOrUndefined(resolvedEntry.team)
          : undefined,
        room_scope: networkId && roomId ? "room:" + networkId + ":" + roomId : undefined,
        thread_scope: threadId ? "thread:" + networkId + ":" + roomId + ":" + threadId : undefined,
        context_key: asStringOrUndefined(resolvedEntry.context_key),
        member_slot: asStringOrUndefined(resolvedEntry.member ?? resolvedEntry.representative)
      };
    }
  }

  return undefined;
};

const resolveScheduleContextFromIndex = (index) => {
  const activeSchedules = asObject(asObject(asObject(index)?.active_environments)?.schedules);
  const defaultSchedule = asObject(activeSchedules?.default);

  if (defaultSchedule) {
    const contextKey = asStringOrUndefined(defaultSchedule.context_key);
    const membershipEntries = [
      ...(Array.isArray(index?.direct_memberships) ? index.direct_memberships : []),
      ...(Array.isArray(index?.representations) ? index.representations : [])
    ];
    const matched = contextKey
      ? membershipEntries.find((entry) => asStringOrUndefined(entry?.context_key) === contextKey)
      : undefined;

    const resolvedMatch = asObject(matched);

    if (contextKey === "self") {
      return {
        context_key: "self",
        team_scope: asMemoryScopeText(defaultSchedule.memory?.durable_scope)
      };
    }

    return {
      teamId: asStringOrUndefined(resolvedMatch?.team) ?? contextKey,
      team_doc: asStringOrUndefined(resolvedMatch?.team_doc),
      roster: asStringOrUndefined(resolvedMatch?.roster),
      context_key: contextKey,
      member_slot: asStringOrUndefined(resolvedMatch?.member ?? resolvedMatch?.representative),
      team_scope: asMemoryScopeText(defaultSchedule.memory?.durable_scope),
      session_key: asStringOrUndefined(defaultSchedule.session_key)
    };
  }

  if (!Array.isArray(index?.direct_memberships) || index.direct_memberships.length !== 1) {
    return undefined;
  }

  const entry = asObject(index.direct_memberships[0]);
  if (!entry) {
    return undefined;
  }

  return {
    teamId: asStringOrUndefined(entry.team),
    team_doc: asStringOrUndefined(entry.team_doc),
    roster: asStringOrUndefined(entry.roster),
    context_key: asStringOrUndefined(entry.context_key),
    member_slot: asStringOrUndefined(entry.member),
    team_scope: asStringOrUndefined(entry.team)
      ? "team:" + asStringOrUndefined(entry.team)
      : undefined
  };
};

const resolveDreamContextFromIndex = (index, environmentKey) => {
  const activeDreams = asObject(asObject(asObject(index)?.active_environments)?.dreams);
  if (!activeDreams) {
    return undefined;
  }

  const membershipEntries = [
    ...(Array.isArray(index?.direct_memberships) ? index.direct_memberships : []),
    ...(Array.isArray(index?.representations) ? index.representations : [])
  ];

  const explicit = environmentKey ? asObject(activeDreams[environmentKey]) : undefined;
  const selectedKey = explicit
    ? environmentKey
    : Object.keys(activeDreams).length === 1
      ? Object.keys(activeDreams)[0]
      : "self";
  const selected = asObject(activeDreams[selectedKey]);
  if (!selected) {
    return undefined;
  }

  const contextKey = asStringOrUndefined(selected.context_key);
  const matched = contextKey
    ? membershipEntries.find((member) => asStringOrUndefined(member?.context_key) === contextKey)
    : undefined;

  const resolvedMatch = asObject(matched);
  const teamScopeText = asMemoryScopeText(selected.memory?.durable_scope);

  return {
    context_key: contextKey,
    environment_key: asStringOrUndefined(selected.environment_key),
    session_key_template: asStringOrUndefined(selected.session_key_template),
    team_scope: teamScopeText,
    teamId: teamScopeText?.startsWith("team:") ? teamScopeText.slice(5) : asStringOrUndefined(resolvedMatch?.team) ?? (contextKey === "self" ? undefined : contextKey),
    team_doc: asStringOrUndefined(resolvedMatch?.team_doc),
    roster: asStringOrUndefined(resolvedMatch?.roster),
    member_slot: asStringOrUndefined(resolvedMatch?.member ?? resolvedMatch?.representative)
  };
};

const listDreamEnvironmentKeys = async (workspacePath) => {
  const index = await readTeamContextIndex(workspacePath);
  const activeDreams = asObject(asObject(asObject(index)?.active_environments)?.dreams);
  return activeDreams ? Object.keys(activeDreams).sort() : ["self"];
};

const buildRuntimeContextForWake = (payload) => {
  const parsed = parseWakeContext(payload);
  const messageFrom = asStringOrUndefined(payload.from);
  const kind = normalizeWakeKind(typeof payload.wake_kind === "string" ? payload.wake_kind : payload.kind);
  const isMessageWake = kind === "message" || kind === "manual";
  const surface = parsed.context.surface;
  const isMoltnetRoomWake = isMessageWake && surface === "moltnet" && parsed.context.networkId && parsed.context.roomId;

  return {
    context: parsed.context,
    activeEnvironment: {
      ...parsed.context,
      surface,
      senderId: parsed.senderId
    },
    eventFrom: messageFrom ?? "moltnet",
    messageFrom: messageFrom ?? parsed.senderId ?? "moltnet",
    isRoomWake: isMoltnetRoomWake
  };
};

const renderDreamSessionKey = (template, runId) => {
  if (!template) {
    return undefined;
  }
  return template.replace("{run_id}", runId);
};

const enrichWakeContext = async (workspacePath, payload) => {
  const base = buildRuntimeContextForWake(payload);
  const index = await readTeamContextIndex(workspacePath);
  if (!index) {
    return base;
  }

  const kind = normalizeWakeKind(typeof payload.wake_kind === "string" ? payload.wake_kind : payload.kind);
  if (kind === "schedule") {
    const scheduleContext = resolveScheduleContextFromIndex(index);
    if (!scheduleContext) {
      return base;
    }

    return {
      ...base,
      context: {
        ...base.context,
        surface: "schedule",
        teamId: scheduleContext.teamId || base.context.teamId,
        team_doc: scheduleContext.team_doc || base.context.team_doc,
        roster: scheduleContext.roster || base.context.roster
      },
      activeEnvironment: {
        ...base.activeEnvironment,
        surface: "schedule",
        ...scheduleContext
      }
    };
  }

  if (base.isRoomWake) {
    const roomContext = resolveRoomEnvironmentFromIndex(
      index,
      base.context.networkId,
      base.context.roomId,
      base.context.threadId
    );

    if (roomContext) {
      return {
        ...base,
        eventFrom: undefined,
        context: {
          ...base.context,
          from: undefined,
          networkId: base.context.networkId,
          roomId: base.context.roomId,
          threadId: base.context.threadId,
          teamId: roomContext.teamId || base.context.teamId,
          team_doc: roomContext.team_doc || base.context.team_doc,
          roster: roomContext.roster || base.context.roster,
          pairPeers: base.context.pairPeers,
          participants: base.context.participants
        },
        activeEnvironment: {
          ...base.activeEnvironment,
          ...roomContext,
          networkId: base.context.networkId,
          roomId: base.context.roomId,
          threadId: base.context.threadId,
          surface: "moltnet"
        },
        isRoomWake: false
      };
    }
  }

  if (kind === "dream") {
    const dreamContext = resolveDreamContextFromIndex(index, payload.dream_environment ?? payload.environment_key);
    if (dreamContext) {
      const runId = asStringOrUndefined(payload.run_id) ?? String(Date.now());
      return {
        ...base,
        eventFrom: renderDreamSessionKey(dreamContext.session_key_template, runId) ?? base.eventFrom,
        context: {
          ...base.context,
          surface: "dream",
          teamId: dreamContext.teamId || base.context.teamId,
          team_doc: dreamContext.team_doc || base.context.team_doc,
          roster: dreamContext.roster || base.context.roster
        },
        activeEnvironment: {
          ...base.activeEnvironment,
          ...dreamContext,
          run_id: runId,
          surface: "dream"
        }
      };
    }
  }

  return base;
};
`;
