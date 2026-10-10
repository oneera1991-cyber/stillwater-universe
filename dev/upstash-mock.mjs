/*
LOCAL STAND-IN for the Upstash Redis REST API (dev/tests only, never deployed).
  UPSTASH_MOCK_TOKEN=devtoken node dev/upstash-mock.mjs [port=8079] [dumpFile]
Then: KV_REST_API_URL=http://127.0.0.1:8079 KV_REST_API_TOKEN=devtoken node dev/server.mjs
Implements the subset Stillwater uses: POST / (one command as a JSON array) and
POST /pipeline (array of commands): RPUSH, LRANGE, LLEN, LPOP, LTRIM, LINDEX, DEL, PING.
Responses follow Upstash: { result } or { error } (HTTP 400 on a bad command, 401 bad token).
State is in memory; with dumpFile it is also written there (JSON) after every write.
*/
import http from "node:http";
import { writeFileSync } from "node:fs";

const PORT = Number(process.argv[2] || 8079);
const DUMP = process.argv[3] || "";
const TOKEN = process.env.UPSTASH_MOCK_TOKEN || "devtoken";
const lists = new Map();

function idx(list, i) { i = Number(i); return i < 0 ? list.length + i : i; }
function run(cmd) {
  if (!Array.isArray(cmd) || !cmd.length) throw new Error("ERR bad command");
  const [name, key, ...args] = cmd.map(String);
  const list = lists.get(key) || [];
  switch (name.toUpperCase()) {
    case "PING": return "PONG";
    case "RPUSH": if (!args.length) throw new Error("ERR wrong number of arguments"); list.push(...args); lists.set(key, list); return list.length;
    case "LLEN": return list.length;
    case "LRANGE": { const a = Math.max(0, idx(list, args[0])), b = Math.min(list.length - 1, idx(list, args[1])); return b < a ? [] : list.slice(a, b + 1); }
    case "LINDEX": return list[idx(list, args[0])] ?? null;
    case "LPOP": { const n = args[0] ? Number(args[0]) : 1; const out = list.splice(0, n); lists.set(key, list); return args[0] ? out : (out[0] ?? null); }
    case "LTRIM": { const a = Math.max(0, idx(list, args[0])), b = idx(list, args[1]); lists.set(key, b < a ? [] : list.slice(a, b + 1)); return "OK"; }
    case "DEL": { const had = lists.delete(key) ? 1 : 0; return had; }
    default: throw new Error("ERR unknown command " + name);
  }
}
const WRITES = /^(RPUSH|LPOP|LTRIM|DEL)$/i;

http.createServer(async (req, res) => {
  const send = (status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  if (req.headers.authorization !== "Bearer " + TOKEN) return send(401, { error: "Unauthorized" });
  const chunks = []; for await (const c of req) chunks.push(c);
  let body; try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return send(400, { error: "ERR bad json" }); }
  const path = new URL(req.url, "http://x").pathname.replace(/\/+$/, "");
  try {
    if (path === "/pipeline") {
      const out = body.map((c) => { try { return { result: run(c) }; } catch (e) { return { error: e.message }; } });
      if (DUMP && body.some((c) => WRITES.test(String(c[0])))) writeFileSync(DUMP, JSON.stringify(Object.fromEntries(lists)));
      return send(200, out);
    }
    const result = run(body);
    if (DUMP && WRITES.test(String(body[0]))) writeFileSync(DUMP, JSON.stringify(Object.fromEntries(lists)));
    return send(200, { result });
  } catch (e) { return send(400, { error: e.message }); }
}).listen(PORT, "127.0.0.1", () => console.log("upstash mock on http://127.0.0.1:" + PORT));
