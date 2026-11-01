import assert from "node:assert/strict";
import { test } from "node:test";
import { createHandler } from "../src/app.ts";
import { createErcot, ErcotError, type Ercot } from "../src/ercot.ts";
import { parseInstant, toDeliveryInterval } from "../src/interval.ts";

const query = (values: Record<string, string>) => new URLSearchParams(values);
const ok = { node_or_zone: "lz_west", interval_start: "2026-10-31T21:15:00Z" };

const priced: Ercot = {
  price: async (settlementPoint, market, start) => ({
    lmpUsdPerMwh: 98.5,
    settlementPoint,
    market,
    delivery: toDeliveryInterval(start),
    report: "np6-905-cd/spp_node_zone_hub",
  }),
};

test("converts UTC to ERCOT delivery time, hour ending", () => {
  // 21:15 UTC on Oct 31 is 16:15 Central during daylight time.
  assert.deepEqual(toDeliveryInterval(new Date("2026-10-31T21:15:00Z")), {
    deliveryDate: "2026-10-31",
    deliveryHour: 17,
    deliveryInterval: 2,
  });
  // Midnight Central falls in hour ending 1 of the new day.
  assert.equal(toDeliveryInterval(new Date("2026-07-01T05:00:00Z")).deliveryHour, 1);
});

test("refuses a time without a timezone", () => {
  assert.equal(parseInstant("2026-10-31T21:15:00"), null);
  assert.ok(parseInstant("2026-10-31T16:15:00-05:00"));
});

test("returns the intent's fields for a published interval", async () => {
  const { status, body } = await createHandler(priced)(query(ok));
  assert.equal(status, 200);
  assert.equal(body.lmp_usd_per_mwh, 98.5);
  assert.equal(body.node_or_zone, "LZ_WEST");
  assert.equal(body.market, "real-time");
  assert.equal(body.currency, "USD");
});

test("rejects an unknown settlement point without calling ERCOT", async () => {
  let called = false;
  const spy: Ercot = {
    price: async () => {
      called = true;
      return null;
    },
  };
  const { status, body } = await createHandler(spy)(query({ ...ok, node_or_zone: "NP15" }));
  assert.equal(status, 400);
  assert.equal(body.error, "unknown_settlement_point");
  assert.equal(called, false);
});

test("never substitutes another interval when one is missing", async () => {
  const empty: Ercot = { price: async () => null };
  const { status, body } = await createHandler(empty)(query(ok));
  assert.equal(status, 404);
  assert.equal(body.error, "interval_not_published");
  assert.equal(body.lmp_usd_per_mwh, undefined);
});

test("reports an ERCOT failure as a clean error, with no price", async () => {
  const failing: Ercot = {
    price: async () => {
      throw new ErcotError(503, "ERCOT rate limit reached");
    },
  };
  const { status, body } = await createHandler(failing)(query(ok));
  assert.equal(status, 503);
  assert.equal(body.lmp_usd_per_mwh, undefined);
});

test("serves a repeat request from cache", async () => {
  let calls = 0;
  const counting: Ercot = {
    price: async (...args) => {
      calls++;
      return priced.price(...args);
    },
  };
  const handle = createHandler(counting);
  await handle(query(ok));
  await handle(query(ok));
  assert.equal(calls, 1);
});

test("reuses the login token between requests", async () => {
  let logins = 0;
  const http = (async (url: string) => {
    if (String(url).includes("b2clogin")) {
      logins++;
      return new Response(JSON.stringify({ id_token: "t" }));
    }
    return new Response(JSON.stringify({ fields: [{ name: "settlementPointPrice" }], data: [[12.5]] }));
  }) as typeof fetch;
  let clock = 1_000_000;
  const ercot = createErcot({ username: "u", password: "p", subscriptionKey: "k" }, http, () => (clock += 3_000));
  const start = new Date("2026-10-31T21:15:00Z");
  assert.equal((await ercot.price("HB_WEST", "real-time", start))?.lmpUsdPerMwh, 12.5);
  await ercot.price("HB_WEST", "real-time", start);
  assert.equal(logins, 1);
});
