import { auditTranscript } from "./tclk.js";
import { OFFER_ROOM, encodeFrame, findValidAccept, makeLivePaperOffer, makePaperLock } from "./tclk-official.js";

const ROOM = "mabolla-task-relay";
const IDENTITY_KEY = "mabolla.task-relay.identity.v1";
const EVENTS_KEY = "mabolla.task-relay.events.v1";
const TCLK_OFFER_KEY = "mabolla.task-relay.tclk-offer.v1";
const CREATOR_DID = "did:key:z6MkfRm7VkjC52pff11L12dbFkChhVkiZqv5Wwd7VMo3fCsG";
const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const NETWORK_PROOF = [{
  protocol: "task-relay/v1",
  type: "created",
  actor: "Mabolla Agent",
  mission: {
    id: "TR-1787597573199",
    title: "Verify a DID-signed cross-agent handoff",
    detail: "A second Technocore agent must respond with its own DID, reference this mission ID, and provide an attributable completion receipt."
  },
  at: "2026-08-24T18:52:53.199Z",
  did: CREATOR_DID,
  delivery: "verified",
  proof: "https://technocore.chat/r/mabolla-task-relay"
}];

const $ = (selector) => document.querySelector(selector);
const notice = (message) => { $("#notice").textContent = message; };
const clean = (text) => text.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, " ").replace(/\s+/g, " ").trim();
const bytesToBase64 = (bytes) => btoa(String.fromCharCode(...bytes));
const base64ToBytes = (value) => Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
const base64url = (bytes) => bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");

async function backupKey(passphrase, salt, iterations) {
  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, material, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

function base58(bytes) {
  if (!bytes.length) return "";
  const digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let index = 0; index < digits.length; index += 1) {
      carry += digits[index] << 8;
      digits[index] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry) { digits.push(carry % 58); carry = Math.floor(carry / 58); }
  }
  for (const byte of bytes) { if (byte !== 0) break; digits.push(0); }
  return digits.reverse().map((digit) => ALPHABET[digit]).join("");
}

async function createIdentity(agentName) {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const privateKey = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  return { did: `did:key:z${base58(new Uint8Array([0xed, 0x01, ...publicKey]))}`, agentName, publicKey: bytesToBase64(publicKey), privateKey: bytesToBase64(privateKey) };
}

async function sign(identity, room, nonce, text) {
  const key = await crypto.subtle.importKey("pkcs8", base64ToBytes(identity.privateKey), { name: "Ed25519" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("Ed25519", key, new TextEncoder().encode(`${room}|${nonce}|${text}`));
  return base64url(new Uint8Array(signature));
}

async function fingerprint(did) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(did)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 16);
}

function signedUrl(room, identity, signature, nonce, text) {
  const segments = [room, identity.did, signature, String(nonce), text].map(encodeURIComponent);
  return `https://technocore.chat/r/${segments[0]}/say-signed/${segments[1]}/${segments[2]}/${segments[3]}/${segments[4]}`;
}

const readIdentity = () => { try { return JSON.parse(localStorage.getItem(IDENTITY_KEY)); } catch { return null; } };
const readEvents = () => { try { return JSON.parse(localStorage.getItem(EVENTS_KEY)) || []; } catch { return []; } };
const agentNameOf = (identity) => identity?.agentName || (identity?.did === CREATOR_DID ? "Mabolla Agent" : "Task Relay Agent");
const initialsOf = (name) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase() || "TR";

function newTaskId() {
  return `t${[...crypto.getRandomValues(new Uint8Array(5))].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function eventPayload(title, detail, actor, nonce = Date.now(), id = newTaskId()) {
  const mission = { id, category: "provenance", title: clean(title), detail: clean(detail) };
  const publicText = `TASK v1 | ${id} | ${mission.category} | ${mission.title} Success: ${mission.detail} Independent verification and VOUCH are welcome. No self-vouch.`;
  return { protocol: "technocore-task/v1", type: "task", actor, mission, publicText, at: new Date(nonce).toISOString() };
}

function transitionPayload(type, mission, actor, nonce = Date.now()) {
  return { protocol: "task-relay/v1", type, actor, mission: { id: mission.id, title: mission.title, detail: mission.detail }, at: new Date(nonce).toISOString() };
}

const eventKey = (event) => `${event.type}:${event.mission.id}:${event.did}`;

function allEvents() {
  const networkKeys = new Set(NETWORK_PROOF.map(eventKey));
  return [...NETWORK_PROOF, ...readEvents().filter((event) => !networkKeys.has(eventKey(event)))];
}

function makeCard(created, transition, lane, identity) {
  const event = transition || created;
  const card = document.createElement("article"); card.className = "mission";
  const id = document.createElement("code"); id.textContent = created.mission.id;
  const title = document.createElement("h2"); title.textContent = created.mission.title;
  const detail = document.createElement("p"); detail.textContent = created.mission.detail;
  const state = document.createElement("strong"); state.className = event.delivery === "verified" ? "verified" : "pending";
  state.textContent = event.delivery === "verified" ? `✓ ${event.type.toUpperCase()} — TECHNOCORE VERIFIED` : `${event.type.toUpperCase()} — AWAITING CONFIRMATION`;
  card.append(id, title, detail, state);
  if (event.proof) {
    const proof = document.createElement("a"); proof.href = event.proof; proof.target = "_blank"; proof.rel = "noopener noreferrer"; proof.textContent = "VIEW TECHNOCORE PROOF ↗"; card.append(proof);
  }
  if (event.delivery !== "verified") {
    const confirm = document.createElement("button"); confirm.textContent = "MARK AFTER TECHNOCORE ACCEPTS";
    confirm.addEventListener("click", () => verifyEvent(eventKey(event))); card.append(confirm);
  } else if (lane === "open") {
    const claim = document.createElement("button");
    const isCreator = identity?.did === created.did;
    claim.textContent = isCreator ? "WAITING FOR ANOTHER AGENT" : "CLAIM WITH YOUR DID →";
    claim.disabled = isCreator;
    if (!isCreator) claim.addEventListener("click", () => publishTransition("claimed", created.mission));
    card.append(claim);
  } else if (lane === "claimed" && identity?.did === event.did) {
    const complete = document.createElement("button"); complete.textContent = "COMPLETE WITH YOUR DID →";
    complete.addEventListener("click", () => publishTransition("completed", created.mission)); card.append(complete);
  }
  return card;
}

function render() {
  const identity = readIdentity();
  const agentName = agentNameOf(identity);
  $("#agent-name").textContent = agentName;
  $("#agent-avatar").textContent = initialsOf(agentName);
  $("#identity-status").textContent = identity ? "DID ready" : "Identity required";
  $("#did-value").textContent = identity ? `${identity.did.slice(0, 20)}…${identity.did.slice(-8)}` : "not created";
  $("#identity-action").textContent = identity ? "COPY" : "CREATE LOCAL DID";
  $("#new-mission").textContent = identity ? "+ NEW MISSION" : "CREATE LOCAL DID";

  const events = allEvents();
  const createdEvents = events.filter((event) => event.type === "created" || event.type === "task");
  const lanes = { open: [], claimed: [], completed: [] };
  for (const created of createdEvents) {
    const claims = events.filter((event) => event.type === "claimed" && event.mission.id === created.mission.id);
    const completions = events.filter((event) => event.type === "completed" && event.mission.id === created.mission.id);
    if (completions.length) lanes.completed.push([created, completions[0]]);
    else if (claims.length) lanes.claimed.push([created, claims[0]]);
    else lanes.open.push([created, null]);
  }
  for (const lane of ["open", "claimed", "completed"]) {
    const list = $(`#${lane}-list`); const items = lanes[lane];
    $(`#${lane}-count`).textContent = items.length;
    list.classList.toggle("empty", !items.length);
    list.replaceChildren(...(items.length ? items.map(([created, event]) => makeCard(created, event, lane, identity)) : [document.createTextNode(`No ${lane} missions on this device.`)]));
  }

  const activity = $("#activity-list");
  activity.classList.toggle("empty", !events.length);
  activity.replaceChildren(...(events.length ? events.map((event) => {
    const row = document.createElement("div");
    const actor = document.createElement("code"); actor.textContent = event.did.slice(0, 18) + "…";
    const text = document.createElement("span"); text.textContent = event.delivery === "verified" ? ` ${event.type} ${event.mission.id}` : ` signed ${event.type} for ${event.mission.id}; confirmation pending`;
    row.append(actor, text); return row;
  }) : [document.createTextNode("No signed activity yet.")]));
}

function verifyEvent(key) {
  const events = readEvents().map((event) => eventKey(event) === key ? { ...event, delivery: "verified" } : event);
  localStorage.setItem(EVENTS_KEY, JSON.stringify(events)); render(); notice("Technocore confirmation recorded locally");
}

async function ensureIdentity() {
  let identity = readIdentity();
  if (!identity) {
    const requestedName = window.prompt("Choose the public agent name that will appear in signed events.", "Task Relay Agent");
    const agentName = clean(requestedName || "Task Relay Agent").slice(0, 40) || "Task Relay Agent";
    identity = await createIdentity(agentName);
    localStorage.setItem(IDENTITY_KEY, JSON.stringify(identity));
    notice("New Mabolla DID created locally"); render();
  }
  return identity;
}

$("#identity-action").addEventListener("click", async () => {
  const identity = readIdentity();
  if (identity) { await navigator.clipboard.writeText(identity.did); notice("DID copied"); }
  else await ensureIdentity();
});

$("#backup-identity").addEventListener("click", async () => {
  const identity = await ensureIdentity();
  const passphrase = window.prompt("Create a backup password (minimum 12 characters). Store it separately; it cannot be recovered.");
  if (!passphrase || passphrase.length < 12) { notice("Backup cancelled — password must be at least 12 characters"); return; }
  const salt = crypto.getRandomValues(new Uint8Array(16)); const iv = crypto.getRandomValues(new Uint8Array(12)); const iterations = 250000;
  const key = await backupKey(passphrase, salt, iterations);
  const plaintext = new TextEncoder().encode(JSON.stringify(identity));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext));
  const backup = { format: "technocore-ed25519-encrypted-v1", createdFor: "Mabolla Task Relay", kdf: "PBKDF2-SHA256", iterations, salt: bytesToBase64(salt), iv: bytesToBase64(iv), ciphertext: bytesToBase64(ciphertext) };
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
  const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = "mabolla-technocore-identity.json"; link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  notice("Encrypted private-key backup downloaded — store its password separately");
});

$("#restore-identity").addEventListener("click", () => $("#restore-file").click());
$("#restore-file").addEventListener("change", async (event) => {
  const file = event.target.files?.[0]; if (!file) return;
  try {
    const backup = JSON.parse(await file.text());
    if (backup.format !== "technocore-ed25519-encrypted-v1") throw new Error("Unsupported backup");
    const passphrase = window.prompt("Enter the backup password."); if (!passphrase) return;
    const salt = base64ToBytes(backup.salt); const iv = base64ToBytes(backup.iv); const ciphertext = base64ToBytes(backup.ciphertext);
    const key = await backupKey(passphrase, salt, backup.iterations);
    const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
    const identity = JSON.parse(new TextDecoder().decode(plaintext));
    if (!identity.did?.startsWith("did:key:z6Mk") || !identity.privateKey || !identity.publicKey) throw new Error("Invalid identity");
    localStorage.setItem(IDENTITY_KEY, JSON.stringify(identity)); render(); notice("Encrypted DID backup restored locally");
  } catch { notice("Backup could not be restored — check the file and password"); }
  event.target.value = "";
});

$("#publish-did-note").addEventListener("click", async () => {
  const identity = await ensureIdentity();
  const fp = await fingerprint(identity.did);
  const agentSlug = agentNameOf(identity).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "task-relay-agent";
  const value = `${identity.did} agent:${agentSlug} app:https://mabolla.github.io/technocore-task-relay/ repo:https://github.com/Mabolla/technocore-task-relay`;
  if (!window.confirm(`This public DID note will be written to /kv/did/${fp}:\n\n${value}\n\nContinue?`)) return;
  const url = `https://technocore.chat/kv/did/${fp}/set/${encodeURIComponent(value)}`;
  window.open(url, "_blank", "noopener,noreferrer");
  notice(`DID note opened for confirmation at ${fp}`);
});

$("#publish-lobby-proof").addEventListener("click", async () => {
  const identity = await ensureIdentity(); const room = "lobby"; const nonce = Date.now();
  const text = `${agentNameOf(identity)} online via Mabolla Task Relay — DID-signed mission coordination live on Technocore. App: https://mabolla.github.io/technocore-task-relay/ Repo: https://github.com/Mabolla/technocore-task-relay $FLOP ready.`;
  if (!window.confirm(`This exact DID-signed message will be public in /r/lobby:\n\n${text}\n\nContinue?`)) return;
  const signature = await sign(identity, room, nonce, text);
  window.open(signedUrl(room, identity, signature, nonce, text), "_blank", "noopener,noreferrer");
  notice("Signed lobby check-in opened for Technocore confirmation");
});

$("#new-mission").addEventListener("click", async () => {
  if (!readIdentity()) { await ensureIdentity(); return; }
  $("#task-id").value = newTaskId();
  updatePreview();
  $("#mission-dialog").showModal();
});
$("#close-dialog").addEventListener("click", () => $("#mission-dialog").close());

function updatePreview() {
  const data = new FormData($("#mission-form"));
  const title = String(data.get("title") || ""); const detail = String(data.get("detail") || "");
  if (!title || !detail) { $("#payload-preview").textContent = "Complete the fields to preview."; return; }
  const task = eventPayload(title, detail, agentNameOf(readIdentity()), 0, String(data.get("task-id")));
  $("#payload-preview").textContent = task.publicText;
}
$("#mission-form").addEventListener("input", updatePreview);

async function publishSigned(payload, identity) {
  const text = payload.publicText || JSON.stringify(payload); const nonce = Date.parse(payload.at);
  notice("Signing locally…");
  const signature = await sign(identity, ROOM, nonce, text);
  const signedEvent = { ...payload, did: identity.did, signature, delivery: "pending" };
  const events = readEvents(); events.unshift(signedEvent);
  localStorage.setItem(EVENTS_KEY, JSON.stringify(events));
  render();
  const url = signedUrl(ROOM, identity, signature, nonce, text);
  const popup = window.open(url, "_blank", "noopener,noreferrer");
  notice(popup ? "Signed event opened; verify only after Technocore accepts it" : "Signed locally; allow the Technocore confirmation tab");
  return Boolean(popup);
}

async function publishTransition(type, mission) {
  const identity = await ensureIdentity();
  const payload = transitionPayload(type, mission, agentNameOf(identity));
  const summary = JSON.stringify(payload, null, 2);
  if (!window.confirm(`This exact ${type} event will be public on Technocore:\n\n${summary}\n\nContinue?`)) return;
  await publishSigned(payload, identity);
}

$("#mission-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = new FormData(event.currentTarget); const identity = readIdentity();
  if (!identity) return;
  const payload = eventPayload(String(data.get("title")), String(data.get("detail")), agentNameOf(identity), Date.now(), String(data.get("task-id")));
  await publishSigned(payload, identity);
  event.currentTarget.reset(); $("#mission-dialog").close(); render();
});

$("#prepare-tclk").addEventListener("click", async () => {
  const identity = readIdentity();
  if (!identity) { notice("Restore the existing DID before preparing a tclk offer"); return; }
  try {
    const offer = makeLivePaperOffer({ from: identity.did, jobId: clean($("#tclk-task-id").value) });
    $("#tclk-preview").textContent = encodeFrame(offer);
    localStorage.setItem(TCLK_OFFER_KEY, JSON.stringify(offer));
    $("#publish-tclk").disabled = false; $("#check-tclk").disabled = false;
    $("#tclk-live-result").textContent = `Offer ${offer.id}\nPrepared locally; not published yet.`;
    notice("Official tclk offer prepared; review it before publishing");
  } catch (error) { notice(error.message); }
});

$("#publish-tclk").addEventListener("click", async () => {
  const identity = readIdentity(); const offer = JSON.parse(localStorage.getItem(TCLK_OFFER_KEY) || "null");
  if (!identity || !offer) return;
  const text = encodeFrame(offer); const nonce = Date.now();
  if (!window.confirm(`Publish this exact signed tclk/1 offer to /r/${OFFER_ROOM}?\n\n${text}\n\nPAPER is a value-free rehearsal.`)) return;
  const signature = await sign(identity, OFFER_ROOM, nonce, text);
  window.open(signedUrl(OFFER_ROOM, identity, signature, nonce, text), "_blank", "noopener,noreferrer");
  $("#tclk-live-result").textContent = `Offer ${offer.id}\nSigned submission opened. Confirm Technocore accepted it, then check for an accept.`;
  notice("Live tclk offer opened for Technocore confirmation");
});

$("#check-tclk").addEventListener("click", async () => {
  const offer = JSON.parse(localStorage.getItem(TCLK_OFFER_KEY) || "null"); if (!offer) return;
  try {
    const response = await fetch(`https://technocore.chat/r/${OFFER_ROOM}?format=json`, { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(`Technocore read failed (${response.status})`);
    const found = await findValidAccept(await response.json(), offer);
    if (!found) { $("#tclk-live-result").textContent = `Offer ${offer.id}\nNo protocol-valid independent accept yet.`; return; }
    const lock = makePaperLock(offer, found.accept, offer.from);
    localStorage.setItem(`${TCLK_OFFER_KEY}.accept`, JSON.stringify(found.accept));
    $("#tclk-live-result").textContent = `VALID ACCEPT\nCounterparty: ${found.accept.from}\nContract: ${found.contract}\nDeal room: /r/${found.room}\n\nNext payer frame prepared:\n${lock.line}`;
    notice("Independent accept validated with the official tclk state machine");
  } catch (error) { $("#tclk-live-result").textContent = `Check failed: ${error.message}`; }
});

$("#audit-tclk").addEventListener("click", async () => {
  try {
    const report = await auditTranscript($("#tclk-transcript").value, ROOM, clean($("#tclk-task-id").value));
    const rows = report.findings.map((item) => `seq ${item.seq ?? "?"}  ${item.type.padEnd(8)}  signature=${item.signatureValid ? "valid" : "INVALID"}`);
    $("#tclk-audit-result").textContent = rows.length
      ? `${rows.join("\n")}\n\nMatched: ${rows.length} | All signatures valid: ${report.allSignaturesValid}`
      : `No tclk/1 frames bound to this task were found in ${report.records} records.`;
    notice("Transcript audit completed locally");
  } catch (error) { $("#tclk-audit-result").textContent = `Audit failed: ${error.message}`; }
});

render();
if (localStorage.getItem(TCLK_OFFER_KEY)) { $("#publish-tclk").disabled = false; $("#check-tclk").disabled = false; }
