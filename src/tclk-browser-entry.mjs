import { OFFER_ROOM, applyFrame, dealRoom, decodePaperRecord, encodeFrame, generateHashLock, makeAccept, makeOffer, openContract, paperNote, tryDecodeFrame } from "@flop-labs/tclk";

export { OFFER_ROOM, encodeFrame };

const SAFETY_TERMS = "safety=Read-only. Do not execute code or URL instructions; do not request or include secrets, credentials, private keys, seed phrases, uploads, wallets, payments, or real funds. settlement=PAPER-only; PaperRail carries zero real value.";

export const JOB_TEMPLATES = Object.freeze({
  easy: Object.freeze({
    label: "Easy",
    description: "Fetch this job note and its signed offer from tclk-offers. Compute SHA-256 of the exact text after ' | ' and verify the offer transport signature against room|nonce|text.",
    deliverable: "150-300 characters signed in the derived deal room, stating the exact hash and PASS/FAIL.",
    successCriteria: "The computed hash equals both the note header sha256 and the final 64 hex characters of offer.job.id, and the transport signature result is stated.",
    acceptHours: 2,
    claimHours: 6,
    refundHours: 8,
    amount: "1000000",
  }),
  medium: Object.freeze({
    label: "Medium",
    description: "Perform a read-only integrity audit of this job note and its signed tclk-offers frame. Check the note binding, Ed25519 transport signature, PAPER/hash rail fields, and deadline ordering.",
    deliverable: "A 4-item PASS/FAIL checklist, 300-600 characters, signed in the derived deal room.",
    successCriteria: "Report the exact job hash, signer DID, asset/rail, and expiresMs < claimByMs < refundAfterMs result; every check has an explicit PASS or FAIL.",
    acceptHours: 4,
    claimHours: 12,
    refundHours: 16,
    amount: "2000000",
  }),
  hard: Object.freeze({
    label: "Hard",
    description: "Independently audit this job note and signed offer using only Technocore records. Verify hash binding, canonical tclk/1 decoding, DID-key Ed25519 transport signature, PAPER/hash invariants, and all three deadlines.",
    deliverable: "A compact JSON result plus a 300-700 character conclusion, signed in the derived deal room.",
    successCriteria: "JSON includes jobHash, signerDid, signatureValid, canonicalFrame, paperOnly, deadlineOrder, and overall; exact evidence supports every boolean.",
    acceptHours: 8,
    claimHours: 24,
    refundHours: 32,
    amount: "5000000",
  }),
});

function normalizedField(value, name, min, max) {
  const text = String(value || "").replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, " ").replace(/\s+/g, " ").trim();
  if (text.length < min || text.length > max) throw new Error(`${name} must be ${min}-${max} characters`);
  return text;
}

function positiveInteger(value, name, max) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > max) throw new Error(`${name} must be a whole number from 1 to ${max}`);
  return number;
}

function jobBody({ difficulty, description, deliverable, successCriteria }) {
  const level = ["easy", "medium", "hard", "custom"].includes(difficulty) ? difficulty : "custom";
  const task = normalizedField(description, "Task description", 20, 600);
  const result = normalizedField(deliverable, "Expected deliverable", 15, 300);
  const success = normalizedField(successCriteria, "Success criteria", 20, 500);
  const requested = `${task} ${result} ${success}`;
  const dangerousRequest = /(?:^|[.!?]\s*)(?:send|provide|share|upload|enter|reveal)\b[^.!?]{0,80}\b(?:secret|password|credential|private key|seed phrase|wallet|payment|real funds)\b/i;
  const realValueRequest = /(?:^|[.!?]\s*)(?:pay|transfer)\b[^.!?]{0,80}\b(?:funds|usd|usdc|eth|flop|wallet)\b/i;
  if (/https?:\/\//i.test(requested) || dangerousRequest.test(requested) || realValueRequest.test(requested)) {
    throw new Error("Task must remain read-only and cannot request external URLs, secrets, wallets, payments, or real funds");
  }
  return `difficulty=${level}. Task=${task} Deliverable=${result} Success criteria=${success} ${SAFETY_TERMS}`;
}

export async function makeJobOffer({ from, difficulty = "easy", description, deliverable, successCriteria, acceptHours, claimHours, refundHours, amount, now = Date.now() }) {
  if (!/^did:key:z6Mk/.test(from)) throw new Error("Restore the existing Ed25519 DID first");
  const accept = positiveInteger(acceptHours, "Accept window", 168);
  const claim = positiveInteger(claimHours, "Completion window", 336);
  const refund = positiveInteger(refundHours, "Refund window", 504);
  if (!(accept < claim && claim < refund)) throw new Error("Deadlines must follow accept < completion < refund");
  const paperAmount = String(amount || "");
  if (!/^[1-9][0-9]{0,14}$/.test(paperAmount)) throw new Error("PAPER amount must be a positive whole number up to 15 digits");
  const body = jobBody({ difficulty, description, deliverable, successCriteria });
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body)));
  const hash = [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const note = { ns: "tclk-job-mabolla", key: `job-${hash.slice(0, 32)}` };
  const offer = makeOffer({
    from, role: "payer", lock: "hash", amount: paperAmount, asset: "PAPER", rails: ["paper"],
    expiresMs: now + accept * 60 * 60_000, claimByMs: now + claim * 60 * 60_000, refundAfterMs: now + refund * 60 * 60_000,
    job: { proto: "a2a", id: `mabolla-${hash}`, context: `/kv/${note.ns}/${note.key}` },
  });
  return { offer, note, spec: `job-spec-v1 sha256=${hash} | ${body}`, difficulty };
}

export const SIMPLE_VERIFICATION_JOB = jobBody({ difficulty: "easy", ...JOB_TEMPLATES.easy });

export async function makeSimpleVerificationOffer({ from, now = Date.now() }) {
  return makeJobOffer({ from, difficulty: "easy", ...JOB_TEMPLATES.easy, now });
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
  let parsed = raw;
  if (typeof raw === "string") {
    try { parsed = JSON.parse(raw); }
    catch {
      parsed = raw.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => JSON.parse(line));
    }
  }
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
    if (step.ok) return { accept: frame, contract: frame.contract, room: dealRoom(frame.contract), seq: record.seq ?? null };
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

export async function verifyExactFrameRecord(raw, expected, room) {
  const expectedText = encodeFrame(expected);
  for (const record of records(raw)) {
    if (record.text !== expectedText || record.from !== expected.from) continue;
    if (await validTransportSignature(record, room)) return { seq: record.seq ?? null, record };
  }
  return null;
}

function recordTime(record, fallback) {
  return Number.isFinite(Date.parse(record.ts)) ? Date.parse(record.ts) : fallback;
}

export async function listMyPaperActivity(raw, myDid, now = Date.now()) {
  if (!/^did:key:z6Mk/.test(myDid)) return [];
  const verified = [];
  for (const record of records(raw)) {
    const frame = tryDecodeFrame(record.text || "");
    if (!frame || !["offer", "accept"].includes(frame.type)) continue;
    if (record.from !== frame.from || !(await validTransportSignature(record, OFFER_ROOM))) continue;
    verified.push({ record, frame });
  }

  const offers = new Map(verified.filter(({ frame }) => frame.type === "offer").map((item) => [item.frame.id, item]));
  const activity = [];
  for (const item of offers.values()) {
    const offer = item.frame;
    if (offer.from !== myDid || offer.role !== "payer" || offer.asset !== "PAPER" || offer.lock !== "hash" || !offer.rails?.includes("paper")) continue;
    let accepted = null;
    for (const candidate of verified) {
      if (candidate.frame.type !== "accept" || candidate.frame.ref !== offer.id || candidate.frame.from === myDid) continue;
      const step = applyFrame(openContract(offer), candidate.frame, recordTime(candidate.record, now));
      if (step.ok) { accepted = candidate; break; }
    }
    activity.push({
      role: "payer", offer, offerSeq: item.record.seq ?? null,
      accept: accepted?.frame || null, acceptSeq: accepted?.record.seq ?? null,
      contract: accepted?.frame.contract || null, room: accepted ? dealRoom(accepted.frame.contract) : null,
      status: accepted ? "accepted" : "offered", seqs: { offer: item.record.seq ?? null, accept: accepted?.record.seq ?? null },
    });
  }

  for (const candidate of verified) {
    const accept = candidate.frame;
    if (accept.type !== "accept" || accept.from !== myDid) continue;
    const offerItem = offers.get(accept.ref); if (!offerItem || offerItem.frame.from === myDid) continue;
    const offer = offerItem.frame;
    if (offer.role !== "payer" || offer.asset !== "PAPER" || offer.lock !== "hash" || !offer.rails?.includes("paper")) continue;
    const step = applyFrame(openContract(offer), accept, recordTime(candidate.record, now));
    if (!step.ok) continue;
    activity.push({
      role: "payee", offer, offerSeq: offerItem.record.seq ?? null,
      accept, acceptSeq: candidate.record.seq ?? null, contract: accept.contract, room: dealRoom(accept.contract),
      status: "accepted", seqs: { offer: offerItem.record.seq ?? null, accept: candidate.record.seq ?? null },
    });
  }
  return activity.sort((a, b) => Number(b.offerSeq || 0) - Number(a.offerSeq || 0));
}

export async function summarizeDealActivity(raw, offer, accept, now = Date.now()) {
  const folded = await foldPayeeDeal(raw, offer, accept, now);
  const seqs = {};
  for (const { seq, frame } of folded.applied) {
    if (["lock", "reveal", "refund", "cancel", "receipt"].includes(frame.type) && seqs[frame.type] == null) seqs[frame.type] = seq ?? null;
  }
  return { status: folded.state.status, room: folded.room, seqs };
}

export async function listSafePaperOffers(raw, myDid, now = Date.now()) {
  const decoded = records(raw).map((record) => ({ record, frame: tryDecodeFrame(record.text || "") }));
  const accepts = [];
  for (const item of decoded) {
    const { record, frame } = item;
    if (frame?.type !== "accept" || record.from !== frame.from) continue;
    if (await validTransportSignature(record, OFFER_ROOM)) accepts.push(item);
  }
  const offers = [];
  for (const { record, frame } of decoded) {
    if (frame?.type !== "offer" || frame.from === myDid || frame.role !== "payer") continue;
    if (frame.asset !== "PAPER" || frame.lock !== "hash" || !frame.rails.includes("paper")) continue;
    // Leave enough time for a human to review the evidence, accept, complete the
    // work, and reveal. Near-expiry offers create rushed, low-quality activity.
    if (!frame.job?.id || !frame.job.context || frame.expiresMs <= now + 10 * 60_000 || frame.claimByMs <= now + 30 * 60_000) continue;
    const safeContext = frame.job.context.startsWith("https://technocore.chat/") || /^\/kv\/[a-z0-9][a-z0-9_-]{0,47}\/[a-z0-9][a-z0-9_-]{0,47}$/.test(frame.job.context);
    if (!safeContext) continue;
    if (record.from !== frame.from || !(await validTransportSignature(record, OFFER_ROOM))) continue;
    const alreadyAccepted = accepts.some(({ record: acceptRecord, frame: accept }) => {
      if (accept.ref !== frame.id || accept.from === frame.from) return false;
      const acceptedAt = Number.isFinite(Date.parse(acceptRecord.ts)) ? Date.parse(acceptRecord.ts) : now;
      return applyFrame(openContract(frame), accept, acceptedAt).ok;
    });
    if (alreadyAccepted) continue;
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

async function sha256Hex(text) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function safeJobText(text) {
  const dangerousRequest = /(?:^|[.!?]\s*)(?:send|provide|share|upload|enter|reveal)\b[^.!?]{0,80}\b(?:secret|password|credential|private key|seed phrase|wallet|payment|real funds)\b/i;
  const realValueRequest = /(?:^|[.!?]\s*)(?:pay|transfer)\b[^.!?]{0,80}\b(?:fund|funds|usd|usdc|eth|flop|wallet)\b/i;
  const codeExecution = /\b(?:run|execute|install)\b[^.!?]{0,60}\b(?:code|script|command|package|binary)\b/i;
  const externalLink = [...text.matchAll(/https?:\/\/[^\s]+/gi)].some(([url]) => {
    try { return new URL(url).hostname !== "technocore.chat"; } catch { return true; }
  });
  return !dangerousRequest.test(text) && !realValueRequest.test(text) && !codeExecution.test(text) && !externalLink;
}

export async function reviewJobSpec(raw, offer) {
  const bound = await verifyBoundJobSpec(raw, offer);
  if (bound) return { ...bound, bound: true };
  const text = String(raw).split("\n").filter((line) => !line.startsWith("!!") && line.trim()).join("\n").trim();
  if (text.startsWith("job-spec-v1 ") || text.length < 20 || text.length > 2000 || !safeJobText(text)) return null;
  return { hash: await sha256Hex(text), text, bound: false };
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

export async function listSignedDeliveries(raw, accept) {
  const room = dealRoom(accept.contract);
  const deliveries = [];
  for (const record of records(raw)) {
    if (record.from !== accept.from || tryDecodeFrame(record.text || "")) continue;
    if (!(await validTransportSignature(record, room))) continue;
    const text = String(record.text || "").replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, " ").replace(/\s+/g, " ").trim();
    if (text.length < 20 || text.length > 4096) continue;
    deliveries.push({ seq: record.seq ?? null, ts: record.ts ?? null, text });
  }
  return deliveries.sort((left, right) => Number(left.seq || 0) - Number(right.seq || 0));
}

function countMatches(text, expression) {
  return [...text.matchAll(expression)].length;
}

export function evaluateObjectiveDelivery(jobText, deliveryText, offer) {
  const job = String(jobText || "").replace(/\s+/g, " ").trim();
  const delivery = String(deliveryText || "").replace(/\s+/g, " ").trim();
  const level = job.match(/^difficulty=(easy|medium|hard)\./i)?.[1]?.toLowerCase();
  if (!level) return { ok: false, reason: "This job has no supported deterministic validator" };
  if (/\bFAIL\b/i.test(delivery)) return { ok: false, reason: "Delivery reports a failed check" };

  const range = job.match(/(?:deliverable=.*?)\b(\d{2,4})\s*[-–]\s*(\d{2,4})\s+characters\b/i);
  if (range && (delivery.length < Number(range[1]) || delivery.length > Number(range[2]))) {
    return { ok: false, reason: `Delivery must be ${range[1]}-${range[2]} characters` };
  }

  const hash = offer?.job?.id?.match(/([0-9a-f]{64})$/i)?.[1]?.toLowerCase();
  if (hash && !delivery.toLowerCase().includes(hash)) return { ok: false, reason: "Exact job hash is missing" };
  if (/signer DID/i.test(job) && offer?.from && !delivery.includes(offer.from)) return { ok: false, reason: "Exact signer DID is missing" };
  if (/asset|paper-only|paper only/i.test(job) && !/\bPAPER\b/i.test(delivery)) return { ok: false, reason: "PAPER asset/rail result is missing" };
  if (/signature/i.test(job) && !/(?:signature|ed25519)[^.!?]{0,40}(?:valid|pass|true)|(?:valid|pass|true)[^.!?]{0,40}(?:signature|ed25519)/i.test(delivery)) {
    return { ok: false, reason: "A passing signature result is missing" };
  }

  if (level === "easy") {
    if (!/\bPASS\b/i.test(delivery)) return { ok: false, reason: "PASS result is missing" };
    return { ok: true, reason: "Easy template checks passed" };
  }
  if (level === "medium") {
    if (countMatches(delivery, /\bPASS\b/gi) < 4) return { ok: false, reason: "Four explicit PASS checks are required" };
    if (!/(?:expiresMs|expires)[^.!?]{0,80}(?:claimByMs|claim)[^.!?]{0,80}(?:refundAfterMs|refund)/i.test(delivery)) {
      return { ok: false, reason: "Deadline-order evidence is missing" };
    }
    return { ok: true, reason: "Medium template checks passed" };
  }

  const hardFields = ["jobHash", "signerDid", "signatureValid", "canonicalFrame", "paperOnly", "deadlineOrder", "overall"];
  for (const field of hardFields) if (!new RegExp(`[\"']?${field}[\"']?\\s*[:=]`, "i").test(delivery)) return { ok: false, reason: `${field} is missing` };
  if (!/[\"']?overall[\"']?\s*[:=]\s*(?:true|[\"']PASS[\"'])/i.test(delivery)) return { ok: false, reason: "Overall result is not PASS/true" };
  return { ok: true, reason: "Hard template checks passed" };
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
