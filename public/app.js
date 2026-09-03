import { auditTranscript } from "./tclk.js";
import { JOB_TEMPLATES, OFFER_ROOM, classifyPaperRecord, encodeFrame, expectedPaperClaim, expectedPaperLock, expectedPaperRefund, findValidAccept, foldPayeeDeal, listMyPaperActivity, listSafePaperOffers, makeJobOffer, makePaperLock, makePayeeAcceptance, makePayeeReceipt, makePayeeReveal, makePayerRefund, reviewJobSpec, summarizeDealActivity, verifyAcceptRecord, verifyBoundJobSpec, verifyExactFrameRecord } from "./tclk-official.js";

const ROOM = "mabolla-task-relay";
const IDENTITY_KEY = "mabolla.task-relay.identity.v1";
const EVENTS_KEY = "mabolla.task-relay.events.v1";
const TCLK_OFFER_KEY = "mabolla.task-relay.tclk-offer.v1";
const TCLK_JOB_KEY = "mabolla.task-relay.tclk-job.v1";
const TCLK_PAYER_DEAL_KEY = "mabolla.task-relay.tclk-payer-deal.v1";
const PAYEE_DEAL_KEY = "mabolla.task-relay.tclk-payee-deal.v1";
const TRACK_RECORD_KEY = "mabolla.task-relay.tclk-track-record.v1";
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

async function dealVaultKey(passphrase, salt, iterations) {
  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, material, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
async function sealSecret(passphrase, contract, secret) {
  const salt = crypto.getRandomValues(new Uint8Array(16)); const iv = crypto.getRandomValues(new Uint8Array(12)); const iterations = 250000;
  const key = await dealVaultKey(passphrase, salt, iterations);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(contract) }, key, new TextEncoder().encode(secret));
  return { salt: bytesToBase64(salt), iv: bytesToBase64(iv), iterations, ciphertext: bytesToBase64(new Uint8Array(ciphertext)) };
}
async function openSecret(passphrase, contract, sealed) {
  const key = await dealVaultKey(passphrase, base64ToBytes(sealed.salt), sealed.iterations);
  const bytes = await crypto.subtle.decrypt({ name: "AES-GCM", iv: base64ToBytes(sealed.iv), additionalData: new TextEncoder().encode(contract) }, key, base64ToBytes(sealed.ciphertext));
  return new TextDecoder().decode(bytes);
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
const readPayerDeal = () => { try { return JSON.parse(localStorage.getItem(TCLK_PAYER_DEAL_KEY)); } catch { return null; } };

function renderPayerDeal() {
  const deal = readPayerDeal();
  const lockSubmissionPending = deal?.state === "lock-submitted" || deal?.state === "lock-submission-opened";
  $("#open-payer-room").disabled = !deal;
  $("#check-payer-deal").disabled = !deal;
  const terminal = (deal?.state === "claimed" && deal?.railState === "claimed") || (deal?.state === "refunded" && deal?.railState === "refunded");
  $("#refund-payer-deal").disabled = !(deal?.state === "locked" && deal?.railState === "locked" && Date.now() >= deal.offer.refundAfterMs);
  $("#publish-payer-receipt").disabled = !terminal;
  if (!deal) {
    $("#payer-deal-status").textContent = "No active payer deal saved in this browser.";
    return;
  }
  const state = lockSubmissionPending ? "lock submission opened — NOT VERIFIED" : (deal.state || "accepted / lock prepared");
  const rail = deal.railState || "check required";
  const next = (state === "claimed" && rail === "claimed") || (state === "refunded" && rail === "refunded")
    ? "NEXT: Sign the terminal receipt to archive the outcome."
    : lockSubmissionPending
      ? "NEXT: The signed lock is not confirmed on Technocore. If its tab returned 400, wait for a slot and press VERIFY & PUBLISH SIGNED LOCK again. After Technocore says ok, press VERIFY LOCK / CHECK RESULT."
    : state === "accepted" || state === "accepted / lock prepared"
      ? "NEXT: The deal is accepted, but its signed lock is not in the deal-room transcript. Create or verify PaperRail, then press VERIFY & PUBLISH SIGNED LOCK."
    : state === "claimed"
      ? "NEXT: Wait for the payee to advance PaperRail, then check again."
      : state === "locked" && rail === "locked" && Date.now() >= deal.offer.refundAfterMs
        ? "NEXT: The deadline passed without reveal. Refund the expired deal."
      : "NEXT: Wait for the payee's signed result/reveal, then press VERIFY LOCK / CHECK RESULT.";
  $("#payer-deal-status").textContent = `Contract: ${deal.accept.contract}\nCounterparty: ${deal.accept.from}\nDeal room: /r/${deal.lock.room}\nTranscript state: ${state}\nPaperRail state: ${rail}\n${next}`;
}
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

const jobBuilderFields = {
  description: $("#tclk-description"),
  deliverable: $("#tclk-deliverable"),
  successCriteria: $("#tclk-success"),
  acceptHours: $("#tclk-accept-hours"),
  claimHours: $("#tclk-claim-hours"),
  refundHours: $("#tclk-refund-hours"),
  amount: $("#tclk-amount"),
};

function applyJobTemplate(level) {
  const template = JOB_TEMPLATES[level];
  if (template) {
    for (const [name, field] of Object.entries(jobBuilderFields)) field.value = template[name];
  } else {
    jobBuilderFields.description.value = "";
    jobBuilderFields.deliverable.value = "";
    jobBuilderFields.successCriteria.value = "";
    jobBuilderFields.acceptHours.value = 2;
    jobBuilderFields.claimHours.value = 6;
    jobBuilderFields.refundHours.value = 8;
    jobBuilderFields.amount.value = "1000000";
  }
}

$("#tclk-difficulty").addEventListener("change", (event) => {
  applyJobTemplate(event.target.value);
  $("#publish-job-spec").disabled = true;
  $("#verify-job-spec").disabled = true;
  $("#publish-tclk").disabled = true;
  $("#tclk-preview").textContent = "Template loaded. Review or edit the job, then prepare the offer.";
});

for (const field of Object.values(jobBuilderFields)) field.addEventListener("input", () => {
  if (!localStorage.getItem(TCLK_JOB_KEY)) return;
  $("#publish-job-spec").disabled = true;
  $("#verify-job-spec").disabled = true;
  $("#publish-tclk").disabled = true;
  $("#tclk-preview").textContent = "Job fields changed. Prepare again to bind the new text and deadlines.";
});

applyJobTemplate("easy");

$("#prepare-tclk").addEventListener("click", async () => {
  const identity = readIdentity();
  if (!identity) { notice("Restore the existing DID before preparing a tclk offer"); return; }
  try {
    const difficulty = $("#tclk-difficulty").value;
    const prepared = await makeJobOffer({
      from: identity.did,
      difficulty,
      description: jobBuilderFields.description.value,
      deliverable: jobBuilderFields.deliverable.value,
      successCriteria: jobBuilderFields.successCriteria.value,
      acceptHours: jobBuilderFields.acceptHours.value,
      claimHours: jobBuilderFields.claimHours.value,
      refundHours: jobBuilderFields.refundHours.value,
      amount: jobBuilderFields.amount.value,
    });
    const { offer } = prepared;
    $("#tclk-preview").textContent = encodeFrame(offer);
    localStorage.setItem(TCLK_OFFER_KEY, JSON.stringify(offer));
    localStorage.setItem(TCLK_JOB_KEY, JSON.stringify(prepared));
    $("#publish-job-spec").disabled = false; $("#verify-job-spec").disabled = false;
    $("#publish-tclk").disabled = true; $("#check-tclk").disabled = false;
    $("#tclk-live-result").textContent = `${difficulty.toUpperCase()} JOB PREPARED\n${prepared.spec}\n\nOffer ${offer.id}\nPublish and verify the job note before publishing the offer.`;
    notice("Hash-bound job prepared; publish its job note first");
  } catch (error) { notice(error.message); }
});

$("#publish-job-spec").addEventListener("click", () => {
  const prepared = JSON.parse(localStorage.getItem(TCLK_JOB_KEY) || "null"); if (!prepared) return;
  if (!window.confirm(`Publish this value-free public job specification?\n\n${prepared.spec}`)) return;
  window.open(`https://technocore.chat/kv/${prepared.note.ns}/${prepared.note.key}/set/${encodeURIComponent(prepared.spec)}`, "_blank", "noopener,noreferrer");
  notice("Job note submission opened; verify it before publishing the offer");
});

$("#verify-job-spec").addEventListener("click", async () => {
  const prepared = JSON.parse(localStorage.getItem(TCLK_JOB_KEY) || "null"); if (!prepared) return;
  try {
    const response = await fetch(`https://technocore.chat/kv/${prepared.note.ns}/${prepared.note.key}?n=${Date.now()}`);
    if (!response.ok) throw new Error(`Job note read failed (${response.status})`);
    if (stripNoteBanner(await response.text()) !== prepared.spec) throw new Error("Published job note does not match the prepared hash-bound specification");
    $("#publish-tclk").disabled = false;
    $("#tclk-live-result").textContent = `JOB NOTE VERIFIED\n${prepared.spec}\n\nOffer ${prepared.offer.id}\nReady for final review and signing.`;
    notice("Exact job note verified; offer can now be signed");
  } catch (error) { $("#tclk-live-result").textContent = `Job verification failed: ${error.message}`; }
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
    localStorage.setItem(TCLK_PAYER_DEAL_KEY, JSON.stringify({ offer, accept: found.accept, acceptSeq: found.seq, lock }));
    $("#create-paper-lock").disabled = false;
    $("#publish-payer-lock").disabled = true;
    $("#tclk-live-result").textContent = `VALID ACCEPT\nCounterparty: ${found.accept.from}\nContract: ${found.contract}\nDeal room: /r/${found.room}\n\nNext payer frame prepared:\n${lock.line}`;
    renderPayerDeal();
    notice("Independent accept validated with the official tclk state machine");
    void syncTrackRecord({ announce: false });
  } catch (error) { $("#tclk-live-result").textContent = `Check failed: ${error.message}`; }
});

$("#create-paper-lock").addEventListener("click", async () => {
  const deal = JSON.parse(localStorage.getItem(TCLK_PAYER_DEAL_KEY) || "null"); if (!deal) return;
  try {
    const current = await fetch(`https://technocore.chat/kv/${deal.lock.note.ns}/${deal.lock.note.key}?n=${Date.now()}`);
    if (current.ok) {
      if (stripNoteBanner(await current.text()) !== deal.lock.value) throw new Error("PaperRail note already exists with different terms");
      deal.railState = "locked";
      localStorage.setItem(TCLK_PAYER_DEAL_KEY, JSON.stringify(deal));
      $("#publish-payer-lock").disabled = false;
      renderPayerDeal();
      notice("Exact PaperRail lock already exists and is ready to verify");
      return;
    }
    if (current.status !== 404) throw new Error(`PaperRail preflight failed (${current.status})`);
    if (!window.confirm(`Create this value-free PaperRail lock with if-absent protection?\n\n${deal.lock.value}`)) return;
    const url = `https://technocore.chat/kv/${deal.lock.note.ns}/${deal.lock.note.key}/set/${encodeURIComponent(deal.lock.value)}?if_absent=1`;
    window.open(url, "_blank", "noopener,noreferrer");
    $("#publish-payer-lock").disabled = false;
    notice("PaperRail lock submission opened; verify it before publishing the signed lock frame");
  } catch (error) { $("#tclk-live-result").textContent = `PaperRail lock blocked: ${error.message}`; }
});

$("#publish-payer-lock").addEventListener("click", async () => {
  const identity = readIdentity(); const deal = JSON.parse(localStorage.getItem(TCLK_PAYER_DEAL_KEY) || "null");
  if (!identity || !deal) return;
  try {
    const response = await fetch(`https://technocore.chat/kv/${deal.lock.note.ns}/${deal.lock.note.key}?n=${Date.now()}`);
    if (!response.ok) throw new Error(`PaperRail read failed (${response.status})`);
    if (stripNoteBanner(await response.text()) !== deal.lock.value) throw new Error("PaperRail lock does not exactly match the signed contract terms");
    if (!window.confirm(`PaperRail is verified. Publish this exact signed lock to /r/${deal.lock.room}?\n\n${deal.lock.line}`)) return;
    const nonce = Date.now(); const signature = await sign(identity, deal.lock.room, nonce, deal.lock.line);
    window.open(signedUrl(deal.lock.room, identity, signature, nonce, deal.lock.line), "_blank", "noopener,noreferrer");
    $("#tclk-live-result").textContent = `SIGNED LOCK SUBMISSION OPENED — NOT YET VERIFIED ON TECHNOCORE\nContract: ${deal.accept.contract}\nDeal room: /r/${deal.lock.room}\nPaper note: /kv/${deal.lock.note.ns}/${deal.lock.note.key}\n\n${deal.lock.line}\n\nNEXT: Confirm the opened Technocore tab says ok, then press VERIFY LOCK / CHECK RESULT. If it says 400, the signed lock was not published.`;
    deal.state = "lock-submission-opened"; deal.railState = "locked"; deal.lockSubmittedAt = new Date().toISOString();
    localStorage.setItem(TCLK_PAYER_DEAL_KEY, JSON.stringify(deal));
    renderPayerDeal();
    notice("Signed payer lock opened for Technocore confirmation");
  } catch (error) { $("#tclk-live-result").textContent = `Lock publication blocked: ${error.message}`; }
});

$("#open-payer-room").addEventListener("click", () => {
  const deal = readPayerDeal(); if (!deal) return;
  window.open(`https://technocore.chat/r/${deal.lock.room}`, "_blank", "noopener,noreferrer");
});

$("#check-payer-deal").addEventListener("click", async () => {
  const deal = readPayerDeal(); if (!deal) return;
  try {
    const roomResponse = await fetch(`https://technocore.chat/r/${deal.lock.room}?limit=200&format=json&n=${Date.now()}`, { headers: { accept: "application/json" } });
    if (!roomResponse.ok) throw new Error(`Deal room read failed (${roomResponse.status})`);
    const folded = await foldPayeeDeal(await roomResponse.json(), deal.offer, deal.accept);
    const expected = expectedPaperLock(deal.offer, deal.accept);
    let railState = "absent";
    const noteResponse = await fetch(`https://technocore.chat/kv/${expected.note.ns}/${expected.note.key}?n=${Date.now()}`);
    if (noteResponse.ok) railState = classifyPaperRecord(stripNoteBanner(await noteResponse.text()), deal.offer, deal.accept);
    deal.state = folded.state.status; deal.railState = railState; deal.checkedAt = new Date().toISOString();
    localStorage.setItem(TCLK_PAYER_DEAL_KEY, JSON.stringify(deal));
    renderPayerDeal();
    notice(folded.state.status === "claimed" ? "Valid payee reveal found" : "No valid payee reveal yet");
    void syncTrackRecord({ announce: false });
  } catch (error) {
    const pending = deal.state === "lock-submitted" || deal.state === "lock-submission-opened";
    $("#payer-deal-status").textContent = `Payer deal check failed: ${error.message}\nSaved deal data was preserved.${pending ? "\nSIGNED LOCK IS NOT CONFIRMED. If the publish tab returned 400, wait for a slot and retry VERIFY & PUBLISH SIGNED LOCK." : ""}`;
  }
});

$("#publish-payer-receipt").addEventListener("click", async () => {
  const identity = readIdentity(); const deal = readPayerDeal();
  const terminal = (deal?.state === "claimed" && deal?.railState === "claimed") || (deal?.state === "refunded" && deal?.railState === "refunded");
  if (!identity || !terminal) return;
  const receipt = makePayeeReceipt(deal.accept, identity.did, deal.state);
  if (!window.confirm(`Archive this terminal payer deal with a signed ${deal.state} receipt?\n\n${receipt.line}`)) return;
  const nonce = Date.now(); const signature = await sign(identity, receipt.room, nonce, receipt.line);
  window.open(signedUrl(receipt.room, identity, signature, nonce, receipt.line), "_blank", "noopener,noreferrer");
  deal.receiptSubmittedAt = new Date().toISOString();
  localStorage.setItem(TCLK_PAYER_DEAL_KEY, JSON.stringify(deal));
  renderPayerDeal();
  notice("Payer receipt opened for Technocore confirmation");
});

$("#refund-payer-deal").addEventListener("click", async () => {
  const identity = readIdentity(); const deal = readPayerDeal();
  if (!identity || !deal || Date.now() < deal.offer.refundAfterMs) return;
  try {
    const roomResponse = await fetch(`https://technocore.chat/r/${deal.lock.room}?limit=200&format=json&n=${Date.now()}`, { headers: { accept: "application/json" } });
    if (!roomResponse.ok) throw new Error(`Deal room read failed (${roomResponse.status})`);
    const folded = await foldPayeeDeal(await roomResponse.json(), deal.offer, deal.accept);
    if (folded.state.status !== "locked") throw new Error(`Refund blocked: transcript is ${folded.state.status}, not locked`);
    const refundRail = expectedPaperRefund(deal.offer, deal.accept);
    const noteResponse = await fetch(`https://technocore.chat/kv/${refundRail.note.ns}/${refundRail.note.key}?n=${Date.now()}`);
    if (!noteResponse.ok || classifyPaperRecord(stripNoteBanner(await noteResponse.text()), deal.offer, deal.accept) !== "locked") throw new Error("Refund blocked: PaperRail is not in the expected locked state");
    const refund = makePayerRefund(deal.accept, identity.did);
    if (!window.confirm(`The refund deadline passed and no valid reveal exists. Refund this value-free PAPER deal and publish the signed terminal frame?\n\n${refund.line}`)) return;
    const railUrl = `https://technocore.chat/kv/${refundRail.note.ns}/${refundRail.note.key}/set/${encodeURIComponent(refundRail.value)}?if=${encodeURIComponent(refundRail.lockedValue)}`;
    const railResponse = await fetch(railUrl);
    if (!railResponse.ok) throw new Error(`PaperRail refund failed (${railResponse.status})`);
    const nonce = Date.now(); const signature = await sign(identity, refund.room, nonce, refund.line);
    window.open(signedUrl(refund.room, identity, signature, nonce, refund.line), "_blank", "noopener,noreferrer");
    deal.railState = "refunded"; deal.refundSubmittedAt = new Date().toISOString();
    localStorage.setItem(TCLK_PAYER_DEAL_KEY, JSON.stringify(deal));
    renderPayerDeal();
    notice("PaperRail refunded; confirm the signed refund on Technocore, then check the deal");
  } catch (error) { $("#payer-deal-status").textContent = `${error.message}\nSaved deal data was preserved.`; }
});

const readPayeeDeal = () => { try { return JSON.parse(localStorage.getItem(PAYEE_DEAL_KEY)); } catch { return null; } };
function contextUrl(context) { return context.startsWith("/kv/") ? `https://technocore.chat${context}` : context; }
async function readOfferHistory() {
  const response = await fetch(`https://technocore.chat/r/${OFFER_ROOM}/export?n=${Date.now()}`, { headers: { accept: "application/x-ndjson, application/json" } });
  if (!response.ok) throw new Error(`Technocore offer history read failed (${response.status})`);
  return response.text();
}
function resetPayeeUi() {
  $("#check-payee-deal").disabled = true;
  $("#discard-payee-deal").disabled = true;
  $("#work-complete").checked = false;
  $("#work-complete").disabled = true;
  $("#publish-reveal").disabled = true;
  $("#claim-paper").disabled = true;
  $("#publish-receipt").disabled = true;
  $("#payee-status").textContent = "No offer accepted by this browser.";
}

function renderPayeeOffers(items) {
  const root = $("#payee-candidates"); root.classList.toggle("empty", !items.length);
  root.replaceChildren(...(items.length ? items.map(({ offer, seq, spec }) => {
    const card = document.createElement("article"); card.className = "mission";
    const id = document.createElement("code"); id.textContent = `seq #${seq} · ${offer.id.slice(0, 18)}…`;
    const title = document.createElement("h2"); title.textContent = `${offer.job.proto.toUpperCase()} · ${offer.job.id}`;
    const detail = document.createElement("p"); detail.textContent = `${offer.amount} ${offer.asset} · hash lock · expires ${new Date(offer.expiresMs).toLocaleString()}\n${spec.bound ? "HASH-BOUND JOB NOTE" : "SNAPSHOTTED STANDARD JOB NOTE"}\n${spec.text.slice(0, 600)}`;
    const link = document.createElement("a"); link.href = contextUrl(offer.job.context); link.target = "_blank"; link.rel = "noopener noreferrer"; link.textContent = "REVIEW JOB CONTEXT ↗";
    const accept = document.createElement("button"); accept.textContent = "ACCEPT WITH MY DID →";
    accept.addEventListener("click", () => acceptPaperOffer(offer, spec));
    card.append(id, title, detail, link, accept); return card;
  }) : [document.createTextNode("No safe, signed, unexpired PaperRail offers found.")]));
}

$("#scan-offers").addEventListener("click", async () => {
  const identity = readIdentity(); if (!identity) { notice("Restore the existing DID before scanning offers"); return; }
  try {
    const offers = await listSafePaperOffers(await readOfferHistory(), identity.did);
    const verified = [];
    for (const candidate of offers) {
      const specResponse = await fetch(`${contextUrl(candidate.offer.job.context)}?n=${Date.now()}`);
      if (!specResponse.ok) continue;
      const spec = await reviewJobSpec(await specResponse.text(), candidate.offer);
      if (spec) verified.push({ ...candidate, spec });
    }
    renderPayeeOffers(verified); notice(`${verified.length} signed offer${verified.length === 1 ? "" : "s"} with a hash-bound safe job found`);
  } catch (error) { $("#payee-status").textContent = `Scan failed: ${error.message}`; }
});

async function acceptPaperOffer(offer, jobSnapshot) {
  const identity = readIdentity(); if (!identity) return;
  if (readPayeeDeal()) { notice("Finish the active payee deal before accepting another"); return; }
  const prepared = makePayeeAcceptance(offer, identity.did);
  if (!window.confirm(`Accept this exact PAPER job as payee?\n\nJob: ${offer.job.id}\nPayer: ${offer.from}\nContract: ${prepared.contract}\n\nThe hash-lock secret will be encrypted locally and never sent before reveal.`)) return;
  const vaultPassword = window.prompt("Create a separate deal-vault password (minimum 12 characters). It is not stored and cannot be recovered.");
  if (!vaultPassword || vaultPassword.length < 12) { notice("Accept cancelled — deal-vault password must be at least 12 characters"); return; }
  const sealedSecret = await sealSecret(vaultPassword, prepared.contract, prepared.secret);
  const deal = { offer, accept: prepared.accept, room: prepared.room, sealedSecret, jobSnapshot, acceptedAt: new Date().toISOString(), state: "room-reservation-pending" };
  localStorage.setItem(PAYEE_DEAL_KEY, JSON.stringify(deal));
  const nonce = Date.now(); const signature = await sign(identity, prepared.room, nonce, prepared.line);
  window.open(signedUrl(prepared.room, identity, signature, nonce, prepared.line), "_blank", "noopener,noreferrer");
  $("#check-payee-deal").disabled = false;
  $("#discard-payee-deal").disabled = false;
  $("#payee-status").textContent = `DEAL ROOM RESERVATION OPENED — JOB NOT ACCEPTED YET\nContract: ${prepared.contract}\nDeal room: /r/${prepared.room}\nSecret: encrypted in this browser\nNEXT: Confirm Technocore says ok, then press CHECK ACTIVE DEAL.`;
  notice("Deal-room reservation opened; a 400 means stop — no accept will be published");
}

function stripNoteBanner(text) {
  return text.split("\n").filter((line) => !line.startsWith("!!") && line.trim()).join("\n").trimEnd();
}

const readTrackRecords = () => { try { return JSON.parse(localStorage.getItem(TRACK_RECORD_KEY)) || []; } catch { return []; } };
const trackKey = (entry) => `${entry.role}:${entry.offer.id}`;
const statusRank = { offered: 0, expired: 1, accepted: 2, locked: 3, cancelled: 4, refunded: 5, claimed: 6 };

function jobSummary(entry) {
  const match = String(entry.jobText || "").match(/Task=(.*?) Deliverable=/s);
  return (match?.[1] || `${entry.offer.job.proto} · ${entry.offer.job.id}`).slice(0, 180);
}

function statusLabel(entry) {
  if (entry.status === "claimed" && entry.seqs?.receipt) return "SUCCESSFUL";
  if (entry.status === "claimed") return "CLAIMED · RECEIPT PENDING";
  if (entry.status === "refunded" && entry.seqs?.receipt) return "REFUNDED · RECEIPT SIGNED";
  return String(entry.status || "unknown").toUpperCase();
}

function renderTrackRecord() {
  const entries = readTrackRecords();
  $("#track-given").textContent = entries.filter((entry) => entry.role === "payer").length;
  $("#track-attempted").textContent = entries.filter((entry) => entry.role === "payee").length;
  $("#track-successful").textContent = entries.filter((entry) => entry.status === "claimed" && entry.seqs?.receipt).length;
  $("#track-active").textContent = entries.filter((entry) => ["offered", "accepted", "locked"].includes(entry.status)).length;
  const body = $("#track-record-rows");
  if (!entries.length) {
    const row = document.createElement("tr"); const cell = document.createElement("td"); cell.colSpan = 4; cell.textContent = "No verified tclk activity saved."; row.append(cell); body.replaceChildren(row); return;
  }
  body.replaceChildren(...entries.map((entry) => {
    const row = document.createElement("tr");
    const role = document.createElement("td"); role.textContent = entry.role === "payer" ? "GAVE JOB" : "DID JOB";
    const job = document.createElement("td");
    const summary = document.createElement("div"); summary.textContent = jobSummary(entry);
    const contract = document.createElement("code"); contract.textContent = entry.contract ? `${entry.contract.slice(0, 12)}…${entry.contract.slice(-6)}` : entry.offer.id.slice(0, 18) + "…";
    job.append(summary, contract);
    const chain = document.createElement("td");
    const seqOrder = [["offer", "OFFER"], ["accept", "ACCEPT"], ["lock", "LOCK"], ["reveal", "REVEAL"], ["refund", "REFUND"], ["cancel", "CANCEL"], ["receipt", "RECEIPT"]];
    const parts = seqOrder.filter(([type]) => entry.seqs?.[type] != null).map(([type, label]) => `${label} #${entry.seqs[type]}`);
    chain.textContent = parts.length ? parts.join(" → ") : "No verified seq";
    const status = document.createElement("td"); status.textContent = statusLabel(entry);
    row.append(role, job, chain, status); return row;
  }));
}

function mergeTrackRecords(fresh) {
  const merged = new Map(readTrackRecords().map((entry) => [trackKey(entry), entry]));
  for (const entry of fresh) {
    const previous = merged.get(trackKey(entry));
    const status = previous && (statusRank[previous.status] ?? -1) > (statusRank[entry.status] ?? -1) ? previous.status : entry.status;
    merged.set(trackKey(entry), { ...previous, ...entry, status, seqs: { ...previous?.seqs, ...entry.seqs }, updatedAt: new Date().toISOString() });
  }
  const rows = [...merged.values()].sort((a, b) => Number(b.offerSeq || 0) - Number(a.offerSeq || 0));
  localStorage.setItem(TRACK_RECORD_KEY, JSON.stringify(rows));
  renderTrackRecord();
}

async function syncTrackRecord({ announce = true } = {}) {
  const identity = readIdentity(); if (!identity) return;
  const button = $("#refresh-track-record"); button.disabled = true;
  $("#track-sync-status").textContent = "Reading verified Technocore history…";
  try {
    const activity = await listMyPaperActivity(await readOfferHistory(), identity.did);
    for (const entry of activity) {
      if (entry.accept && entry.room) {
        const roomResponse = await fetch(`https://technocore.chat/r/${entry.room}?limit=200&format=json&n=${Date.now()}`, { headers: { accept: "application/json" } });
        if (roomResponse.ok) {
          const deal = await summarizeDealActivity(await roomResponse.json(), entry.offer, entry.accept);
          entry.status = deal.status; entry.seqs = { ...entry.seqs, ...deal.seqs };
        }
      } else if (entry.offer.expiresMs <= Date.now()) entry.status = "expired";
      const jobUrl = contextUrl(entry.offer.job.context);
      if (jobUrl.startsWith("https://technocore.chat/")) {
        const specResponse = await fetch(`${jobUrl}?n=${Date.now()}`);
        if (specResponse.ok) {
          const spec = await verifyBoundJobSpec(await specResponse.text(), entry.offer);
          if (spec) entry.jobText = spec.text;
        }
      }
    }
    mergeTrackRecords(activity);
    $("#track-sync-status").textContent = `Verified from Technocore · ${new Date().toLocaleString()}`;
    if (announce) notice(`${activity.length} verified tclk record${activity.length === 1 ? "" : "s"} refreshed`);
  } catch (error) {
    $("#track-sync-status").textContent = `History refresh failed: ${error.message}. Saved records were preserved.`;
  } finally { button.disabled = false; }
}

$("#refresh-track-record").addEventListener("click", () => syncTrackRecord());

$("#check-payee-deal").addEventListener("click", async () => {
  const deal = readPayeeDeal(); if (!deal) return;
  try {
    if (deal.state === "room-reservation-pending") {
      const identity = readIdentity(); if (!identity) return;
      const roomResponse = await fetch(`https://technocore.chat/r/${deal.room}?limit=200&format=json&n=${Date.now()}`);
      if (!roomResponse.ok) throw new Error(`Deal room reservation not found (${roomResponse.status})`);
      const reserved = await verifyExactFrameRecord(await roomResponse.json(), deal.accept, deal.room);
      if (!reserved) {
        $("#payee-status").textContent = `DEAL ROOM NOT RESERVED — JOB NOT ACCEPTED\nContract: ${deal.accept.contract}\nIf Technocore returned 400, discard this unconfirmed local deal.`;
        return;
      }
      const specResponse = await fetch(`${contextUrl(deal.offer.job.context)}?n=${Date.now()}`);
      if (!specResponse.ok) throw new Error(`Job note recheck failed (${specResponse.status})`);
      const currentSpec = await reviewJobSpec(await specResponse.text(), deal.offer);
      if (!currentSpec || currentSpec.hash !== deal.jobSnapshot?.hash) throw new Error("Job note changed after selection; accept blocked");
      if (Date.now() >= deal.offer.expiresMs) throw new Error("Offer expired before acceptance; discard the local reservation");
      const line = encodeFrame(deal.accept); const nonce = Date.now(); const signature = await sign(identity, OFFER_ROOM, nonce, line);
      deal.state = "accept-pending"; deal.reservationSeq = reserved.seq;
      localStorage.setItem(PAYEE_DEAL_KEY, JSON.stringify(deal));
      window.open(signedUrl(OFFER_ROOM, identity, signature, nonce, line), "_blank", "noopener,noreferrer");
      $("#payee-status").textContent = `DEAL ROOM RESERVED · seq #${reserved.seq}\nACCEPT SUBMISSION OPENED — confirm Technocore says ok, then press CHECK ACTIVE DEAL again.`;
      notice("Room is confirmed; the signed offer acceptance is now open for your confirmation");
      return;
    }
    const accepted = await verifyAcceptRecord(await readOfferHistory(), deal.offer, deal.accept);
    if (!accepted) { $("#payee-status").textContent = "Accept is not yet confirmed in tclk-offers."; return; }
    const roomResponse = await fetch(`https://technocore.chat/r/${deal.room}?limit=200&format=json&n=${Date.now()}`);
    if (!roomResponse.ok) throw new Error(`Deal room read failed (${roomResponse.status})`);
    const folded = await foldPayeeDeal(await roomResponse.json(), deal.offer, deal.accept);
    let lockValid = false; let railState = "absent";
    if (folded.state.status === "locked" || folded.state.status === "claimed") {
      const expected = expectedPaperLock(deal.offer, deal.accept);
      if (folded.state.rail !== "paper" || folded.state.railRef !== expected.ref) throw new Error("Payer lock frame does not name the expected PaperRail record");
      const noteResponse = await fetch(`https://technocore.chat/kv/${expected.note.ns}/${expected.note.key}?n=${Date.now()}`);
      const noteValue = noteResponse.ok ? stripNoteBanner(await noteResponse.text()) : "";
      railState = classifyPaperRecord(noteValue, deal.offer, deal.accept);
      lockValid = railState === "locked" || railState === "claimed";
      if (!lockValid) throw new Error("PaperRail note is missing or does not match the signed contract");
    }
    deal.state = folded.state.status; deal.acceptSeq = accepted.seq; deal.lockValid = lockValid; deal.railState = railState;
    localStorage.setItem(PAYEE_DEAL_KEY, JSON.stringify(deal));
    $("#work-complete").disabled = folded.state.status !== "locked" || !lockValid;
    $("#claim-paper").disabled = !(folded.state.status === "claimed" && railState === "locked");
    $("#publish-receipt").disabled = !(folded.state.status === "claimed" && railState === "claimed");
    $("#payee-status").textContent = `ACCEPT VERIFIED · seq #${accepted.seq}\nContract: ${deal.accept.contract}\nDeal room: /r/${deal.room}\nTranscript state: ${folded.state.status}\nPaperRail state: ${railState}`;
    notice(`Payee deal state: ${folded.state.status}`);
    void syncTrackRecord({ announce: false });
  } catch (error) { $("#payee-status").textContent = `Deal check failed: ${error.message}`; }
});

$("#discard-payee-deal").addEventListener("click", async () => {
  const deal = readPayeeDeal();
  if (!deal || !["room-reservation-pending", "accept-pending"].includes(deal.state)) return;
  $("#discard-payee-deal").disabled = true;
  try {
    const accepted = await verifyAcceptRecord(await readOfferHistory(), deal.offer, deal.accept);
    if (accepted) {
      deal.state = "accepted"; deal.acceptSeq = accepted.seq;
      localStorage.setItem(PAYEE_DEAL_KEY, JSON.stringify(deal));
      $("#payee-status").textContent = `DISCARD BLOCKED — ACCEPT VERIFIED · seq #${accepted.seq}\nContract: ${deal.accept.contract}\nContinue with CHECK ACTIVE DEAL.`;
      notice("This accept exists on Technocore and cannot be discarded");
      return;
    }
    if (!window.confirm("No matching accept was found on Technocore. Discard this local pending deal and its encrypted secret? This cannot be undone.")) return;
    localStorage.removeItem(PAYEE_DEAL_KEY);
    resetPayeeUi();
    notice("Unconfirmed local payee deal discarded");
  } catch (error) {
    $("#payee-status").textContent = `Discard blocked: ${error.message}\nThe local encrypted secret was preserved.`;
  } finally {
    const current = readPayeeDeal();
    $("#discard-payee-deal").disabled = !current || !["room-reservation-pending", "accept-pending"].includes(current.state);
  }
});

$("#claim-paper").addEventListener("click", async () => {
  const identity = readIdentity(); const deal = readPayeeDeal();
  if (!identity || deal?.state !== "claimed" || deal.railState !== "locked" || Date.now() >= deal.offer.refundAfterMs) return;
  const vaultPassword = window.prompt("Enter the deal-vault password to decrypt the secret for the PaperRail claim."); if (!vaultPassword) return;
  let secret; try { secret = await openSecret(vaultPassword, deal.accept.contract, deal.sealedSecret); } catch { notice("Deal-vault password is incorrect"); return; }
  const claim = expectedPaperClaim(deal.offer, deal.accept, secret);
  if (!window.confirm("Advance the value-free PaperRail record from locked to claimed using compare-and-set? The secret is already public in the signed reveal.")) return;
  const url = `https://technocore.chat/kv/${claim.note.ns}/${claim.note.key}/set/${encodeURIComponent(claim.value)}?if=${encodeURIComponent(claim.lockedValue)}`;
  const response = await fetch(url);
  if (!response.ok) { notice(`PaperRail claim failed (${response.status}); check the deal state`); return; }
  notice("PaperRail advanced to claimed; check the deal before issuing the receipt");
});

$("#work-complete").addEventListener("change", (event) => {
  const deal = readPayeeDeal(); $("#publish-reveal").disabled = !(event.target.checked && deal?.state === "locked" && deal?.lockValid);
});

$("#publish-reveal").addEventListener("click", async () => {
  const identity = readIdentity(); const deal = readPayeeDeal(); if (!identity || !deal?.lockValid || deal.state !== "locked") return;
  const vaultPassword = window.prompt("Enter the deal-vault password to decrypt the reveal secret."); if (!vaultPassword) return;
  let secret; try { secret = await openSecret(vaultPassword, deal.accept.contract, deal.sealedSecret); } catch { notice("Deal-vault password is incorrect"); return; }
  const reveal = makePayeeReveal(deal.accept, identity.did, secret);
  if (!window.confirm(`FINAL CLAIM ACTION\n\nPublishing this reveal exposes the contract secret permanently and claims the PaperRail rehearsal. Continue only if the job is complete and the lock was verified.\n\n${reveal.line}`)) return;
  const nonce = Date.now(); const signature = await sign(identity, reveal.room, nonce, reveal.line);
  window.open(signedUrl(reveal.room, identity, signature, nonce, reveal.line), "_blank", "noopener,noreferrer");
  notice("Reveal opened for Technocore confirmation; re-check the deal before issuing a receipt");
});

$("#publish-receipt").addEventListener("click", async () => {
  const identity = readIdentity(); const deal = readPayeeDeal(); if (!identity || deal?.state !== "claimed") return;
  const receipt = makePayeeReceipt(deal.accept, identity.did);
  if (!window.confirm(`Publish this terminal claimed receipt?\n\n${receipt.line}`)) return;
  const nonce = Date.now(); const signature = await sign(identity, receipt.room, nonce, receipt.line);
  window.open(signedUrl(receipt.room, identity, signature, nonce, receipt.line), "_blank", "noopener,noreferrer");
  notice("Claimed receipt opened for Technocore confirmation");
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
if (localStorage.getItem(TCLK_OFFER_KEY)) { $("#check-tclk").disabled = false; }
if (localStorage.getItem(TCLK_PAYER_DEAL_KEY)) { $("#create-paper-lock").disabled = false; }
renderPayerDeal();
renderTrackRecord();
if (readIdentity()) void syncTrackRecord({ announce: false });
if (readPayeeDeal()) {
  const payeeDeal = readPayeeDeal();
  $("#check-payee-deal").disabled = false;
  $("#discard-payee-deal").disabled = !["room-reservation-pending", "accept-pending"].includes(payeeDeal.state);
  const payeeLabel = payeeDeal.state === "room-reservation-pending"
    ? "DEAL ROOM RESERVATION PENDING — JOB NOT ACCEPTED"
    : payeeDeal.state === "accept-pending"
      ? "ACCEPT PREPARED LOCALLY — NOT YET VERIFIED ON TECHNOCORE"
      : "ACTIVE VERIFIED DEAL";
  $("#payee-status").textContent = `${payeeLabel}\nContract: ${payeeDeal.accept.contract}\nCheck the deal state to continue.`;
}
