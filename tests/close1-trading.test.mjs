import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  CLOSE1_AGENT_DID,
  CLOSE1_REFEREE_DID
} from "../src/close1-protocol.mjs";
import {
  advanceClose1Trading,
  canonicalClose1Terms,
  close1AutomaticExitGuard,
  close1ProfitLockPlan,
  close1SecondTrancheEntryGuard,
  preflightClose1ArchiveHints,
  selectClose1Offer,
  verifyArchivedHintOutcomes,
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

const ACTIVE_OFFER = {
  seq: 64,
  ts: "2026-09-25T21:21:11.470315Z",
  from: CLOSE1_AGENT_DID,
  text: "{\"t\":\"offer\",\"season\":\"close-1\",\"terms\":{\"id\":\"mb112l280fb60bc4f8\",\"maker\":\"did:key:z6MkfRm7VkjC52pff11L12dbFkChhVkiZqv5Wwd7VMo3fCsG\",\"px\":\"225.04\",\"qty\":\"10.97\",\"side\":\"buy\",\"taker\":\"any\",\"until\":114},\"maker_sig\":\"6qopvqe7CVgNlN_0jWTdHpNkTd5P_YYFwkt9F2EpxsczcwR6SFoLRzLnY-MtbGxQW3VBk--35ADSLXK9LwfwBw\"}",
  nonce: 1790371269198,
  sig: "hWVNsFuYmlslWyI0i9t4txr6MtMCfDpUZ5la4SzV9NznF_lYqKZLpzhjMJGO36DhWf2irtapIeTzEOlPgpvfDg"
};

const ACTIVE_OFFER_MARKER = {
  seq: 65,
  ts: "2026-09-25T21:21:13.574787Z",
  from: CLOSE1_AGENT_DID,
  text: "{\"type\":\"close1.offer.visible.v1\",\"season\":\"close-1\",\"did\":\"did:key:z6MkfRm7VkjC52pff11L12dbFkChhVkiZqv5Wwd7VMo3fCsG\",\"trade_id\":\"mb112l280fb60bc4f8\",\"public_seq\":1026041,\"public_nonce\":\"1790371269200\",\"public_sig\":\"cAo9oPJ_4AhncLthuFBdWPc3tuarohlng2C0El-bcXwWDPRghMM0PiqhvLy6tMK9xZmZkRxKphWLbFIo24HYDw\"}",
  nonce: 1790371269201,
  sig: "zKmYOKBaha8Rp-NGrzBFTtEc2BSXucNwUDaH1cU94W-pYU5_7uMYqxPdF2BQOlp5G4s2ES8VZ0ebkIVc3L5dCg"
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

test("binds an omitted trade outcome to the hash-verified official sweep archive", async () => {
  const terms = {
    id: "mb824l3a1108f4a08e",
    maker: CLOSE1_AGENT_DID,
    px: "223.01",
    qty: "11.09",
    side: "buy",
    taker: "any",
    until: 826
  };
  const action = {
    role: "maker",
    direction: "long",
    termsText: canonicalClose1Terms(terms),
    body: { t: "offer", season: "close-1", terms }
  };
  const sweep = JSON.stringify({
    input: {
      t: "sweep",
      n: 825,
      ref: "223.23",
      close: "223.01",
      owners: [],
      trades: [{ ...terms, countersigner: "did:key:z6MknqaR6BcqZX1W7S8Au71V1bL55QqACzUEG3LTKcrEW4Rw" }]
    },
    output: {
      sweep: 825,
      reference: "223.23",
      close: "223.01",
      minted: [],
      trades: [{ id: terms.id, outcome: "settled", maker_fee: "24.731809", taker_fee: "24.731809" }],
      global_price: "223.01"
    }
  });
  const hash = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(sweep))).toString("hex");
  const index = {
    contest: "close-1",
    sweeps: [{ n: 825, file: hash, status: "full", path: `sweeps/${hash}.json`, bytes: sweep.length }]
  };
  const fetchMock = async (url) => String(url).includes("index.json")
    ? Response.json(index)
    : new Response(sweep, { headers: { "content-length": String(sweep.length) } });
  const result = await verifyArchivedHintOutcomes(
    [action],
    new Map(),
    [{ n: 825, file: hash }],
    { CLOSE1_ARCHIVE_OUTCOME_HINTS: `${terms.id}:825:${hash}` },
    fetchMock,
    NOW
  );
  assert.deepEqual(result.pending, []);
  assert.deepEqual(result.found.get(terms.id), {
    outcome: "settled",
    sweep: 825,
    flow_file: hash
  });

  const pending = await verifyArchivedHintOutcomes(
    [action],
    new Map(),
    [{ n: 825, file: hash }],
    { CLOSE1_ARCHIVE_OUTCOME_HINTS: `${terms.id}:825:${hash}` },
    async () => Response.json({ contest: "close-1", sweeps: [] }),
    NOW
  );
  assert.deepEqual(pending, { found: new Map(), pending: [terms.id] });
});

test("preflights pinned archive outcomes before any expensive signed-room scan", async () => {
  const first = "a".repeat(64);
  const second = "b".repeat(64);
  const hints = `trade-a:825:${first},trade-b:827:${second}`;
  const pending = await preflightClose1ArchiveHints(
    { CLOSE1_ARCHIVE_OUTCOME_HINTS: hints },
    async () => Response.json({ contest: "close-1", sweeps: [{ n: 825, file: first, status: "redacted", path: `redacted/${first}.json` }] }),
    NOW
  );
  assert.deepEqual(pending, {
    action: "blocked",
    reason: "archive-outcome-pending",
    tradeIds: ["trade-b"]
  });

  const ready = await preflightClose1ArchiveHints(
    { CLOSE1_ARCHIVE_OUTCOME_HINTS: hints },
    async () => Response.json({
      contest: "close-1",
      sweeps: [
        { n: 825, file: first, status: "redacted", path: `redacted/${first}.json` },
        { n: 827, file: second, status: "full", path: `sweeps/${second}.json` }
      ]
    }),
    NOW
  );
  assert.deepEqual(ready, { action: "ready", reason: "archive-outcome-files-visible" });

  await assert.rejects(() => preflightClose1ArchiveHints(
    { CLOSE1_ARCHIVE_OUTCOME_HINTS: hints },
    async () => Response.json({
      contest: "close-1",
      sweeps: [{ n: 825, file: second, status: "redacted", path: `redacted/${second}.json` }]
    }),
    NOW
  ), /does not match/);
});

test("both runtimes pin the omitted sweep 824 settlement before trading", () => {
  const expected = "mb822le05d3c34c797:824:0527d1ea85775dc081ace61ed2f21936c44208b0be26cdccd9cfe270ee10d7dd";
  const workflow = readFileSync(new URL("../.github/workflows/run-close1.yml", import.meta.url), "utf8");
  const wrangler = readFileSync(new URL("../wrangler.close1.jsonc", import.meta.url), "utf8");
  assert.ok(workflow.includes(`CLOSE1_ARCHIVE_OUTCOME_HINTS: ${expected},`));
  assert.ok(wrangler.includes(`"CLOSE1_ARCHIVE_OUTCOME_HINTS": "${expected},`));
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

test("closes the second tranche at 230 and preserves the first tranche target", () => {
  const first = {
    record: { seq: 10 },
    direction: "long",
    body: { terms: { id: "first-long", qty: "11.01", px: "224.71" } }
  };
  const second = {
    record: { seq: 20 },
    direction: "long",
    body: { terms: { id: "second-long", qty: "10.98", px: "225.08" } }
  };
  const secondExit = {
    record: { seq: 30 },
    direction: "short",
    body: { terms: { id: "second-exit", qty: "10.98", px: "230.00" } }
  };
  const outcomes = new Map([
    ["first-long", { outcome: "settled" }],
    ["second-long", { outcome: "settled" }]
  ]);

  assert.deepEqual(close1ProfitLockPlan([first, second], outcomes, 21.99, "229.99"), {
    action: "hold",
    reason: "profit-lock-not-reached",
    averageEntry: "224.89",
    triggerPrice: "230.00"
  });
  assert.deepEqual(close1ProfitLockPlan([first, second], outcomes, 21.99, "230.00"), {
    action: "close",
    reason: "second-tranche-fixed-profit-lock",
    quantity: "10.98",
    averageEntry: "225.08",
    triggerPrice: "230.00"
  });

  outcomes.set("second-exit", { outcome: "settled" });
  assert.deepEqual(close1ProfitLockPlan([first, second, secondExit], outcomes, 11.01, "230.00"), {
    action: "hold",
    reason: "profit-lock-not-reached",
    averageEntry: "224.71",
    triggerPrice: "231.46",
    reentryBlocked: true
  });
  assert.deepEqual(close1ProfitLockPlan([first, second, secondExit], outcomes, 11.01, "231.46"), {
    action: "close",
    reason: "three-percent-profit-lock",
    quantity: "11.01",
    averageEntry: "224.71",
    triggerPrice: "231.46"
  });
});

test("keeps automatic exits disabled while the final all-in entry is active", () => {
  const close = {
    action: "close",
    reason: "second-tranche-fixed-profit-lock",
    quantity: "10.97",
    averageEntry: "225.19",
    triggerPrice: "230.00"
  };
  assert.deepEqual(close1AutomaticExitGuard({ CLOSE1_EXIT_ENABLED: "false" }, close), {
    action: "hold",
    reason: "automatic-exit-disabled",
    quantity: "10.97",
    averageEntry: "225.19",
    triggerPrice: "230.00"
  });
  assert.deepEqual(close1AutomaticExitGuard({ CLOSE1_EXIT_ENABLED: "true" }, close), close);
});

test("does not chase the second tranche above its profitable 230 exit cap", () => {
  assert.deepEqual(close1SecondTrancheEntryGuard(11.01, 10.98, "225.40"), { action: "allow" });
  assert.deepEqual(close1SecondTrancheEntryGuard(11.01, 10.98, "225.41"), {
    action: "hold",
    reason: "second-tranche-entry-above-profitable-cap",
    entryCeiling: "225.40",
    exitPrice: "230.00"
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

test("continues position reconciliation after the referee freezes new trading", async () => {
  const reads = [];
  const fetchMock = async (url) => {
    const target = String(url);
    reads.push(target);
    if (target.includes("/mabolla-task-relay/export")) return new Response("");
    if (target.includes("/d-close1-flow?")) return Response.json({ messages: [FLOW] });
    return Response.json({ messages: [] });
  };
  const result = await advanceClose1Trading({
    TECHNOCORE_AGENT_DID: CLOSE1_AGENT_DID,
    CLOSE1_TRADING_ENABLED: "true"
  }, { ...snapshot(), tradingEnabled: false }, { action: "hold" }, { action: "blocked" }, {
    now: NOW,
    fetch: fetchMock
  });
  assert.deepEqual(result, {
    action: "position-frozen",
    reason: "snapshot-trading-disabled",
    position: 0
  });
  assert.ok(reads.some((url) => url.includes("/mabolla-task-relay/export")));
  assert.ok(reads.some((url) => url.includes("/d-close1-flow?")));
});

test("posts one liquid maker slice with two sweeps for counterparties to settle", async () => {
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
    riskPlan: { quantity: "43.90" }
  }, { action: "ready" }, { now: NOW, fetch: fetchMock });

  assert.equal(result.action, "offer-posted");
  assert.equal(result.direction, "long");
  assert.equal(result.qty, "10.99");
  assert.equal(result.until, 68);
  assert.deepEqual(posted.map(({ room }) => room), [
    "mabolla-task-relay",
    "close1",
    "close1",
    "mabolla-task-relay"
  ]);
  const offer = JSON.parse(posted[0].text);
  assert.equal(offer.t, "offer");
  assert.equal(offer.terms.side, "buy");
  assert.equal(offer.terms.taker, "any");
  assert.deepEqual(JSON.parse(posted[1].text), {
    t: "owner",
    season: "close-1",
    key: CLOSE1_AGENT_DID
  });
  assert.equal(JSON.parse(posted[2].text).terms.id, offer.terms.id);
  assert.ok(Number(posted[2].nonce) > Number(posted[1].nonce));
  assert.match(posted[3].text, /close1\.offer\.visible\.v1/);
});

test("refreshes the owner and exact offer while a maker lease remains active", async () => {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const privateKey = Buffer.from(await crypto.subtle.exportKey("pkcs8", pair.privateKey)).toString("base64");
  const posted = [];
  const fetchMock = async (url, init = {}) => {
    const target = String(url);
    if (target.includes("/mabolla-task-relay/export")) {
      return new Response(`${JSON.stringify(ACTIVE_OFFER)}\n${JSON.stringify(ACTIVE_OFFER_MARKER)}\n`);
    }
    if (target.includes("/d-close1-flow?")) return Response.json({ messages: [FLOW] });
    if (init.method === "POST") {
      const body = JSON.parse(init.body);
      posted.push({ room: target.split("/r/")[1], ...body, from: body.did, seq: 901 });
      return new Response("ok");
    }
    return Response.json({ messages: posted });
  };
  const result = await advanceClose1Trading({
    TECHNOCORE_AGENT_DID: CLOSE1_AGENT_DID,
    TECHNOCORE_AGENT_PRIVATE_KEY: privateKey,
    CLOSE1_TRADING_ENABLED: "true"
  }, snapshot(), { action: "hold", reason: "not-needed" }, { action: "ready" }, { now: NOW, fetch: fetchMock });

  assert.deepEqual(result, {
    action: "waiting-offer",
    tradeId: "mb112l280fb60bc4f8",
    position: 0,
    ownerSeq: 901,
    publicSeq: 901
  });
  assert.equal(posted.length, 2);
  assert.equal(posted[0].room, "close1");
  assert.deepEqual(JSON.parse(posted[0].text), {
    t: "owner",
    season: "close-1",
    key: CLOSE1_AGENT_DID
  });
  assert.equal(posted[1].room, "close1");
  assert.equal(posted[1].text, ACTIVE_OFFER.text);
  assert.ok(Number(posted[1].nonce) > Number(posted[0].nonce));
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
