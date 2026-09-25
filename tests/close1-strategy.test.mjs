import test from "node:test";
import assert from "node:assert/strict";

import {
  HYPERLIQUID_INFO_URL,
  analyzeClose1Market,
  fetchNvdaCandles,
  sizeClose1Position,
  validateNvdaCandles
} from "../src/close1-strategy.mjs";

const NOW = Date.parse("2026-09-25T17:00:00Z");

function candlesFrom(closes) {
  return closes.map((close, index) => ({
    t: NOW - (closes.length - index) * 60 * 60 * 1000,
    T: NOW - (closes.length - index - 1) * 60 * 60 * 1000 - 1,
    s: "xyz:NVDA",
    i: "1h",
    o: close.toFixed(2),
    h: (close + 0.2).toFixed(2),
    l: (close - 0.2).toFixed(2),
    c: close.toFixed(2),
    v: "100"
  }));
}

function snapshot(reference = "225.00") {
  return {
    action: "healthy",
    sweep: 63,
    reference,
    leaderboard: [["did:key:a", "75.60"], ["did:key:b", "67.66"], ["did:key:c", "67.66"]]
  };
}

test("validates ordered fresh hourly NVDA candles", () => {
  const candles = candlesFrom(Array.from({ length: 120 }, (_, index) => 220 + index * 0.04));
  assert.equal(validateNvdaCandles(candles, NOW).length, 120);
  assert.throws(() => validateNvdaCandles(candles.slice(0, 90), NOW), /Insufficient/);
  const wrongMarket = structuredClone(candles);
  wrongMarket[3].s = "NVDA";
  assert.throws(() => validateNvdaCandles(wrongMarket, NOW), /Unexpected/);
});

test("fetches only the official seven-day one-hour Hyperliquid request", async () => {
  const candles = candlesFrom(Array.from({ length: 120 }, (_, index) => 220 + index * 0.04));
  let request;
  const result = await fetchNvdaCandles(async (url, init) => {
    request = { url, init, body: JSON.parse(init.body) };
    return Response.json(candles);
  }, NOW);
  assert.equal(result.length, 120);
  assert.equal(request.url, HYPERLIQUID_INFO_URL);
  assert.deepEqual(request.body, {
    type: "candleSnapshot",
    req: { coin: "xyz:NVDA", interval: "1h", startTime: NOW - 7 * 24 * 60 * 60 * 1000, endTime: NOW }
  });
  assert.equal(analyzeClose1Market(result, snapshot(result.at(-1).c)).action, "hold");
});

test("holds on mixed trend instead of manufacturing a trade signal", () => {
  const closes = Array.from({ length: 120 }, (_, index) => 225 + Math.sin(index / 4));
  const result = analyzeClose1Market(candlesFrom(closes), snapshot(closes.at(-1).toFixed(2)));
  assert.equal(result.action, "hold");
  assert.equal(result.reason, "mixed-trend");
  assert.equal(result.metrics.currentTop3Score, "67.66");
});

test("creates a capped plan only for aligned 24h and 72h momentum", () => {
  const closes = Array.from({ length: 120 }, (_, index) => 210 + index * 0.13);
  const latest = closes.at(-1);
  const result = analyzeClose1Market(candlesFrom(closes), snapshot(latest.toFixed(2)));
  assert.equal(result.action, "candidate");
  assert.equal(result.direction, "long");
  assert.equal(result.riskPlan.allocation, 0.25);
  assert.ok(Number(result.riskPlan.notional) <= 2500);
  assert.ok(Number(result.riskPlan.beatCurrentTop3Final) > latest);
});

test("blocks divergent market data and allocations above the risk cap", () => {
  const candles = candlesFrom(Array.from({ length: 120 }, (_, index) => 220 + index * 0.04));
  assert.deepEqual(
    analyzeClose1Market(candles, snapshot("200.00")),
    { action: "blocked", reason: "market-reference-divergence" }
  );
  assert.throws(() => sizeClose1Position({
    side: "long",
    entryPrice: "225",
    targetScore: "67.66",
    allocation: 0.5
  }), /risk cap/);
});
