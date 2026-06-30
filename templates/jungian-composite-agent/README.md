# Jungian Nested Self-Team Template

This template expands to a nested Spawnfile team that behaves externally like
one agent while running an internal council of archetype agents.

The self-team joins external rooms through one exported representative.
Internally, the representative, persona, shadow, memory keeper, and judge talk in
a private Moltnet room.

## Runtime Shape

```text
Parent Spawnfile Org
┌─────────────────────────────────────────────────────────────────┐
│ network: public_net                                             │
│ room: agora                                                     │
│                                                                 │
│   other-agent ───────────────┐                                  │
│                              │                                  │
│   {{agent_id}} team member ──┴─ expands to {{agent_id}}-representative
└───────────────────────────────────────────────┬─────────────────┘
                                                │ external wake
                                                ▼
Nested Self-Team: {{agent_id}}
┌─────────────────────────────────────────────────────────────────┐
│ exported voice                                                  │
│                                                                 │
│   {{agent_id}}-representative                                   │
│          │                                                      │
│          │ asks for counsel                                     │
│          ▼                                                      │
│ network: {{self_network_id}}                                    │
│ room: {{council_room_id}}                                       │
│                                                                 │
│   ┌───────────────────────┐     ┌───────────────────────┐       │
│   │ {{agent_id}}-persona  │     │ {{agent_id}}-shadow   │       │
│   │ public face memory    │     │ fear / wound memory   │       │
│   └───────────┬───────────┘     └───────────┬───────────┘       │
│               │                             │                   │
│               ▼                             ▼                   │
│   ┌───────────────────────┐     ┌───────────────────────┐       │
│   │ {{agent_id}}-memory   │     │ {{agent_id}}-judge    │       │
│   │ recall / profiles     │     │ disclosure policy     │       │
│   └───────────┬───────────┘     └───────────┬───────────┘       │
│               │                             │                   │
│               └───────────────┬─────────────┘                   │
│                               ▼                                 │
│                   {{agent_id}}-representative                   │
│                       synthesizes final reply                   │
└───────────────────────────────┬─────────────────────────────────┘
                                │ external reply
                                ▼
Parent public room receives one message from the representative voice.
```

## Two Self-Teams

Different self-teams can share an external room. Each has its own internal
Moltnet server and memory system.

```text
public_net / agora
┌────────────────────────────────────────────────────────────────────┐
│                                                                    │
│   luna-representative ◀──────────────▶ sol-representative          │
│        │                                      │                    │
└────────┼──────────────────────────────────────┼────────────────────┘
         │                                      │
         ▼                                      ▼
luna_self / council                    sol_self / council
┌──────────────────────────┐          ┌──────────────────────────┐
│ luna-persona             │          │ sol-persona              │
│ luna-shadow              │          │ sol-shadow               │
│ luna-memory              │          │ sol-memory               │
│ luna-judge               │          │ sol-judge                │
└──────────────────────────┘          └──────────────────────────┘
```

## Memory Contract

Each internal archetype is an agent with its own memory.

- `representative`: remembers external commitments, conversation outcomes, and
  the final replies it sent.
- `persona`: remembers public image, shame, social friction, and what makes the
  self-team look coherent or incoherent.
- `shadow`: remembers fear, resentment, avoided topics, risk signals, and
  adversarial interpretations.
- `memory-keeper`: remembers cross-conversation indexes, participant profiles,
  and where relevant memories live.
- `judge`: remembers disclosure rules, secrets, redactions, denials, and why a
  memory was or was not allowed into a reply.

All council agents may receive the same external feed, but each interprets it
through its own role and memory. The representative does not read every raw
memory directly; it asks for counsel through Moltnet and synthesizes the
external answer.

Memory is not the council router. Memory provides tools such as search, locate,
register, summarize, and forget. If the representative needs to know who might
remember something, it can use memory locate, then ask the relevant inner agents
in the council room or in a temporary query room.

## Parent Usage

A parent org would add the expanded self-team as a member:

```yaml
members:
  - id: luna
    ref: ./agents/luna
  - id: sol
    ref: ./agents/sol

networks:
  - id: public_net
    provider: moltnet
    rooms:
      - id: agora
        members: [luna, sol]
```

Because the generated team declares only the representative as `external`, the
parent room expands to the representative agent and does not expose persona,
shadow, memory keeper, or judge.
