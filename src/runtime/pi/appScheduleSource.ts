export const renderPiScheduleSource = (): string => String.raw`const parseEveryMs = (value) => {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/u.exec(value.trim());
  if (!match) {
    throw new Error("Invalid Pi every schedule: " + value);
  }
  const amount = Number(match[1]);
  const unit = match[2] ?? "ms";
  const multipliers = {
    d: 24 * 60 * 60 * 1000,
    h: 60 * 60 * 1000,
    m: 60 * 1000,
    ms: 1,
    s: 1000
  };
  return Math.max(1, Math.round(amount * multipliers[unit]));
};

const systemClock = Object.freeze({
  now: () => Date.now(),
  setInterval: (callback, delay) => setInterval(callback, delay),
  setTimeout: (callback, delay) => setTimeout(callback, delay)
});

const scheduleWake = async (agent, timers, runOnce, intervalMs, createEvent, label, clock) => {
  if (runOnce) {
    await agent.wake(createEvent());
    return;
  }

  const timer = clock.setInterval(() => {
    void agent.wake(createEvent()).catch((error) => {
      console.error("[pi:" + agent.config.id + "] " + label + " wake error: " + (error instanceof Error ? error.message : String(error)));
    });
  }, intervalMs);
  timers.push(timer);

  clock.setTimeout(() => {
    void agent.wake(createEvent()).catch((error) => {
      console.error("[pi:" + agent.config.id + "] initial " + label + " wake error: " + (error instanceof Error ? error.message : String(error)));
    });
  }, 100);
};

export const installAgentSchedules = async (agents, timers, runOnce, clock = systemClock) => {
  let scheduledCount = 0;
  for (const agent of agents) {
    if (agent.config.schedule?.kind === "every" && agent.config.schedule.every) {
      const intervalMs = parseEveryMs(agent.config.schedule.every);
      // Wake ids become mneme's wake_event_id, which must match the causal-id
      // namespace /^(simfile|moltnet|mneme|daimon):.+$/. These wakes are
      // delivered by the daimon runtime harness (as moltnet wakes carry a
      // moltnet: id), so they carry the daimon: authority prefix.
      const createEvent = () => ({
        id: "daimon:schedule-" + agent.config.id + "-" + clock.now(),
        kind: "schedule",
        from: "scheduler",
        text: agent.config.schedule.prompt ?? "Run the scheduled Spawnfile task."
      });
      scheduledCount += 1;
      await scheduleWake(agent, timers, runOnce, intervalMs, createEvent, "scheduled", clock);
    }

    const consolidation = agent.config.memory?.consolidation;
    if (consolidation?.kind === "every" && consolidation.every) {
      const intervalMs = parseEveryMs(consolidation.every);
      const bankId = agent.config.memory?.bank_id ?? "memory";
      const dreamEnvironments = await agent.listDreamEnvironmentKeys();
      for (const dreamEnvironment of dreamEnvironments) {
        const createEvent = () => ({
          id: "daimon:dream-" + agent.config.id + "-" + bankId + "-" + dreamEnvironment + "-" + clock.now(),
          kind: "dream",
          from: "mneme",
          dream_environment: dreamEnvironment,
          run_id: clock.now() + "-" + Math.random().toString(16).slice(2),
          text: consolidation.prompt ?? "Dream over Mneme memory bank " + bankId + ". Search the active dream scope and read-only global scope, summarize noisy history, register stable consolidated memories, and forget stale duplicates only with evidence."
        });
        scheduledCount += 1;
        await scheduleWake(agent, timers, runOnce, intervalMs, createEvent, "dream:" + dreamEnvironment, clock);
      }
    }
  }
  return scheduledCount;
};
`;
