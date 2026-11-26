import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { deflateRawSync } from "node:zlib";
import { createHandler } from "../src/app.ts";
import { CaisoError, createCaiso } from "../src/caiso.ts";
import type { Ercot } from "../src/ercot.ts";
import { requestLine } from "../src/log.ts";
import { readZip } from "../src/zip.ts";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/caiso/${name}.zip`, import.meta.url));
const NOW = Date.parse("2026-11-26T04:30:00Z");

/** A stand-in for OASIS that answers with recorded files, chosen by node and day. */
function oasis(files: Record<string, Buffer | number>) {
  const calls: string[] = [];
  const http = (async (url: string) => {
    const q = new URL(url).searchParams;
    const key = `${q.get("node")}|${q.get("startdatetime")?.slice(0, 8)}`;
    calls.push(key);
    const file = files[key] ?? files[`${q.get("node")}|*`];
    if (typeof file === "number") return new Response("", { status: file });
    return new Response(file ?? fixture("no_data"));
  }) as typeof fetch;
  return { http, calls };
}

function caisoWith(files: Record<string, Buffer | number>) {
  const stub = oasis(files);
  const sleeps: number[] = [];
  let clock = NOW;
  const caiso = createCaiso(stub.http, () => clock, async (ms) => void (sleeps.push(ms), (clock += ms)));
  return { caiso, calls: stub.calls, sleeps, advance: (ms: number) => (clock += ms) };
}

/** Builds a one-file zip, to simulate OASIS answers that were not recorded. */
function zipOf(name: string, text: string): Buffer {
  const data = deflateRawSync(Buffer.from(text));
  const nameBytes = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(text.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(text.length, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  central.writeUInt32LE(0, 42);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  const directory = Buffer.concat([central, nameBytes]);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(30 + nameBytes.length + data.length, 16);
  return Buffer.concat([local, nameBytes, data, directory, end]);
}

const HEADER =
  "INTERVALSTARTTIME_GMT,INTERVALENDTIME_GMT,OPR_DT,OPR_HR,OPR_INTERVAL,NODE_ID_XML,NODE_ID,NODE,MARKET_RUN_ID,LMP_TYPE,XML_DATA_ITEM,PNODE_RESMRID,GRP_TYPE,POS,MW,GROUP";
const row = (item: string, mw: number, node = "TH_NP15_GEN-APND") =>
  `2026-11-20T18:00:00-00:00,2026-11-20T19:00:00-00:00,2026-11-20,11,0,${node},${node},${node},DAM,X,${item},${node},ALL_APNODES,0,${mw},1`;
const csv = (...rows: string[]) => zipOf("x.csv", [HEADER, ...rows].join("\n"));

const NP15 = "TH_NP15_GEN-APND";
const at = (iso: string) => new Date(iso);

test("reads the recorded zip", () => {
  const [entry] = readZip(fixture("np15_day"));
  assert.match(entry!.name, /PRC_LMP_DAM/);
  assert.ok(entry!.data.toString().startsWith("INTERVALSTARTTIME_GMT"));
});

test("returns the recorded NP15 day-ahead price and its components", async () => {
  const { caiso } = caisoWith({ [`${NP15}|20261120`]: fixture("np15_day") });
  const price = await caiso.price(NP15, at("2026-11-20T18:00:00Z"));
  assert.equal(price?.lmpUsdPerMwh, 55.23633);
  assert.equal(price?.hourStart.toISOString(), "2026-11-20T18:00:00.000Z");
  assert.equal(price?.hourEnd.toISOString(), "2026-11-20T19:00:00.000Z");
  assert.deepEqual(price?.components, { energy: 33.5358, congestion: 21.70053, loss: 0, ghg: 0 });
});

test("a time inside the hour gets that hour's price", async () => {
  const { caiso } = caisoWith({ [`${NP15}|20261120`]: fixture("np15_day") });
  assert.equal((await caiso.price(NP15, at("2026-11-20T18:45:00Z")))?.lmpUsdPerMwh, 55.23633);
});

test("returns the recorded prices for the other hubs, a DLAP and a plain node", async () => {
  const cases: [string, string, number][] = [
    ["TH_SP15_GEN-APND", "sp15_day", -5.52728],
    ["TH_ZP26_GEN-APND", "zp26_day", -10],
    ["DLAP_PGAE-APND", "dlap_pgae_day", 59.52106],
    ["0096WD_7_N001", "plain_node_day", -4.8191],
  ];
  for (const [node, file, expected] of cases) {
    const { caiso } = caisoWith({ [`${node}|20261120`]: fixture(file) });
    assert.equal((await caiso.price(node, at("2026-11-20T18:00:00Z")))?.lmpUsdPerMwh, expected, node);
  }
});

test("hours are read in GMT across the spring-forward day", async () => {
  const { caiso } = caisoWith({ [`${NP15}|20260308`]: fixture("np15_dst_start") });
  assert.equal((await caiso.price(NP15, at("2026-03-08T08:00:00Z")))?.lmpUsdPerMwh, 27.98047);
  assert.equal((await caiso.price(NP15, at("2026-03-08T10:00:00Z")))?.lmpUsdPerMwh, 25.62782);
});

test("an hour OASIS has not published is null, never a neighbouring hour", async () => {
  const { caiso } = caisoWith({ [`${NP15}|20261127`]: fixture("np15_partial") });
  assert.equal((await caiso.price(NP15, at("2026-11-27T07:00:00Z")))?.lmpUsdPerMwh, 44.32358);
  assert.equal(await caiso.price(NP15, at("2026-11-27T08:00:00Z")), null);
  assert.equal(await caiso.price(NP15, at("2026-11-27T20:00:00Z")), null);
});

test("a published node with an empty day is not published, an unknown node is a 400", async () => {
  // Real node: empty far-future day, but data on the reference day three days before "now".
  const real = caisoWith({ [`${NP15}|20261205`]: fixture("np15_far_future"), [`${NP15}|20261123`]: fixture("np15_day") });
  assert.equal(await real.caiso.price(NP15, at("2026-12-05T18:00:00Z")), null);
  // Unknown node: OASIS answers "no data" for both the day and the reference day.
  const bogus = caisoWith({ "NOPE_NODE|*": fixture("no_data") });
  await assert.rejects(
    bogus.caiso.price("NOPE_NODE", at("2026-11-20T18:00:00Z")),
    (e: unknown) => e instanceof CaisoError && e.status === 400,
  );
  // A bad node is remembered, so asking again does not call OASIS again.
  const before = bogus.calls.length;
  await assert.rejects(bogus.caiso.price("NOPE_NODE", at("2026-11-21T18:00:00Z")));
  assert.equal(bogus.calls.length, before + 1); // the new day, but not another reference probe
});

test("one OASIS call serves every hour of that node and day, even when requested together", async () => {
  const { caiso, calls } = caisoWith({ [`${NP15}|20261120`]: fixture("np15_day") });
  const hours = ["01", "05", "09", "13", "17", "21"].map((h) => at(`2026-11-20T${h}:00:00Z`));
  const prices = await Promise.all(hours.map((h) => caiso.price(NP15, h)));
  assert.ok(prices.every((p) => p !== null));
  assert.equal(calls.length, 1);
});

test("calls OASIS no faster than its five second limit", async () => {
  const { caiso, sleeps } = caisoWith({ [`${NP15}|*`]: fixture("np15_day") });
  await caiso.price(NP15, at("2026-11-20T18:00:00Z"));
  await caiso.price(NP15, at("2026-11-19T18:00:00Z"));
  assert.equal(sleeps.length, 1);
  assert.ok(sleeps[0]! >= 5_000);
});

test("fails closed with 503 when OASIS errors, then backs off without calling it", async () => {
  const { caiso, calls, advance } = caisoWith({ [`${NP15}|*`]: 429 });
  for (let i = 0; i < 2; i++) {
    await assert.rejects(
      caiso.price(NP15, at("2026-11-20T18:00:00Z")),
      (e: unknown) => e instanceof CaisoError && e.status === 503,
    );
  }
  assert.equal(calls.length, 1);
  advance(31_000);
  await assert.rejects(caiso.price(NP15, at("2026-11-20T18:00:00Z")));
  assert.equal(calls.length, 2);
});

test("an OASIS error other than 'no data' is a 503, not an empty day", async () => {
  const xml = '<m:OASISReport><m:ERROR><m:ERR_CODE>2000</m:ERR_CODE><m:ERR_DESC>boom</m:ERR_DESC></m:ERROR></m:OASISReport>';
  const { caiso } = caisoWith({ [`${NP15}|*`]: zipOf("e.xml", xml) });
  await assert.rejects(
    caiso.price(NP15, at("2026-11-20T18:00:00Z")),
    (e: unknown) => e instanceof CaisoError && e.status === 503,
  );
});

test("a file that is not a zip is a 503", async () => {
  const { caiso } = caisoWith({ [`${NP15}|*`]: Buffer.from("<html>maintenance</html>") });
  await assert.rejects(
    caiso.price(NP15, at("2026-11-20T18:00:00Z")),
    (e: unknown) => e instanceof CaisoError && e.status === 503,
  );
});

test("refuses a price that disagrees with its components", async () => {
  const bad = csv(row("LMP_PRC", 50), row("LMP_ENE_PRC", 30), row("LMP_CONG_PRC", 5), row("LMP_LOSS_PRC", 0), row("LMP_GHG_PRC", 0));
  const { caiso } = caisoWith({ [`${NP15}|*`]: bad });
  await assert.rejects(
    caiso.price(NP15, at("2026-11-20T18:00:00Z")),
    (e: unknown) => e instanceof CaisoError && e.status === 503,
  );
  const good = csv(row("LMP_PRC", 35), row("LMP_ENE_PRC", 30), row("LMP_CONG_PRC", 5), row("LMP_LOSS_PRC", 0), row("LMP_GHG_PRC", 0));
  assert.equal((await caisoWith({ [`${NP15}|*`]: good }).caiso.price(NP15, at("2026-11-20T18:00:00Z")))?.lmpUsdPerMwh, 35);
});

test("refuses rows for another node", async () => {
  const wrong = csv(row("LMP_PRC", 10, "TH_SP15_GEN-APND"));
  const { caiso } = caisoWith({ [`${NP15}|*`]: wrong });
  await assert.rejects(caiso.price(NP15, at("2026-11-20T18:00:00Z")), (e: unknown) => e instanceof CaisoError && e.status === 503);
});

test("names shorthand hubs, rejects shapes that cannot be nodes", () => {
  const { caiso } = caisoWith({});
  assert.equal(caiso.resolve("NP15"), NP15);
  assert.equal(caiso.resolve("DLAP_SCE"), "DLAP_SCE-APND");
  assert.equal(caiso.resolve("0096WD_7_N001"), "0096WD_7_N001");
  assert.equal(caiso.resolve("A B"), null);
  assert.equal(caiso.resolve("X"), null);
  assert.equal(caiso.resolve("../../etc"), null);
});

// ---- the HTTP handler -----------------------------------------------------------------------------

const ercotNever: Ercot = {
  price: async () => {
    throw new Error("ERCOT must not be called for a CAISO node");
  },
};
const q = (values: Record<string, string>) => new URLSearchParams(values);

test("serves a CAISO node through the handler in the ERCOT answer shape", async () => {
  const { caiso } = caisoWith({ [`${NP15}|20261120`]: fixture("np15_day") });
  const handle = createHandler(ercotNever, () => NOW, caiso);
  const { status, body } = await handle(q({ node_or_zone: "th_np15_gen-apnd", interval_start: "2026-11-20T18:00:00Z", market: "day-ahead" }));
  assert.equal(status, 200);
  assert.equal(body.lmp_usd_per_mwh, 55.23633);
  assert.equal(body.node_or_zone, NP15);
  assert.equal(body.market, "day-ahead");
  assert.equal(body.interval_start, "2026-11-20T18:00:00.000Z");
  assert.equal(body.currency, "USD");
  assert.equal(body.iso, "CAISO");
  assert.equal(body.source, "CAISO OASIS PRC_LMP");
  assert.equal(body.verification, "single_source");
});

test("a CAISO node with no market defaults to day-ahead, and real-time is refused", async () => {
  const { caiso } = caisoWith({ [`${NP15}|20261120`]: fixture("np15_day") });
  const handle = createHandler(ercotNever, () => NOW, caiso);
  const ok = await handle(q({ node_or_zone: "NP15", interval_start: "2026-11-20T18:00:00Z" }));
  assert.equal(ok.status, 200);
  assert.equal(ok.body.market, "day-ahead");
  const rt = await handle(q({ node_or_zone: "NP15", interval_start: "2026-11-20T18:00:00Z", market: "real-time" }));
  assert.equal(rt.status, 400);
  assert.equal(rt.body.lmp_usd_per_mwh, undefined);
});

test("CAISO answers 404 for an unpublished hour, 400 for an unknown node, 503 for an OASIS failure", async () => {
  const published = caisoWith({ [`${NP15}|20261127`]: fixture("np15_partial") });
  const missing = await createHandler(ercotNever, () => NOW, published.caiso)(
    q({ node_or_zone: NP15, interval_start: "2026-11-27T20:00:00Z" }),
  );
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error, "interval_not_published");
  assert.equal(missing.body.lmp_usd_per_mwh, undefined);

  const bogus = caisoWith({ "NOPE_NODE|*": fixture("no_data") });
  const unknown = await createHandler(ercotNever, () => NOW, bogus.caiso)(
    q({ node_or_zone: "NOPE_NODE", interval_start: "2026-11-20T18:00:00Z" }),
  );
  assert.equal(unknown.status, 400);
  assert.equal(unknown.body.error, "unknown_settlement_point");

  const down = caisoWith({ [`${NP15}|*`]: 500 });
  const failed = await createHandler(ercotNever, () => NOW, down.caiso)(
    q({ node_or_zone: NP15, interval_start: "2026-11-20T18:00:00Z" }),
  );
  assert.equal(failed.status, 503);
  assert.equal(failed.body.lmp_usd_per_mwh, undefined);
});

test("CAISO input errors match the ERCOT ones", async () => {
  const handle = createHandler(ercotNever, () => NOW, caisoWith({}).caiso);
  assert.equal((await handle(q({ node_or_zone: NP15 }))).body.error, "interval_start_required");
  assert.equal((await handle(q({ node_or_zone: NP15, interval_start: "2026-11-20T18:00:00" }))).body.error, "interval_start_needs_a_timezone");
});

test("ERCOT points never touch CAISO, and answer exactly as before", async () => {
  let called = false;
  const spy = createCaiso((async () => {
    called = true;
    return new Response("");
  }) as typeof fetch);
  const ercot: Ercot = {
    price: async (settlementPoint, market) => ({
      lmpUsdPerMwh: -6.38,
      settlementPoint,
      market,
      delivery: { deliveryDate: "2026-11-20", deliveryHour: 13, deliveryInterval: 1 },
      report: "np4-190-cd/dam_stlmnt_pnt_prices",
    }),
  };
  const query = q({ node_or_zone: "HB_WEST", interval_start: "2026-11-20T18:00:00Z", market: "day-ahead" });
  const withCaiso = await createHandler(ercot, () => NOW, spy)(query);
  const without = await createHandler(ercot, () => NOW)(query);
  assert.equal(called, false);
  assert.equal(withCaiso.status, 200);
  assert.deepEqual(withCaiso, without);
  assert.deepEqual(Object.keys(withCaiso.body), [
    "lmp_usd_per_mwh", "node_or_zone", "market", "interval_start", "currency", "iso", "delivery", "source_report", "fetched_at",
  ]);
});

test("without CAISO configured, a CAISO node is still the old 400", async () => {
  const { status, body } = await createHandler(ercotNever)(q({ node_or_zone: NP15, interval_start: "2026-11-20T18:00:00Z" }));
  assert.equal(status, 400);
  assert.equal(body.error, "unknown_settlement_point");
  assert.equal(body.also_supported_caiso, undefined);
});

// ---- request logging -------------------------------------------------------------------------------

test("request log line is greppable JSON with the fixed fields", () => {
  const line = requestLine({
    at: new Date("2026-11-26T04:30:00Z"),
    route: "/price",
    query: new URLSearchParams({ node_or_zone: "TH_NP15_GEN-APND", interval_start: "2026-11-20T18:00:00Z" }),
    status: 400,
    error: "unknown_settlement_point",
    ms: 12.4,
    ip: "13.237.89.59",
  });
  assert.ok(line.startsWith("req {"));
  assert.ok(!line.includes("\n"));
  assert.deepEqual(JSON.parse(line.slice(4)), {
    ts: "2026-11-26T04:30:00.000Z",
    route: "/price",
    query: { node_or_zone: "TH_NP15_GEN-APND", interval_start: "2026-11-20T18:00:00Z" },
    status: 400,
    error: "unknown_settlement_point",
    ms: 12,
    ip: "13.237.89.59",
  });
});

test("request log truncates values to 200 characters, bounds parameters and stays on one line", () => {
  const query = new URLSearchParams({ node_or_zone: "x".repeat(500), note: "a\nb\r\nc" });
  for (let i = 0; i < 40; i++) query.append(`p${i}`, "v");
  const line = requestLine({ at: new Date(0), route: "/price", query, status: 200, ms: 1, ip: "::1" });
  assert.ok(!/[\r\n]/.test(line));
  const parsed = JSON.parse(line.slice(4));
  assert.equal(parsed.query.node_or_zone.length, 200);
  assert.ok(Object.keys(parsed.query).length <= 20);
  assert.equal(parsed.error, undefined);
});
