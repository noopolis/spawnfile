/** Adapter entry point that leaves training composition unloaded until a run starts. */
export const invokeTrainingCore: typeof import("./trainingCli.js").main =
  async (...args) => (await import("./trainingCli.js")).main(...args);
