const HOUR_MS = 60 * 60 * 1000;

export const CLOSE1_MARKET = "xyz:NVDA";
export const HYPERLIQUID_INFO_URL = "https://api.hyperliquid.xyz/info";
export const CLOSE1_STARTING_BALANCE = 10_000;
export const CLOSE1_FEE_RATE = 0.01;
export const CLOSE1_MAX_INITIAL_ALLOCATION = 0.25;

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

function mean(values) {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function sampleStdDev(values) {
  if (values.length < 2) return 0;
  const average = mean(values);
  return Math.sqrt(values.reduce((total, value) => total + (value - average) ** 2, 0) / (values.length - 1));
}

export function validateNvdaCandles(candles, now = Date.now()) {
  if (!Array.isArray(candles) || candles.length < 96) throw new Error("Insufficient NVDA candle history");
  let previousStart = -1;
  return candles.map((candle) => {
    if (candle?.s !== CLOSE1_MARKET || candle?.i !== "1h") throw new Error("Unexpected NVDA candle market");
    const start = Number(candle.t);
    const end = Number(candle.T);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start <= previousStart || end <= start) {
      throw new Error("Invalid NVDA candle chronology");
    }
    previousStart = start;
    const parsed = {
      start,
      end,
      open: finitePositive(candle.o, "candle open"),
      high: finitePositive(candle.h, "candle high"),
      low: finitePositive(candle.l, "candle low"),
      close: finitePositive(candle.c, "candle close"),
      volume: Number(candle.v)
    };
    if (!Number.isFinite(parsed.volume) || parsed.volume < 0 || parsed.low > parsed.high
      || parsed.open < parsed.low || parsed.open > parsed.high || parsed.close < parsed.low || parsed.close > parsed.high) {
      throw new Error("Invalid NVDA candle values");
    }
    return parsed;
  }).filter(({ start }) => start <= now + 5 * 60 * 1000);
}

export async function fetchNvdaCandles(fetchImpl = fetch, now = Date.now()) {
  const response = await fetchImpl(HYPERLIQUID_INFO_URL, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      type: "candleSnapshot",
      req: {
        coin: CLOSE1_MARKET,
        interval: "1h",
        startTime: now - 7 * 24 * HOUR_MS,
        endTime: now
      }
    })
  });
  if (!response.ok) throw new Error(`Hyperliquid candle read failed: ${response.status}`);
  const payload = await response.json();
  const candles = validateNvdaCandles(payload, now);
  const latest = candles.at(-1);
  if (!latest || now - latest.start > 2 * HOUR_MS) throw new Error("Stale NVDA candle history");
  return payload;
}

export function sizeClose1Position({
  side,
  entryPrice,
  targetScore,
  balance = CLOSE1_STARTING_BALANCE,
  allocation = CLOSE1_MAX_INITIAL_ALLOCATION
}) {
  if (!new Set(["long", "short"]).has(side)) throw new Error("Invalid Close-1 side");
  const entry = finitePositive(entryPrice, "entry price");
  const score = Number(targetScore);
  const cash = finitePositive(balance, "balance");
  if (!Number.isFinite(score) || score < 0) throw new Error("Invalid target score");
  if (!Number.isFinite(allocation) || allocation <= 0 || allocation > CLOSE1_MAX_INITIAL_ALLOCATION) {
    throw new Error("Initial allocation exceeds Close-1 risk cap");
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

export function analyzeClose1Market(candles, snapshot) {
  if (snapshot?.action !== "healthy" || !Number.isSafeInteger(snapshot?.sweep)) {
    return { action: "blocked", reason: "unhealthy-signed-snapshot" };
  }
  const parsed = validateNvdaCandles(candles);
  const closes = parsed.map(({ close }) => close);
  const latest = closes.at(-1);
  const signedReference = finitePositive(snapshot.reference, "signed reference");
  const divergencePct = Math.abs(latest / signedReference - 1) * 100;
  if (divergencePct > 1) return { action: "blocked", reason: "market-reference-divergence" };

  const sma = (period) => mean(closes.slice(-period));
  const hourlyReturns = closes.slice(1).map((close, index) => Math.log(close / closes[index]));
  const return24h = pct(latest, closes.at(-25));
  const return72h = pct(latest, closes.at(-73));
  const sma24 = sma(24);
  const sma72 = sma(72);
  const bullish = return24h >= 1 && return72h >= 2 && latest > sma24 && sma24 > sma72;
  const bearish = return24h <= -1 && return72h <= -2 && latest < sma24 && sma24 < sma72;
  const direction = bullish ? "long" : bearish ? "short" : null;
  const board = Array.isArray(snapshot.leaderboard) ? snapshot.leaderboard : [];
  const targetScore = Number(board[Math.min(2, board.length - 1)]?.[1] ?? 0);
  if (!Number.isFinite(targetScore) || targetScore < 0) {
    return { action: "blocked", reason: "invalid-signed-leaderboard" };
  }
  const metrics = {
    last: round(latest, 2).toFixed(2),
    signedReference: round(signedReference, 2).toFixed(2),
    return24hPct: return24h,
    return72hPct: return72h,
    sma24: round(sma24, 2).toFixed(2),
    sma72: round(sma72, 2).toFixed(2),
    sevenDayHigh: round(Math.max(...parsed.map(({ high }) => high)), 2).toFixed(2),
    sevenDayLow: round(Math.min(...parsed.map(({ low }) => low)), 2).toFixed(2),
    hourlyVolatilityPct: round(sampleStdDev(hourlyReturns) * 100),
    currentTop3Score: round(targetScore, 2).toFixed(2)
  };
  if (!direction) return { action: "hold", reason: "mixed-trend", sweep: snapshot.sweep, metrics };
  return {
    action: "candidate",
    reason: "aligned-24h-72h-trend",
    sweep: snapshot.sweep,
    direction,
    metrics,
    riskPlan: sizeClose1Position({ side: direction, entryPrice: signedReference, targetScore })
  };
}
