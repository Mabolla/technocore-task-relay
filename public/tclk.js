const PREFIX = "tclk1 ";
const OFFER_DOMAIN = "FLOP::tclk::v1|offer|";

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).filter((key) => value[key] !== undefined).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function asciiJson(value) {
  return JSON.stringify(canonical(value)).replace(/[\u007f-\uffff]/g, (character) =>
    `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

async function sha256Hex(text) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function makePaperOffer({ from, jobId, now = Date.now(), nonce }) {
  if (!/^did:key:z6Mk/.test(from)) throw new Error("A local Ed25519 DID is required");
  if (!/^t[0-9a-f]{10}$/.test(jobId)) throw new Error("Choose a local TASK v1 id");
  const core = {
    amount: "1", asset: "PAPER", claimByMs: now + 12 * 60 * 60 * 1000,
    expiresMs: now + 60 * 60 * 1000, from,
    job: { id: jobId, proto: "technocore-task" }, lock: "hash",
    nonce: nonce || [...crypto.getRandomValues(new Uint8Array(8))].map((byte) => byte.toString(16).padStart(2, "0")).join(""),
    rails: ["paper"], refundAfterMs: now + 24 * 60 * 60 * 1000,
    role: "payer", type: "offer"
  };
  return { ...core, id: `0x${await sha256Hex(OFFER_DOMAIN + asciiJson(core))}` };
}

export function encodeFrame(frame) { return PREFIX + asciiJson(frame); }

export function decodeFrame(text) {
  if (!text.startsWith(PREFIX)) throw new Error("Not a tclk/1 frame");
  const frame = JSON.parse(text.slice(PREFIX.length));
  if (!frame || typeof frame !== "object" || Array.isArray(frame) || typeof frame.type !== "string" || typeof frame.from !== "string") throw new Error("Malformed tclk/1 frame");
  return frame;
}

function base58Decode(value) {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const bytes = [0];
  for (const character of value) {
    const digit = alphabet.indexOf(character); if (digit < 0) throw new Error("Invalid base58 DID");
    let carry = digit;
    for (let index = 0; index < bytes.length; index += 1) { carry += bytes[index] * 58; bytes[index] = carry & 255; carry >>= 8; }
    while (carry) { bytes.push(carry & 255); carry >>= 8; }
  }
  for (const character of value) { if (character !== "1") break; bytes.push(0); }
  return Uint8Array.from(bytes.reverse());
}

function base64urlBytes(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

async function verifyRecord(room, record) {
  if (!record.sig || record.nonce === undefined || !record.from) return false;
  const decoded = base58Decode(record.from.replace(/^did:key:z/, ""));
  if (decoded[0] !== 0xed || decoded[1] !== 0x01 || decoded.length !== 34) return false;
  const key = await crypto.subtle.importKey("raw", decoded.slice(2), { name: "Ed25519" }, false, ["verify"]);
  const message = new TextEncoder().encode(`${room}|${record.nonce}|${record.text}`);
  return crypto.subtle.verify("Ed25519", key, base64urlBytes(record.sig), message);
}

function recordsFromExport(raw) {
  const trimmed = raw.trim(); if (!trimmed) return [];
  try { const parsed = JSON.parse(trimmed); if (Array.isArray(parsed)) return parsed; if (Array.isArray(parsed.messages)) return parsed.messages; } catch {}
  return trimmed.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

export async function auditTranscript(raw, room, jobId) {
  const records = recordsFromExport(raw); const findings = []; const ids = new Set();
  for (const record of records) {
    let frame; try { frame = decodeFrame(record.text || ""); } catch { continue; }
    const belongs = frame.job?.id === jobId || ids.has(frame.ref) || ids.has(frame.contract);
    if (!belongs) continue;
    if (frame.id) ids.add(frame.id); if (frame.contract) ids.add(frame.contract);
    const signatureValid = frame.from === record.from && await verifyRecord(room, record).catch(() => false);
    findings.push({ seq: record.seq, type: frame.type, signatureValid, frame });
  }
  return { records: records.length, findings, allSignaturesValid: findings.length > 0 && findings.every((item) => item.signatureValid) };
}
