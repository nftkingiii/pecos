import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createHandler } from "./app.ts";
import { createErcot } from "./ercot.ts";

const { ERCOT_USERNAME, ERCOT_PASSWORD, ERCOT_SUBSCRIPTION_KEY, PORT } = process.env;
if (!ERCOT_USERNAME || !ERCOT_PASSWORD || !ERCOT_SUBSCRIPTION_KEY) {
  throw new Error("ERCOT_USERNAME, ERCOT_PASSWORD and ERCOT_SUBSCRIPTION_KEY are required");
}

const handle = createHandler(
  createErcot({ username: ERCOT_USERNAME, password: ERCOT_PASSWORD, subscriptionKey: ERCOT_SUBSCRIPTION_KEY }),
);

/** Telegraph nodes fetch this and check it against the hash registered on-chain. */
const minerYaml = readFileSync(new URL("../pecos.yaml", import.meta.url));

const LIMIT_PER_MINUTE = 30;
const hits = new Map<string, { count: number; reset: number }>();

function allowed(ip: string): boolean {
  const now = Date.now();
  const hit = hits.get(ip);
  if (!hit || hit.reset < now) {
    if (hits.size > 10_000) hits.clear();
    hits.set(ip, { count: 1, reset: now + 60_000 });
    return true;
  }
  return ++hit.count <= LIMIT_PER_MINUTE;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://pecos");
  const send = (status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (req.method !== "GET") return send(405, { error: "method_not_allowed" });
  if (url.pathname === "/health") return send(200, { status: "ok" });
  if (url.pathname === "/pecos.yaml") {
    res.writeHead(200, { "content-type": "application/yaml" });
    return res.end(minerYaml);
  }
  if (url.pathname !== "/price") return send(404, { error: "not_found" });

  const forwarded = req.headers["x-real-ip"];
  const ip = (Array.isArray(forwarded) ? forwarded[0] : forwarded) ?? req.socket.remoteAddress ?? "unknown";
  if (!allowed(ip)) return send(429, { error: "rate_limited" });

  const { status, body } = await handle(url.searchParams);
  send(status, body);
});

server.listen(Number(PORT ?? 8080), () => console.log("pecos listening"));
