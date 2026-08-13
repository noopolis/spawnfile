/** Generic Moltnet wire-protocol shapes shared by every E2E driver (team-chat, memetics, office-sim, and
 * whatever bespoke scenario comes next). Kept free of any scenario-specific fields; scenario types live next to
 * their scenario (e.g. moltnetTeamChatTypes.ts, moltnetMemeticsTypes.ts, officeSimTypes.ts). */
export interface MoltnetE2ELogger {
  info(message: string): void;
}
/** @deprecated Use MoltnetE2ELogger. Kept so existing imports of the old name keep compiling. */
export type MoltnetTeamChatLogger = MoltnetE2ELogger;

export interface MoltnetRoom {
  id: string;
  members?: string[];
}
export interface MoltnetAgentSummary {
  connected?: boolean;
  id: string;
  rooms?: string[];
}
export interface MoltnetMessage {
  from: {
    id: string;
    name?: string;
    type: string;
  };
  id: string;
  parts: Array<{ kind: string; text?: string }>;
}
export interface MoltnetApiClient {
  getRoom(baseUrl: string, roomId: string): Promise<MoltnetRoom>;
  health(baseUrl: string): Promise<boolean>;
  listAgents(baseUrl: string): Promise<MoltnetAgentSummary[]>;
  listRoomMessages(baseUrl: string, roomId: string, limit: number): Promise<MoltnetMessage[]>;
  sendRoomMessage(input: {
    baseUrl: string;
    from: { id: string; name?: string; type: string };
    mentions?: string[];
    roomId: string;
    text: string;
  }): Promise<void>;
}
/** @deprecated Use MoltnetApiClient. Kept so existing imports of the old name keep compiling. */
export type MoltnetTeamChatApiClient = MoltnetApiClient;
