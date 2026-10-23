# somiya-mcp

[MCP](https://modelcontextprotocol.io) server for [Somiya](https://somiya.app) — point your own AI assistant at your family's calendar and tasks.

**Your AI proposes. Only you confirm.**

The server runs on your machine. Your assistant talks to it, it talks to the Somiya API, and Somiya's servers never see the conversation. The assistant can read what you can see, and it can suggest a task or a shopping item — but a suggestion is only a line of text waiting in the app until you tap confirm. Nothing reaches your family's data without that tap.

## Quick start

1. In the Somiya app: **Settings → AI access → Create token**. Copy it (it is shown once).
2. Add this to your MCP client's config:

```json
{
  "mcpServers": {
    "somiya": {
      "command": "npx",
      "args": ["-y", "somiya-mcp"],
      "env": { "SOMIYA_TOKEN": "smcp_..." }
    }
  }
}
```

3. Restart the client and ask it *"what's on for the family this week?"*

## Tools

| Tool | Needs scope | What it returns |
|---|---|---|
| `somiya_whats_next` | — | Events and due/overdue tasks for the next 7 days |
| `somiya_get_family` | — | Member names and roles |
| `somiya_whoami` | — | This token's label, scopes, role, expiry |
| `somiya_search_events` | `read:calendar` | Events between two timestamps |
| `somiya_list_tasks` | `read:tasks` | Open family tasks |
| `somiya_list_shopping` | `read:tasks` | Shopping lists and their items |
| `somiya_suggest_task` | `suggest:changes` | Files a task for you to confirm in the app. Creates nothing |
| `somiya_suggest_shopping_item` | `suggest:changes` | Files an item for you to confirm in the app. Creates nothing |

Only the tools your token's scopes cover are advertised — the assistant never sees a tool it would be refused. Started without a token, the server lists every tool and each one answers with how to get a token. Scopes are chosen when you create the token; the read scopes are on by default and `suggest:changes` is off.

## Configuration

| Variable | Default | |
|---|---|---|
| `SOMIYA_TOKEN` | — | **Required.** Minted in the app. |
| `SOMIYA_API_URL` | `https://api.somiya.app` | Override only for self-hosting or staging. |

## Privacy

- **Somiya never sees your AI conversation.** This process is the only thing that talks to both sides, and it runs on your machine.
- **Your AI provider does see whatever you send it.** What you paste into your assistant is governed by that provider's terms — that is your choice and your agreement, not something Somiya can make on your behalf.
- **Revoke any time**, from the same screen you created the token on. It stops working on the next call.
- Tokens expire after 90 days.
- Somiya counts how often each tool is called, for capacity planning. Those counters record a tool name and a date — no user, no family, no arguments, no results.

## Why it cannot write on its own

An assistant that reads untrusted content — a forwarded email, a flyer, a web page — can be steered by that content. Give it a "delete the task" tool and prompt injection stops being a curiosity and starts being destructive. So the boundary is the product: every change goes through a person, in the app.

A suggestion arrives as one line with two buttons. Confirming it runs the same code your own tap runs, with the same permission checks and the same audit trail; dismissing it leaves nothing behind; an unanswered suggestion is dropped after a day. **That confirmation is not a setting** — there is no "always allow", because an always-allow switch is exactly what would turn an injected instruction into a real change.

Editing and deleting are not offered even as suggestions. An assistant that can propose additions can, at worst, waste your time. One that could propose removals would be asking you to approve losses one tap at a time.

The noise is bounded as well, since a confirmation prompt you stop reading is the same as none: at most ten unanswered suggestions per client, one notification per burst rather than one per item, and your quiet hours are honoured.

## Development

```bash
pnpm install
pnpm build
```

Inside the Somiya monorepo, use `pnpm install --ignore-workspace` instead. It matters there: this package deliberately sits outside the monorepo's pnpm workspace. The repo hoists its `node_modules` (`shamefully-hoist=true`), and folding an HTTP-server dependency tree into the workspace would put packages within reach of the mobile app's resolver that have no business being there.

Requires Node 20+ (uses global `fetch`).

## License

MIT
