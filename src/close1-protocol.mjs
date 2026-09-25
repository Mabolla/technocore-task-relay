const DEFAULT_BASE_URL = "https://technocore.chat";

export const CLOSE1_SEASON = "close-1";
export const CLOSE1_TRADING_ROOM = "close1";
export const CLOSE1_CONTROL_ROOM = "mabolla-close1";
export const CLOSE1_AGENT_DID = "did:key:z6MkfRm7VkjC52pff11L12dbFkChhVkiZqv5Wwd7VMo3fCsG";
export const CLOSE1_REFEREE_DID = "did:key:z6MkowHQwsx9xr84WbWN3YCnKutyBnBXkT1ChKY4uEAAMzte";
export const CLOSE1_MANIFEST_SHA256 = "bae09812e25eb6f1369c611f24964f7ea0acafddfc45301a16f33f941296dafa";
export const CLOSE1_LOCK_SWEEP = 2556;
export const CLOSE1_LOCK_AT = "2026-10-04T09:00:00.000Z";
export const CLOSE1_REGISTRATION_REQUEST_ID = "mabolla-close1-owner-v1";

export const CLOSE1_REFEREE_ROOMS = Object.freeze([
  "d-close1-flow",
  "d-close1-state",
  "d-close1-price",
  "d-close1-positions",
  "d-close1-pnl"
]);

export const CLOSE1_SEED_RECORD = Object.freeze({
  seq: 1,
  ts: "2026-09-25T12:05:22.575364Z",
  from: CLOSE1_REFEREE_DID,
  text: "{\"for\":1,\"limits\":[\"214.84\",\"237.44\"],\"package\":\"bae09812e25eb6f1369c611f24964f7ea0acafddfc45301a16f33f941296dafa\",\"price\":\"226.14\",\"rooms\":[\"d-close1-flow\",\"d-close1-state\",\"d-close1-price\",\"d-close1-positions\",\"d-close1-pnl\"],\"season\":\"close-1\",\"t\":\"seed\",\"trade\":{\"tid\":626256716983248,\"time\":\"2026-09-25T11:59:42.666000Z\"}}",
  nonce: 1790337922535,
  sig: "j3_asvvwrt67C13PdoA2Q1p0QfO24av1hvkC_2Nc5FJet9dKey97CFuKv1ZW9G7Ki4hxw86K-2dfhIjAjhlsCw"
});

function base58Decode(value) {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const bytes = [0];
  for (const character of value) {
    const digit = alphabet.indexOf(character);
    if (digit < 0) throw new Error("Invalid base58 DID");
    let carry = digit;
    for (let index = 0; index < bytes.length; index += 1) {
      carry += bytes[index] * 58;
      bytes[index] = carry & 255;
      carry >>= 8;
    }
    while (carry) {
      bytes.push(carry & 255);
      carry >>= 8;
    }
  }
  for (const character of value) {
    if (character !== "1") break;
    bytes.push(0);
  }
  return Uint8Array.from(bytes.reverse());
}

function base64urlBytes(value) {
  const normalized = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

function base64Bytes(value) {
  return Uint8Array.from(atob(String(value || "")), (character) => character.charCodeAt(0));
}

function bytesBase64url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function recordTimestampMs(record) {
  const value = record?.ts ?? record?.at ?? record?.timestamp;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
  return Date.parse(String(value || ""));
}

function requireIdentity(env) {
  if (env?.TECHNOCORE_AGENT_DID !== CLOSE1_AGENT_DID) {
    throw new Error("TECHNOCORE_AGENT_DID does not match the Mabolla identity");
  }
  if (!env?.TECHNOCORE_AGENT_PRIVATE_KEY) throw new Error("TECHNOCORE_AGENT_PRIVATE_KEY is required");
}

export function close1OwnerText(did = CLOSE1_AGENT_DID) {
  return JSON.stringify({ t: "owner", season: CLOSE1_SEASON, key: did });
}

export async function verifySignedRecord(room, record, expectedDid) {
  if (record?.from !== expectedDid || !record?.sig || record?.nonce === undefined || typeof record?.text !== "string") {
    return false;
  }
  const decoded = base58Decode(expectedDid.replace(/^did:key:z/, ""));
  if (decoded[0] !== 0xed || decoded[1] !== 0x01 || decoded.length !== 34) return false;
  const key = await crypto.subtle.importKey("raw", decoded.slice(2), { name: "Ed25519" }, false, ["verify"]);
  const signed = new TextEncoder().encode(`${room}|${record.nonce}|${record.text}`);
  return crypto.subtle.verify("Ed25519", key, base64urlBytes(record.sig), signed);
}

async function signRecord(room, nonce, text, privateKeyBase64) {
  const key = await crypto.subtle.importKey(
    "pkcs8",
    base64Bytes(privateKeyBase64),
    { name: "Ed25519" },
    false,
    ["sign"]
  );
  const payload = new TextEncoder().encode(`${room}|${nonce}|${text}`);
  const signature = await crypto.subtle.sign("Ed25519", key, payload);
  return bytesBase64url(new Uint8Array(signature));
}

export async function verifyPinnedSeed() {
  if (!await verifySignedRecord("d-close1-price", CLOSE1_SEED_RECORD, CLOSE1_REFEREE_DID)) return false;
  let seed;
  try { seed = JSON.parse(CLOSE1_SEED_RECORD.text); } catch { return false; }
  return seed?.t === "seed"
    && seed?.season === CLOSE1_SEASON
    && seed?.package === CLOSE1_MANIFEST_SHA256
    && seed?.for === 1
    && seed?.price === "226.14"
    && JSON.stringify(seed?.rooms) === JSON.stringify(CLOSE1_REFEREE_ROOMS)
    && seed?.trade?.time === "2026-09-25T11:59:42.666000Z"
    && seed?.trade?.tid === 626256716983248;
}

async function readJson(url, fetchImpl) {
  const response = await fetchImpl(url, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`Technocore read failed: ${response.status}`);
  return response.json();
}

async function readControlExport(baseUrl, fetchImpl, now) {
  const response = await fetchImpl(`${baseUrl}/r/${CLOSE1_CONTROL_ROOM}/export?n=${now}`, {
    headers: { accept: "application/x-ndjson" }
  });
  if (response.status === 404) return [];
  if (!response.ok) throw new Error(`Technocore control read failed: ${response.status}`);
  const text = await response.text();
  if (text.length > 256_000) throw new Error("Close-1 control journal exceeds safe size");
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  if (lines.length > 200) throw new Error("Close-1 control journal exceeds safe record count");
  return lines.map((line) => {
    let record;
    try { record = JSON.parse(line); } catch { throw new Error("Close-1 control journal contains invalid JSON"); }
    if (!Number.isSafeInteger(Number(record?.seq)) || typeof record?.text !== "string") {
      throw new Error("Close-1 control journal contains an invalid record");
    }
    return record;
  });
}

async function publishSignedRecord(room, text, env, fetchImpl, nonceValue) {
  requireIdentity(env);
  const nonce = String(nonceValue);
  const sig = await signRecord(room, nonce, text, env.TECHNOCORE_AGENT_PRIVATE_KEY);
  const baseUrl = env.TECHNOCORE_URL || DEFAULT_BASE_URL;
  const response = await fetchImpl(`${baseUrl}/r/${encodeURIComponent(room)}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ did: CLOSE1_AGENT_DID, sig, nonce, text })
  });
  const responseText = await response.text();
  if (!response.ok) {
    const detail = responseText.replace(/\s+/g, " ").trim().slice(0, 160);
    throw new Error(`Technocore publish failed: ${response.status}${detail ? ` (${detail})` : ""}`);
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const confirmation = await readJson(
      `${baseUrl}/r/${encodeURIComponent(room)}?limit=200&format=json&n=${nonce}-${attempt}`,
      fetchImpl
    );
    const accepted = (confirmation?.messages || []).find((record) =>
      record?.from === CLOSE1_AGENT_DID
        && String(record?.nonce) === nonce
        && record?.text === text
        && record?.sig === sig
    );
    if (accepted?.seq) return accepted;
  }
  throw new Error("Technocore did not confirm the exact signed close-1 record");
}

function registrationIntentText(observedSweep) {
  return JSON.stringify({
    type: "close1.registration.intent.v1",
    season: CLOSE1_SEASON,
    did: CLOSE1_AGENT_DID,
    observed_sweep: observedSweep,
    package_sha256: CLOSE1_MANIFEST_SHA256,
    request_id: CLOSE1_REGISTRATION_REQUEST_ID
  });
}

function registrationReceiptText(registration, observedSweep) {
  return JSON.stringify({
    type: "close1.registration.receipt.v1",
    season: CLOSE1_SEASON,
    did: CLOSE1_AGENT_DID,
    observed_sweep: observedSweep,
    registration_room: CLOSE1_TRADING_ROOM,
    registration_seq: Number(registration.seq),
    registration_nonce: String(registration.nonce),
    registration_sig: registration.sig,
    request_id: CLOSE1_REGISTRATION_REQUEST_ID
  });
}

async function verifiedJournalEntries(records) {
  const entries = [];
  for (const record of records) {
    if (record?.from !== CLOSE1_AGENT_DID) continue;
    if (!await verifySignedRecord(CLOSE1_CONTROL_ROOM, record, CLOSE1_AGENT_DID).catch(() => false)) continue;
    let body;
    try { body = JSON.parse(record.text); } catch { continue; }
    if (body?.season === CLOSE1_SEASON && body?.did === CLOSE1_AGENT_DID) entries.push({ record, body });
  }
  return entries;
}

async function latestVerifiedPrice(baseUrl, fetchImpl, now) {
  const payload = await readJson(`${baseUrl}/r/d-close1-price?limit=8&format=json&n=${now}`, fetchImpl);
  const verified = [];
  for (const record of payload?.messages || []) {
    if (!await verifySignedRecord("d-close1-price", record, CLOSE1_REFEREE_DID).catch(() => false)) continue;
    let body;
    try { body = JSON.parse(record.text); } catch { continue; }
    if (body?.t !== "price" || !Number.isSafeInteger(body?.n) || body.n < 1 || body.n > CLOSE1_LOCK_SWEEP) continue;
    if (!Array.isArray(body?.limits) || body.limits.length !== 2 || !/^[a-f0-9]{64}$/.test(body?.file || "")) continue;
    verified.push({ record, body });
  }
  verified.sort((left, right) => left.body.n - right.body.n);
  return verified.at(-1) || null;
}

export async function registerClose1Owner(env, options = {}) {
  requireIdentity(env);
  if (String(env.CLOSE1_REGISTRATION_ENABLED || "").toLowerCase() !== "true") return { action: "disabled" };
  if (!await verifyPinnedSeed()) throw new Error("Pinned close-1 seed verification failed");

  const now = Number(options.now || Date.now());
  const fetchImpl = options.fetch || fetch;
  const baseUrl = env.TECHNOCORE_URL || DEFAULT_BASE_URL;
  const journal = await verifiedJournalEntries(await readControlExport(baseUrl, fetchImpl, now));
  let receipt;
  for (const entry of journal) {
    const body = entry.body;
    if (body?.type !== "close1.registration.receipt.v1"
      || body?.request_id !== CLOSE1_REGISTRATION_REQUEST_ID
      || body?.registration_room !== CLOSE1_TRADING_ROOM
      || !Number.isSafeInteger(body?.registration_seq)
      || !Number.isSafeInteger(body?.observed_sweep)
      || !/^\d+$/.test(body?.registration_nonce || "")
      || !/^[A-Za-z0-9_-]{86}$/.test(body?.registration_sig || "")) continue;
    const registration = {
      from: CLOSE1_AGENT_DID,
      nonce: body.registration_nonce,
      text: close1OwnerText(),
      sig: body.registration_sig
    };
    if (await verifySignedRecord(CLOSE1_TRADING_ROOM, registration, CLOSE1_AGENT_DID).catch(() => false)) {
      receipt = entry;
      break;
    }
  }
  if (receipt) {
    return {
      action: "already-registered",
      registrationSeq: receipt.body.registration_seq,
      observedSweep: receipt.body.observed_sweep
    };
  }

  const unresolved = journal.find(({ body }) =>
    body?.type === "close1.registration.intent.v1"
      && body?.request_id === CLOSE1_REGISTRATION_REQUEST_ID
  );
  if (unresolved) return { action: "blocked", reason: "unresolved-registration-intent" };

  const price = await latestVerifiedPrice(baseUrl, fetchImpl, now);
  if (!price) return { action: "blocked", reason: "no-verified-price" };
  const priceAge = now - recordTimestampMs(price.record);
  if (!Number.isFinite(priceAge) || priceAge < 0 || priceAge > 20 * 60 * 1000) {
    return { action: "blocked", reason: "stale-verified-price" };
  }

  let nonce = Math.trunc(now);
  const intent = await publishSignedRecord(
    CLOSE1_CONTROL_ROOM,
    registrationIntentText(price.body.n),
    env,
    fetchImpl,
    nonce
  );
  nonce = Math.max(nonce + 1, Date.now());
  const registration = await publishSignedRecord(
    CLOSE1_TRADING_ROOM,
    close1OwnerText(),
    env,
    fetchImpl,
    nonce
  );
  nonce = Math.max(nonce + 1, Date.now());
  const journalReceipt = await publishSignedRecord(
    CLOSE1_CONTROL_ROOM,
    registrationReceiptText(registration, price.body.n),
    env,
    fetchImpl,
    nonce
  );
  return {
    action: "registered",
    registrationSeq: Number(registration.seq),
    journalIntentSeq: Number(intent.seq),
    journalReceiptSeq: Number(journalReceipt.seq),
    observedSweep: price.body.n
  };
}

function parseRefereeMessage(room, record) {
  let body;
  try { body = JSON.parse(record.text); } catch { return null; }
  const expectedType = room.replace(/^d-close1-/, "");
  if (body?.t !== expectedType || !Number.isSafeInteger(body?.n) || body.n < 1 || body.n > CLOSE1_LOCK_SWEEP) return null;
  if (!/^[a-f0-9]{64}$/.test(body?.file || "")) return null;
  return body;
}

export async function observeClose1(env, options = {}) {
  if (env?.TECHNOCORE_AGENT_DID !== CLOSE1_AGENT_DID) {
    throw new Error("TECHNOCORE_AGENT_DID does not match the Mabolla identity");
  }
  if (!await verifyPinnedSeed()) throw new Error("Pinned close-1 seed verification failed");
  const now = Number(options.now || Date.now());
  const fetchImpl = options.fetch || fetch;
  const baseUrl = env.TECHNOCORE_URL || DEFAULT_BASE_URL;
  const roomRecords = await Promise.all(CLOSE1_REFEREE_ROOMS.map(async (room) => {
    const payload = await readJson(`${baseUrl}/r/${room}?limit=8&format=json&n=${now}`, fetchImpl);
    const valid = [];
    for (const record of payload?.messages || []) {
      if (!await verifySignedRecord(room, record, CLOSE1_REFEREE_DID).catch(() => false)) continue;
      const body = parseRefereeMessage(room, record);
      if (body) valid.push({ record, body });
    }
    return [room, valid];
  }));

  const byRoom = new Map(roomRecords);
  const common = new Set((byRoom.get(CLOSE1_REFEREE_ROOMS[0]) || []).map(({ body }) => body.n));
  for (const room of CLOSE1_REFEREE_ROOMS.slice(1)) {
    const present = new Set((byRoom.get(room) || []).map(({ body }) => body.n));
    for (const n of [...common]) if (!present.has(n)) common.delete(n);
  }
  const sweep = [...common].sort((left, right) => right - left)[0];
  if (!Number.isSafeInteger(sweep)) return { action: "blocked", reason: "no-common-signed-sweep" };

  const selected = Object.fromEntries(CLOSE1_REFEREE_ROOMS.map((room) => {
    const item = (byRoom.get(room) || []).find(({ body }) => body.n === sweep);
    return [room, item];
  }));
  const files = new Set(Object.values(selected).map(({ body }) => body.file));
  if (files.size !== 1) return { action: "blocked", reason: "sweep-file-mismatch", sweep };
  const newestTimestamp = Math.max(...Object.values(selected).map(({ record }) => recordTimestampMs(record)));
  const age = now - newestTimestamp;
  if (!Number.isFinite(age) || age < 0 || age > 20 * 60 * 1000) {
    return { action: "blocked", reason: "stale-signed-sweep", sweep };
  }

  const price = selected["d-close1-price"].body;
  const state = selected["d-close1-state"].body;
  const pnl = selected["d-close1-pnl"].body;
  return {
    action: "healthy",
    sweep,
    file: price.file,
    reference: price.ref?.px,
    limits: price.limits,
    global: price.global,
    owners: state.owners,
    rooms: state.rooms,
    mark: pnl.mark,
    tradingEnabled: String(env.CLOSE1_TRADING_ENABLED || "").toLowerCase() === "true"
  };
}
