const HOUR_MS = 60 * 60 * 1000;

export const CLOSE1_MARKET = "xyz:NVDA";
export const CLOSE1_BENCHMARK = "xyz:XYZ100";
export const HYPERLIQUID_INFO_URL = "https://api.hyperliquid.xyz/info";
export const CLOSE1_FINAL_AT = "2026-10-04T10:00:00.000Z";
export const CLOSE1_STARTING_BALANCE = 10_000;
export const CLOSE1_FEE_RATE = 0.01;
export const CLOSE1_MAX_ALLOCATION = 0.5;
export const CLOSE1_CONFIRMED_TARGET_ALLOCATION = 0.5;
export const CLOSE1_STAGE_ONE_ENTRY_HOURS = 207;
export const CLOSE1_TIME_BOXED_ENTRY_HOURS = 192;

const MIN_CANDLE_HISTORY = 700;
const RELATIVE_LOOKBACK_HOURS = 168;
const REGIME_LOOKBACK_HOURS = 672;
const RELATIVE_GAP_PCT = -5;
const MIN_ENTRY_HOURS = 96;
const MAX_ENTRY_HOURS = 216;

function finitePositive(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`Invalid ${label}`);
  return number;
}

function round(value, places = 6) {
  const scale = 10 ** places;
  return Math.round((value + Number.EPSILON) * scale) / scale;
}

function pct(current, previous) {
  return round((current / previous - 1) * 100);
}

export function validateHourlyCandles(candles, market, now = Date.now()) {
  if (!Array.isArray(candles) || candles.length < MIN_CANDLE_HISTORY) {
    throw new Error(`Insufficient ${market} candle history`);
  }
  let previousStart = -1;
  const parsed = candles.map((candle) => {
    if (candle?.s !== market || candle?.i !== "1h") throw new Error(`Unexpected ${market} candle market`);
    const start = Number(candle.t);
    const end = Number(candle.T);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start <= previousStart || end <= start) {
      throw new Error(`Invalid ${market} candle chronology`);
    }
    previousStart = start;
    const item = {
      start,
      end,
      open: finitePositive(candle.o, "candle open"),
      high: finitePositive(candle.h, "candle high"),
      low: finitePositive(candle.l, "candle low"),
      close: finitePositive(candle.c, "candle close"),
      volume: Number(candle.v)
    };
    if (!Number.isFinite(item.volume) || item.volume < 0 || item.low > item.high
      || item.open < item.low || item.open > item.high || item.close < item.low || item.close > item.high) {
      throw new Error(`Invalid ${market} candle values`);
    }
    return item;
  }).filter(({ start }) => start <= now + 5 * 60 * 1000);
  const latest = parsed.at(-1);
  if (!latest || now - latest.start > 2 * HOUR_MS) throw new Error(`Stale ${market} candle history`);
  return parsed;
}

export function validateNvdaCandles(candles, now = Date.now()) {
  return validateHourlyCandles(candles, CLOSE1_MARKET, now);
}

async function fetchHourlyCandles(market, fetchImpl = fetch, now = Date.now()) {
  const response = await fetchImpl(HYPERLIQUID_INFO_URL, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      type: "candleSnapshot",
      req: {
        coin: market,
        interval: "1h",
        startTime: now - 32 * 24 * HOUR_MS,
        endTime: now
      }
    })
  });
  if (!response.ok) throw new Error(`Hyperliquid ${market} candle read failed: ${response.status}`);
  const payload = await response.json();
  validateHourlyCandles(payload, market, now);
  return payload;
}

export function fetchNvdaCandles(fetchImpl = fetch, now = Date.now()) {
  return fetchHourlyCandles(CLOSE1_MARKET, fetchImpl, now);
}

export function fetchBenchmarkCandles(fetchImpl = fetch, now = Date.now()) {
  return fetchHourlyCandles(CLOSE1_BENCHMARK, fetchImpl, now);
}

export function sizeClose1Position({
  side,
  entryPrice,
  targetScore,
  balance = CLOSE1_STARTING_BALANCE,
  allocation = CLOSE1_MAX_ALLOCATION
}) {
  if (!new Set(["long", "short"]).has(side)) throw new Error("Invalid Close-1 side");
  const entry = finitePositive(entryPrice, "entry price");
  const score = Number(targetScore);
  const cash = finitePositive(balance, "balance");
  if (!Number.isFinite(score) || score < 0) throw new Error("Invalid target score");
  if (!Number.isFinite(allocation) || allocation <= 0 || allocation > CLOSE1_MAX_ALLOCATION) {
    throw new Error("Allocation exceeds Close-1 risk cap");
  }
  const quantity = Math.floor((cash * allocation) / (entry * (1 + CLOSE1_FEE_RATE)) * 100) / 100;
  if (quantity < 0.1) throw new Error("Allocation is below the Close-1 minimum quantity");
  const estimatedFee = quantity * entry * CLOSE1_FEE_RATE;
  const breakEven = side === "long" ? entry + estimatedFee / quantity : entry - estimatedFee / quantity;
  const beatTarget = side === "long"
    ? entry + (score + estimatedFee) / quantity
    : entry - (score + estimatedFee) / quantity;
  return {
    side,
    allocation,
    quantity: quantity.toFixed(2),
    notional: round(quantity * entry, 2).toFixed(2),
    estimatedFee: round(estimatedFee, 2).toFixed(2),
    breakEvenFinal: round(breakEven, 2).toFixed(2),
    beatCurrentTop3Final: round(beatTarget, 2).toFixed(2)
  };
}

function alignedHistory(nvdaCandles, benchmarkCandles, now) {
  const nvda = validateHourlyCandles(nvdaCandles, CLOSE1_MARKET, now);
  const benchmark = validateHourlyCandles(benchmarkCandles, CLOSE1_BENCHMARK, now);
  const byStart = new Map(benchmark.map((candle) => [candle.start, candle]));
  const aligned = nvda.filter(({ start }) => byStart.has(start)).map((candle) => ({
    start: candle.start,
    nvda: candle,
    benchmark: byStart.get(candle.start)
  }));
  if (aligned.length < MIN_CANDLE_HISTORY) throw new Error("Insufficient aligned Close-1 market history");
  return aligned;
}

export function analyzeClose1Market(nvdaCandles, benchmarkCandles, snapshot, now = Date.now()) {
  if (snapshot?.action !== "healthy" || !Number.isSafeInteger(snapshot?.sweep)) {
    return { action: "blocked", reason: "unhealthy-signed-snapshot" };
  }
  const history = alignedHistory(nvdaCandles, benchmarkCandles, now);
  const latest = history.at(-1);
  const nvdaLast = latest.nvda.close;
  const benchmarkLast = latest.benchmark.close;
  const signedReference = finitePositive(snapshot.reference, "signed reference");
  const divergencePct = Math.abs(nvdaLast / signedReference - 1) * 100;
  if (divergencePct > 1) return { action: "blocked", reason: "market-reference-divergence" };

  const relativeBase = history.at(-(RELATIVE_LOOKBACK_HOURS + 1));
  const regimeBase = history.at(-(REGIME_LOOKBACK_HOURS + 1));
  const nvdaRelativeReturn = pct(nvdaLast, relativeBase.nvda.close);
  const benchmarkRelativeReturn = pct(benchmarkLast, relativeBase.benchmark.close);
  const relativeGap = round(nvdaRelativeReturn - benchmarkRelativeReturn);
  const nvdaRegimeReturn = pct(nvdaLast, regimeBase.nvda.close);
  const remainingHours = (Date.parse(CLOSE1_FINAL_AT) - now) / HOUR_MS;
  const board = Array.isArray(snapshot.leaderboard) ? snapshot.leaderboard : [];
  const targetScore = Number(board[Math.min(2, board.length - 1)]?.[1] ?? 0);
  if (!Number.isFinite(targetScore) || targetScore < 0) {
    return { action: "blocked", reason: "invalid-signed-leaderboard" };
  }
  const metrics = {
    last: round(nvdaLast, 2).toFixed(2),
    benchmarkLast: round(benchmarkLast, 2).toFixed(2),
    signedReference: round(signedReference, 2).toFixed(2),
    nvdaReturn168hPct: nvdaRelativeReturn,
    benchmarkReturn168hPct: benchmarkRelativeReturn,
    relativeGap168hPct: relativeGap,
    nvdaReturn672hPct: nvdaRegimeReturn,
    remainingHours: round(remainingHours, 2),
    currentTop3Score: round(targetScore, 2).toFixed(2)
  };
  if (remainingHours < MIN_ENTRY_HOURS || remainingHours > MAX_ENTRY_HOURS) {
    return { action: "hold", reason: "outside-validated-entry-window", sweep: snapshot.sweep, metrics };
  }
  const primarySignal = nvdaRegimeReturn > 0 && relativeGap <= RELATIVE_GAP_PCT;
  const stagedEntry = remainingHours <= CLOSE1_STAGE_ONE_ENTRY_HOURS;
  const timeBoxedFallback = remainingHours <= CLOSE1_TIME_BOXED_ENTRY_HOURS;
  if (!primarySignal && !stagedEntry) {
    const reason = nvdaRegimeReturn <= 0
      ? "long-regime-not-positive"
      : "relative-gap-not-wide-enough";
    return { action: "hold", reason, sweep: snapshot.sweep, metrics };
  }
  return {
    action: "candidate",
    reason: primarySignal
      ? "validated-relative-value-reversion"
      : timeBoxedFallback
        ? "time-boxed-long-fallback"
        : "staged-long-entry",
    sweep: snapshot.sweep,
    direction: "long",
    metrics,
    riskPlan: sizeClose1Position({
      side: "long",
      entryPrice: signedReference,
      targetScore,
      allocation: primarySignal || timeBoxedFallback
        ? CLOSE1_MAX_ALLOCATION
        : CLOSE1_CONFIRMED_TARGET_ALLOCATION
    })
  };
}
