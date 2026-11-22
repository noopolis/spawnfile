const workerDetailsKey = Symbol("Daimon worker configuration");

interface DaimonWorkerDetails {
  modelByNodeId: Record<string, { model: string; reasoningEffort: string }>;
  turnLimitsByNodeId?: Record<string, { maxRequests?: number; maxTokens?: number; timeoutMs?: number }>;
  skillsByNodeId?: Record<string, { name: string; files: { path: string; content: string }[] }[]>;
}

export const createDaimonWorkerDetails = (details: DaimonWorkerDetails) => ({
  [workerDetailsKey]: details
});

export const daimonWorkerDetails = (
  plan: { hostDetails?: object }
): DaimonWorkerDetails | undefined =>
  (plan.hostDetails as Partial<ReturnType<typeof createDaimonWorkerDetails>> | undefined)?.[workerDetailsKey];
