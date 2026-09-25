import test from "node:test";
import assert from "node:assert/strict";

import {
  CLOSE1_BENCHMARK,
  CLOSE1_MARKET,
  HYPERLIQUID_INFO_URL,
  analyzeClose1Market,
  fetchBenchmarkCandles,
  fetchNvdaCandles,
  sizeClose1Position,
  validateNvdaCandles
} from "../src/close1-strategy.mjs";

const NOW = Date.parse("2026-09-25T17:00:00Z");
const HOUR_MS = 60 * 60 * 1000;

function candlesFrom(closes, market = CLOSE1_MARKET) {
  return closes.map((close, index) => ({
    t: NOW - (closes.length - index) * HOUR_MS,
    T: NOW - (closes.length - index - 1) * HOUR_MS - 1,
    s: market,
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
    sweep: 72,
    reference,
    leaderboard: [["did:key:a", "99.97"], ["did:key:b", "99.65"], ["did:key:c", "89.32"]]
  };
}

function candidateSeries() {
  const benchmark = Array.from({ length: 720 }, (_, index) => 30_000 + index * 3);
  const nvda = Array.from({ length: 720 }, (_, index) => {
    if (index <= 551) return 200 + index * 0.05;
    return 227.55 - (index - 551) * (9.55 / 168);
  });
  return { nvda, benchmark };
}

test("validates ordered fresh hourly NVDA candles", () => {
  const candles = candlesFrom(Array.from({ length: 720 }, (_, index) => 220 + index * 0.004));
  assert.equal(validateNvdaCandles(candles, NOW).length, 720);
  assert.throws(() => validateNvdaCandles(candles.slice(0, 600), NOW), /Insufficient/);
  const wrongMarket = structuredClone(candles);
  wrongMarket[3].s = "NVDA";
  assert.throws(() => validateNvdaCandles(wrongMarket, NOW), /Unexpected/);
});

test("fetches 32 days of official hourly Hyperliquid data for both markets", async () => {
  const nvda = candlesFrom(Array.from({ length: 720 }, (_, index) => 220 + index * 0.004));
  const benchmark = candlesFrom(
    Array.from({ length: 720 }, (_, index) => 30_000 + index * 0.5),
    CLOSE1_BENCHMARK
  );
  const requests = [];
  const fetchMock = async (url, init) => {
    const body = JSON.parse(init.body);
    requests.push({ url, body });
    return Response.json(body.req.coin === CLOSE1_MARKET ? nvda : benchmark);
  };
  const result = await Promise.all([
    fetchNvdaCandles(fetchMock, NOW),
    fetchBenchmarkCandles(fetchMock, NOW)
  ]);
  assert.deepEqual(result.map((rows) => rows.length), [720, 720]);
  assert.deepEqual(requests.map(({ body }) => body.req.coin), [CLOSE1_MARKET, CLOSE1_BENCHMARK]);
  assert.ok(requests.every(({ url, body }) => (
    url === HYPERLIQUID_INFO_URL
      && body.req.interval === "1h"
      && body.req.startTime === NOW - 32 * 24 * HOUR_MS
      && body.req.endTime === NOW
  )));
});

test("holds until NVDA underperforms the benchmark by five points", () => {
  const nvda = Array.from({ length: 720 }, (_, index) => 220 + index * 0.01);
  const benchmark = Array.from({ length: 720 }, (_, index) => 30_000 + index * 1.4);
  const result = analyzeClose1Market(
    candlesFrom(nvda),
    candlesFrom(benchmark, CLOSE1_BENCHMARK),
    snapshot(nvda.at(-1).toFixed(2)),
    NOW
  );
  assert.equal(result.action, "hold");
  assert.equal(result.reason, "relative-gap-not-wide-enough");
  assert.equal(result.metrics.currentTop3Score, "89.32");
});

test("creates a half-balance long plan only for validated relative-value reversion", () => {
  const { nvda, benchmark } = candidateSeries();
  const result = analyzeClose1Market(
    candlesFrom(nvda),
    candlesFrom(benchmark, CLOSE1_BENCHMARK),
    snapshot(nvda.at(-1).toFixed(2)),
    NOW
  );
  assert.equal(result.action, "candidate");
  assert.equal(result.reason, "validated-relative-value-reversion");
  assert.equal(result.direction, "long");
  assert.ok(result.metrics.relativeGap168hPct <= -5);
  assert.ok(result.metrics.nvdaReturn672hPct > 0);
  assert.equal(result.riskPlan.allocation, 0.5);
  assert.ok(Number(result.riskPlan.notional) <= 5_000);
  assert.ok(Number(result.riskPlan.beatCurrentTop3Final) > nvda.at(-1));
});

test("holds if the long regime is not positive or the validated horizon has passed", () => {
  const benchmark = Array.from({ length: 720 }, (_, index) => 30_000 + index * 3);
  const falling = Array.from({ length: 720 }, (_, index) => 240 - index * 0.04);
  const regime = analyzeClose1Market(
    candlesFrom(falling),
    candlesFrom(benchmark, CLOSE1_BENCHMARK),
    snapshot(falling.at(-1).toFixed(2)),
    NOW
  );
  assert.equal(regime.action, "hold");
  assert.equal(regime.reason, "long-regime-not-positive");

  const { nvda } = candidateSeries();
  const lateNow = Date.parse("2026-10-02T10:00:01Z");
  const lateNvda = candlesFrom(nvda);
  const lateBenchmark = candlesFrom(benchmark, CLOSE1_BENCHMARK);
  const shift = lateNow - NOW;
  for (const candle of [...lateNvda, ...lateBenchmark]) {
    candle.t += shift;
    candle.T += shift;
  }
  const late = analyzeClose1Market(
    lateNvda,
    lateBenchmark,
    snapshot(nvda.at(-1).toFixed(2)),
    lateNow
  );
  assert.equal(late.action, "hold");
  assert.equal(late.reason, "outside-validated-entry-window");
});

test("blocks divergent prices, insufficient alignment, and allocations over the cap", () => {
  const { nvda, benchmark } = candidateSeries();
  const nvdaCandles = candlesFrom(nvda);
  const benchmarkCandles = candlesFrom(benchmark, CLOSE1_BENCHMARK);
  assert.deepEqual(
    analyzeClose1Market(nvdaCandles, benchmarkCandles, snapshot("200.00"), NOW),
    { action: "blocked", reason: "market-reference-divergence" }
  );
  const shifted = structuredClone(benchmarkCandles);
  shifted.forEach((candle) => {
    candle.t += 30 * 60 * 1000;
    candle.T += 30 * 60 * 1000;
  });
  assert.throws(
    () => analyzeClose1Market(nvdaCandles, shifted, snapshot(nvda.at(-1).toFixed(2)), NOW),
    /aligned/
  );
  assert.throws(() => sizeClose1Position({
    side: "long",
    entryPrice: "225",
    targetScore: "89.32",
    allocation: 0.51
  }), /risk cap/);
});
