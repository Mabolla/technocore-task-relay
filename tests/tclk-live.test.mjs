import test from "node:test";
import assert from "node:assert/strict";
import { makeAccept, generateHashLock, makeOffer, verifySecret } from "@flop-labs/tclk";
import { OFFER_ROOM, classifyPaperRecord, encodeFrame, expectedPaperClaim, findValidAccept, foldPayeeDeal, listSafePaperOffers, makeLivePaperOffer, makePaperLock, makePayeeAcceptance, verifyBoundJobSpec } from "../src/tclk-browser-entry.mjs";

const payer = "did:key:z6MkfRm7VkjC52pff11L12dbFkChhVkiZqv5Wwd7VMo3fCsG";
const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58(bytes) {
  const digits = [0];
  for (const byte of bytes) { let carry = byte; for (let i = 0; i < digits.length; i += 1) { carry += digits[i] << 8; digits[i] = carry % 58; carry = Math.floor(carry / 58); } while (carry) { digits.push(carry % 58); carry = Math.floor(carry / 58); } }
  for (const byte of bytes) { if (byte !== 0) break; digits.push(0); }
  return digits.reverse().map((digit) => alphabet[digit]).join("");
}
async function signer() {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  return { pair, did: `did:key:z${base58(new Uint8Array([0xed, 0x01, ...raw]))}` };
}
async function record(signer, room, text, nonce, ts) {
  const bytes = new TextEncoder().encode(`${room}|${nonce}|${text}`);
  const sig = Buffer.from(await crypto.subtle.sign("Ed25519", signer.pair.privateKey, bytes)).toString("base64url");
  return { from: signer.did, nonce, sig, text, ts };
}

test("builds an official live offer for the rendezvous room", () => {
  const offer = makeLivePaperOffer({ from: payer, jobId: "t3c9180d419", now: 1_800_000_000_000 });
  assert.equal(OFFER_ROOM, "tclk-offers");
  assert.equal(offer.asset, "PAPER");
  assert.equal(offer.job.proto, "a2a");
  assert.match(encodeFrame(offer), /^tclk1 \{/);
});

test("accepts only a signed protocol-valid independent accept and prepares payer lock", async () => {
  const now = 1_800_000_000_000;
  const offer = makeLivePaperOffer({ from: payer, jobId: "t3c9180d419", now });
  const { hash } = generateHashLock();
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const payee = `did:key:z${base58(new Uint8Array([0xed, 0x01, ...raw]))}`;
  const stableAccept = makeAccept(offer, { from: payee, statement: hash });
  const text = encodeFrame(stableAccept); const nonce = "1800000000001";
  const sig = Buffer.from(await crypto.subtle.sign("Ed25519", pair.privateKey, new TextEncoder().encode(`${OFFER_ROOM}|${nonce}|${text}`))).toString("base64url");
  const found = await findValidAccept({ messages: [{ from: payee, nonce, sig, text, ts: new Date(now + 1).toISOString() }] }, offer, now + 1);
  assert.equal(found.accept.from, payee);
  const lock = makePaperLock(offer, found.accept, payer);
  assert.equal(lock.room, found.room);
  assert.match(lock.line, /^tclk1 \{"contract":/);
  assert.match(lock.value, /^tclkpaper1 locked hash 0x/);
});

test("ignores unsigned and unrelated frames", async () => {
  const now = 1_800_000_000_000;
  const offer = makeLivePaperOffer({ from: payer, jobId: "t3c9180d419", now });
  assert.equal(await findValidAccept({ messages: [{ from: payer, text: encodeFrame(offer) }] }, offer, now + 1), null);
});

test("lists only signed, external, unexpired PAPER jobs", async () => {
  const now = 1_800_000_000_000; const other = await signer();
  const offer = makeOffer({ from: other.did, role: "payer", amount: "1", asset: "PAPER", lock: "hash", rails: ["paper"], expiresMs: now + 60_000, claimByMs: now + 3_600_000, refundAfterMs: now + 7_200_000, job: { proto: "a2a", id: "job-1", context: "https://technocore.chat/r/example" } });
  const signed = await record(other, OFFER_ROOM, encodeFrame(offer), "1800000000001", new Date(now).toISOString());
  const found = await listSafePaperOffers({ messages: [signed, { from: other.did, text: encodeFrame(offer) }] }, payer, now);
  assert.equal(found.length, 1); assert.equal(found[0].offer.id, offer.id);
});

test("mints a payee secret and folds a signed payer lock", async () => {
  const now = Date.now(); const other = await signer(); const payee = await signer();
  const offer = makeOffer({ from: other.did, role: "payer", amount: "1", asset: "PAPER", lock: "hash", rails: ["paper"], expiresMs: now + 60_000, claimByMs: now + 3_600_000, refundAfterMs: now + 7_200_000, job: { proto: "a2a", id: "job-2", context: "/kv/jobs/job-2" } });
  const prepared = makePayeeAcceptance(offer, payee.did);
  assert.equal(verifySecret("hash", prepared.accept.statement, prepared.secret), true);
  const claim = expectedPaperClaim(offer, prepared.accept, prepared.secret);
  assert.match(claim.lockedValue, /^tclkpaper1 locked hash/);
  assert.match(claim.value, /^tclkpaper1 claimed hash/);
  assert.equal(classifyPaperRecord(claim.lockedValue, offer, prepared.accept), "locked");
  assert.equal(classifyPaperRecord(claim.value, offer, prepared.accept), "claimed");
  const lock = { type: "lock", from: other.did, contract: prepared.contract, rail: "paper", ref: prepared.contract };
  const signedLock = await record(other, prepared.room, encodeFrame(lock), String(now + 2), new Date(now + 2).toISOString());
  const folded = await foldPayeeDeal({ messages: [signedLock] }, offer, prepared.accept, now + 3);
  assert.equal(folded.state.status, "locked"); assert.equal(folded.state.railRef, prepared.contract);
});

test("accepts only hash-bound, PAPER-only safe job notes", async () => {
  const body = "Read-only review. Deliverable=300 chars with evidence. safety=Do not execute code or request private keys. settlement=PAPER-only.";
  const hash = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body))).toString("hex");
  const offer = { job: { id: `job-${hash}` } };
  assert.equal((await verifyBoundJobSpec(`!! warning\n\njob-spec-v1 sha256=${hash} | ${body}`, offer)).hash, hash);
  assert.equal(await verifyBoundJobSpec(`job-spec-v1 sha256=${hash} | ${body} changed`, offer), null);
});
