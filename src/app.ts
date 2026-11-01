import { ErcotError, SETTLEMENT_POINTS, type Ercot, type Market, type Price } from "./ercot.ts";
import { parseInstant } from "./interval.ts";

export interface Reply {
  status: number;
  body: Record<string, unknown>;
}

const CACHE_MS = 60_000;

export function createHandler(ercot: Ercot, now = () => Date.now()) {
  const cache = new Map<string, { price: Price; at: number }>();

  return async function handle(query: URLSearchParams): Promise<Reply> {
    const point = (query.get("node_or_zone") ?? "").trim().toUpperCase();
    if (!SETTLEMENT_POINTS.has(point)) {
      return { status: 400, body: { error: "unknown_settlement_point", supported: [...SETTLEMENT_POINTS] } };
    }
    const market = (query.get("market") ?? "real-time").toLowerCase() as Market;
    if (market !== "real-time" && market !== "day-ahead") {
      return { status: 400, body: { error: "unknown_market", supported: ["real-time", "day-ahead"] } };
    }
    const rawStart = query.get("interval_start");
    if (!rawStart) return { status: 400, body: { error: "interval_start_required" } };
    const start = parseInstant(rawStart);
    if (!start) {
      return { status: 400, body: { error: "interval_start_needs_a_timezone", example: "2026-10-31T21:15:00Z" } };
    }

    const key = `${point}|${market}|${start.toISOString()}`;
    const hit = cache.get(key);
    try {
      const price = hit && now() - hit.at < CACHE_MS ? hit.price : await ercot.price(point, market, start);
      if (!price) {
        return {
          status: 404,
          body: { error: "interval_not_published", node_or_zone: point, interval_start: start.toISOString() },
        };
      }
      cache.set(key, { price, at: now() });
      return {
        status: 200,
        body: {
          lmp_usd_per_mwh: price.lmpUsdPerMwh,
          node_or_zone: point,
          market,
          interval_start: start.toISOString(),
          currency: "USD",
          iso: "ERCOT",
          delivery: price.delivery,
          source_report: price.report,
          fetched_at: new Date(now()).toISOString(),
        },
      };
    } catch (error) {
      if (error instanceof ErcotError) return { status: error.status, body: { error: error.message } };
      return { status: 502, body: { error: "ERCOT request failed" } };
    }
  };
}
