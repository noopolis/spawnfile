---
title: Skills and MCP
description: How to define skills with SKILL.md, declare MCP servers, and connect skills to MCP dependencies using requires.mcp.
---

Skills and MCP servers are the two mechanisms Spawnfile provides for giving agents capabilities beyond conversation. Skills define what an agent can do in natural language. MCP servers provide the tool infrastructure that backs those skills.

## Skills

### Declaring Skills

Each entry in the `skills` list must have a `ref` pointing to a directory that contains a `SKILL.md` file.

```yaml
skills:
  - ref: ./skills/web_search
    requires:
      mcp:
        - web_search
```

The `ref` path is relative to the manifest directory and must use forward slashes.

### SKILL.md Format

A `SKILL.md` file must begin with a YAML frontmatter block declaring at minimum `name` and `description`:

```markdown
---
name: web_search
description: "Search the web and summarize the most relevant findings."
---

Use web search when the task needs current information or direct
source verification.
```

The body of the file (after the frontmatter) is free-form Markdown. Its contents are up to the author and the target adapter. This is where you describe when and how the agent should use the skill.

### Skill Directory Layout

A minimal skill is just a directory with a `SKILL.md`:

```text
skills/
  web_search/
    SKILL.md
```

The compiler reads the `SKILL.md` and maps the skill into the runtime's native skill surface. For example, OpenClaw and PicoClaw both have workspace skill directories where the compiled skill is placed.

### requires.mcp

A skill may declare MCP server dependencies using `requires.mcp`:

```yaml
skills:
  - ref: ./skills/web_search
    requires:
      mcp:
        - web_search
  - ref: ./skills/memory_store
    requires:
      mcp:
        - memory_store
```

Each name in `requires.mcp` must match a `name` in the agent's visible `mcp_servers` list. The compiler validates this at compile time and reports an error if a required MCP server is not declared.

For team members, the visible MCP scope is the union of the team's shared MCP servers and the member's own MCP servers, with member-local names taking precedence on conflict.

## MCP Servers

### Declaring MCP Servers

The `mcp_servers` list declares MCP servers available to the agent:

```yaml
mcp_servers:
  - name: web_search
    transport: streamable_http
    url: https://search.mcp.example.com/mcp
    auth:
      secret: SEARCH_API_KEY
  - name: local_index
    transport: stdio
    command: node
    args:
      - ./tools/index-mcp.js
```

Each entry must have a unique `name` within its manifest scope. Names are logical identifiers used for skill dependency resolution, not runtime-specific instance IDs.

### Transport Types

The `transport` field must be one of three values:

| Transport | Required Fields | Description |
|-----------|----------------|-------------|
| `stdio` | `command` | Runs a local process. May include `args` and `env`. |
| `streamable_http` | `url` | Connects to a remote MCP server over HTTP. |
| `sse` | `url` | Connects to a remote MCP server over Server-Sent Events. |

### Authentication

Use `auth.secret` to reference an environment variable that holds the API key or credential:

```yaml
mcp_servers:
  - name: web_search
    transport: streamable_http
    url: https://search.mcp.example.com/mcp
    auth:
      secret: SEARCH_API_KEY
```

The `auth.secret` value should be an environment variable name, not a literal credential. Pair it with a `secrets` entry to declare the requirement:

```yaml
secrets:
  - name: SEARCH_API_KEY
    required: true
```

### How Adapters Handle MCP

Adapters map logical MCP declarations into runtime-native MCP configuration. The level of support varies by runtime:

- **PicoClaw** has a first-class MCP config surface (`tools.mcp.servers`) and supports stdio, SSE, and HTTP transports.
- **OpenClaw** supports MCP through an `mcporter` bridge layer.
- **NullClaw** supports MCP with a stdio-first approach. Remote URLs may require a local bridge.
- **TinyClaw** does not have a clear first-class MCP surface at this time.

If a runtime cannot preserve an MCP declaration, the compiler reports it as `degraded` or `unsupported` based on your policy settings.

## Shared Skills and MCP in Teams

Teams can declare shared skills and MCP servers that all direct members inherit:

```yaml
kind: team
name: research-cell

shared:
  skills:
    - ref: ./shared/skills/web_search
  mcp_servers:
    - name: web_search
      transport: streamable_http
      url: https://search.mcp.example.com/mcp
      auth:
        secret: SEARCH_API_KEY
  secrets:
    - name: SEARCH_API_KEY
      required: true
```

Inheritance rules:
- Members extend the shared surface -- they cannot remove inherited items.
- On MCP name conflict, the member-local declaration wins.
- Shared surfaces do not propagate through nested team boundaries.

For validation of a shared skill's `requires.mcp`, the visible MCP scope is `shared.mcp_servers`. For a direct member's skills, the scope is the union of shared and member-local MCP servers.

## Example: Single Agent with Skill and MCP

From the `single-agent` fixture:

```yaml
spawnfile_version: "0.1"
kind: agent
name: analyst

runtime: openclaw

skills:
  - ref: ./skills/web_search
    requires:
      mcp:
        - web_search

mcp_servers:
  - name: web_search
    transport: streamable_http
    url: https://search.mcp.example.com/mcp
    auth:
      secret: SEARCH_API_KEY

secrets:
  - name: SEARCH_API_KEY
    required: true
```

The skill `web_search` declares a dependency on the `web_search` MCP server. The compiler validates that the MCP server exists and the secret is declared.

The corresponding `SKILL.md`:

```markdown
---
name: web_search
description: "Search the web and summarize the most relevant findings."
---

Use web search when the task needs current information or direct
source verification.
```
