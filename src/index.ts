#!/usr/bin/env node
/**
 * Somiya MCP server — reads directly, writes only by asking.
 *
 * Runs on the user's own machine and speaks MCP over stdio to whichever client
 * they point at it. It holds a token the user minted in the Somiya app and
 * calls only the endpoints that token covers. Somiya's servers never see the
 * conversation: the assistant talks to this process, this process talks to the
 * API, and the transcript stays between the user and their own client.
 *
 * Nothing here changes family data on its own. The suggestion tools file a
 * draft that appears in the Somiya app, and it stays a draft until the user
 * taps confirm; that confirmation runs as the user, through the app's ordinary
 * create path, with its role checks and its audit trail. The absence of a
 * direct write is a design decision, not an unfinished feature: an assistant
 * reading untrusted content (a forwarded email, a flyer, a web page) can be
 * steered by that content, so the one thing it must never hold is a tool that
 * takes effect without a human seeing it first. See ADR 2026-08-07 in the
 * Somiya vault.
 *
 * Two rules this file must keep:
 *
 *  1. Never write to stdout. Stdout IS the JSON-RPC channel; a stray
 *     console.log corrupts the stream and the client disconnects with a
 *     parse error that looks like anything but a log line. Diagnostics go to
 *     stderr, via note().
 *  2. Never follow a URL found in family content. This process fetches exactly
 *     one origin — the configured API — and nothing a tool result contains can
 *     redirect it. Family text is data to be handed to the model, never
 *     instructions for this program.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";

const DEFAULT_API_URL = "https://api.somiya.app";

const SCOPE_CALENDAR = "read:calendar";
const SCOPE_TASKS = "read:tasks";
const SCOPE_SUGGEST = "suggest:changes";

/** Diagnostics — stderr only. See rule 1 in the module comment. */
function note(message: string): void {
  process.stderr.write(`[somiya-mcp] ${message}\n`);
}

function fail(message: string): never {
  note(message);
  process.exit(1);
}

/** Pull FastAPI's `detail` out of an error body, falling back to the status. */
async function detail(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { detail?: unknown };
    if (typeof body.detail === "string") {
      return body.detail;
    }
    return JSON.stringify(body.detail);
  } catch {
    return `Somiya returned ${response.status}.`;
  }
}

interface Introspection {
  token_name: string;
  scopes: string[];
  expires_at: string;
  role: string;
}

class SomiyaClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  async get(path: string, query?: Record<string, string>): Promise<unknown> {
    return this.request("GET", path, { query });
  }

  async post(path: string, body: unknown): Promise<unknown> {
    return this.request("POST", path, { body });
  }

  private async request(
    method: "GET" | "POST",
    path: string,
    opts: { query?: Record<string, string>; body?: unknown },
  ): Promise<unknown> {
    // Built from a fixed base plus a fixed path constant — never from anything
    // that came back in a previous response.
    const url = new URL(`/mcp/v1${path}`, this.baseUrl);
    for (const [key, value] of Object.entries(opts.query ?? {})) {
      url.searchParams.set(key, value);
    }

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: "application/json",
          ...(opts.body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        redirect: "error",
      });
    } catch (cause) {
      throw new Error(
        `Could not reach Somiya at ${this.baseUrl}. Is SOMIYA_API_URL right, and are you online? (${String(cause)})`,
      );
    }

    if (response.status === 401) {
      throw new Error(
        "Somiya rejected this token. It was revoked, it expired, or the account " +
          "changed. Mint a new one in the app: Settings → AI access.",
      );
    }
    if (response.status === 403) {
      throw new Error(
        "This token does not carry the scope for that data. Scopes are chosen " +
          "when the token is created, in Settings → AI access.",
      );
    }
    if (response.status === 422) {
      // The suggestion was refused — malformed, or too many already waiting.
      // The server's wording is written to be repeated to the user, so pass it
      // through rather than flattening it to a status code.
      throw new Error(await detail(response));
    }
    if (!response.ok) {
      throw new Error(`Somiya returned ${response.status} for ${path}.`);
    }
    if (response.status === 204) {
      return {};
    }
    return response.json();
  }
}

/** Tool definitions, each tagged with the scope that unlocks it. */
interface ToolDef {
  tool: Tool;
  scope: string | null;
  run: (client: SomiyaClient, args: Record<string, unknown>) => Promise<unknown>;
}

const ISO_DATE = {
  type: "string",
  description: "ISO 8601 timestamp, e.g. 2026-08-20T00:00:00Z",
} as const;

/**
 * Drop keys the model left null or blank.
 *
 * A model filling a schema tends to send `"due_at": null` for anything it was
 * not told, and the API's create-schemas are strict. Stripping empties here
 * turns "the user didn't say" into "not provided", which is what it means.
 */
function compact(args: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(args).filter(([, value]) => value !== null && value !== undefined && value !== ""),
  );
}

const TOOL_DEFS: ToolDef[] = [
  {
    scope: null,
    tool: {
      name: "somiya_whoami",
      description:
        "What this connection may read: the token's label, its scopes, the " +
        "caller's role in the family, and when the token expires. Useful when " +
        "an answer came back narrower than expected.",
      inputSchema: { type: "object", properties: {} },
    },
    run: (client) => client.get("/me"),
  },
  {
    scope: null,
    tool: {
      name: "somiya_get_family",
      description:
        "The family roster — member names and their roles — so people can be " +
        "referred to by name rather than by id.",
      inputSchema: { type: "object", properties: {} },
    },
    run: (client) => client.get("/family"),
  },
  {
    scope: null,
    tool: {
      name: "somiya_whats_next",
      description:
        "What is coming up for this family over the next week: upcoming " +
        "calendar events and tasks that are due or overdue. The best first " +
        "call for any 'what's on', 'what's next' or 'anything I'm forgetting' " +
        "question. Read-only.",
      inputSchema: { type: "object", properties: {} },
    },
    run: (client) => client.get("/now"),
  },
  {
    scope: SCOPE_CALENDAR,
    tool: {
      name: "somiya_search_events",
      description:
        "Calendar events between two timestamps, expanded from any recurrence. " +
        "Read-only: creating or changing an event happens in the Somiya app.",
      inputSchema: {
        type: "object",
        properties: { from: ISO_DATE, to: ISO_DATE },
        required: ["from", "to"],
      },
    },
    run: (client, args) =>
      client.get("/events", {
        from: String(args.from ?? ""),
        to: String(args.to ?? ""),
      }),
  },
  {
    scope: SCOPE_TASKS,
    tool: {
      name: "somiya_list_tasks",
      description:
        "Open family tasks with their due dates and assignees. Another " +
        "member's private tasks are never included. Read-only: ticking a task " +
        "off happens in the Somiya app. To add one, use " +
        "somiya_suggest_task.",
      inputSchema: { type: "object", properties: {} },
    },
    run: (client) => client.get("/tasks"),
  },
  {
    scope: SCOPE_TASKS,
    tool: {
      name: "somiya_list_shopping",
      description:
        "The family's shopping lists and the items on them. Read-only: checking " +
        "an item off happens in the Somiya app. To add one, use " +
        "somiya_suggest_shopping_item.",
      inputSchema: { type: "object", properties: {} },
    },
    run: (client) => client.get("/shopping"),
  },
  {
    scope: SCOPE_SUGGEST,
    tool: {
      name: "somiya_suggest_task",
      description:
        "Suggest a new family task. This does NOT create the task: it puts a " +
        "one-line draft in the Somiya app for the user to confirm or dismiss, " +
        "and nothing appears on the family's list until they do. Say so when " +
        "reporting back — 'I've suggested it, confirm it in Somiya' — never " +
        "'I've added it'. Unconfirmed suggestions are dropped after a day.",
      inputSchema: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description: "What needs doing, in the user's own words. Required.",
          },
          notes: { type: "string", description: "Optional detail." },
          due_at: {
            ...ISO_DATE,
            description:
              "Optional deadline, ISO 8601. Give a real clock time when the " +
              "user said one; otherwise pass midnight and set is_all_day.",
          },
          due_timezone: {
            type: "string",
            description: "IANA zone for due_at, e.g. Europe/Berlin. Family members travel.",
          },
          is_all_day: {
            type: "boolean",
            description: "True when the deadline is a day, not a time.",
          },
        },
        required: ["title"],
      },
    },
    run: (client, args) =>
      client.post("/propose", { kind: "task", payload: compact(args) }),
  },
  {
    scope: SCOPE_SUGGEST,
    tool: {
      name: "somiya_suggest_shopping_item",
      description:
        "Suggest an item for a family shopping list — the natural tool for " +
        "'add X to the shopping list'. This does NOT add it: it puts a draft " +
        "in the Somiya app for the user to confirm, and the item reaches the " +
        "shared list only after they tap confirm. Report it as suggested, not " +
        "as done. Unconfirmed suggestions are dropped after a day.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "The item, e.g. 'olive oil'. Required." },
          quantity: { type: "string", description: "Free text, e.g. '2 bottles'." },
          category: { type: "string", description: "Optional grouping, e.g. 'dairy'." },
          notes: { type: "string", description: "Optional detail, e.g. a brand." },
          list_id: {
            type: "string",
            description:
              "Which list, from somiya_list_shopping. Omit to use the family's " +
              "first list.",
          },
        },
        required: ["name"],
      },
    },
    run: (client, args) => {
      const { list_id: listId, ...item } = args;
      const payload: Record<string, unknown> = { item: compact(item) };
      if (typeof listId === "string" && listId) {
        payload.list_id = listId;
      }
      return client.post("/propose", { kind: "shopping_item", payload });
    },
  },
];

async function main(): Promise<void> {
  const token = process.env.SOMIYA_TOKEN?.trim();
  if (!token) {
    fail(
      "SOMIYA_TOKEN is not set. Create one in the Somiya app under " +
        "Settings → AI access, then put it in your client's MCP config.",
    );
  }
  const baseUrl = (process.env.SOMIYA_API_URL?.trim() || DEFAULT_API_URL).replace(/\/+$/, "");

  const client = new SomiyaClient(baseUrl, token);

  // Ask the token what it may do before advertising anything. A tool the token
  // cannot use is worse than a missing one: the model will call it, get a 403,
  // and report a failure the user cannot act on.
  let me: Introspection;
  try {
    me = (await client.get("/me")) as Introspection;
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }

  const granted = new Set(me.scopes);
  const active = TOOL_DEFS.filter((def) => def.scope === null || granted.has(def.scope));
  const byName = new Map(active.map((def) => [def.tool.name, def]));

  note(
    `connected as "${me.token_name}" (${me.role}); scopes: ${me.scopes.join(", ") || "none"}; ` +
      `${active.length} tools; token expires ${me.expires_at.slice(0, 10)}`,
  );

  const server = new Server(
    { name: "somiya", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: active.map((def) => def.tool),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const def = byName.get(request.params.name);
    if (!def) {
      // Either a stale tool list on the client, or a model inventing a name.
      // Both deserve the same flat answer rather than a thrown transport error.
      return {
        isError: true,
        content: [{ type: "text" as const, text: `Unknown tool: ${request.params.name}` }],
      };
    }

    try {
      const data = await def.run(client, request.params.arguments ?? {});
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
      };
    } catch (error) {
      return {
        isError: true,
        content: [
          { type: "text" as const, text: error instanceof Error ? error.message : String(error) },
        ],
      };
    }
  });

  await server.connect(new StdioServerTransport());
  note("ready");
}

main().catch((error: unknown) => {
  fail(error instanceof Error ? error.message : String(error));
});
