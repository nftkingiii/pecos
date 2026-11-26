import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { createHandler } from "./app.ts";
import { createCaiso } from "./caiso.ts";
import { createErcot } from "./ercot.ts";
import { requestLine } from "./log.ts";

const { ERCOT_USERNAME, ERCOT_PASSWORD, ERCOT_SUBSCRIPTION_KEY, PORT } = process.env;
if (!ERCOT_USERNAME || !ERCOT_PASSWORD || !ERCOT_SUBSCRIPTION_KEY) {
  throw new Error("ERCOT_USERNAME, ERCOT_PASSWORD and ERCOT_SUBSCRIPTION_KEY are required");
}

const handle = createHandler(
  createErcot({ username: ERCOT_USERNAME, password: ERCOT_PASSWORD, subscriptionKey: ERCOT_SUBSCRIPTION_KEY }),
  undefined,
  createCaiso(),
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

function clientIp(req: IncomingMessage): string {
  const header = req.headers["x-real-ip"] ?? req.headers["x-forwarded-for"];
  const raw = (Array.isArray(header) ? header[0] : header) ?? req.socket.remoteAddress ?? "unknown";
  return raw.split(",")[0]!.trim();
}

const server = createServer(async (req, res) => {
  const started = performance.now();
  const url = new URL(req.url ?? "/", "http://pecos");
  const ip = clientIp(req);
  let status = 0;
  let error: string | undefined;
  const send = (code: number, body: unknown) => {
    status = code;
    if (body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string") {
      error = (body as { error: string }).error;
    }
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  try {
    if (req.method !== "GET") return send(405, { error: "method_not_allowed" });
    if (url.pathname === "/health") return send(200, { status: "ok" });
    if (url.pathname === "/pecos.yaml") {
      status = 200;
      res.writeHead(200, { "content-type": "application/yaml" });
      return res.end(minerYaml);
    }
    if (url.pathname !== "/price") return send(404, { error: "not_found" });

    if (!allowed(ip)) return send(429, { error: "rate_limited" });

    const reply = await handle(url.searchParams);
    send(reply.status, reply.body);
  } catch {
    if (!res.headersSent) send(500, { error: "internal_error" });
  } finally {
    console.log(
      requestLine({ at: new Date(), route: url.pathname, query: url.searchParams, status, error, ms: performance.now() - started, ip }),
    );
  }
});

server.listen(Number(PORT ?? 8080), () => console.log("pecos listening"));
