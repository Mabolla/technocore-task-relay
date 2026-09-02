import test from "node:test";
import assert from "node:assert/strict";
import { makeAccept, generateHashLock } from "@flop-labs/tclk";
import { OFFER_ROOM, encodeFrame, findValidAccept, makeLivePaperOffer, makePaperLock } from "../src/tclk-browser-entry.mjs";

const payer = "did:key:z6MkfRm7VkjC52pff11L12dbFkChhVkiZqv5Wwd7VMo3fCsG";
const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58(bytes) {
  const digits = [0];
  for (const byte of bytes) { let carry = byte; for (let i = 0; i < digits.length; i += 1) { carry += digits[i] << 8; digits[i] = carry % 58; carry = Math.floor(carry / 58); } while (carry) { digits.push(carry % 58); carry = Math.floor(carry / 58); } }
  for (const byte of bytes) { if (byte !== 0) break; digits.push(0); }
  return digits.reverse().map((digit) => alphabet[digit]).join("");
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
