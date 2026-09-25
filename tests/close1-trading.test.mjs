import test from "node:test";
import assert from "node:assert/strict";

import {
  CLOSE1_AGENT_DID,
  CLOSE1_REFEREE_DID
} from "../src/close1-protocol.mjs";
import {
  advanceClose1Trading,
  canonicalClose1Terms,
  close1ProfitLockPlan,
  selectClose1Offer,
  verifyClose1Offer
} from "../src/close1-trading.mjs";

const NOW = Date.parse("2026-09-25T17:36:00Z");
const FLOW = {
  seq: 66,
  ts: "2026-09-25T17:31:15.701993Z",
  from: CLOSE1_REFEREE_DID,
  text: "{\"file\":\"674d7a0c03b3a5392d0ef42055620e03198d1e6eebd733dc4cb2c4d0274a29fc\",\"mints\":[],\"missed\":[],\"n\":66,\"rooms\":[],\"settled\":[],\"t\":\"flow\",\"void\":[]}",
  nonce: 1790357474910,
  sig: "G-v95okSmy1RZ9O1FoKXLoWx2fj0tiRNNiY1pgtd1uR4LP7w99UnF4uAq656L-yO-XUS-Y0JN_Kxb0y8GdoxDw"
};

function base58(bytes) {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let index = 0; index < digits.length; index += 1) {
      carry += digits[index] << 8;
      digits[index] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  let output = "";
  for (const byte of bytes) {
    if (byte !== 0) break;
    output += "1";
  }
  return output + digits.reverse().map((digit) => alphabet[digit]).join("");
}

async function identity() {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  return { pair, did: `did:key:z${base58(Uint8Array.from([0xed, 0x01, ...raw]))}` };
}

async function signature(privateKey, payload) {
  const bytes = new Uint8Array(await crypto.subtle.sign("Ed25519", privateKey, new TextEncoder().encode(payload)));
  return Buffer.from(bytes).toString("base64url");
}

function snapshot() {
  return {
    action: "healthy",
    sweep: 66,
    reference: "225.11",
    limits: ["213.86", "236.36"],
    tradingEnabled: true
  };
}

async function signedRecord(room, identityValue, text, nonce = 1234) {
  return {
    seq: nonce,
    ts: new Date(NOW - 60_000).toISOString(),
    from: identityValue.did,
    text,
    nonce,
    sig: await signature(identityValue.pair.privateKey, `${room}|${nonce}|${text}`)
  };
}

async function offerFixture(overrides = {}) {
  const maker = await identity();
  const terms = {
    id: "offer-1",
    maker: maker.did,
    px: "225.00",
    qty: "0.50",
    side: "sell",
    taker: "any",
    until: 70,
    ...overrides
  };
  const termsText = canonicalClose1Terms(terms);
  const makerSig = await signature(maker.pair.privateKey, `close-1|terms|${termsText}`);
  const text = JSON.stringify({ t: "offer", season: "close-1", terms, maker_sig: makerSig });
  return { maker, terms, record: await signedRecord("close1", maker, text) };
}

test("canonicalizes only exact protocol trade terms", () => {
  const terms = {
    id: "abc-1",
    maker: CLOSE1_AGENT_DID,
    px: "225.10",
    qty: "1.25",
    side: "buy",
    taker: "any",
    until: 70
  };
  assert.equal(
    canonicalClose1Terms(terms),
    `{"id":"abc-1","maker":"${CLOSE1_AGENT_DID}","px":"225.10","qty":"1.25","side":"buy","taker":"any","until":70}`
  );
  assert.throws(() => canonicalClose1Terms({ ...terms, extra: true }), /Unexpected/);
  assert.throws(() => canonicalClose1Terms({ ...terms, qty: "0.09" }), /amount/);
  assert.throws(() => canonicalClose1Terms({ ...terms, until: 2557 }), /expiry/);
});

test("accepts only fresh, owner-proven, doubly signed public offers", async () => {
  const fixture = await offerFixture();
  const valid = await verifyClose1Offer("close1", fixture.record, snapshot(), new Set([fixture.maker.did]), NOW);
  assert.equal(valid?.terms.id, "offer-1");
  assert.equal(valid?.takerDirection, "long");

  assert.equal(await verifyClose1Offer("close1", fixture.record, snapshot(), new Set(), NOW), null);
  const tampered = structuredClone(fixture.record);
  tampered.text = tampered.text.replace('"225.00"', '"224.00"');
  assert.equal(await verifyClose1Offer("close1", tampered, snapshot(), new Set([fixture.maker.did]), NOW), null);
  const stale = { ...fixture.record, ts: new Date(NOW - 13 * 60_000).toISOString() };
  assert.equal(await verifyClose1Offer("close1", stale, snapshot(), new Set([fixture.maker.did]), NOW), null);
});

test("selects price-compatible offers without exceeding the remaining cap", async () => {
  const low = await offerFixture({ id: "low", px: "224.90", qty: "0.50" });
  const high = await offerFixture({ id: "high", px: "225.20", qty: "0.80" });
  const oversized = await offerFixture({ id: "large", px: "224.00", qty: "5.00" });
  const parsed = await Promise.all([low, high, oversized].map((fixture) =>
    verifyClose1Offer("close1", fixture.record, snapshot(), new Set([fixture.maker.did]), NOW)
  ));
  assert.equal(selectClose1Offer(parsed, {
    direction: "long",
    reference: "225.11",
    remainingQty: 1,
    knownIds: new Set()
  })?.terms.id, "low");
  assert.equal(selectClose1Offer(parsed, {
    direction: "long",
    reference: "225.11",
    remainingQty: 1,
    knownIds: new Set(["low"])
  })?.terms.id, "high");
  assert.equal(selectClose1Offer(parsed, {
    direction: "long",
    reference: "225.11",
    remainingQty: 1,
    remainingNotional: 100,
    knownIds: new Set()
  }), null);
});

test("locks a settled long at a three-percent price gain regardless of leaderboard score", () => {
  const long = {
    direction: "long",
    body: { terms: { id: "long-1", qty: "11.01", px: "224.71" } }
  };
  const outcomes = new Map([["long-1", { outcome: "settled" }]]);
  assert.deepEqual(close1ProfitLockPlan([long], outcomes, 11.01, "231.45"), {
    action: "hold",
    reason: "profit-lock-not-reached",
    averageEntry: "224.71",
    triggerPrice: "231.46"
  });
  assert.deepEqual(close1ProfitLockPlan([long], outcomes, 11.01, "231.46"), {
    action: "close",
    reason: "three-percent-profit-lock",
    quantity: "11.01",
    averageEntry: "224.71",
    triggerPrice: "231.46"
  });

  const close = {
    direction: "short",
    body: { terms: { id: "close-1", qty: "11.01", px: "231.45" } }
  };
  outcomes.set("close-1", { outcome: "settled" });
  assert.deepEqual(close1ProfitLockPlan([long, close], outcomes, 0, "240.00"), {
    action: "closed",
    reason: "profit-lock-complete"
  });
});

test("trading stays disabled or holds without any write", async () => {
  assert.deepEqual(await advanceClose1Trading({}, snapshot(), { action: "candidate" }, { action: "ready" }), {
    action: "disabled"
  });
  let writes = 0;
  const fetchMock = async (url, init = {}) => {
    const target = String(url);
    if (init.method === "POST") writes += 1;
    if (target.includes("/mabolla-task-relay/export")) return new Response("");
    if (target.includes("/d-close1-flow?")) return Response.json({ messages: [FLOW] });
    return Response.json({ messages: [] });
  };
  const result = await advanceClose1Trading({
    TECHNOCORE_AGENT_DID: CLOSE1_AGENT_DID,
    CLOSE1_TRADING_ENABLED: "true"
  }, snapshot(), { action: "hold", reason: "mixed-trend" }, { action: "ready" }, { now: NOW, fetch: fetchMock });
  assert.deepEqual(result, { action: "hold", reason: "mixed-trend", position: 0 });
  assert.equal(writes, 0);
});

test("posts one capped maker offer with two sweeps for counterparties to settle", async () => {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const privateKey = Buffer.from(await crypto.subtle.exportKey("pkcs8", pair.privateKey)).toString("base64");
  const posted = [];
  let sequence = 900;
  const fetchMock = async (url, init = {}) => {
    const target = String(url);
    if (target.includes("/mabolla-task-relay/export")) return new Response("");
    if (target.includes("/d-close1-flow?")) return Response.json({ messages: [FLOW] });
    if (init.method === "POST") {
      const body = JSON.parse(init.body);
      const room = target.split("/r/")[1];
      posted.push({ room, ...body, from: body.did, seq: ++sequence });
      return new Response("ok");
    }
    const room = target.split("/r/")[1].split("?")[0];
    return Response.json({ messages: posted.filter((record) => record.room === room) });
  };
  const result = await advanceClose1Trading({
    TECHNOCORE_AGENT_DID: CLOSE1_AGENT_DID,
    TECHNOCORE_AGENT_PRIVATE_KEY: privateKey,
    CLOSE1_TRADING_ENABLED: "true"
  }, snapshot(), {
    action: "candidate",
    sweep: 66,
    direction: "long",
    riskPlan: { quantity: "10.99" }
  }, { action: "ready" }, { now: NOW, fetch: fetchMock });

  assert.equal(result.action, "offer-posted");
  assert.equal(result.direction, "long");
  assert.equal(result.qty, "10.99");
  assert.equal(result.until, 68);
  assert.deepEqual(posted.map(({ room }) => room), ["mabolla-task-relay", "close1", "mabolla-task-relay"]);
  const offer = JSON.parse(posted[0].text);
  assert.equal(offer.t, "offer");
  assert.equal(offer.terms.side, "buy");
  assert.equal(offer.terms.taker, "any");
  assert.match(posted[2].text, /close1\.offer\.visible\.v1/);
});

test("countersigns one verified owner offer and posts it only in the registered journal", async () => {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const privateKey = Buffer.from(await crypto.subtle.exportKey("pkcs8", pair.privateKey)).toString("base64");
  const fixture = await offerFixture({ id: "take-me", qty: "0.50" });
  const ownerText = JSON.stringify({ t: "owner", season: "close-1", key: fixture.maker.did });
  const ownerRecord = await signedRecord("close1", fixture.maker, ownerText, 1200);
  const posted = [];
  let sequence = 950;
  const fetchMock = async (url, init = {}) => {
    const target = String(url);
    if (target.includes("/mabolla-task-relay/export")) return new Response("");
    if (target.includes("/d-close1-flow?")) return Response.json({ messages: [FLOW] });
    if (target.includes("/r/close1?limit=200")) return Response.json({ messages: [ownerRecord, fixture.record] });
    if (init.method === "POST") {
      const body = JSON.parse(init.body);
      const room = target.split("/r/")[1];
      posted.push({ room, ...body, from: body.did, seq: ++sequence });
      return new Response("ok");
    }
    const room = target.split("/r/")[1].split("?")[0];
    return Response.json({ messages: posted.filter((record) => record.room === room) });
  };
  const result = await advanceClose1Trading({
    TECHNOCORE_AGENT_DID: CLOSE1_AGENT_DID,
    TECHNOCORE_AGENT_PRIVATE_KEY: privateKey,
    CLOSE1_TRADING_ENABLED: "true",
    CLOSE1_TAKER_ENABLED: "true"
  }, snapshot(), {
    action: "candidate",
    sweep: 66,
    direction: "long",
    riskPlan: { quantity: "10.99" }
  }, { action: "ready" }, { now: NOW, fetch: fetchMock });

  assert.equal(result.action, "trade-posted");
  assert.equal(result.tradeId, "take-me");
  assert.deepEqual(posted.map(({ room }) => room), ["mabolla-task-relay"]);
  const trade = JSON.parse(posted[0].text);
  assert.equal(trade.t, "trade");
  assert.equal(trade.taker, CLOSE1_AGENT_DID);
  assert.match(trade.taker_sig, /^[A-Za-z0-9_-]{86}$/);
});

test("rejects a candidate computed for a different signed sweep", async () => {
  const fetchMock = async (url) => {
    const target = String(url);
    if (target.includes("/mabolla-task-relay/export")) return new Response("");
    if (target.includes("/d-close1-flow?")) return Response.json({ messages: [FLOW] });
    return Response.json({ messages: [] });
  };
  const result = await advanceClose1Trading({
    TECHNOCORE_AGENT_DID: CLOSE1_AGENT_DID,
    CLOSE1_TRADING_ENABLED: "true"
  }, snapshot(), {
    action: "candidate",
    sweep: 65,
    direction: "long",
    riskPlan: { quantity: "10.99" }
  }, { action: "ready" }, { now: NOW, fetch: fetchMock });
  assert.deepEqual(result, { action: "blocked", reason: "stale-strategy-sweep", position: 0 });
});

test("blocks a strategy that tries to exceed the hard account notional cap", async () => {
  const fetchMock = async (url) => {
    const target = String(url);
    if (target.includes("/mabolla-task-relay/export")) return new Response("");
    if (target.includes("/d-close1-flow?")) return Response.json({ messages: [FLOW] });
    return Response.json({ messages: [] });
  };
  const result = await advanceClose1Trading({
    TECHNOCORE_AGENT_DID: CLOSE1_AGENT_DID,
    CLOSE1_TRADING_ENABLED: "true"
  }, snapshot(), {
    action: "candidate",
    sweep: 66,
    direction: "long",
    riskPlan: { quantity: "50.00" }
  }, { action: "ready" }, { now: NOW, fetch: fetchMock });
  assert.deepEqual(result, { action: "blocked", reason: "strategy-risk-cap-violation", position: 0 });
});
