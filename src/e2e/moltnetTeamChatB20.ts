export interface MoltnetTeamChatB20BusyTurnBurst {
  runId: string;
  responseSentinel: string;
  step2Marker: string;
  step3Marker: string;
  texts: [string, string, string];
}

export interface MoltnetTeamChatB20BurstOptions {
  runId: string;
  responseAuthorId: string;
}

export const createMoltnetTeamChatB20BusyTurnBurst = (
  input: MoltnetTeamChatB20BurstOptions
): MoltnetTeamChatB20BusyTurnBurst => {
  const responseSentinel = `SF-MOLTNET-E2E-B20-ACK-${input.runId}`;
  const step2Marker = `SF-MOLTNET-E2E-B20-STEP2-${input.runId}`;
  const step3Marker = `SF-MOLTNET-E2E-B20-STEP3-${input.runId}`;
  return {
    runId: input.runId,
    responseSentinel,
    step2Marker,
    step3Marker,
    texts: [
      `SF-MOLTNET-E2E-B20 burst=${input.runId} step=1. Step 1 active turn for mission-control with context addressed to ${input.responseAuthorId}. Do not reply yet; no ack sentinel has been requested.`,
      `SF-MOLTNET-E2E-B20 burst=${input.runId} step=2 marker=${step2Marker}. Step 2 queued update while the turn stays active for ${input.responseAuthorId}.`,
      `SF-MOLTNET-E2E-B20 burst=${input.runId} step=3 ack=${responseSentinel} marker=${step3Marker}. Step 3 queued final update. Reply once with ${responseSentinel}, the exact step-2 marker you read earlier, and ${step3Marker} after accumulation.`
    ]
  };
};
