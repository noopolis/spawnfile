export const MOLTNET_PI_ONLY_CAPABILITIES = ["pi-bridge"] as const;
export const MOLTNET_DUAL_BRIDGE_CAPABILITIES = ["daimon-bridge", "pi-bridge"] as const;
export const MOLTNET_ACP_BRIDGE_CAPABILITIES = ["acp-bridge", "daimon-bridge", "pi-bridge"] as const;

export type LocalMoltnetBridgeCapabilities =
  | typeof MOLTNET_DUAL_BRIDGE_CAPABILITIES
  | typeof MOLTNET_ACP_BRIDGE_CAPABILITIES;

export type MoltnetBridgeCapabilities = typeof MOLTNET_PI_ONLY_CAPABILITIES | LocalMoltnetBridgeCapabilities;

/** Accept only canonical capability tuples. Older release identities stay valid. */
export const parseMoltnetBridgeCapabilities = (value: unknown): MoltnetBridgeCapabilities | null => {
  if (!Array.isArray(value)) return null;
  return [MOLTNET_PI_ONLY_CAPABILITIES, MOLTNET_DUAL_BRIDGE_CAPABILITIES, MOLTNET_ACP_BRIDGE_CAPABILITIES]
    .find((tuple) => tuple.length === value.length && tuple.every((part, index) => part === value[index])) ?? null;
};

export const parseLocalMoltnetBridgeCapabilities = (value: unknown): LocalMoltnetBridgeCapabilities | null => {
  const capabilities = parseMoltnetBridgeCapabilities(value);
  return !capabilities || capabilities.length === 1 ? null : capabilities;
};
