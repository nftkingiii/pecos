import { readZip } from "./zip.ts";

const OASIS = "https://oasis.caiso.com/oasisapi/SingleZip";
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** OASIS allows one request every five seconds. */
const MIN_GAP_MS = 5_500;
/** A caller never waits behind more than this much queue; it gets a 503 instead. */
const MAX_QUEUE_WAIT_MS = 20_000;
/** After OASIS errors or throttles us, stop calling it for a while. */
const COOLDOWN_MS = 30_000;
const REQUEST_TIMEOUT_MS = 20_000;
const PRICE_TOLERANCE = 0.011;

export const CAISO_SOURCE = "CAISO OASIS PRC_LMP";

/** Shorthand for the trading hubs and default load aggregation points; everything else is passed to OASIS as given. */
const ALIASES: Record<string, string> = {
  NP15: "TH_NP15_GEN-APND",
  SP15: "TH_SP15_GEN-APND",
  ZP26: "TH_ZP26_GEN-APND",
  TH_NP15_GEN: "TH_NP15_GEN-APND",
  TH_SP15_GEN: "TH_SP15_GEN-APND",
  TH_ZP26_GEN: "TH_ZP26_GEN-APND",
  DLAP_PGAE: "DLAP_PGAE-APND",
  DLAP_SCE: "DLAP_SCE-APND",
  DLAP_SDGE: "DLAP_SDGE-APND",
  DLAP_VEA: "DLAP_VEA-APND",
};
export const CAISO_EXAMPLES = [
  "TH_NP15_GEN-APND", "TH_SP15_GEN-APND", "TH_ZP26_GEN-APND",
  "DLAP_PGAE-APND", "DLAP_SCE-APND", "DLAP_SDGE-APND", "DLAP_VEA-APND",
];
const NODE_SHAPE = /^[A-Z0-9][A-Z0-9_.-]{2,39}$/;

export interface CaisoPrice {
  lmpUsdPerMwh: number;
  node: string;
  hourStart: Date;
  hourEnd: Date;
  components: { energy: number; congestion: number; loss: number; ghg: number } | null;
}

export class CaisoError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

interface Hour {
  end: number;
  lmp: number[];
  energy?: number;
  congestion?: number;
  loss?: number;
  ghg?: number;
}
type Day = Map<number, Hour>;

const ITEMS: Record<string, "lmp" | "energy" | "congestion" | "loss" | "ghg"> = {
  LMP_PRC: "lmp",
  LMP_ENE_PRC: "energy",
  LMP_CONG_PRC: "congestion",
  LMP_LOSS_PRC: "loss",
  LMP_GHG_PRC: "ghg",
};

function splitCsv(line: string): string[] {
  const out: string[] = [];
  let cell = "";
  let quoted = false;
  for (const ch of line) {
    if (ch === '"') quoted = !quoted;
    else if (ch === "," && !quoted) {
      out.push(cell);
      cell = "";
    } else cell += ch;
  }
  out.push(cell);
  return out;
}

/** Turns an OASIS SingleZip body into hours keyed by their start time. An OASIS "no data" answer is an empty day. */
export function parseOasis(body: Buffer, node: string): Day {
  const day: Day = new Map();
  for (const entry of readZip(body)) {
    const text = entry.data.toString("utf8");
    if (text.includes("ERR_CODE")) {
      const code = /ERR_CODE>\s*(\d+)/.exec(text)?.[1];
      if (code === "1000") continue;
      throw new CaisoError(503, `CAISO OASIS error ${code ?? "unknown"}`);
    }
    const [header, ...lines] = text.split(/\r?\n/).filter((l) => l.trim());
    const cols = splitCsv(header ?? "");
    const want = ["INTERVALSTARTTIME_GMT", "INTERVALENDTIME_GMT", "NODE", "MARKET_RUN_ID", "XML_DATA_ITEM", "MW"];
    const idx = want.map((name) => cols.indexOf(name));
    if (idx.some((i) => i < 0)) throw new CaisoError(503, "CAISO OASIS returned an unrecognised file");
    const [iStart, iEnd, iNode, iMarket, iItem, iValue] = idx as [number, number, number, number, number, number];
    for (const line of lines) {
      const cells = splitCsv(line);
      if (cells[iNode] !== node || cells[iMarket] !== "DAM") throw new CaisoError(503, "CAISO OASIS returned another node or market");
      const field = ITEMS[cells[iItem] ?? ""];
      if (!field) continue;
      const start = Date.parse(cells[iStart] ?? "");
      const end = Date.parse(cells[iEnd] ?? "");
      const value = Number(cells[iValue]);
      if (!Number.isFinite(start) || !Number.isFinite(value) || end - start !== HOUR_MS) {
        throw new CaisoError(503, "CAISO OASIS returned an unreadable row");
      }
      const hour = day.get(start) ?? { end, lmp: [] };
      if (field === "lmp") hour.lmp.push(value);
      else hour[field] = value;
      day.set(start, hour);
    }
  }
  return day;
}

export function createCaiso(
  http: typeof fetch = fetch,
  now = () => Date.now(),
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
) {
  let nextSlot = 0;
  let blockedUntil = 0;
  const days = new Map<string, { day: Day; at: number; ttl: number }>();
  const inflight = new Map<string, Promise<Day>>();
  const known = new Map<string, { known: boolean; at: number }>();

  async function fetchDay(node: string, dayStart: number): Promise<Day> {
    if (blockedUntil > now()) throw new CaisoError(503, "CAISO OASIS is unavailable, try again shortly");
    const wait = Math.max(0, nextSlot - now());
    if (wait > MAX_QUEUE_WAIT_MS) throw new CaisoError(503, "CAISO OASIS rate limit reached");
    nextSlot = Math.max(now(), nextSlot) + MIN_GAP_MS;
    if (wait) await sleep(wait);

    const stamp = (ms: number) => `${new Date(ms).toISOString().slice(0, 10).replaceAll("-", "")}T00:00-0000`;
    const url = `${OASIS}?${new URLSearchParams({
      queryname: "PRC_LMP",
      version: "1",
      market_run_id: "DAM",
      resultformat: "6",
      startdatetime: stamp(dayStart),
      enddatetime: stamp(dayStart + DAY_MS),
      node,
    })}`;
    let res: Response;
    try {
      res = await http(url, { headers: { "user-agent": "pecos-miner/1.0" }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch {
      blockedUntil = now() + COOLDOWN_MS;
      throw new CaisoError(503, "CAISO OASIS request failed");
    }
    if (!res.ok) {
      blockedUntil = now() + COOLDOWN_MS;
      throw new CaisoError(503, res.status === 429 ? "CAISO OASIS rate limit reached" : `CAISO OASIS answered ${res.status}`);
    }
    try {
      return parseOasis(Buffer.from(await res.arrayBuffer()), node);
    } catch (error) {
      if (error instanceof CaisoError) throw error;
      throw new CaisoError(503, "CAISO OASIS returned an unreadable file");
    }
  }

  /** One OASIS call per node and UTC day, cached and shared between concurrent callers. */
  async function dayOf(node: string, dayStart: number): Promise<Day> {
    const key = `${node}|${dayStart}`;
    const hit = days.get(key);
    if (hit && now() - hit.at < hit.ttl) return hit.day;
    const pending = inflight.get(key);
    if (pending) return pending;
    const run = fetchDay(node, dayStart)
      .then((day) => {
        if (days.size > 500) days.clear();
        // A finished day does not change; today's and tomorrow's can still gain hours.
        const settled = dayStart + DAY_MS < now() - 2 * DAY_MS;
        days.set(key, { day, at: now(), ttl: day.size === 0 ? 60_000 : settled ? 6 * HOUR_MS : 5 * 60_000 });
        return day;
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, run);
    return run;
  }

  /** OASIS answers "no data" alike for a bad node and an unpublished hour, so a node counts as real if it has data on a recent published day. */
  async function nodeExists(node: string, avoidDay: number): Promise<boolean> {
    const hit = known.get(node);
    if (hit && now() - hit.at < (hit.known ? 24 * HOUR_MS : HOUR_MS)) return hit.known;
    const today = Math.floor(now() / DAY_MS) * DAY_MS;
    const reference = today - 3 * DAY_MS === avoidDay ? today - 4 * DAY_MS : today - 3 * DAY_MS;
    const exists = (await dayOf(node, reference)).size > 0;
    if (known.size > 2_000) known.clear();
    known.set(node, { known: exists, at: now() });
    return exists;
  }

  return {
    /** The CAISO node a request names, or null when it cannot be one. */
    resolve(point: string): string | null {
      const node = ALIASES[point] ?? point;
      return NODE_SHAPE.test(node) ? node : null;
    },

    /** The day-ahead price for the hour containing `start`, or null when OASIS has not published it. Throws 400 for an unknown node, 503 when OASIS fails. */
    async price(node: string, start: Date): Promise<CaisoPrice | null> {
      const hourStart = Math.floor(start.getTime() / HOUR_MS) * HOUR_MS;
      const dayStart = Math.floor(start.getTime() / DAY_MS) * DAY_MS;
      const day = await dayOf(node, dayStart);
      if (day.size === 0) {
        if (!(await nodeExists(node, dayStart))) throw new CaisoError(400, "unknown_settlement_point");
        return null;
      }
      known.set(node, { known: true, at: now() });
      const hour = day.get(hourStart);
      if (!hour || hour.lmp.length === 0) return null;
      const lmp = hour.lmp[0]!;
      if (hour.lmp.some((v) => Math.abs(v - lmp) > PRICE_TOLERANCE)) throw new CaisoError(503, "CAISO OASIS returned conflicting prices");
      let components: CaisoPrice["components"] = null;
      if (hour.energy !== undefined && hour.congestion !== undefined && hour.loss !== undefined && hour.ghg !== undefined) {
        components = { energy: hour.energy, congestion: hour.congestion, loss: hour.loss, ghg: hour.ghg };
        if (Math.abs(hour.energy + hour.congestion + hour.loss + hour.ghg - lmp) > PRICE_TOLERANCE) {
          throw new CaisoError(503, "CAISO OASIS price does not match its components");
        }
      }
      return { lmpUsdPerMwh: lmp, node, hourStart: new Date(hourStart), hourEnd: new Date(hour.end), components };
    },
  };
}

export type Caiso = ReturnType<typeof createCaiso>;
