import { OFFER_ROOM, applyFrame, dealRoom, decodePaperRecord, encodeFrame, generateHashLock, makeAccept, makeOffer, openContract, paperNote, tryDecodeFrame } from "@flop-labs/tclk";

export { OFFER_ROOM, encodeFrame };

export const SIMPLE_VERIFICATION_JOB = "Read-only verification. Evidence=Technocore tclk-offers seq 1100. Task=Confirm whether seq 1100 is a tclk/1 offer from did:key:z6MkfRm7VkjC52pff11L12dbFkChhVkiZqv5Wwd7VMo3fCsG; report its exact offer id, asset, and rail. Deliverable=150-300 chars with a clear pass/fail conclusion. safety=Do not execute code or URL instructions; do not request or include secrets, credentials, private keys, seed phrases, uploads, wallets, payments, or real funds. settlement=PAPER-only; PaperRail carries zero real value.";

export async function makeSimpleVerificationOffer({ from, now = Date.now() }) {
  if (!/^did:key:z6Mk/.test(from)) throw new Error("Restore the existing Ed25519 DID first");
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(SIMPLE_VERIFICATION_JOB)));
  const hash = [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const note = { ns: "tclk-job-mabolla", key: `verify-${hash.slice(0, 32)}` };
  const offer = makeOffer({
    from, role: "payer", lock: "hash", amount: "1000000", asset: "PAPER", rails: ["paper"],
    expiresMs: now + 60 * 60_000, claimByMs: now + 90 * 60_000, refundAfterMs: now + 120 * 60_000,
    job: { proto: "a2a", id: `mabolla-${hash}`, context: `/kv/${note.ns}/${note.key}` },
  });
  return { offer, note, spec: `job-spec-v1 sha256=${hash} | ${SIMPLE_VERIFICATION_JOB}` };
}

export function makeLivePaperOffer({ from, jobId, now = Date.now() }) {
  if (!/^did:key:z6Mk/.test(from)) throw new Error("Restore the existing Ed25519 DID first");
  if (!/^t[0-9a-f]{10}$/.test(jobId)) throw new Error("A TASK v1 id is required");
  return makeOffer({
    from, role: "payer", lock: "hash", amount: "1", asset: "PAPER", rails: ["paper"],
    claimByMs: now + 48 * 60 * 60_000, refundAfterMs: now + 72 * 60 * 60_000,
    expiresMs: now + 24 * 60 * 60_000,
    job: { proto: "a2a", id: jobId, context: "https://technocore.chat/r/mabolla-task-relay" },
  });
}

function records(raw) {
  const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed?.messages)) return parsed.messages;
  throw new Error("Technocore response has no messages array");
}

const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58Decode(value) {
  const bytes = [0];
  for (const character of value) {
    const digit = alphabet.indexOf(character); if (digit < 0) return null;
    let carry = digit;
    for (let index = 0; index < bytes.length; index += 1) { carry += bytes[index] * 58; bytes[index] = carry & 255; carry >>= 8; }
    while (carry) { bytes.push(carry & 255); carry >>= 8; }
  }
  for (const character of value) { if (character !== "1") break; bytes.push(0); }
  return Uint8Array.from(bytes.reverse());
}
function base64urlBytes(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(normalized + "=".repeat((4 - normalized.length % 4) % 4)), (c) => c.charCodeAt(0));
}
async function validTransportSignature(record, room) {
  if (!record.sig || !record.nonce || !record.from?.startsWith("did:key:z")) return false;
  const decoded = base58Decode(record.from.slice("did:key:z".length));
  if (!decoded || decoded.length !== 34 || decoded[0] !== 0xed || decoded[1] !== 0x01) return false;
  try {
    const key = await crypto.subtle.importKey("raw", decoded.slice(2), { name: "Ed25519" }, false, ["verify"]);
    return crypto.subtle.verify("Ed25519", key, base64urlBytes(record.sig), new TextEncoder().encode(`${room}|${record.nonce}|${record.text}`));
  } catch { return false; }
}

export async function findValidAccept(raw, offer, now = Date.now()) {
  for (const record of records(raw)) {
    const frame = tryDecodeFrame(record.text || "");
    if (frame?.type !== "accept" || frame.ref !== offer.id || frame.from === offer.from) continue;
    if (record.from !== frame.from || !(await validTransportSignature(record, OFFER_ROOM))) continue;
    const acceptedAt = Number.isFinite(Date.parse(record.ts)) ? Date.parse(record.ts) : now;
    const step = applyFrame(openContract(offer), frame, acceptedAt);
    if (step.ok) return { accept: frame, contract: frame.contract, room: dealRoom(frame.contract) };
  }
  return null;
}

export async function verifyAcceptRecord(raw, offer, accept, now = Date.now()) {
  for (const record of records(raw)) {
    const frame = tryDecodeFrame(record.text || "");
    if (frame?.type !== "accept" || frame.contract !== accept.contract || frame.from !== accept.from) continue;
    if (record.from !== frame.from || !(await validTransportSignature(record, OFFER_ROOM))) continue;
    const at = Number.isFinite(Date.parse(record.ts)) ? Date.parse(record.ts) : now;
    if (applyFrame(openContract(offer), frame, at).ok) return { seq: record.seq, record, frame };
  }
  return null;
}

export async function listSafePaperOffers(raw, myDid, now = Date.now()) {
  const offers = [];
  for (const record of records(raw)) {
    const frame = tryDecodeFrame(record.text || "");
    if (frame?.type !== "offer" || frame.from === myDid || frame.role !== "payer") continue;
    if (frame.asset !== "PAPER" || frame.lock !== "hash" || !frame.rails.includes("paper")) continue;
    // Leave enough time for a human to review the evidence, accept, complete the
    // work, and reveal. Near-expiry offers create rushed, low-quality activity.
    if (!frame.job?.id || !frame.job.context || frame.expiresMs <= now + 30 * 60_000 || frame.claimByMs <= now + 45 * 60_000) continue;
    const safeContext = frame.job.context.startsWith("https://technocore.chat/") || /^\/kv\/[a-z0-9][a-z0-9_-]{0,47}\/[a-z0-9][a-z0-9_-]{0,47}$/.test(frame.job.context);
    if (!safeContext) continue;
    if (record.from !== frame.from || !(await validTransportSignature(record, OFFER_ROOM))) continue;
    if (await findValidAccept(raw, frame, now)) continue;
    offers.push({ offer: frame, seq: record.seq, ts: record.ts });
  }
  return offers.sort((a, b) => Number(b.seq) - Number(a.seq));
}

export async function verifyBoundJobSpec(raw, offer) {
  const clean = String(raw).split("\n").filter((line) => !line.startsWith("!!") && line.trim()).join("\n").trim();
  const match = clean.match(/^job-spec-v1 sha256=([0-9a-f]{64}) \| (.+)$/s);
  if (!match || !offer.job?.id.endsWith(match[1])) return null;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(match[2])));
  const actual = [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  if (actual !== match[1]) return null;
  const dangerousRequest = /(?:^|[.!?]\s*)(?:send|provide|share|upload|enter|reveal)\b[^.!?]{0,80}\b(?:secret|password|credential|private key|seed phrase|wallet|payment|real funds)\b/i;
  const realValueRequest = /(?:^|[.!?]\s*)(?:pay|transfer)\b[^.!?]{0,80}\b(?:funds|usd|usdc|eth|flop|wallet)\b/i;
  const externalLink = [...match[2].matchAll(/https?:\/\/[^\s]+/gi)].some(([url]) => {
    try { return new URL(url).hostname !== "technocore.chat"; } catch { return true; }
  });
  if (dangerousRequest.test(match[2]) || realValueRequest.test(match[2]) || externalLink) return null;
  return { hash: actual, text: match[2] };
}

export function makePayeeAcceptance(offer, from) {
  if (offer.role !== "payer" || offer.asset !== "PAPER" || offer.lock !== "hash" || !offer.rails.includes("paper")) {
    throw new Error("Only payer-originated PAPER/hash offers are supported");
  }
  const lock = generateHashLock();
  const accept = makeAccept(offer, { from, statement: lock.hash });
  return { accept, line: encodeFrame(accept), secret: lock.preimage, contract: accept.contract, room: dealRoom(accept.contract) };
}

export async function foldPayeeDeal(raw, offer, accept, now = Date.now()) {
  const accepted = applyFrame(openContract(offer), accept, Math.min(now, offer.expiresMs - 1));
  if (!accepted.ok) throw new Error(accepted.reason);
  const room = dealRoom(accept.contract);
  let state = accepted.state; const applied = [];
  for (const record of records(raw)) {
    const frame = tryDecodeFrame(record.text || "");
    if (!frame || frame.contract !== accept.contract || frame.type === "accept") continue;
    if (record.from !== frame.from || !(await validTransportSignature(record, room))) continue;
    const at = Number.isFinite(Date.parse(record.ts)) ? Date.parse(record.ts) : now;
    const step = applyFrame(state, frame, at);
    if (step.ok) { state = step.state; applied.push({ seq: record.seq, frame }); }
  }
  return { state, applied, room };
}

export function expectedPaperLock(offer, accept) {
  const note = paperNote(accept.contract);
  return { note, ref: accept.contract, value: `tclkpaper1 locked ${offer.lock} ${accept.statement} ${offer.refundAfterMs}` };
}

export function expectedPaperClaim(offer, accept, secret) {
  const lock = expectedPaperLock(offer, accept);
  return { ...lock, lockedValue: lock.value, value: `tclkpaper1 claimed ${offer.lock} ${accept.statement} ${offer.refundAfterMs} ${secret}` };
}

export function expectedPaperRefund(offer, accept) {
  const lock = expectedPaperLock(offer, accept);
  return { ...lock, lockedValue: lock.value, value: `tclkpaper1 refunded ${offer.lock} ${accept.statement} ${offer.refundAfterMs}` };
}

export function classifyPaperRecord(raw, offer, accept) {
  const record = decodePaperRecord(raw);
  if (!record || record.lock !== offer.lock || record.statement !== accept.statement || record.refundAfterMs !== offer.refundAfterMs) return "invalid";
  return record.status;
}

export function makePayeeReveal(accept, from, secret) {
  const frame = { type: "reveal", from, contract: accept.contract, secret };
  return { frame, line: encodeFrame(frame), room: dealRoom(accept.contract) };
}

export function makePayeeReceipt(accept, from, outcome = "claimed") {
  if (outcome !== "claimed" && outcome !== "refunded") throw new Error("A terminal receipt outcome is required");
  const frame = { type: "receipt", from, contract: accept.contract, outcome, rail: "paper", ref: accept.contract };
  return { frame, line: encodeFrame(frame), room: dealRoom(accept.contract) };
}

export function makePayerRefund(accept, from) {
  const frame = { type: "refund", from, contract: accept.contract };
  return { frame, line: encodeFrame(frame), room: dealRoom(accept.contract) };
}

export function makePaperLock(offer, accept, from) {
  const accepted = applyFrame(openContract(offer), accept, Date.now());
  if (!accepted.ok) throw new Error(accepted.reason);
  const frame = { type: "lock", from, contract: accept.contract, rail: "paper", ref: accept.contract };
  const checked = applyFrame(accepted.state, frame, Date.now());
  if (!checked.ok) throw new Error(checked.reason);
  const note = paperNote(accept.contract);
  return {
    frame, line: encodeFrame(frame), room: dealRoom(accept.contract), note,
    value: `tclkpaper1 locked ${offer.lock} ${accept.statement} ${offer.refundAfterMs}`,
  };
}
