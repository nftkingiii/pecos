import { CAISO_EXAMPLES, CAISO_SOURCE, CaisoError, type Caiso } from "./caiso.ts";
import { ErcotError, SETTLEMENT_POINTS, type Ercot, type Market, type Price } from "./ercot.ts";
import { parseInstant } from "./interval.ts";

export interface Reply {
  status: number;
  body: Record<string, unknown>;
}

const CACHE_MS = 60_000;

export function createHandler(ercot: Ercot, now = () => Date.now(), caiso?: Caiso) {
  const cache = new Map<string, { price: Price; at: number }>();

  async function caisoPrice(source: Caiso, node: string, query: URLSearchParams): Promise<Reply> {
    // CAISO is served from OASIS day-ahead results, so that is also the default market for a CAISO node.
    const market = (query.get("market") ?? "day-ahead").toLowerCase();
    if (market !== "day-ahead") {
      return { status: 400, body: { error: "market_not_supported_for_caiso", supported: ["day-ahead"] } };
    }
    const rawStart = query.get("interval_start");
    if (!rawStart) return { status: 400, body: { error: "interval_start_required" } };
    const start = parseInstant(rawStart);
    if (!start) {
      return { status: 400, body: { error: "interval_start_needs_a_timezone", example: "2026-10-31T21:15:00Z" } };
    }
    try {
      const price = await source.price(node, start);
      if (!price) {
        return {
          status: 404,
          body: { error: "interval_not_published", node_or_zone: node, interval_start: start.toISOString() },
        };
      }
      return {
        status: 200,
        body: {
          lmp_usd_per_mwh: price.lmpUsdPerMwh,
          node_or_zone: node,
          market: "day-ahead",
          interval_start: start.toISOString(),
          currency: "USD",
          iso: "CAISO",
          source: CAISO_SOURCE,
          delivery_hour_start: price.hourStart.toISOString(),
          delivery_hour_end: price.hourEnd.toISOString(),
          lmp_components_usd_per_mwh: price.components,
          verification: "single_source",
          fetched_at: new Date(now()).toISOString(),
        },
      };
    } catch (error) {
      if (error instanceof CaisoError) {
        if (error.status === 400) {
          return {
            status: 400,
            body: { error: error.message, supported: [...SETTLEMENT_POINTS], also_supported_caiso: CAISO_EXAMPLES },
          };
        }
        return { status: error.status, body: { error: error.message } };
      }
      return { status: 503, body: { error: "CAISO request failed" } };
    }
  }

  return async function handle(query: URLSearchParams): Promise<Reply> {
    const point = (query.get("node_or_zone") ?? "").trim().toUpperCase();
    if (!SETTLEMENT_POINTS.has(point)) {
      const node = caiso?.resolve(point);
      if (caiso && node) return caisoPrice(caiso, node, query);
      return {
        status: 400,
        body: {
          error: "unknown_settlement_point",
          supported: [...SETTLEMENT_POINTS],
          ...(caiso ? { also_supported_caiso: CAISO_EXAMPLES } : {}),
        },
      };
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
