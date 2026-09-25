import {
  CLOSE1_AGENT_DID,
  CLOSE1_CONTROL_ROOM,
  CLOSE1_LOCK_AT,
  CLOSE1_LOCK_SWEEP,
  CLOSE1_REFEREE_DID,
  CLOSE1_SEASON,
  CLOSE1_TRADING_ROOM,
  publishSignedRecord,
  signClose1Payload,
  verifyDidSignature,
  verifySignedRecord
} from "./close1-protocol.mjs";

const DEFAULT_BASE_URL = "https://technocore.chat";
const DID = /^did:key:z6Mk[1-9A-HJ-NP-Za-km-z]{44}$/;
const TRADE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const AMOUNT = /^[0-9]{1,7}(?:\.[0-9]{1,2})?$/;
const SIGNATURE = /^[A-Za-z0-9_-]{86}$/;
const MAX_PUBLIC_MESSAGES = 200;
const MAX_JOURNAL_BYTES = 256_000;
const OFFER_MAX_AGE_MS = 12 * 60 * 1000;
const MAX_PRICE_SLIPPAGE = 0.0025;
const MAX_INITIAL_NOTIONAL = 5_000;
const OUTCOME_LOOKBACK = 200;
const MAKER_OFFER_LIFETIME_SWEEPS = 2;
export const CLOSE1_PROFIT_LOCK_PCT = 3;

function positiveAmount(value) {
  if (typeof value !== "string" || !AMOUNT.test(value)) return null;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function timestampMs(record) {
  const value = record?.ts ?? record?.at ?? record?.timestamp;
  const number = Number(value);
  if (Number.isFinite(number)) return number < 10_000_000_000 ? number * 1000 : number;
  return Date.parse(String(value || ""));
}

function fixed2(value) {
  return (Math.floor((Number(value) + Number.EPSILON) * 100) / 100).toFixed(2);
}

function opposite(side) {
  return side === "buy" ? "short" : side === "sell" ? "long" : null;
}

function makerDirection(side) {
  return side === "buy" ? "long" : side === "sell" ? "short" : null;
}

async function readJson(url, fetchImpl) {
  const response = await fetchImpl(url, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`Close-1 read failed: ${response.status}`);
  return response.json();
}

async function readJournal(baseUrl, fetchImpl, now) {
  const response = await fetchImpl(`${baseUrl}/r/${CLOSE1_CONTROL_ROOM}/export?n=${now}`, {
    headers: { accept: "application/x-ndjson" }
  });
  if (!response.ok) throw new Error(`Close-1 journal read failed: ${response.status}`);
  const text = await response.text();
  if (text.length > MAX_JOURNAL_BYTES) throw new Error("Close-1 journal exceeds safe size");
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  if (lines.length > 200) throw new Error("Close-1 journal exceeds safe record count");
  const records = [];
  for (const line of lines) {
    let record;
    try { record = JSON.parse(line); } catch { throw new Error("Close-1 journal contains invalid JSON"); }
    if (record?.from !== CLOSE1_AGENT_DID) continue;
    if (!await verifySignedRecord(CLOSE1_CONTROL_ROOM, record, CLOSE1_AGENT_DID).catch(() => false)) continue;
    let body;
    try { body = JSON.parse(record.text); } catch { continue; }
    records.push({ record, body });
  }
  return records;
}

export function canonicalClose1Terms(terms) {
  if (!terms || typeof terms !== "object" || Array.isArray(terms)) throw new Error("Invalid Close-1 terms");
  const expected = ["id", "maker", "px", "qty", "side", "taker", "until"];
  const keys = Object.keys(terms).sort();
  if (JSON.stringify(keys) !== JSON.stringify(expected)) throw new Error("Unexpected Close-1 term keys");
  if (!TRADE_ID.test(terms.id) || !DID.test(terms.maker)) throw new Error("Invalid Close-1 identity terms");
  if (positiveAmount(terms.px) === null || positiveAmount(terms.qty) === null || Number(terms.qty) < 0.1) {
    throw new Error("Invalid Close-1 amount terms");
  }
  if (!new Set(["buy", "sell"]).has(terms.side)) throw new Error("Invalid Close-1 side");
  if (!(terms.taker === "any" || DID.test(terms.taker))) throw new Error("Invalid Close-1 taker");
  if (!Number.isSafeInteger(terms.until) || terms.until < 1 || terms.until > CLOSE1_LOCK_SWEEP) {
    throw new Error("Invalid Close-1 expiry");
  }
  return JSON.stringify({
    id: terms.id,
    maker: terms.maker,
    px: terms.px,
    qty: terms.qty,
    side: terms.side,
    taker: terms.taker,
    until: terms.until
  });
}

export async function verifyClose1Offer(room, record, snapshot, ownerDids, now = Date.now()) {
  let body;
  try { body = JSON.parse(record?.text); } catch { return null; }
  if (body?.t !== "offer" || body?.season !== CLOSE1_SEASON || !SIGNATURE.test(body?.maker_sig || "")) return null;
  let termsText;
  try { termsText = canonicalClose1Terms(body.terms); } catch { return null; }
  const terms = body.terms;
  if (terms.maker !== record?.from || terms.maker === CLOSE1_AGENT_DID || !ownerDids.has(terms.maker)) return null;
  if (!(terms.taker === "any" || terms.taker === CLOSE1_AGENT_DID)) return null;
  if (!await verifySignedRecord(room, record, terms.maker).catch(() => false)) return null;
  if (!await verifyDidSignature(`close-1|terms|${termsText}`, body.maker_sig, terms.maker).catch(() => false)) return null;
  const age = now - timestampMs(record);
  if (!Number.isFinite(age) || age < 0 || age > OFFER_MAX_AGE_MS) return null;
  if (!Number.isSafeInteger(snapshot?.sweep) || terms.until < snapshot.sweep + 1) return null;
  const px = positiveAmount(terms.px);
  const qty = positiveAmount(terms.qty);
  const limits = snapshot?.limits?.map(Number);
  if (!limits || limits.length !== 2 || !limits.every(Number.isFinite) || px < limits[0] || px > limits[1]) return null;
  return { room, record, body, terms, termsText, px, qty, takerDirection: opposite(terms.side) };
}

export function selectClose1Offer(offers, {
  direction,
  reference,
  remainingQty,
  remainingNotional = Number.POSITIVE_INFINITY,
  knownIds = new Set()
}) {
  const ref = Number(reference);
  const remaining = Number(remainingQty);
  if (!new Set(["long", "short"]).has(direction) || !Number.isFinite(ref) || ref <= 0
    || !Number.isFinite(remaining) || remaining < 0.1) return null;
  const eligible = offers.filter((offer) => {
    if (offer.takerDirection !== direction || knownIds.has(offer.terms.id)) return false;
    if (offer.qty > remaining + 1e-9) return false;
    if (offer.qty * offer.px * 1.01 > remainingNotional + 1e-9) return false;
    if (direction === "long" && offer.px > ref * (1 + MAX_PRICE_SLIPPAGE)) return false;
    if (direction === "short" && offer.px < ref * (1 - MAX_PRICE_SLIPPAGE)) return false;
    return true;
  });
  eligible.sort((left, right) => {
    const price = direction === "long" ? left.px - right.px : right.px - left.px;
    return price || right.qty - left.qty || Number(left.record.seq) - Number(right.record.seq);
  });
  return eligible[0] || null;
}

async function verifiedPublicOffers(baseUrl, fetchImpl, snapshot, now) {
  const payload = await readJson(
    `${baseUrl}/r/${CLOSE1_TRADING_ROOM}?limit=${MAX_PUBLIC_MESSAGES}&format=json&n=${now}`,
    fetchImpl
  );
  const records = Array.isArray(payload?.messages) ? payload.messages : [];
  const ownerDids = new Set();
  for (const record of records) {
    let body;
    try { body = JSON.parse(record?.text); } catch { continue; }
    if (body?.t !== "owner" || body?.season !== CLOSE1_SEASON || body?.key !== record?.from || !DID.test(body.key)) continue;
    if (await verifySignedRecord(CLOSE1_TRADING_ROOM, record, body.key).catch(() => false)) ownerDids.add(body.key);
  }
  const offers = [];
  for (const record of records) {
    const offer = await verifyClose1Offer(CLOSE1_TRADING_ROOM, record, snapshot, ownerDids, now);
    if (offer) offers.push(offer);
  }
  return offers;
}

async function verifiedFlows(baseUrl, fetchImpl, now) {
  const payload = await readJson(
    `${baseUrl}/r/d-close1-flow?limit=${OUTCOME_LOOKBACK}&format=json&n=${now}`,
    fetchImpl
  );
  const flows = [];
  for (const record of payload?.messages || []) {
    if (!await verifySignedRecord("d-close1-flow", record, CLOSE1_REFEREE_DID).catch(() => false)) continue;
    let body;
    try { body = JSON.parse(record.text); } catch { continue; }
    if (body?.t !== "flow" || !Number.isSafeInteger(body?.n) || !/^[a-f0-9]{64}$/.test(body?.file || "")) continue;
    flows.push(body);
  }
  return flows.sort((left, right) => left.n - right.n);
}

async function ownActions(journal) {
  const actions = [];
  for (const { record, body } of journal) {
    if (body?.season !== CLOSE1_SEASON || !new Set(["offer", "trade"]).has(body?.t)) continue;
    let termsText;
    try { termsText = canonicalClose1Terms(body.terms); } catch { continue; }
    if (!SIGNATURE.test(body?.maker_sig || "")) continue;
    const makerValid = await verifyDidSignature(
      `close-1|terms|${termsText}`,
      body.maker_sig,
      body.terms.maker
    ).catch(() => false);
    if (!makerValid) continue;
    if (body.t === "offer" && body.terms.maker === CLOSE1_AGENT_DID) {
      actions.push({ record, body, termsText, role: "maker", direction: makerDirection(body.terms.side) });
    } else if (body.t === "trade" && body.taker === CLOSE1_AGENT_DID && SIGNATURE.test(body?.taker_sig || "")) {
      const takerValid = await verifyDidSignature(
        `close-1|accept|${termsText}|${CLOSE1_AGENT_DID}`,
        body.taker_sig,
        CLOSE1_AGENT_DID
      ).catch(() => false);
      if (!takerValid) continue;
      actions.push({ record, body, termsText, role: "taker", direction: opposite(body.terms.side) });
    }
  }
  return actions;
}

function outcomeNotes(journal) {
  const outcomes = new Map();
  for (const { body } of journal) {
    if (body?.type !== "close1.trade.outcome.v1" || body?.season !== CLOSE1_SEASON || body?.did !== CLOSE1_AGENT_DID) continue;
    if (!TRADE_ID.test(body?.trade_id || "") || !new Set(["settled", "void"]).has(body?.outcome)
      || !Number.isSafeInteger(body?.sweep) || !/^[a-f0-9]{64}$/.test(body?.flow_file || "")) continue;
    outcomes.set(body.trade_id, body);
  }
  return outcomes;
}

function findFlowOutcome(flows, action) {
  const tradeId = action.body.terms.id;
  if (action.role === "maker") {
    // A failed acceptance does not close an open offer. Only a settlement is
    // terminal for the maker; unmatched offers simply expire.
    const settled = flows.find((flow) => Array.isArray(flow.settled) && flow.settled.includes(tradeId));
    return settled ? { outcome: "settled", sweep: settled.n, flow_file: settled.file } : null;
  }
  for (const flow of flows) {
    const settled = Array.isArray(flow.settled) && flow.settled.includes(tradeId);
    const item = Array.isArray(flow.void)
      ? flow.void.find((entry) => Array.isArray(entry) && entry[0] === tradeId)
      : null;
    // Summary omission or competing accepts can make the owner of a settled
    // id ambiguous. Never invent our position from that evidence.
    if (settled && (item || Number(flow?.omitted?.void || 0) > 0)) return null;
    if (item) return { outcome: "void", reason: String(item[1] || "unknown"), sweep: flow.n, flow_file: flow.file };
    if (settled) return { outcome: "settled", sweep: flow.n, flow_file: flow.file };
  }
  return null;
}

function outcomeText(action, outcome) {
  return JSON.stringify({
    type: "close1.trade.outcome.v1",
    season: CLOSE1_SEASON,
    did: CLOSE1_AGENT_DID,
    trade_id: action.body.terms.id,
    role: action.role,
    direction: action.direction,
    qty: action.body.terms.qty,
    px: action.body.terms.px,
    outcome: outcome.outcome,
    ...(outcome.reason ? { reason: outcome.reason } : {}),
    sweep: outcome.sweep,
    flow_file: outcome.flow_file
  });
}

function visibleOfferIds(journal) {
  return new Set(journal.filter(({ body }) =>
    body?.type === "close1.offer.visible.v1"
      && body?.season === CLOSE1_SEASON
      && body?.did === CLOSE1_AGENT_DID
      && TRADE_ID.test(body?.trade_id || "")
      && Number.isSafeInteger(body?.public_seq)
  ).map(({ body }) => body.trade_id));
}

function visibilityText(action, publicRecord) {
  return JSON.stringify({
    type: "close1.offer.visible.v1",
    season: CLOSE1_SEASON,
    did: CLOSE1_AGENT_DID,
    trade_id: action.body.terms.id,
    public_seq: Number(publicRecord.seq),
    public_nonce: String(publicRecord.nonce),
    public_sig: publicRecord.sig
  });
}

async function publishOfferVisibility(action, env, fetchImpl, now) {
  const publicRecord = await publishSignedRecord(
    CLOSE1_TRADING_ROOM,
    action.record.text,
    env,
    fetchImpl,
    Math.max(Math.trunc(now), Number(action.record.nonce) + 1)
  );
  const marker = await publishSignedRecord(
    CLOSE1_CONTROL_ROOM,
    visibilityText(action, publicRecord),
    env,
    fetchImpl,
    Math.max(Math.trunc(now) + 1, Number(publicRecord.nonce) + 1)
  );
  return { publicSeq: Number(publicRecord.seq), markerSeq: Number(marker.seq) };
}

async function reconcileOutcomes(journal, flows, snapshot, env, fetchImpl, now) {
  const actions = await ownActions(journal);
  const outcomes = outcomeNotes(journal);
  const newlySettled = [];
  let nonce = Math.trunc(now);
  for (const action of actions) {
    const id = action.body.terms.id;
    if (outcomes.has(id)) continue;
    const found = findFlowOutcome(flows, action);
    if (!found) continue;
    const note = await publishSignedRecord(
      CLOSE1_CONTROL_ROOM,
      outcomeText(action, found),
      env,
      fetchImpl,
      nonce
    );
    nonce = Math.max(nonce + 1, Number(note.nonce) + 1);
    const body = JSON.parse(note.text);
    outcomes.set(id, body);
    if (found.outcome === "settled") newlySettled.push(id);
  }

  const unresolved = actions.filter((action) => !outcomes.has(action.body.terms.id));
  // An unmatched maker offer is ordinary negotiation and never appears in the
  // referee flow. A countersigned taker trade, by contrast, must receive a
  // settled/void result; losing that outcome makes our position unknowable.
  const dangerouslyOld = unresolved.find((action) =>
    action.role === "taker" && snapshot.sweep > action.body.terms.until + 2
  );
  return { actions, outcomes, unresolved, dangerouslyOld, newlySettled };
}

function positionFrom(actions, outcomes) {
  let position = 0;
  const used = new Set();
  for (const action of actions) {
    const id = action.body.terms.id;
    if (used.has(id) || outcomes.get(id)?.outcome !== "settled") continue;
    used.add(id);
    const quantity = Number(action.body.terms.qty);
    position += action.direction === "long" ? quantity : -quantity;
  }
  return Math.round(position * 100) / 100;
}

export function close1ProfitLockPlan(actions, outcomes, position, reference) {
  const mark = Number(reference);
  if (!Array.isArray(actions) || !(outcomes instanceof Map) || !Number.isFinite(mark) || mark <= 0) {
    return { action: "blocked", reason: "invalid-profit-lock-input" };
  }
  const settled = actions.filter((action) => outcomes.get(action?.body?.terms?.id)?.outcome === "settled");
  if (settled.some((action) => action.direction === "short")) {
    return { action: "closed", reason: "profit-lock-complete" };
  }
  if (!Number.isFinite(position) || position <= 0) return { action: "hold", reason: "no-long-position" };
  const longs = settled.filter((action) => action.direction === "long");
  const quantity = longs.reduce((total, action) => total + Number(action.body.terms.qty), 0);
  const notional = longs.reduce((total, action) =>
    total + Number(action.body.terms.qty) * Number(action.body.terms.px), 0);
  if (!Number.isFinite(quantity) || !Number.isFinite(notional) || quantity <= 0
    || Math.abs(quantity - position) > 0.011) {
    return { action: "blocked", reason: "unreconciled-profit-lock-position" };
  }
  const averageEntry = notional / quantity;
  const triggerPrice = Math.ceil((averageEntry * (1 + CLOSE1_PROFIT_LOCK_PCT / 100) - Number.EPSILON) * 100) / 100;
  if (mark + 1e-9 < triggerPrice) {
    return {
      action: "hold",
      reason: "profit-lock-not-reached",
      averageEntry: fixed2(averageEntry),
      triggerPrice: fixed2(triggerPrice)
    };
  }
  return {
    action: "close",
    reason: "three-percent-profit-lock",
    quantity: fixed2(position),
    averageEntry: fixed2(averageEntry),
    triggerPrice: fixed2(triggerPrice)
  };
}

function makeOfferTerms(snapshot, direction, quantity) {
  const suffix = direction === "long" ? "l" : "s";
  const random = new Uint8Array(6);
  crypto.getRandomValues(random);
  const tag = [...random].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return {
    id: `mb${snapshot.sweep}${suffix}${tag}`,
    maker: CLOSE1_AGENT_DID,
    px: Number(snapshot.reference).toFixed(2),
    qty: fixed2(quantity),
    side: direction === "long" ? "buy" : "sell",
    taker: "any",
    until: Math.min(snapshot.sweep + MAKER_OFFER_LIFETIME_SWEEPS, CLOSE1_LOCK_SWEEP)
  };
}

export async function advanceClose1Trading(env, snapshot, strategy, roomRegistration, options = {}) {
  if (String(env?.CLOSE1_TRADING_ENABLED || "").toLowerCase() !== "true") return { action: "disabled" };
  if (snapshot?.action !== "healthy" || !Number.isSafeInteger(snapshot?.sweep)) {
    return { action: "blocked", reason: "unhealthy-signed-snapshot" };
  }
  if (snapshot.tradingEnabled !== true) return { action: "blocked", reason: "snapshot-trading-disabled" };
  if (roomRegistration?.action !== "ready") return { action: "blocked", reason: "trading-room-not-ready" };
  const now = Number(options.now || Date.now());
  if (!Number.isFinite(now) || now >= Date.parse(CLOSE1_LOCK_AT) || snapshot.sweep >= CLOSE1_LOCK_SWEEP) {
    return { action: "blocked", reason: "contest-locked" };
  }
  const fetchImpl = options.fetch || fetch;
  const baseUrl = env.TECHNOCORE_URL || DEFAULT_BASE_URL;
  const journal = await readJournal(baseUrl, fetchImpl, now);
  const flows = await verifiedFlows(baseUrl, fetchImpl, now);
  const ledger = await reconcileOutcomes(journal, flows, snapshot, env, fetchImpl, now);
  if (ledger.dangerouslyOld) return { action: "blocked", reason: "unresolved-trade-outcome" };

  const position = positionFrom(ledger.actions, ledger.outcomes);
  const visible = visibleOfferIds(journal);
  const activeOffer = ledger.unresolved.find((action) =>
    action.role === "maker" && action.body.terms.until >= snapshot.sweep + 1
  );
  if (activeOffer) {
    if (!visible.has(activeOffer.body.terms.id)) {
      const visibility = await publishOfferVisibility(activeOffer, env, fetchImpl, now);
      return { action: "offer-visible", tradeId: activeOffer.body.terms.id, position, ...visibility };
    }
    return { action: "waiting-offer", tradeId: activeOffer.body.terms.id, position };
  }
  const pendingTrade = ledger.unresolved.find((action) => action.role === "taker");
  if (pendingTrade) return { action: "waiting-trade", tradeId: pendingTrade.body.terms.id, position };

  const profitLock = close1ProfitLockPlan(ledger.actions, ledger.outcomes, position, snapshot.reference);
  if (profitLock.action === "blocked") {
    return { action: "blocked", reason: profitLock.reason, position };
  }
  if (profitLock.action === "closed") {
    return { action: "hold", reason: profitLock.reason, position };
  }
  if (profitLock.action === "close") {
    const terms = makeOfferTerms(snapshot, "short", position);
    const termsText = canonicalClose1Terms(terms);
    const makerSig = await signClose1Payload(`close-1|terms|${termsText}`, env);
    const offerText = JSON.stringify({ t: "offer", season: CLOSE1_SEASON, terms, maker_sig: makerSig });
    const journalRecord = await publishSignedRecord(CLOSE1_CONTROL_ROOM, offerText, env, fetchImpl, Math.trunc(now));
    const visibility = await publishOfferVisibility(
      { record: journalRecord, body: JSON.parse(offerText) },
      env,
      fetchImpl,
      Math.max(Math.trunc(now) + 1, Number(journalRecord.nonce) + 1)
    );
    return {
      action: "profit-lock-offer-posted",
      role: "maker",
      tradeId: terms.id,
      direction: "short",
      qty: terms.qty,
      px: terms.px,
      until: terms.until,
      position,
      averageEntry: profitLock.averageEntry,
      triggerPrice: profitLock.triggerPrice,
      ...visibility
    };
  }
  if (strategy?.action !== "candidate") {
    return { action: "hold", reason: strategy?.reason || "no-strategy-candidate", position };
  }
  if (strategy.sweep !== snapshot.sweep) return { action: "blocked", reason: "stale-strategy-sweep", position };
  const direction = strategy.direction;
  if (!new Set(["long", "short"]).has(direction)) return { action: "blocked", reason: "invalid-strategy-direction" };
  if ((position > 0 && direction === "short") || (position < 0 && direction === "long")) {
    return { action: "blocked", reason: "position-direction-conflict", position };
  }
  const reference = Number(snapshot.reference);
  const requestedTarget = Number(strategy?.riskPlan?.quantity);
  const hardTarget = Math.floor(MAX_INITIAL_NOTIONAL / (reference * 1.01) * 100) / 100;
  if (!Number.isFinite(requestedTarget) || requestedTarget < 0.1 || requestedTarget > hardTarget + 1e-9) {
    return { action: "blocked", reason: "strategy-risk-cap-violation", position };
  }
  const directionalPosition = direction === "long" ? position : -position;
  const remainingQty = Math.floor((requestedTarget - Math.max(0, directionalPosition) + Number.EPSILON) * 100) / 100;
  if (remainingQty < 0.1) return { action: "position-ready", direction, position, targetQty: requestedTarget };

  const knownIds = new Set([
    ...ledger.actions.map((action) => action.body.terms.id),
    ...ledger.outcomes.keys(),
    ...flows.flatMap((flow) => [
      ...(Array.isArray(flow.settled) ? flow.settled : []),
      ...(Array.isArray(flow.void) ? flow.void.map((entry) => Array.isArray(entry) ? entry[0] : null) : [])
    ]).filter(Boolean)
  ]);
  const committedNotional = ledger.actions.reduce((total, action) => {
    if (ledger.outcomes.get(action.body.terms.id)?.outcome !== "settled") return total;
    return total + Number(action.body.terms.qty) * Number(action.body.terms.px) * 1.01;
  }, 0);
  const remainingNotional = Math.max(0, MAX_INITIAL_NOTIONAL - committedNotional);
  const offers = await verifiedPublicOffers(baseUrl, fetchImpl, snapshot, now);
  const selected = selectClose1Offer(offers, {
    direction,
    reference,
    remainingQty,
    remainingNotional,
    knownIds
  });
  if (selected && String(env.CLOSE1_TAKER_ENABLED || "").toLowerCase() === "true") {
    const takerSig = await signClose1Payload(
      `close-1|accept|${selected.termsText}|${CLOSE1_AGENT_DID}`,
      env
    );
    const tradeText = JSON.stringify({
      t: "trade",
      season: CLOSE1_SEASON,
      terms: selected.terms,
      taker: CLOSE1_AGENT_DID,
      maker_sig: selected.body.maker_sig,
      taker_sig: takerSig
    });
    const posted = await publishSignedRecord(CLOSE1_CONTROL_ROOM, tradeText, env, fetchImpl, Math.trunc(now));
    return {
      action: "trade-posted",
      role: "taker",
      tradeId: selected.terms.id,
      direction,
      qty: selected.terms.qty,
      px: selected.terms.px,
      seq: Number(posted.seq),
      position
    };
  }

  const offerQty = Math.floor(Math.min(remainingQty, remainingNotional / (reference * 1.01)) * 100) / 100;
  if (offerQty < 0.1) return { action: "position-ready", direction, position, targetQty: requestedTarget };
  const terms = makeOfferTerms(snapshot, direction, offerQty);
  const termsText = canonicalClose1Terms(terms);
  const makerSig = await signClose1Payload(`close-1|terms|${termsText}`, env);
  const offerText = JSON.stringify({ t: "offer", season: CLOSE1_SEASON, terms, maker_sig: makerSig });
  const journalRecord = await publishSignedRecord(CLOSE1_CONTROL_ROOM, offerText, env, fetchImpl, Math.trunc(now));
  const visibility = await publishOfferVisibility(
    { record: journalRecord, body: JSON.parse(offerText) },
    env,
    fetchImpl,
    Math.max(Math.trunc(now) + 1, Number(journalRecord.nonce) + 1)
  );
  return {
    action: "offer-posted",
    role: "maker",
    tradeId: terms.id,
    direction,
    qty: terms.qty,
    px: terms.px,
    until: terms.until,
    journalSeq: Number(journalRecord.seq),
    position,
    ...visibility
  };
}
