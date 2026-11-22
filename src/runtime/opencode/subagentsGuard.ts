export function renderOpenCodeSubagentGuard(names: string[]): string {
  return String.raw`const names = ${JSON.stringify(names)}
export async function spawnfileSubagents() {
  const prompts = new Set()
  return {
    config(config) {
      const roles = names.map(name => config.agent?.[name])
      if (roles.some(role => role?.mode !== "subagent" || !role.prompt ||
          role.permission?.["*"] !== "deny" || Object.values(role.permission).some(action => action !== "deny"))) {
        throw new Error("OpenCode Spawnfile helpers require compiled text-only roles")
      }
      for (const role of roles) prompts.add(role.prompt)
      const task = Object.fromEntries([["*", "deny"], ...names.map(name => [name, "allow"])])
      for (const name of ["build", "plan"]) {
        const parent = config.agent[name] ??= {}
        parent.permission = { ...parent.permission, task }
      }
    },
    "tool.execute.before"({ tool }, { args }) {
      if (tool !== "task") return
      if (!names.includes(args.subagent_type)) throw new Error("Choose a declared Spawnfile helper")
      if ("task_id" in args || args.background === true) throw new Error("Start a fresh, foreground helper task")
      // The native task parser treats @ mentions as file attachments and reads them outside tool permissions.
      if (typeof args.prompt !== "string" || /(?<![\w\x60])@(\.?[^\s\x60,.]*(?:\.[^\s\x60,.]+)*)/u.test(args.prompt)) {
        throw new Error("Send the helper plain text without OpenCode @ attachments")
      }
    },
    "experimental.chat.system.transform"(_input, output) {
      // The pinned LLM builder puts the role prompt before environment and project or MCP instructions.
      const first = output.system[0]
      const prompt = [...prompts].find(candidate => first === candidate || first?.startsWith(candidate + "\n"))
      if (prompt) output.system.splice(0, output.system.length, prompt)
    }
  }
}
`;
}
