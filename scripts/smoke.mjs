// Start the built server with no token and talk MCP to it over stdio: it must
// list every tool, and a call must answer with how to get a token rather than
// fail or reach the network. Exits non-zero on any mismatch.
import { spawn } from "node:child_process";

const env = { ...process.env };
delete env.SOMIYA_TOKEN;
const child = spawn(process.execPath, ["dist/index.js"], { env, stdio: ["pipe", "pipe", "inherit"] });

const pending = new Map();
let buffer = "";
let nextId = 0;
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line) {
      const message = JSON.parse(line);
      pending.get(message.id)?.(message);
    }
  }
});

function rpc(method, params) {
  const id = ++nextId;
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  return new Promise((resolve) => pending.set(id, resolve));
}

function check(condition, message) {
  if (!condition) {
    console.error(`smoke: FAIL — ${message}`);
    child.kill();
    process.exit(1);
  }
}

setTimeout(() => check(false, "no answer within 10s"), 10_000).unref();

await rpc("initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "smoke", version: "0" },
});
child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

const listed = (await rpc("tools/list", {})).result?.tools ?? [];
check(listed.length === 8, `expected 8 tools without a token, got ${listed.length}`);

const call = (await rpc("tools/call", { name: "somiya_whats_next", arguments: {} })).result;
check(call?.isError === true, "a call without a token should be an error result");
check(/SOMIYA_TOKEN is not set/.test(call.content?.[0]?.text ?? ""), "the error should say how to get a token");

console.log(`smoke: ok — ${listed.length} tools listed, calls explain the missing token`);
child.kill();
