import { toDeliveryInterval, type DeliveryInterval } from "./interval.ts";

const TOKEN_URL =
  "https://ercotb2c.b2clogin.com/ercotb2c.onmicrosoft.com/B2C_1_PUBAPI-ROPC-FLOW/oauth2/v2.0/token";
const CLIENT_ID = "fec253ea-0d06-4272-a5e6-b478baeecd70";
const REPORTS = "https://api.ercot.com/api/public-reports";
const TOKEN_LIFETIME_MS = 50 * 60 * 1000;
/** ERCOT allows 30 requests a minute. */
const MIN_GAP_MS = 2_100;

export const SETTLEMENT_POINTS = new Set([
  "HB_BUSAVG", "HB_HOUSTON", "HB_HUBAVG", "HB_NORTH", "HB_PAN", "HB_SOUTH", "HB_WEST",
  "LZ_AEN", "LZ_CPS", "LZ_HOUSTON", "LZ_LCRA", "LZ_NORTH", "LZ_RAYBN", "LZ_SOUTH", "LZ_WEST",
]);

export type Market = "real-time" | "day-ahead";

export interface Price {
  lmpUsdPerMwh: number;
  settlementPoint: string;
  market: Market;
  delivery: DeliveryInterval;
  report: string;
}

export class ErcotError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

export interface Credentials {
  username: string;
  password: string;
  subscriptionKey: string;
}

export function createErcot(credentials: Credentials, http: typeof fetch = fetch, now = () => Date.now()) {
  let token: { value: string; expires: number } | null = null;
  let nextSlot = 0;

  async function idToken(): Promise<string> {
    if (token && token.expires > now()) return token.value;
    const res = await http(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        username: credentials.username,
        password: credentials.password,
        grant_type: "password",
        scope: `openid ${CLIENT_ID} offline_access`,
        client_id: CLIENT_ID,
        response_type: "id_token",
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new ErcotError(502, `ERCOT login failed with ${res.status}`);
    const body = (await res.json()) as { id_token?: string };
    if (!body.id_token) throw new ErcotError(502, "ERCOT login returned no token");
    token = { value: body.id_token, expires: now() + TOKEN_LIFETIME_MS };
    return token.value;
  }

  async function report(path: string, query: Record<string, string>) {
    const wait = Math.max(0, nextSlot - now());
    nextSlot = Math.max(now(), nextSlot) + MIN_GAP_MS;
    if (wait) await new Promise((resolve) => setTimeout(resolve, wait));

    const res = await http(`${REPORTS}/${path}?${new URLSearchParams(query)}`, {
      headers: {
        "Ocp-Apim-Subscription-Key": credentials.subscriptionKey,
        Authorization: `Bearer ${await idToken()}`,
      },
      signal: AbortSignal.timeout(20_000),
    });
    if (res.status === 429) throw new ErcotError(503, "ERCOT rate limit reached");
    if (!res.ok) throw new ErcotError(502, `ERCOT answered ${res.status}`);
    return (await res.json()) as { fields?: { name: string }[]; data?: unknown[][] };
  }

  return {
    /** The exact published interval, or null when ERCOT has not published it. */
    async price(settlementPoint: string, market: Market, start: Date): Promise<Price | null> {
      const delivery = toDeliveryInterval(start);
      const hour = String(delivery.deliveryHour);
      const interval = String(delivery.deliveryInterval);
      const realTime = market === "real-time";
      const path = realTime ? "np6-905-cd/spp_node_zone_hub" : "np4-190-cd/dam_stlmnt_pnt_prices";
      // The day-ahead report has no hour filter, so its row is picked out below.
      const window: Record<string, string> = realTime
        ? { deliveryHourFrom: hour, deliveryHourTo: hour, deliveryIntervalFrom: interval, deliveryIntervalTo: interval }
        : {};

      const body = await report(path, {
        deliveryDateFrom: delivery.deliveryDate,
        deliveryDateTo: delivery.deliveryDate,
        settlementPoint,
        ...window,
      });
      const names = (body.fields ?? []).map((f) => f.name);
      const column = names.indexOf("settlementPointPrice");
      const hourEnding = `${hour.padStart(2, "0")}:00`;
      const row = realTime
        ? body.data?.[0]
        : body.data?.find((r) => r[names.indexOf("hourEnding")] === hourEnding);
      if (column < 0 || !row) return null;
      const lmpUsdPerMwh = Number(row[column]);
      if (!Number.isFinite(lmpUsdPerMwh)) return null;
      return { lmpUsdPerMwh, settlementPoint, market, delivery, report: path };
    },
  };
}

export type Ercot = ReturnType<typeof createErcot>;
