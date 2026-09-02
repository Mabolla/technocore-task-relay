import { OFFER_ROOM, applyFrame, dealRoom, encodeFrame, makeOffer, openContract, paperNote, tryDecodeFrame } from "@flop-labs/tclk";

export { OFFER_ROOM, encodeFrame };

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
async function validTransportSignature(record) {
  if (!record.sig || !record.nonce || !record.from?.startsWith("did:key:z")) return false;
  const decoded = base58Decode(record.from.slice("did:key:z".length));
  if (!decoded || decoded.length !== 34 || decoded[0] !== 0xed || decoded[1] !== 0x01) return false;
  try {
    const key = await crypto.subtle.importKey("raw", decoded.slice(2), { name: "Ed25519" }, false, ["verify"]);
    return crypto.subtle.verify("Ed25519", key, base64urlBytes(record.sig), new TextEncoder().encode(`${OFFER_ROOM}|${record.nonce}|${record.text}`));
  } catch { return false; }
}

export async function findValidAccept(raw, offer, now = Date.now()) {
  for (const record of records(raw)) {
    const frame = tryDecodeFrame(record.text || "");
    if (frame?.type !== "accept" || frame.ref !== offer.id || frame.from === offer.from) continue;
    if (record.from !== frame.from || !(await validTransportSignature(record))) continue;
    const acceptedAt = Number.isFinite(Date.parse(record.ts)) ? Date.parse(record.ts) : now;
    const step = applyFrame(openContract(offer), frame, acceptedAt);
    if (step.ok) return { accept: frame, contract: frame.contract, room: dealRoom(frame.contract) };
  }
  return null;
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
