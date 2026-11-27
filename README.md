# Pecos

ERCOT (Texas) wholesale electricity prices for Telegraph's `GRID_POWER_PRICE_GENERAL` intent. Pecos reads settlement point prices from ERCOT's Public API and answers only the exact interval asked for. It never substitutes another interval and never returns a stale value as fresh.

- Telegraph provider: **7310042** (`pecos-ercot`), registration 4863, active on Ethereum Sepolia testnet
- Service: https://pecos-app.up.railway.app
- Miner YAML: https://pecos-app.up.railway.app/pecos.yaml

Before Pecos, no provider on `GRID_POWER_PRICE_GENERAL` served ERCOT, the Texas grid. The Season II Mining & Power mission asks for real-time and day-ahead prices at each site's node.

## Call it through Telegraph

A request costs $0.01 in test USDC, paid with x402 on Ethereum Sepolia. Test USDC is free to mint: see [Addresses & Parameters](https://anjoman.ai/docs/protocol/addresses-and-params).

```bash
curl -i -X POST https://devnode.telegraphprotocol.com/engine/v1/ask/7310042 \
  -H "Content-Type: application/json" \
  -d '{"intent":"GRID_POWER_PRICE_GENERAL","params":{"node_or_zone":"HB_WEST","interval_start":"2026-10-31T21:15:00Z"}}'
```

Without a payment this answers `402 Payment Required` with the price. With an x402 client ([Pay per Request](https://anjoman.ai/docs/using/x402-inference)) it answers in the intent's shape:

```json
{
  "miner_id": "7310042",
  "result": {
    "lmp_usd_per_mwh": 98.5,
    "node_or_zone": "HB_WEST",
    "market": "real-time",
    "interval_start": "2026-10-31T21:15:00.000Z",
    "currency": "USD"
  },
  "result_shape": "intent",
  "cost_usd": 0.01
}
```

That response is a real call made on 2026-11-01. It was an internal test from a wallet of the same team, not third-party use:

| | |
|---|---|
| Signal | `0xe51b5c7fe08655835c1b0d3fcfefd5301cd1e5b258fd36932c8867aa266db764` |
| Receipt | `0xb89bd457107be190641d690a279f45b08ebee99a477242cdff1310b2c1eab420` |
| Payment | [`0xc872c266…f651`](https://sepolia.etherscan.io/tx/0xc872c266baa0f768ee8505eb2d8276aa8ea041c12e999a25288740d203e6f651) |

## Call the service directly

```bash
curl "https://pecos-app.up.railway.app/price?node_or_zone=HB_WEST&interval_start=2026-10-31T21:15:00Z"
curl "https://pecos-app.up.railway.app/price?node_or_zone=HB_WEST&market=day-ahead&interval_start=2026-10-31T22:00:00Z"
```

| Parameter | Values |
|---|---|
| `node_or_zone` | `HB_BUSAVG`, `HB_HOUSTON`, `HB_HUBAVG`, `HB_NORTH`, `HB_PAN`, `HB_SOUTH`, `HB_WEST`, `LZ_AEN`, `LZ_CPS`, `LZ_HOUSTON`, `LZ_LCRA`, `LZ_NORTH`, `LZ_RAYBN`, `LZ_SOUTH`, `LZ_WEST` |
| `interval_start` | An RFC 3339 time with a timezone. Real-time intervals are 15 minutes; day-ahead intervals are hourly |
| `market` | `real-time` (default) or `day-ahead` |

Failures are explicit:

| Status | When |
|---|---|
| `400 unknown_settlement_point` | The point isn't an ERCOT hub or load zone. ERCOT is not called |
| `400 interval_start_needs_a_timezone` | The time has no `Z` or offset |
| `404 interval_not_published` | ERCOT hasn't published that interval, for example a future one |
| `502` or `503` | ERCOT login or rate limit failed. No price is returned |

Times are converted to ERCOT delivery time: Central time, hour ending 1 to 24, 15-minute intervals 1 to 4. For example, 21:15 UTC on 31 October is hour ending 17, interval 2.

## Run it yourself

Requires Node 22+ and a free [ERCOT Public API](https://apiexplorer.ercot.com) account.

```bash
npm install
npm test
ERCOT_USERNAME=... ERCOT_PASSWORD=... ERCOT_SUBSCRIPTION_KEY=... npm start   # http://localhost:8080
```

Pecos logs in once per 50 minutes (ERCOT ID tokens last an hour), keeps to ERCOT's 30 requests a minute, caches each interval for 60 seconds, and rate-limits callers to 30 requests a minute per IP.

## CAISO day-ahead

A CAISO node (for example `TH_NP15_GEN-APND`, `TH_SP15_GEN-APND`, `TH_ZP26_GEN-APND`, `DLAP_PGAE-APND`, or any node CAISO OASIS has data for) is answered from CAISO OASIS `PRC_LMP` day-ahead results, with the same fields as an ERCOT answer plus `source`, `delivery_hour_start`, `delivery_hour_end` and `lmp_components_usd_per_mwh`. `market` defaults to `day-ahead` for these nodes and `real-time` is refused with a 400. An hour OASIS has not published is a 404, an unknown node a 400, and an OASIS failure a 503. It is a single source (`verification: single_source`), but each price is checked against its energy, congestion, loss and GHG components. Only the OASIS rate limit (one request per five seconds) applies, so the first answer for a node and UTC day can take a few seconds and the rest of that day is served from cache.

## Logs

Every request writes one line to stdout: `req {"ts":...,"route":...,"query":{...},"status":...,"error":...,"ms":...,"ip":...}`. Query values are cut to 200 characters; headers and bodies are never logged. Search for `req ` in the deploy logs.

## Limits

- ERCOT and, for day-ahead prices, CAISO. Other grids are served by other Telegraph providers.
- `GRID_POWER_PRICE_GENERAL` is now ranked: on 2026-11-27 its evaluation pool held 235 eligible rows from 7 submitters (we contributed ERCOT, CAISO, MISO and NYISO truth sources through Assize, tracked in [bounties#92](https://github.com/telegraphprotocol/bounties/issues/92); disclosed because we also run this miner). Pecos's score moves between epochs: 0 at epoch 45, rank 1 at 0.5 at epoch 57, 0 at epochs 62 and 64. Each epoch samples few questions, and most of the pool is outside ERCOT.
- Testnet only: payments are test USDC on Ethereum Sepolia.
