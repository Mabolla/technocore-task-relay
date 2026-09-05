import { auditTranscript } from "./tclk.js";
import { JOB_TEMPLATES, OFFER_ROOM, classifyPaperRecord, deliveryRoomFromJobText, encodeFrame, evaluateObjectiveDelivery, expectedPaperClaim, expectedPaperLock, expectedPaperRefund, findValidAccept, foldPayeeDeal, isSuccessfulTrackEntry, latestDeliveryBeforeReveal, listMyPaperActivity, listRecentAcceptedPayerDeals, listSafePaperOffers, listSignedDeliveries, makeJobOffer, makePaperLock, makePayeeAcceptance, makePayeeReceipt, makePayeeReveal, makePayerDeliveryReview, makePayerNoDeliveryReview, makePayerRefund, resolveDeliveryRoom, reviewJobSpec, summarizeDealActivity, verifyAcceptRecord, verifyBoundJobSpec, verifyExactFrameRecord, verifyExactSignedTextRecord } from "./tclk-official.js?v=objective-validator-1";

const ROOM = "mabolla-task-relay";
const IDENTITY_KEY = "mabolla.task-relay.identity.v1";
const EVENTS_KEY = "mabolla.task-relay.events.v1";
const TCLK_OFFER_KEY = "mabolla.task-relay.tclk-offer.v1";
const TCLK_JOB_KEY = "mabolla.task-relay.tclk-job.v1";
const TCLK_PAYER_DEAL_KEY = "mabolla.task-relay.tclk-payer-deal.v1";
const TCLK_PAYER_DEALS_KEY = "mabolla.task-relay.tclk-payer-deals.v1";
const PAYER_AUTOPILOT_KEY = "mabolla.task-relay.payer-autopilot.v1";
const PAYER_AUTO_SETTLE_KEY = "mabolla.task-relay.payer-auto-settle.v1";
const PAYEE_DEAL_KEY = "mabolla.task-relay.tclk-payee-deal.v1";
const PAYEE_DEALS_KEY = "mabolla.task-relay.tclk-payee-deals.v1";
const PAYEE_AUTO_ACCEPT_KEY = "mabolla.task-relay.payee-auto-accept.v1";
const PAYEE_AUTO_HUNTER_KEY = "mabolla.task-relay.payee-auto-hunter.v1";
const PAYER_LOCK_PRIORITY_KEY = "mabolla.task-relay.payer-lock-priority.v1";
const MAX_ACTIVE_PAYEE_DEALS = 3;
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
const readPayerDeals = () => { try { return JSON.parse(localStorage.getItem(TCLK_PAYER_DEALS_KEY)) || {}; } catch { return {}; } };
const readPayerAutopilot = () => { try { return JSON.parse(localStorage.getItem(PAYER_AUTOPILOT_KEY)) || { armed: false }; } catch { return { armed: false }; } };
const readPayerAutoSettle = () => { try { return JSON.parse(localStorage.getItem(PAYER_AUTO_SETTLE_KEY)) || { armed: false }; } catch { return { armed: false }; } };
const readPayeeDeals = () => { try { return JSON.parse(localStorage.getItem(PAYEE_DEALS_KEY)) || {}; } catch { return {}; } };
const readPayeeAutoAccept = () => { try { return JSON.parse(localStorage.getItem(PAYEE_AUTO_ACCEPT_KEY)) || { armed: false }; } catch { return { armed: false }; } };
const readPayeeAutoHunter = () => { try { return JSON.parse(localStorage.getItem(PAYEE_AUTO_HUNTER_KEY)) || { armed: false }; } catch { return { armed: false }; } };
const readPayerLockPriority = () => { try { return JSON.parse(localStorage.getItem(PAYER_LOCK_PRIORITY_KEY)) || {}; } catch { return {}; } };
let payerAutopilotRunning = false;
let payerAutoSettleRunning = false;
let payeeAutoAcceptRunning = false;
let payeeAutoHunterRunning = false;
let payeeAutoHunterVaultPassword = null;
const payerLockPriorityChecks = new Set();

function hasVerifiedPayerLock(did) {
  return Number(readPayerLockPriority()[did]?.verifiedLocks || 0) > 0;
}

function savePayerLockPriority(did, verifiedLocks, checkedAt = new Date().toISOString()) {
  if (!/^did:key:z6Mk/.test(did)) return;
  const history = readPayerLockPriority();
  const previous = history[did] || {};
  history[did] = {
    checkedAt,
    verifiedLocks: Math.max(Number(previous.verifiedLocks || 0), Number(verifiedLocks || 0)),
  };
  localStorage.setItem(PAYER_LOCK_PRIORITY_KEY, JSON.stringify(history));
}

function prioritizePaperOffers(offers) {
  return [...offers].sort((left, right) => {
    const priority = Number(hasVerifiedPayerLock(right.offer.from)) - Number(hasVerifiedPayerLock(left.offer.from));
    return priority || Number(right.seq || 0) - Number(left.seq || 0);
  });
}

async function refreshPayerLockPriority(candidates) {
  const history = readPayerLockPriority();
  const freshAfter = Date.now() - 6 * 60 * 60_000;
  const payerDids = [...new Set(candidates.map((candidate) => candidate?.offer?.from).filter(Boolean))]
    .filter((did) => Date.parse(history[did]?.checkedAt || 0) < freshAfter && !payerLockPriorityChecks.has(did))
    .slice(0, 4);
  if (!payerDids.length) return;
  payerDids.forEach((did) => payerLockPriorityChecks.add(did));
  try {
    const deals = await listRecentAcceptedPayerDeals(await readOfferHistory(), payerDids, Date.now(), 3);
    await Promise.all(payerDids.map(async (did) => {
      let verifiedLocks = 0;
      for (const deal of deals.filter((candidate) => candidate.payerDid === did)) {
        try {
          const response = await fetch(`https://technocore.chat/r/${deal.room}?limit=200&format=json&n=${Date.now()}`, {
            headers: { accept: "application/json" }, cache: "no-store", signal: AbortSignal.timeout(4_000),
          });
          if (!response.ok) continue;
          const summary = await summarizeDealActivity(await response.json(), deal.offer, deal.accept);
          if (summary.seqs.lock != null) { verifiedLocks = 1; break; }
        } catch { /* A failed history lookup never blocks or penalizes a current offer. */ }
      }
      savePayerLockPriority(did, verifiedLocks);
    }));
  } catch { /* Reputation is optional; the existing hunter remains the fallback. */ }
  finally { payerDids.forEach((did) => payerLockPriorityChecks.delete(did)); }
}

function rememberPayeeDeal(deal) {
  const contract = deal?.accept?.contract;
  if (!contract) return;
  const deals = readPayeeDeals();
  deals[contract] = deal;
  localStorage.setItem(PAYEE_DEALS_KEY, JSON.stringify(deals));
}

function forgetPayeeDeal(contract) {
  if (!contract) return;
  const deals = readPayeeDeals();
  delete deals[contract];
  localStorage.setItem(PAYEE_DEALS_KEY, JSON.stringify(deals));
}

function queuedPayeeDeals() {
  return Object.values(readPayeeDeals()).filter((deal) => deal?.accept?.contract && deal.acceptSeq && !["refunded", "cancelled", "abandoned"].includes(deal.state));
}

function activePayeeDeals() {
  return queuedPayeeDeals().filter((deal) => !(
    ["accepted", "accepted-room-pending"].includes(deal.state)
    && Date.now() >= Number(deal.offer?.claimByMs || 0)
  ));
}

function removePayeeDealFromActiveQueue(deal) {
  const contract = deal?.accept?.contract;
  if (!contract) return;
  forgetPayeeDeal(contract);
  if (readPayeeDeal()?.accept?.contract === contract) {
    localStorage.removeItem(PAYEE_DEAL_KEY);
    resetPayeeUi();
    renderPayeeAutoAccept();
    renderPayeeJobNote();
  }
}

async function reconcilePayeeDealQueue() {
  const identity = readIdentity();
  const deals = queuedPayeeDeals();
  await Promise.all(deals.map(async (deal) => {
    try {
      const response = await fetch(`https://technocore.chat/r/${deal.room}?limit=200&format=json&n=${Date.now()}`, {
        headers: { accept: "application/json" }, cache: "no-store", signal: AbortSignal.timeout(4_000),
      });
      if (!response.ok) return;
      const payload = await response.json();
      const folded = await foldPayeeDeal(payload, deal.offer, deal.accept);
      if (["refunded", "cancelled"].includes(folded.state.status)) {
        removePayeeDealFromActiveQueue(deal);
        return;
      }
      if (folded.state.status === "claimed" && identity?.did === deal.accept.from) {
        const receipt = makePayeeReceipt(deal.accept, identity.did, "claimed");
        if (await verifyExactFrameRecord(payload, receipt.frame, receipt.room)) {
          removePayeeDealFromActiveQueue(deal);
          return;
        }
      }
      if (["accepted", "accepted-room-pending"].includes(deal.state)
        && Date.now() >= Number(deal.offer?.claimByMs || 0)
        && !["locked", "claimed"].includes(folded.state.status)) {
        removePayeeDealFromActiveQueue(deal);
        return;
      }
      if (folded.state.status !== deal.state) {
        deal.state = folded.state.status;
        rememberPayeeDeal(deal);
      }
    } catch { /* A temporary read failure must not delete a live local deal. */ }
  }));
  renderPayeeDealQueue();
  renderPayeeAutoHunter();
}

function rememberPayerDeal(deal) {
  const contract = deal?.accept?.contract;
  if (!contract) return;
  const deals = readPayerDeals();
  deals[contract] = deal;
  localStorage.setItem(TCLK_PAYER_DEALS_KEY, JSON.stringify(deals));
}

function saveActivePayerDeal(deal) {
  localStorage.setItem(TCLK_PAYER_DEAL_KEY, JSON.stringify(deal));
  rememberPayerDeal(deal);
}

function updateStoredPayerDeal(deal) {
  rememberPayerDeal(deal);
  if (readPayerDeal()?.accept?.contract === deal.accept.contract) {
    localStorage.setItem(TCLK_PAYER_DEAL_KEY, JSON.stringify(deal));
  }
}

function pendingPayerDeals() {
  const active = readPayerDeal();
  if (active) rememberPayerDeal(active);
  return Object.values(readPayerDeals())
    .filter((deal) => deal?.offer && deal?.accept && deal?.lock)
    .filter((deal) => [undefined, "accepted", "lock-submitted", "lock-submission-opened"].includes(deal.state))
    .filter((deal) => Date.now() < deal.offer.refundAfterMs)
    .sort((left, right) => left.offer.refundAfterMs - right.offer.refundAfterMs);
}

function renderPayerAutopilot() {
  const state = readPayerAutopilot();
  const deals = Object.values(readPayerDeals()).filter((deal) => deal?.accept?.contract);
  const pending = pendingPayerDeals();
  $("#payer-autopilot").textContent = state.armed ? "STOP PAYER AUTO-PUBLISH" : "ARM PAYER AUTO-PUBLISH";
  $("#payer-autopilot-status").textContent = `${state.armed ? "ARMED · TAB MUST STAY OPEN" : "OFF"}\n${deals.length ? deals.map((deal) => {
    const seq = deal.offerSeq ? `OFFER #${deal.offerSeq}` : deal.accept.contract.slice(0, 14) + "…";
    const status = deal.state === "locked" ? "LOCK VERIFIED" : Date.now() >= deal.offer.refundAfterMs ? "REFUND WINDOW PASSED" : deal.autoPublishStatus || "WAITING";
    return `${seq}: ${status}`;
  }).join("\n") : "No saved payer deals."}${state.armed ? `\nPending: ${pending.length} · watching server-created room events` : ""}`;
}

async function verifyPaperRailForAutopilot(deal) {
  const noteUrl = `https://technocore.chat/kv/${deal.lock.note.ns}/${deal.lock.note.key}`;
  let response = await fetch(`${noteUrl}?n=${Date.now()}`, { cache: "no-store" });
  if (response.ok) {
    if (stripNoteBanner(await response.text()) !== deal.lock.value) throw new Error("PaperRail note has different terms");
  } else if (response.status === 404) {
    response = await fetch(`${noteUrl}/set/${encodeURIComponent(deal.lock.value)}?if_absent=1&n=${Date.now()}`, { cache: "no-store" });
    if (!response.ok && response.status !== 409) throw new Error(`PaperRail creation failed (${response.status})`);
    const verified = await fetch(`${noteUrl}?n=${Date.now()}`, { cache: "no-store" });
    if (!verified.ok || stripNoteBanner(await verified.text()) !== deal.lock.value) throw new Error("PaperRail creation was not verified");
  } else throw new Error(`PaperRail read failed (${response.status})`);
  deal.railState = "locked";
  updateStoredPayerDeal(deal);
}

async function inspectPayerDealRoom(deal) {
  const response = await fetch(`https://technocore.chat/r/${deal.lock.room}?limit=200&format=json&n=${Date.now()}`, { headers: { accept: "application/json" }, cache: "no-store" });
  if (response.status === 404) return { exists: false, locked: false };
  if (!response.ok) throw new Error(`Deal-room preflight failed (${response.status})`);
  const folded = await foldPayeeDeal(await response.json(), deal.offer, deal.accept);
  if (["locked", "claimed", "refunded"].includes(folded.state.status)) {
    deal.state = folded.state.status;
    deal.railState = "locked";
    deal.autoPublishStatus = "LOCK VERIFIED IN DEAL ROOM";
    deal.checkedAt = new Date().toISOString();
    updateStoredPayerDeal(deal);
    return { exists: true, locked: true };
  }
  return { exists: true, locked: false };
}

async function tryAutoPublishPayerLock(deal, eventSeq) {
  const identity = readIdentity();
  if (!identity || identity.did !== deal.offer.from) throw new Error("Local DID does not match the payer");
  if (Date.now() >= deal.offer.refundAfterMs) throw new Error("Refund window passed");
  const existing = await inspectPayerDealRoom(deal);
  if (existing.locked) return true;
  if (deal.lastPublishReturnedOkAt && Date.now() - Date.parse(deal.lastPublishReturnedOkAt) < 60_000) {
    deal.autoPublishStatus = "PUBLISH RETURNED OK · VERIFYING TRANSCRIPT";
    updateStoredPayerDeal(deal);
    return false;
  }
  await verifyPaperRailForAutopilot(deal);
  const nonce = Date.now();
  const signature = await sign(identity, deal.lock.room, nonce, deal.lock.line);
  const response = await fetch(signedUrl(deal.lock.room, identity, signature, nonce, deal.lock.line), { cache: "no-store" });
  const result = clean(await response.text());
  if (!response.ok) {
    if (response.status === 400 && /room limit reached/i.test(result)) {
      deal.state = "lock-submission-opened";
      deal.autoPublishStatus = `SLOT LOST AT EVENT #${eventSeq} · WAITING`;
      updateStoredPayerDeal(deal);
      return false;
    }
    throw new Error(`Signed lock rejected (${response.status}${result ? `: ${result.slice(0, 120)}` : ""})`);
  }
  deal.lastPublishReturnedOkAt = new Date().toISOString();
  updateStoredPayerDeal(deal);
  let confirmed = false;
  for (let attempt = 0; attempt < 3 && !confirmed; attempt += 1) {
    if (attempt) await new Promise((resolve) => setTimeout(resolve, 500));
    confirmed = (await inspectPayerDealRoom(deal)).locked;
  }
  if (!confirmed) {
    deal.autoPublishStatus = "PUBLISH RETURNED OK · VERIFYING TRANSCRIPT";
    updateStoredPayerDeal(deal);
    return false;
  }
  deal.autoPublishStatus = `LOCK VERIFIED AT EVENT #${eventSeq}`;
  updateStoredPayerDeal(deal);
  return true;
}

async function runPayerAutopilot() {
  if (payerAutopilotRunning || !readPayerAutopilot().armed) return;
  payerAutopilotRunning = true;
  try {
    while (readPayerAutopilot().armed) {
      const state = readPayerAutopilot();
      const response = await fetch(`https://technocore.chat/r/events?since=${state.cursor}&wait=10&format=json&n=${Date.now()}`, { headers: { accept: "application/json" }, cache: "no-store" });
      if (!response.ok) throw new Error(`Event stream failed (${response.status})`);
      const payload = await response.json();
      const messages = Array.isArray(payload.messages) ? payload.messages : [];
      for (const message of messages) if (Number.isFinite(message.seq) && message.seq > state.cursor) state.cursor = message.seq;
      state.lastPollAt = new Date().toISOString();
      localStorage.setItem(PAYER_AUTOPILOT_KEY, JSON.stringify(state));
      const created = messages.find((message) => message.from === "server" && /^created\s+\S+/.test(String(message.text || "")));
      if (created) {
        for (const deal of pendingPayerDeals()) {
          try { await tryAutoPublishPayerLock(deal, created.seq); }
          catch (error) {
            deal.autoPublishStatus = `BLOCKED: ${error.message}`;
            updateStoredPayerDeal(deal);
          }
        }
        if (!pendingPayerDeals().length) {
          state.armed = false;
          localStorage.setItem(PAYER_AUTOPILOT_KEY, JSON.stringify(state));
          notice("All eligible payer locks are verified or expired; auto-publish stopped");
        }
        renderPayerDeal();
      }
      renderPayerAutopilot();
      await new Promise((resolve) => setTimeout(resolve, 750));
    }
  } catch (error) {
    const state = readPayerAutopilot();
    state.lastError = error.message;
    state.lastErrorAt = new Date().toISOString();
    localStorage.setItem(PAYER_AUTOPILOT_KEY, JSON.stringify(state));
    $("#payer-autopilot-status").textContent = `ARMED · TEMPORARY ERROR\n${error.message}\nRetrying in 10 seconds.`;
    setTimeout(() => { payerAutopilotRunning = false; void runPayerAutopilot(); }, 10_000);
    return;
  } finally {
    if (!readPayerAutopilot().armed) payerAutopilotRunning = false;
  }
}

function renderPayeeAutoAccept() {
  const state = readPayeeAutoAccept();
  const deal = readPayeeDeal();
  const status = $("#payee-auto-accept-status");
  const stop = $("#payee-auto-accept-stop");
  if (!status || !stop) return;
  stop.disabled = !state.armed;
  status.textContent = state.armed && deal
    ? `ARMED · TAB MUST STAY OPEN\nOffer seq #${deal.offerSeq ?? "?"}\nContract: ${deal.accept.contract}\n${deal.autoAcceptStatus || "Publishing accept, then creating the deal room"}`
    : deal?.autoAcceptStatus
      ? `OFF\n${deal.autoAcceptStatus}`
      : "OFF\nChoose a scanned job and press ARM AUTO-ACCEPT.";
}

function renderPayeeJobNote(deal = readPayeeDeal()) {
  const output = $("#payee-job-note");
  if (!output) return;
  const text = clean(deal?.jobSnapshot?.text || "");
  output.textContent = text
    ? `Source: ${deal.offer?.job?.context || "saved snapshot"}\n\n${text}`
    : deal
      ? "Saved job note unavailable for this older local deal. Do not publish delivery or reveal until the exact job context is recovered."
      : "No accepted job selected.";
}

function savePayeeDeal(deal) {
  localStorage.setItem(PAYEE_DEAL_KEY, JSON.stringify(deal));
  rememberPayeeDeal(deal);
  renderPayeeAutoAccept();
  renderPayeeDealQueue();
  renderPayeeJobNote(deal);
}

function payeeQueueLabel(deal) {
  if (["accepted", "accepted-room-pending"].includes(deal.state) && Date.now() >= Number(deal.offer?.claimByMs || 0)) return "DEADLINE PASSED · NO LOCAL LOCK";
  if (deal.state === "locked") return "LOCKED · READY TO WORK";
  if (deal.state === "accepted") return deal.lockValid ? "LOCKED · READY TO WORK" : "ACCEPTED · WAITING FOR LOCK";
  if (deal.state === "accepted-room-pending") return "ACCEPTED · WAITING FOR ROOM";
  if (deal.state === "claim-pending") return "REVEAL PUBLISHED · CHECK RESULT";
  return String(deal.state || "SAVED").toUpperCase();
}

function renderPayeeDealQueue() {
  const root = $("#payee-deal-queue");
  if (!root) return;
  const currentContract = readPayeeDeal()?.accept?.contract;
  const deals = activePayeeDeals().sort((left, right) => Number(left.offerSeq || 0) - Number(right.offerSeq || 0));
  root.classList.toggle("empty", !deals.length);
  if (!deals.length) {
    root.replaceChildren(document.createTextNode("No accepted payee jobs in the local queue."));
    return;
  }
  root.replaceChildren(...deals.map((deal) => {
    const row = document.createElement("article"); row.className = "mission";
    const title = document.createElement("b"); title.textContent = `OFFER #${deal.offerSeq ?? "?"} · ${payeeQueueLabel(deal)}`;
    const detail = document.createElement("code"); detail.textContent = `${deal.accept.contract.slice(0, 18)}… · /r/${deal.room}`;
    const select = document.createElement("button");
    select.textContent = currentContract === deal.accept.contract ? "SELECTED" : "OPEN / CHECK →";
    select.disabled = currentContract === deal.accept.contract;
    select.addEventListener("click", () => {
      if (readPayeeAutoAccept().armed || readPayeeAutoHunter().armed) { notice("Stop the hunter before opening a queued deal for work"); return; }
      savePayeeDeal(deal);
      $("#check-payee-deal").disabled = false;
      $("#discard-payee-deal").disabled = true;
      $("#payee-status").textContent = `QUEUED PAYEE DEAL SELECTED\nOffer #${deal.offerSeq ?? "?"}\nContract: ${deal.accept.contract}\nDeal room: /r/${deal.room}\nPress CHECK ACTIVE DEAL.`;
      renderPayeeDealQueue();
      notice(`Offer #${deal.offerSeq ?? "?"} selected from the payee queue`);
    });
    row.append(title, detail, select);
    return row;
  }));
}

async function detectQueuedPayeeLock() {
  const candidates = activePayeeDeals().filter((deal) => deal.state === "accepted" && !deal.lockDetectedAt);
  const checked = await Promise.all(candidates.map(async (deal) => {
    try {
      const response = await fetch(`https://technocore.chat/r/${deal.room}?limit=200&format=json&n=${Date.now()}`, {
        headers: { accept: "application/json" },
        cache: "no-store",
        signal: AbortSignal.timeout(4_000),
      });
      if (!response.ok) return null;
      const folded = await foldPayeeDeal(await response.json(), deal.offer, deal.accept);
      if (!["locked", "claimed"].includes(folded.state.status)) return null;
      deal.state = folded.state.status;
      deal.lockDetectedAt = new Date().toISOString();
      rememberPayeeDeal(deal);
      return deal;
    } catch {
      return null;
    }
  }));
  const ready = checked.find(Boolean) || null;
  if (ready) renderPayeeDealQueue();
  return ready;
}

function stopPayeeAutoAccept(reason, deal = readPayeeDeal()) {
  const state = readPayeeAutoAccept();
  localStorage.setItem(PAYEE_AUTO_ACCEPT_KEY, JSON.stringify({ ...state, armed: false, stoppedAt: new Date().toISOString(), reason }));
  if (deal) {
    deal.autoAcceptStatus = reason;
    savePayeeDeal(deal);
  }
  payeeAutoAcceptRunning = false;
  renderPayeeAutoAccept();
}

function notifyPayeeAutoAccept(title, body) {
  notice(`${title}: ${body}`);
  if ("Notification" in window && Notification.permission === "granted") new Notification(title, { body });
}

async function inspectPayeeReservation(deal) {
  const response = await fetch(`https://technocore.chat/r/${deal.room}?limit=200&format=json&n=${Date.now()}`, { headers: { accept: "application/json" }, cache: "no-store" });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Deal-room verification failed (${response.status})`);
  return verifyExactFrameRecord(await response.json(), deal.accept, deal.room);
}

async function recheckAutoAcceptOffer(deal, identity) {
  if (Date.now() >= deal.offer.expiresMs || Date.now() >= deal.offer.claimByMs) return false;
  const currentSpecResponse = await fetch(freshContextUrl(deal.offer.job.context), { cache: "no-store" });
  if (!currentSpecResponse.ok) throw new Error(`Job note recheck failed (${currentSpecResponse.status})`);
  const currentSpec = await reviewJobSpec(await currentSpecResponse.text(), deal.offer);
  if (!currentSpec || currentSpec.hash !== deal.jobSnapshot?.hash) throw new Error("Job note changed after arming");
  const windowPayload = await readOfferWindow(deal.offerSeq);
  const available = await listSafePaperOffers(windowPayload, identity.did, Date.now(), Number(deal.minimumFinishMs || 0));
  return available.some((candidate) => candidate.offer.id === deal.offer.id);
}

async function resolveUnacceptedHunterMiss(deal, state, reason) {
  const accepted = await verifyAcceptRecord(await readOfferHistory(), deal.offer, deal.accept);
  if (accepted) {
    deal.state = "accepted-room-pending";
    deal.acceptSeq = accepted.seq;
    deal.autoAcceptStatus = `ACCEPT VERIFIED DURING RECOVERY · seq #${accepted.seq ?? "?"} · CREATING DEAL ROOM`;
    savePayeeDeal(deal);
    notifyPayeeAutoAccept("Technocore job secured", `Offer #${deal.offerSeq ?? "?"} is verified; creating its deal room.`);
    return "accepted";
  }

  deal.state = state;
  if (deal.selectedBy !== "auto-job-hunter" || !payeeAutoHunterVaultPassword) {
    stopPayeeAutoAccept(reason, deal);
    return "stopped";
  }

  const tail = await readOfferTail();
  const cursor = Number(tail.last_seq || tail.messages?.at(-1)?.seq || 0);
  const hunter = readPayeeAutoHunter();
  stopPayeeAutoAccept(reason, deal);
  forgetPayeeDeal(deal.accept.contract);
  localStorage.removeItem(PAYEE_DEAL_KEY);
  resetPayeeUi();
  savePayeeAutoHunter({
    ...hunter,
    armed: true,
    cursor,
    reason: "",
    status: `${reason} · VERIFIED NO ACCEPT · WATCHING NEXT OFFERS`,
    resumedAt: new Date().toISOString(),
  });
  notifyPayeeAutoAccept("Technocore job hunter resumed", `Offer #${deal.offerSeq ?? "?"} ended without an accept; watching the next eligible job.`);
  setTimeout(() => { payeeAutoHunterRunning = false; void runPayeeAutoHunter(); }, 0);
  return "resumed";
}

async function continueHunterAfterQueuedDeal(deal) {
  if (deal.selectedBy !== "auto-job-hunter" || !payeeAutoHunterVaultPassword) return false;
  localStorage.removeItem(PAYEE_DEAL_KEY);
  resetPayeeUi();
  renderPayeeDealQueue();
  const count = activePayeeDeals().length;
  if (count >= MAX_ACTIVE_PAYEE_DEALS) {
    stopPayeeAutoHunter(`QUEUE FULL · ${count}/${MAX_ACTIVE_PAYEE_DEALS} ACCEPTED JOBS`);
    notifyPayeeAutoAccept("Payee queue full", `${count} accepted jobs are saved; complete or archive one before hunting again.`);
    return true;
  }
  const tail = await readOfferTail();
  const cursor = Number(tail.last_seq || tail.messages?.at(-1)?.seq || 0);
  savePayeeAutoHunter({
    ...readPayeeAutoHunter(),
    armed: true,
    cursor,
    reason: "",
    status: `${count}/${MAX_ACTIVE_PAYEE_DEALS} JOBS SECURED · WATCHING NEXT OFFERS`,
    resumedAt: new Date().toISOString(),
  });
  notifyPayeeAutoAccept("Technocore job hunter resumed", `Offer #${deal.offerSeq ?? "?"} is queued; watching for another job.`);
  setTimeout(() => {
    payeeAutoHunterRunning = false;
    void detectQueuedPayeeLock()
      .then(async (ready) => {
        if (ready) {
          stopPayeeAutoHunter(`LOCK DETECTED · OFFER #${ready.offerSeq ?? "?"} READY TO WORK`);
          notifyPayeeAutoAccept("Payee job ready", `Offer #${ready.offerSeq ?? "?"} received its payer lock. Open it from the payee queue.`);
          return;
        }
        if (!await tryAutoHuntFromPayload(tail)) void runPayeeAutoHunter();
      })
      .catch((error) => {
        const state = readPayeeAutoHunter();
        savePayeeAutoHunter({ ...state, status: `TEMPORARY ERROR · ${error.message} · RETRYING` });
        setTimeout(() => void runPayeeAutoHunter(), 1_000);
      });
  }, 0);
  return true;
}

async function tryAutoAcceptPayeeDeal(deal, eventSeq) {
  const identity = readIdentity();
  if (!identity || identity.did !== deal.accept.from) throw new Error("Local DID does not match the prepared payee accept");
  if (Date.now() >= deal.offer.expiresMs || Date.now() >= deal.offer.claimByMs) {
    if (deal.acceptSeq) {
      stopPayeeAutoAccept(`ACCEPT #${deal.acceptSeq} VERIFIED · DEAL-ROOM DEADLINE PASSED`, deal);
      await continueHunterAfterQueuedDeal(deal);
      return false;
    }
    await resolveUnacceptedHunterMiss(deal, "auto-accept-expired", "OFFER EXPIRED BEFORE ACCEPT");
    return false;
  }

  let accepted = deal.acceptSeq ? { seq: deal.acceptSeq } : null;
  if (!accepted) {
    if (!(deal.acceptPublishReturnedOkAt && Date.now() - Date.parse(deal.acceptPublishReturnedOkAt) < 2_000)) {
      deal.autoAcceptStatus = `CLAIMING OFFER #${deal.offerSeq ?? "?"} NOW`;
      savePayeeDeal(deal);
      const nonce = Date.now();
      const signature = await sign(identity, OFFER_ROOM, nonce, deal.acceptLine);
      const response = await fetch(signedUrl(OFFER_ROOM, identity, signature, nonce, deal.acceptLine), { cache: "no-store" });
      const result = clean(await response.text());
      if (!response.ok && response.status !== 422) throw new Error(`Offer acceptance rejected (${response.status}${result ? `: ${result.slice(0, 120)}` : ""})`);
      deal.acceptPublishReturnedOkAt = new Date().toISOString();
      savePayeeDeal(deal);
    }
    for (let attempt = 0; attempt < 4 && !accepted; attempt += 1) {
      if (attempt) await new Promise((resolve) => setTimeout(resolve, 100));
      accepted = await verifyAcceptRecord(await readOfferTail(), deal.offer, deal.accept);
    }
    if (!accepted) {
      if (!await recheckAutoAcceptOffer(deal, identity)) {
        await resolveUnacceptedHunterMiss(deal, "auto-accept-unavailable", "OFFER WAS TAKEN BEFORE OUR ACCEPT VERIFIED");
        return false;
      }
      deal.autoAcceptStatus = "ACCEPT SUBMITTED · VERIFYING TCLK-OFFERS";
      savePayeeDeal(deal);
      return false;
    }
    deal.acceptSeq = accepted.seq;
    deal.state = "accepted-room-pending";
    deal.autoAcceptStatus = `ACCEPT VERIFIED · seq #${accepted.seq ?? "?"} · CLAIM SECURED · CREATING DEAL ROOM`;
    savePayeeDeal(deal);
    notifyPayeeAutoAccept("Technocore job secured", `Offer #${deal.offerSeq ?? "?"} was accepted at seq #${accepted.seq ?? "?"}; creating its deal room.`);
  }

  const lastOfferCheck = Date.parse(deal.offerCheckedAt || "");
  if (!deal.acceptSeq && deal.state !== "accept-pending" && (!Number.isFinite(lastOfferCheck) || Date.now() - lastOfferCheck >= 5_000)) {
    if (!await recheckAutoAcceptOffer(deal, identity)) {
      await resolveUnacceptedHunterMiss(deal, "auto-accept-unavailable", "OFFER IS NO LONGER AVAILABLE");
      return false;
    }
    deal.offerCheckedAt = new Date().toISOString();
    savePayeeDeal(deal);
  }

  let reserved = await inspectPayeeReservation(deal);
  if (!reserved) {
    const nonce = Date.now();
    const signature = await sign(identity, deal.room, nonce, deal.acceptLine);
    const response = await fetch(signedUrl(deal.room, identity, signature, nonce, deal.acceptLine), { cache: "no-store" });
    const result = clean(await response.text());
    if (!response.ok && response.status !== 422) {
      if (response.status === 400 && /room limit reached/i.test(result)) {
        deal.autoAcceptStatus = `ACCEPT VERIFIED · seq #${deal.acceptSeq ?? "?"} · ROOM FULL · RETRY #${eventSeq}`;
        savePayeeDeal(deal);
        return false;
      }
      throw new Error(`Room reservation rejected (${response.status}${result ? `: ${result.slice(0, 120)}` : ""})`);
    }
    for (let attempt = 0; attempt < 3 && !reserved; attempt += 1) {
      if (attempt) await new Promise((resolve) => setTimeout(resolve, 500));
      reserved = await inspectPayeeReservation(deal);
    }
    if (!reserved) {
      deal.autoAcceptStatus = "ROOM RETURNED OK · VERIFYING RESERVATION";
      savePayeeDeal(deal);
      return false;
    }
  }

  deal.reservationSeq = reserved.seq;
  deal.state = "accepted";
  deal.acceptSeq = accepted.seq;
  deal.autoAcceptStatus = `ACCEPT VERIFIED · seq #${accepted.seq ?? "?"} · ROOM RESERVED #${reserved.seq ?? "?"}`;
  savePayeeDeal(deal);
  stopPayeeAutoAccept(deal.autoAcceptStatus, deal);
  $("#check-payee-deal").disabled = false;
  $("#discard-payee-deal").disabled = true;
  $("#payee-status").textContent = `AUTO-ACCEPT VERIFIED · seq #${accepted.seq ?? "?"}\nDEAL ROOM RESERVED · seq #${reserved.seq ?? "?"}\nContract: ${deal.accept.contract}\nDeal room: /r/${deal.room}\nNEXT: Wait for the payer's signed lock, then press CHECK ACTIVE DEAL.`;
  notifyPayeeAutoAccept("Technocore job accepted", `Offer #${deal.offerSeq ?? "?"} is verified. Wait for the payer lock.`);
  await continueHunterAfterQueuedDeal(deal);
  return true;
}

async function runPayeeAutoAccept() {
  if (payeeAutoAcceptRunning || !readPayeeAutoAccept().armed) return;
  payeeAutoAcceptRunning = true;
  try {
    while (readPayeeAutoAccept().armed) {
      const deal = readPayeeDeal();
      if (!deal || deal.accept.contract !== readPayeeAutoAccept().contract) {
        stopPayeeAutoAccept("SAVED PAYEE DEAL IS MISSING");
        break;
      }
      if (Date.now() >= deal.offer.expiresMs || Date.now() >= deal.offer.claimByMs) {
        if (deal.acceptSeq) {
          stopPayeeAutoAccept(`ACCEPT #${deal.acceptSeq} VERIFIED · DEAL-ROOM DEADLINE PASSED`, deal);
          await continueHunterAfterQueuedDeal(deal);
        }
        else await resolveUnacceptedHunterMiss(deal, "auto-accept-expired", "OFFER EXPIRED BEFORE ACCEPT");
        break;
      }
      await tryAutoAcceptPayeeDeal(deal, "DIRECT");
      renderPayeeAutoAccept();
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  } catch (error) {
    const state = readPayeeAutoAccept();
    state.lastError = error.message;
    state.lastErrorAt = new Date().toISOString();
    localStorage.setItem(PAYEE_AUTO_ACCEPT_KEY, JSON.stringify(state));
    const deal = readPayeeDeal();
    if (deal) { deal.autoAcceptStatus = `TEMPORARY ERROR · ${error.message} · RETRYING`; savePayeeDeal(deal); }
    setTimeout(() => { payeeAutoAcceptRunning = false; void runPayeeAutoAccept(); }, 1_000);
    return;
  } finally {
    if (!readPayeeAutoAccept().armed) payeeAutoAcceptRunning = false;
  }
}

function savePayeeAutoHunter(state) {
  localStorage.setItem(PAYEE_AUTO_HUNTER_KEY, JSON.stringify(state));
  renderPayeeAutoHunter();
}

function renderPayeeAutoHunter() {
  const state = readPayeeAutoHunter();
  const deal = readPayeeDeal();
  const recoverable = Boolean(deal && ["auto-accept-expired", "auto-accept-unavailable"].includes(deal.state));
  const parkable = Boolean(deal?.acceptSeq && !recoverable);
  const status = $("#payee-auto-hunter-status");
  const arm = $("#payee-auto-hunter");
  const stop = $("#payee-auto-hunter-stop");
  if (!status || !arm || !stop) return;
  arm.disabled = state.armed || Boolean(deal && !recoverable && !parkable);
  arm.textContent = recoverable
    ? "VERIFY STALE DEAL & ARM AUTO-JOB HUNTER"
    : parkable
      ? "PARK ACTIVE DEAL & ARM AUTO-JOB HUNTER"
      : "ARM AUTO-JOB HUNTER";
  stop.disabled = !state.armed;
  status.textContent = state.armed
    ? `ARMED · TAB MUST STAY OPEN\nQueued jobs: ${activePayeeDeals().length}/${MAX_ACTIVE_PAYEE_DEALS}\nMinimum finish time: ${state.minFinishMinutes}m\n${state.status || "Watching signed tclk-offers"}`
    : `OFF\n${state.reason || "Arms once, immediately claims the newest actionable PAPER job, then creates its deal room."}`;
}

function stopPayeeAutoHunter(reason) {
  const state = readPayeeAutoHunter();
  savePayeeAutoHunter({ ...state, armed: false, reason, stoppedAt: new Date().toISOString() });
  payeeAutoHunterVaultPassword = null;
  payeeAutoHunterRunning = false;
}

function pausePayeeAutoHunter(reason) {
  const state = readPayeeAutoHunter();
  savePayeeAutoHunter({ ...state, armed: false, reason, stoppedAt: new Date().toISOString() });
  payeeAutoHunterRunning = false;
}

async function tryAutoHuntFromPayload(payload) {
  const state = readPayeeAutoHunter();
  const identity = readIdentity();
  if (!state.armed || !identity) return false;
  if (activePayeeDeals().length >= MAX_ACTIVE_PAYEE_DEALS) {
    stopPayeeAutoHunter(`QUEUE FULL · ${MAX_ACTIVE_PAYEE_DEALS}/${MAX_ACTIVE_PAYEE_DEALS} ACCEPTED JOBS`);
    return false;
  }
  if (readPayeeDeal()) {
    stopPayeeAutoHunter("PAUSED · AN ACTIVE OR PREPARED PAYEE DEAL ALREADY EXISTS");
    return false;
  }
  if (!payeeAutoHunterVaultPassword) {
    stopPayeeAutoHunter("STOPPED AFTER REFRESH · ARM AGAIN BECAUSE THE VAULT PASSWORD IS NEVER STORED");
    return false;
  }
  state.status = "Checking newest signed offers";
  savePayeeAutoHunter(state);
  const minimumFinishMs = state.minFinishMinutes * 60_000;
  const knownOfferIds = new Set(Object.values(readPayeeDeals()).map((deal) => deal?.offer?.id).filter(Boolean));
  const safe = prioritizePaperOffers((await listSafePaperOffers(payload, identity.did, Date.now(), minimumFinishMs))
    .filter((candidate) => !knownOfferIds.has(candidate.offer.id)))
    .slice(0, 8);
  void refreshPayerLockPriority(safe);
  const candidate = await verifyFirstPaperOffer(safe);
  if (!candidate) {
    state.status = "No eligible offer yet · still watching";
    savePayeeAutoHunter(state);
    return false;
  }

  const prepared = makePayeeAcceptance(candidate.offer, identity.did);
  const sealedSecret = await sealSecret(payeeAutoHunterVaultPassword, prepared.contract, prepared.secret);
  const deal = {
    offer: candidate.offer,
    offerSeq: candidate.seq,
    accept: prepared.accept,
    acceptLine: prepared.line,
    room: prepared.room,
    sealedSecret,
    jobSnapshot: candidate.spec,
    selectedBy: "auto-job-hunter",
    minimumFinishMs,
  };
  savePayeeDeal(deal);
  pausePayeeAutoHunter(`MATCHED OFFER #${candidate.seq} · PUBLISHING ACCEPT NOW`);
  notifyPayeeAutoAccept("Actionable PAPER job matched", `Offer #${candidate.seq} is selected; publishing accept immediately.`);
  await startPayeeAutoAccept(deal, state.notificationPermission);
  return true;
}

async function runPayeeAutoHunter() {
  if (payeeAutoHunterRunning || !readPayeeAutoHunter().armed) return;
  payeeAutoHunterRunning = true;
  try {
    while (readPayeeAutoHunter().armed) {
      const state = readPayeeAutoHunter();
      const ready = await detectQueuedPayeeLock();
      if (ready) {
        stopPayeeAutoHunter(`LOCK DETECTED · OFFER #${ready.offerSeq ?? "?"} READY TO WORK`);
        notifyPayeeAutoAccept("Payee job ready", `Offer #${ready.offerSeq ?? "?"} received its payer lock. Open it from the payee queue.`);
        break;
      }
      const response = await fetch(`https://technocore.chat/r/${OFFER_ROOM}?since=${state.cursor}&wait=10&format=json&n=${Date.now()}`, { headers: { accept: "application/json" }, cache: "no-store" });
      if (!response.ok) throw new Error(`Offer stream failed (${response.status})`);
      const payload = await response.json();
      const messages = Array.isArray(payload.messages) ? payload.messages : [];
      for (const message of messages) if (Number(message.seq) > Number(state.cursor)) state.cursor = Number(message.seq);
      state.lastPollAt = new Date().toISOString();
      savePayeeAutoHunter(state);
      if (await tryAutoHuntFromPayload(payload)) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  } catch (error) {
    const state = readPayeeAutoHunter();
    state.status = `TEMPORARY ERROR · ${error.message} · RETRYING`;
    state.lastErrorAt = new Date().toISOString();
    savePayeeAutoHunter(state);
    setTimeout(() => { payeeAutoHunterRunning = false; void runPayeeAutoHunter(); }, 1_000);
    return;
  } finally {
    if (!readPayeeAutoHunter().armed) payeeAutoHunterRunning = false;
  }
}

function autoSettleDeals() {
  const active = readPayerDeal();
  if (active) rememberPayerDeal(active);
  return Object.values(readPayerDeals())
    .filter((deal) => deal?.offer && deal?.accept && deal?.lock)
    .filter((deal) => ["locked", "claimed", "refunded"].includes(deal.state))
    .filter((deal) => !deal.receiptVerifiedAt && !deal.failReviewVerifiedAt && !deal.noDeliveryReviewVerifiedAt);
}

function payerDealLabel(deal) {
  return deal.offerSeq ? `OFFER #${deal.offerSeq}` : `${deal.accept.contract.slice(0, 14)}…`;
}

function renderPayerAutoSettle() {
  const state = readPayerAutoSettle();
  const deals = Object.values(readPayerDeals()).filter((deal) => deal?.accept?.contract && ["locked", "claimed", "refunded"].includes(deal.state));
  $("#payer-auto-settle").textContent = state.armed ? "STOP SAFE AUTO-SETTLE" : "ARM SAFE AUTO-SETTLE";
  $("#payer-auto-settle-status").textContent = `${state.armed ? "ARMED · TAB MUST STAY OPEN" : "OFF"}\n${deals.length ? deals.map((deal) => {
    const status = deal.receiptVerifiedAt
      ? "TERMINAL RECEIPT VERIFIED"
      : deal.failReviewVerifiedAt
        ? `DELIVERY REJECTED · FAIL REVIEW #${deal.failReviewSeq ?? "?"}`
        : deal.noDeliveryReviewVerifiedAt
          ? `NO DELIVERY REJECTED · FAIL REVIEW #${deal.noDeliveryReviewSeq ?? "?"}`
          : deal.autoSettleStatus || (deal.state === "locked" ? "WAITING FOR SIGNED DELIVERY / REVEAL" : "CHECKING TERMINAL STATE");
    return `${payerDealLabel(deal)}: ${status}`;
  }).join("\n") : "No locked payer deals saved."}${state.armed ? `\nPending: ${autoSettleDeals().length} · checking every 30 seconds` : ""}`;
}

function notifyAutoSettle(deal, key, title, body) {
  const state = readPayerAutoSettle();
  state.notified = state.notified || {};
  const id = `${deal.accept.contract}:${key}`;
  if (state.notified[id]) return;
  state.notified[id] = new Date().toISOString();
  localStorage.setItem(PAYER_AUTO_SETTLE_KEY, JSON.stringify(state));
  notice(`${title}: ${body}`);
  if ("Notification" in window && Notification.permission === "granted") new Notification(title, { body });
}

async function readJobForAutoSettle(deal) {
  const url = contextUrl(deal.offer.job.context);
  if (!url.startsWith("https://technocore.chat/")) return null;
  const response = await fetch(`${url}${url.includes("?") ? "&" : "?"}n=${Date.now()}`, { cache: "no-store" });
  if (!response.ok) return null;
  return reviewJobSpec(await response.text(), deal.offer);
}

function deliveryNeedsHumanReview(evaluation) {
  return !evaluation?.ok && /no supported deterministic validator|not machine-verifiable/i.test(String(evaluation?.reason || ""));
}

function claimedDeliveryApproved(deal) {
  if (deal?.deliveryEvaluation?.ok) return true;
  return Boolean(deal?.deliveryReviewAllowed && deal.deliverySeq != null && String(deal.manualDeliveryApprovedSeq) === String(deal.deliverySeq));
}

function deterministicDeliveryFailure(deal) {
  return Boolean(deal?.deliverySeq != null && deal?.deliveryEvaluation && !deal.deliveryEvaluation.ok && !deal.deliveryReviewAllowed);
}

function manualDeliveryFailure(deal) {
  return Boolean(deal?.deliveryReviewAllowed && deal?.deliverySeq != null
    && String(deal.manualDeliveryRejectedSeq) === String(deal.deliverySeq));
}

function deliveryFailureReviewAllowed(deal) {
  return deterministicDeliveryFailure(deal) || manualDeliveryFailure(deal);
}

function payerFailReview(deal) {
  const reason = manualDeliveryFailure(deal)
    ? "Manual review: delivery does not satisfy the custom job requirements"
    : deal.deliveryEvaluation.reason;
  return makePayerDeliveryReview(deal.offer, deal.accept, deal.offer.from, Number(deal.deliverySeq), "FAIL", reason);
}

function payerNoDeliveryReview(deal) {
  return makePayerNoDeliveryReview(deal.offer, deal.accept, deal.offer.from);
}

async function inspectPayerFailReview(deal, roomPayload) {
  if (!deliveryFailureReviewAllowed(deal)) {
    delete deal.failReviewSeq;
    delete deal.failReviewVerifiedAt;
    return null;
  }
  const review = payerFailReview(deal);
  const existing = await verifyExactSignedTextRecord(roomPayload, review.line, deal.offer.from, review.room);
  if (!existing) return null;
  deal.failReviewSeq = existing.seq;
  deal.failReviewVerifiedAt = new Date().toISOString();
  deal.autoSettleStatus = `DELIVERY REJECTED · FAIL REVIEW #${existing.seq ?? "?"}`;
  return existing;
}

async function inspectPayerNoDeliveryReview(deal, roomPayload) {
  const noDeliveryClaim = deal?.state === "claimed" && deal?.railState === "claimed" && deal.deliverySeq == null;
  if (!noDeliveryClaim) {
    delete deal.noDeliveryReviewSeq;
    delete deal.noDeliveryReviewVerifiedAt;
    return null;
  }
  const review = payerNoDeliveryReview(deal);
  const existing = await verifyExactSignedTextRecord(roomPayload, review.line, deal.offer.from, review.room);
  if (!existing) return null;
  deal.noDeliveryReviewSeq = existing.seq;
  deal.noDeliveryReviewVerifiedAt = new Date().toISOString();
  deal.autoSettleStatus = `NO DELIVERY REJECTED · FAIL REVIEW #${existing.seq ?? "?"}`;
  return existing;
}

async function inspectSignedPayerDelivery(deal, roomPayload, folded) {
  const job = await readJobForAutoSettle(deal);
  const fallbackRoom = deal.lock?.room || deal.room;
  const deliveryRoom = resolveDeliveryRoom(job?.text || "", fallbackRoom, deal.deliveryRoom);
  let deliveryPayload = roomPayload;
  if (deliveryRoom !== fallbackRoom) {
    const response = await fetch(`https://technocore.chat/r/${deliveryRoom}?limit=200&format=json&n=${Date.now()}`, { headers: { accept: "application/json" }, cache: "no-store" });
    deliveryPayload = response.status === 404 ? { messages: [] } : response.ok ? await response.json() : null;
    if (!deliveryPayload) throw new Error(`Delivery room read failed (${response.status})`);
  }
  const deliveries = await listSignedDeliveries(deliveryPayload, deal.accept, deliveryRoom);
  const revealEvent = folded.applied.find((entry) => entry.frame.type === "reveal");
  const lockEvent = folded.applied.find((entry) => entry.frame.type === "lock");
  const delivery = lockEvent?.ts ? latestDeliveryBeforeReveal(deliveries, {
    sameRoom: deliveryRoom === fallbackRoom,
    revealSeq: revealEvent?.seq,
    revealTs: revealEvent?.ts,
    claimByMs: deal.offer.claimByMs,
    notBeforeTs: lockEvent.ts,
  }) : null;
  const previousSeq = deal.deliverySeq;
  deal.deliveryRoom = deliveryRoom;
  delete deal.deliverySeq;
  delete deal.deliveryPreview;
  delete deal.deliveryEvaluation;
  delete deal.deliveryReviewAllowed;
  if (!delivery) {
    delete deal.manualDeliveryApprovedSeq;
    return null;
  }
  const evaluation = job ? evaluateObjectiveDelivery(job.text, delivery.text, deal.offer) : { ok: false, reason: "Job specification is not machine-verifiable" };
  deal.deliverySeq = delivery.seq;
  deal.deliveryPreview = delivery.text.slice(0, 1000);
  deal.deliveryEvaluation = evaluation;
  deal.deliveryReviewAllowed = deliveryNeedsHumanReview(evaluation);
  if (String(previousSeq) !== String(delivery.seq)) delete deal.manualDeliveryApprovedSeq;
  return { delivery, evaluation };
}

async function publishVerifiedPayerReceipt(deal, roomPayload, outcome) {
  const identity = readIdentity();
  if (!identity || identity.did !== deal.offer.from) throw new Error("Local DID does not match the payer");
  const receipt = makePayeeReceipt(deal.accept, identity.did, outcome);
  const existing = await verifyExactFrameRecord(roomPayload, receipt.frame, receipt.room);
  if (existing) {
    deal.receiptSeq = existing.seq;
    deal.receiptVerifiedAt = new Date().toISOString();
    deal.autoSettleStatus = `TERMINAL RECEIPT VERIFIED · seq #${existing.seq ?? "?"}`;
    updateStoredPayerDeal(deal);
    return true;
  }
  if (deal.receiptPublishReturnedOkAt && Date.now() - Date.parse(deal.receiptPublishReturnedOkAt) < 60_000) {
    deal.autoSettleStatus = "RECEIPT RETURNED OK · VERIFYING TRANSCRIPT";
    updateStoredPayerDeal(deal);
    return false;
  }
  const nonce = Date.now();
  const signature = await sign(identity, receipt.room, nonce, receipt.line);
  const response = await fetch(signedUrl(receipt.room, identity, signature, nonce, receipt.line), { cache: "no-store" });
  const result = clean(await response.text());
  if (!response.ok && response.status !== 422) throw new Error(`Terminal receipt rejected (${response.status}${result ? `: ${result.slice(0, 120)}` : ""})`);
  deal.receiptPublishReturnedOkAt = new Date().toISOString();
  updateStoredPayerDeal(deal);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt) await new Promise((resolve) => setTimeout(resolve, 500));
    const check = await fetch(`https://technocore.chat/r/${receipt.room}?limit=200&format=json&n=${Date.now()}`, { headers: { accept: "application/json" }, cache: "no-store" });
    if (!check.ok) continue;
    const verified = await verifyExactFrameRecord(await check.json(), receipt.frame, receipt.room);
    if (verified) {
      deal.receiptSeq = verified.seq;
      deal.receiptVerifiedAt = new Date().toISOString();
      deal.autoSettleStatus = `TERMINAL RECEIPT VERIFIED · seq #${verified.seq ?? "?"}`;
      updateStoredPayerDeal(deal);
      return true;
    }
  }
  deal.autoSettleStatus = "RECEIPT RETURNED OK · VERIFYING TRANSCRIPT";
  updateStoredPayerDeal(deal);
  return false;
}

async function inspectAndAutoSettle(deal) {
  const roomResponse = await fetch(`https://technocore.chat/r/${deal.lock.room}?limit=200&format=json&n=${Date.now()}`, { headers: { accept: "application/json" }, cache: "no-store" });
  if (!roomResponse.ok) throw new Error(`Deal room read failed (${roomResponse.status})`);
  const roomPayload = await roomResponse.json();
  const folded = await foldPayeeDeal(roomPayload, deal.offer, deal.accept);
  const expected = expectedPaperLock(deal.offer, deal.accept);
  const noteResponse = await fetch(`https://technocore.chat/kv/${expected.note.ns}/${expected.note.key}?n=${Date.now()}`, { cache: "no-store" });
  const railState = noteResponse.ok ? classifyPaperRecord(stripNoteBanner(await noteResponse.text()), deal.offer, deal.accept) : "absent";
  deal.state = folded.state.status;
  deal.railState = railState;
  deal.checkedAt = new Date().toISOString();
  const inspected = ["locked", "claimed"].includes(folded.state.status)
    ? await inspectSignedPayerDelivery(deal, roomPayload, folded)
    : null;

  if (folded.state.status === "locked") {
    if (inspected?.delivery) {
      const { delivery } = inspected;
      deal.autoSettleStatus = `SIGNED DELIVERY #${delivery.seq ?? "?"} · WAITING FOR VALID REVEAL`;
      notifyAutoSettle(deal, `delivery:${delivery.seq}`, "Technocore delivery received", `${payerDealLabel(deal)} has a signed delivery and is waiting for reveal.`);
    } else if (Date.now() >= deal.offer.refundAfterMs) {
      deal.autoSettleStatus = "REFUND AVAILABLE · MANUAL ACTION REQUIRED";
      notifyAutoSettle(deal, "refund", "Technocore refund available", `${payerDealLabel(deal)} has no valid reveal. Open Task Relay to review the refund.`);
    } else deal.autoSettleStatus = "WAITING FOR SIGNED DELIVERY / REVEAL";
    updateStoredPayerDeal(deal);
    return;
  }

  if (folded.state.status === "refunded") {
    if (railState !== "refunded") {
      deal.autoSettleStatus = "REFUND FRAME FOUND · WAITING FOR PAPER RAIL";
      updateStoredPayerDeal(deal);
      return;
    }
    await publishVerifiedPayerReceipt(deal, roomPayload, "refunded");
    return;
  }

  if (folded.state.status !== "claimed") {
    deal.autoSettleStatus = `TERMINAL CHECK BLOCKED · ${folded.state.status}`;
    updateStoredPayerDeal(deal);
    return;
  }
  if (railState !== "claimed") {
    deal.autoSettleStatus = "VALID REVEAL FOUND · WAITING FOR PAPER RAIL CLAIM";
    updateStoredPayerDeal(deal);
    return;
  }

  if (!inspected) {
    const rejected = await inspectPayerNoDeliveryReview(deal, roomPayload);
    deal.autoSettleStatus = rejected ? `NO DELIVERY REJECTED · FAIL REVIEW #${rejected.seq ?? "?"}` : "REVIEW REQUIRED · NO SIGNED DELIVERY BEFORE REVEAL";
    updateStoredPayerDeal(deal);
    if (!rejected) {
      const revealSeq = folded.applied.find((entry) => entry.frame.type === "reveal")?.seq;
      notifyAutoSettle(deal, `review:no-delivery:${revealSeq}`, "Technocore review required", `${payerDealLabel(deal)} revealed without a signed delivery that can be auto-approved.`);
    }
    return;
  }
  const { delivery, evaluation } = inspected;
  if (!evaluation.ok) {
    const rejected = await inspectPayerFailReview(deal, roomPayload);
    deal.autoSettleStatus = rejected ? `DELIVERY REJECTED · FAIL REVIEW #${rejected.seq ?? "?"}` : `REVIEW REQUIRED · ${evaluation.reason}`;
    updateStoredPayerDeal(deal);
    notifyAutoSettle(deal, `review:${delivery.seq}:${evaluation.reason}`, "Technocore review required", `${payerDealLabel(deal)} delivery needs manual review: ${evaluation.reason}.`);
    return;
  }
  deal.autoSettleStatus = `OBJECTIVE DELIVERY PASSED · seq #${delivery.seq ?? "?"}`;
  updateStoredPayerDeal(deal);
  const published = await publishVerifiedPayerReceipt(deal, roomPayload, "claimed");
  if (published) notifyAutoSettle(deal, `settled:${deal.receiptSeq}`, "Technocore deal finalized", `${payerDealLabel(deal)} passed deterministic checks and its terminal receipt is verified.`);
}

async function runPayerAutoSettle() {
  if (payerAutoSettleRunning || !readPayerAutoSettle().armed) return;
  payerAutoSettleRunning = true;
  try {
    while (readPayerAutoSettle().armed) {
      const deals = autoSettleDeals();
      for (const deal of deals) {
        try { await inspectAndAutoSettle(deal); }
        catch (error) {
          deal.autoSettleStatus = `TEMPORARY ERROR · ${error.message}`;
          updateStoredPayerDeal(deal);
        }
      }
      if (deals.length && !autoSettleDeals().length) {
        const state = readPayerAutoSettle();
        state.armed = false;
        state.completedAt = new Date().toISOString();
        localStorage.setItem(PAYER_AUTO_SETTLE_KEY, JSON.stringify(state));
        notice("All eligible payer deals have verified terminal receipts; safe auto-settle stopped");
      }
      renderPayerDeal();
      renderPayerAutoSettle();
      if (readPayerAutoSettle().armed) await new Promise((resolve) => setTimeout(resolve, 30_000));
    }
  } finally { payerAutoSettleRunning = false; }
}

function renderPayerDeal() {
  const deal = readPayerDeal();
  const lockSubmissionPending = deal?.state === "lock-submitted" || deal?.state === "lock-submission-opened";
  $("#open-payer-room").disabled = !deal;
  $("#check-payer-deal").disabled = !deal;
  const claimedTerminal = deal?.state === "claimed" && deal?.railState === "claimed";
  const refundedTerminal = deal?.state === "refunded" && deal?.railState === "refunded";
  const terminal = refundedTerminal || (claimedTerminal && claimedDeliveryApproved(deal));
  $("#refund-payer-deal").disabled = !(deal?.state === "locked" && deal?.railState === "locked" && Date.now() >= deal.offer.refundAfterMs);
  $("#publish-payer-receipt").disabled = !terminal;
  const humanRejectable = deal?.deliveryReviewAllowed && deal?.deliverySeq != null && !claimedDeliveryApproved(deal);
  $("#publish-payer-fail-review").disabled = !(claimedTerminal && (deterministicDeliveryFailure(deal) || humanRejectable) && !deal.failReviewVerifiedAt);
  $("#publish-payer-no-delivery-review").disabled = !(claimedTerminal && deal.deliverySeq == null && !deal.noDeliveryReviewVerifiedAt);
  const deliveryStatus = $("#payer-delivery-status");
  const approveDelivery = $("#approve-payer-delivery");
  if (approveDelivery) {
    approveDelivery.checked = Boolean(deal?.deliverySeq != null && String(deal.manualDeliveryApprovedSeq) === String(deal.deliverySeq));
    approveDelivery.disabled = !(claimedTerminal && deal?.deliveryReviewAllowed);
  }
  if (deliveryStatus) {
    deliveryStatus.textContent = !deal
      ? "No signed delivery checked."
      : deal.deliverySeq == null
        ? `${deal.noDeliveryReviewVerifiedAt ? "REJECTED · SIGNED NO-DELIVERY FAIL REVIEW VERIFIED" : "BLOCKED"} · No signed non-tclk result from the accepted payee was verified before reveal.`
        : `${deal.failReviewVerifiedAt ? "REJECTED · SIGNED FAIL REVIEW VERIFIED" : deal.deliveryEvaluation?.ok ? "PASSED" : deal.deliveryReviewAllowed ? "HUMAN REVIEW REQUIRED" : "FAILED"} · SIGNED DELIVERY #${deal.deliverySeq}\n${deal.deliveryEvaluation?.reason || "Not evaluated"}\n\n${deal.deliveryPreview || ""}`;
  }
  if (!deal) {
    $("#payer-deal-status").textContent = "No active payer deal saved in this browser.";
    return;
  }
  const state = lockSubmissionPending ? "lock submission opened — NOT VERIFIED" : (deal.state || "accepted / lock prepared");
  const rail = deal.railState || "check required";
  const next = state === "refunded" && rail === "refunded"
    ? "NEXT: Sign the refunded terminal receipt to archive the outcome."
    : state === "claimed" && rail === "claimed" && deal.noDeliveryReviewVerifiedAt
      ? `TERMINAL: Signed no-delivery FAIL review verified at seq #${deal.noDeliveryReviewSeq ?? "?"}; no payer PASS receipt will be issued.`
    : state === "claimed" && rail === "claimed" && deal.deliverySeq == null
      ? "NEXT: Reveal/claim exists, but no signed job delivery was verified before it. Receipt stays disabled; publish a signed no-delivery FAIL review."
    : state === "claimed" && rail === "claimed" && deal.failReviewVerifiedAt
      ? `TERMINAL: Signed FAIL review verified at seq #${deal.failReviewSeq ?? "?"}; no payer PASS receipt will be issued.`
    : state === "claimed" && rail === "claimed" && deal.deliveryReviewAllowed && !claimedDeliveryApproved(deal)
      ? "NEXT: Review the signed delivery above and approve it manually only if the custom job is truly satisfied."
    : state === "claimed" && rail === "claimed" && !claimedDeliveryApproved(deal)
      ? `NEXT: Signed delivery failed validation — ${deal.deliveryEvaluation?.reason || "unknown reason"}. Publish a signed FAIL review.`
    : state === "claimed" && rail === "claimed"
      ? "NEXT: Verified delivery passed; sign the terminal receipt to archive the outcome."
    : lockSubmissionPending
      ? "NEXT: The signed lock is not confirmed on Technocore. If its tab returned 400, wait for a slot and press VERIFY & PUBLISH SIGNED LOCK again. After Technocore says ok, press VERIFY LOCK / CHECK RESULT."
    : state === "accepted" || state === "accepted / lock prepared"
      ? "NEXT: The deal is accepted, but its signed lock is not in the deal-room transcript. Create or verify PaperRail, then press VERIFY & PUBLISH SIGNED LOCK."
    : state === "claimed"
      ? "NEXT: Wait for the payee to advance PaperRail, then check again."
      : state === "locked" && rail === "locked" && Date.now() >= deal.offer.refundAfterMs
        ? "NEXT: The deadline passed without reveal. Refund the expired deal."
      : "NEXT: Wait for the payee's signed result/reveal, then press VERIFY LOCK / CHECK RESULT.";
  const seqs = deal.offerSeq || deal.acceptSeq ? `\nVerified chain: OFFER #${deal.offerSeq ?? "?"} → ACCEPT #${deal.acceptSeq ?? "?"}` : "";
  $("#payer-deal-status").textContent = `Contract: ${deal.accept.contract}\nCounterparty: ${deal.accept.from}\nDeal room: /r/${deal.lock.room}${seqs}\nTranscript state: ${state}\nPaperRail state: ${rail}\n${next}`;
}

$("#approve-payer-delivery")?.addEventListener("change", (event) => {
  const deal = readPayerDeal();
  if (!deal?.deliveryReviewAllowed || deal.deliverySeq == null) { event.target.checked = false; return; }
  if (!event.target.checked) {
    delete deal.manualDeliveryApprovedSeq;
    saveActivePayerDeal(deal);
    renderPayerDeal();
    return;
  }
  if (!window.confirm(`Approve this exact signed delivery manually?\n\nSeq #${deal.deliverySeq}\n${deal.deliveryPreview}\n\nOnly continue if it satisfies every custom job requirement.`)) {
    event.target.checked = false;
    return;
  }
  deal.manualDeliveryApprovedSeq = deal.deliverySeq;
  saveActivePayerDeal(deal);
  renderPayerDeal();
  notice(`Signed delivery #${deal.deliverySeq} manually approved for this custom job`);
});

$("#publish-payer-fail-review")?.addEventListener("click", async () => {
  const identity = readIdentity(); const deal = readPayerDeal();
  const humanRejectable = deal?.deliveryReviewAllowed && deal?.deliverySeq != null && !claimedDeliveryApproved(deal);
  if (!identity || identity.did !== deal?.offer?.from || deal?.state !== "claimed" || deal?.railState !== "claimed" || !(deterministicDeliveryFailure(deal) || humanRejectable)) return;
  try {
    const response = await fetch(`https://technocore.chat/r/${deal.lock.room}?limit=200&format=json&n=${Date.now()}`, { headers: { accept: "application/json" }, cache: "no-store" });
    if (!response.ok) throw new Error(`Deal room read failed (${response.status})`);
    const roomPayload = await response.json();
    const folded = await foldPayeeDeal(roomPayload, deal.offer, deal.accept);
    await inspectSignedPayerDelivery(deal, roomPayload, folded);
    const refreshedHumanRejectable = deal.deliveryReviewAllowed && deal.deliverySeq != null && !claimedDeliveryApproved(deal);
    if (!(deterministicDeliveryFailure(deal) || refreshedHumanRejectable)) throw new Error("The selected delivery no longer qualifies for rejection");
    if (refreshedHumanRejectable) {
      deal.manualDeliveryRejectedSeq = deal.deliverySeq;
      delete deal.manualDeliveryApprovedSeq;
    }
    const review = payerFailReview(deal);
    const existing = await inspectPayerFailReview(deal, roomPayload);
    if (existing) {
      saveActivePayerDeal(deal); renderPayerDeal();
      notice(`Signed FAIL review already exists at seq #${existing.seq ?? "?"}; no duplicate was published`);
      return;
    }
    if (!window.confirm(`Publish this DID-signed payer rejection?\n\n${review.line}\n\nThis records that the delivery failed review and will not issue a PASS receipt.`)) return;
    const nonce = Date.now(); const signature = await sign(identity, review.room, nonce, review.line);
    window.open(signedUrl(review.room, identity, signature, nonce, review.line), "_blank", "noopener,noreferrer");
    deal.failReviewSubmittedAt = new Date().toISOString();
    deal.autoSettleStatus = "FAIL REVIEW SUBMISSION OPENED · VERIFYING TRANSCRIPT";
    saveActivePayerDeal(deal); renderPayerDeal();
    notice("Signed FAIL review opened; confirm Technocore says ok, then press VERIFY LOCK / CHECK RESULT");
  } catch (error) { notice(`FAIL review blocked: ${error.message}`); }
});

$("#publish-payer-no-delivery-review")?.addEventListener("click", async () => {
  const identity = readIdentity(); const deal = readPayerDeal();
  if (!identity || identity.did !== deal?.offer?.from || deal?.state !== "claimed" || deal?.railState !== "claimed") return;
  try {
    const response = await fetch(`https://technocore.chat/r/${deal.lock.room}?limit=200&format=json&n=${Date.now()}`, { headers: { accept: "application/json" }, cache: "no-store" });
    if (!response.ok) throw new Error(`Deal room read failed (${response.status})`);
    const roomPayload = await response.json();
    const folded = await foldPayeeDeal(roomPayload, deal.offer, deal.accept);
    await inspectSignedPayerDelivery(deal, roomPayload, folded);
    if (folded.state.status !== "claimed" || deal.deliverySeq != null) throw new Error("This deal no longer qualifies as a claimed deal without a signed delivery before reveal");
    const review = payerNoDeliveryReview(deal);
    const existing = await inspectPayerNoDeliveryReview(deal, roomPayload);
    if (existing) {
      saveActivePayerDeal(deal); renderPayerDeal();
      notice(`Signed no-delivery FAIL review already exists at seq #${existing.seq ?? "?"}; no duplicate was published`);
      return;
    }
    if (!window.confirm(`Publish this DID-signed payer rejection?\n\n${review.line}\n\nThis records that no signed delivery existed before reveal and will not issue a PASS receipt.`)) return;
    const nonce = Date.now(); const signature = await sign(identity, review.room, nonce, review.line);
    window.open(signedUrl(review.room, identity, signature, nonce, review.line), "_blank", "noopener,noreferrer");
    deal.noDeliveryReviewSubmittedAt = new Date().toISOString();
    deal.autoSettleStatus = "NO-DELIVERY FAIL REVIEW SUBMISSION OPENED · VERIFYING TRANSCRIPT";
    saveActivePayerDeal(deal); renderPayerDeal();
    notice("Signed no-delivery FAIL review opened; confirm Technocore says ok, then press VERIFY LOCK / CHECK RESULT");
  } catch (error) { notice(`No-delivery FAIL review blocked: ${error.message}`); }
});
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
    saveActivePayerDeal({ offer, accept: found.accept, acceptSeq: found.seq, lock });
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
      saveActivePayerDeal(deal);
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
    saveActivePayerDeal(deal);
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
    const roomPayload = await roomResponse.json();
    const folded = await foldPayeeDeal(roomPayload, deal.offer, deal.accept);
    const expected = expectedPaperLock(deal.offer, deal.accept);
    let railState = "absent";
    const noteResponse = await fetch(`https://technocore.chat/kv/${expected.note.ns}/${expected.note.key}?n=${Date.now()}`);
    if (noteResponse.ok) railState = classifyPaperRecord(stripNoteBanner(await noteResponse.text()), deal.offer, deal.accept);
    deal.state = folded.state.status; deal.railState = railState; deal.checkedAt = new Date().toISOString();
    await inspectSignedPayerDelivery(deal, roomPayload, folded);
    await inspectPayerFailReview(deal, roomPayload);
    await inspectPayerNoDeliveryReview(deal, roomPayload);
    saveActivePayerDeal(deal);
    renderPayerDeal();
    notice(folded.state.status === "claimed"
      ? claimedDeliveryApproved(deal) ? "Valid reveal and approved signed delivery found" : "Reveal found, but terminal receipt is blocked by the signed-delivery gate"
      : "No valid payee reveal yet");
    void syncTrackRecord({ announce: false });
  } catch (error) {
    const pending = deal.state === "lock-submitted" || deal.state === "lock-submission-opened";
    $("#payer-deal-status").textContent = `Payer deal check failed: ${error.message}\nSaved deal data was preserved.${pending ? "\nSIGNED LOCK IS NOT CONFIRMED. If the publish tab returned 400, wait for a slot and retry VERIFY & PUBLISH SIGNED LOCK." : ""}`;
  }
});

$("#publish-payer-receipt").addEventListener("click", async () => {
  const identity = readIdentity(); const deal = readPayerDeal();
  const terminal = (deal?.state === "claimed" && deal?.railState === "claimed" && claimedDeliveryApproved(deal)) || (deal?.state === "refunded" && deal?.railState === "refunded");
  if (!identity || !terminal) return;
  const button = $("#publish-payer-receipt");
  button.disabled = true;
  try {
    const receipt = makePayeeReceipt(deal.accept, identity.did, deal.state);
    const roomResponse = await fetch(`https://technocore.chat/r/${receipt.room}?limit=200&format=json&n=${Date.now()}`, { headers: { accept: "application/json" }, cache: "no-store" });
    if (!roomResponse.ok) throw new Error(`Deal room read failed (${roomResponse.status})`);
    const roomPayload = await roomResponse.json();
    const existing = await verifyExactFrameRecord(roomPayload, receipt.frame, receipt.room);
    if (existing) {
      deal.receiptSeq = existing.seq;
      deal.receiptVerifiedAt = new Date().toISOString();
      saveActivePayerDeal(deal);
      notice(`Terminal receipt already exists at seq #${existing.seq ?? "?"}; no duplicate was published`);
      return;
    }
    if (deal.state === "claimed") {
      const folded = await foldPayeeDeal(roomPayload, deal.offer, deal.accept);
      await inspectSignedPayerDelivery(deal, roomPayload, folded);
      saveActivePayerDeal(deal);
      if (!claimedDeliveryApproved(deal)) throw new Error("no approved signed delivery exists before reveal");
    }
    if (!window.confirm(`Archive this terminal payer deal with a signed ${deal.state} receipt?\n\n${receipt.line}`)) return;
    notice("Signing and publishing the terminal payer receipt…");
    const verified = await publishVerifiedPayerReceipt(deal, roomPayload, deal.state);
    if (verified) {
      notice(`Terminal payer receipt verified at seq #${deal.receiptSeq ?? "?"}`);
      void syncTrackRecord({ announce: false });
    } else {
      notice("Technocore accepted the payer receipt; verification is still propagating. Press once more after a few seconds to verify it without duplicating.");
    }
  } catch (error) {
    notice(`Terminal receipt was not published: ${error.message}`);
  } finally {
    saveActivePayerDeal(deal);
    renderPayerDeal();
  }
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
    saveActivePayerDeal(deal);
    renderPayerDeal();
    notice("PaperRail refunded; confirm the signed refund on Technocore, then check the deal");
  } catch (error) { $("#payer-deal-status").textContent = `${error.message}\nSaved deal data was preserved.`; }
});

const readPayeeDeal = () => { try { return JSON.parse(localStorage.getItem(PAYEE_DEAL_KEY)); } catch { return null; } };
function contextUrl(context) { return context.startsWith("/kv/") ? `https://technocore.chat${context}` : context; }
function freshContextUrl(context) {
  const url = new URL(contextUrl(context));
  url.searchParams.set("n", String(Date.now()));
  return url.toString();
}
async function readOfferHistory() {
  const response = await fetch(`https://technocore.chat/r/${OFFER_ROOM}/export?n=${Date.now()}`, {
    headers: { accept: "application/x-ndjson, application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`Technocore offer history read failed (${response.status})`);
  return response.text();
}
async function readOfferTail() {
  const response = await fetch(`https://technocore.chat/r/${OFFER_ROOM}?format=json&limit=200&n=${Date.now()}`, { headers: { accept: "application/json" }, cache: "no-store", signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`Technocore recent offers read failed (${response.status})`);
  return response.json();
}
async function readOfferWindow(offerSeq) {
  const since = Math.max(0, Number(offerSeq || 1) - 1);
  const [windowResponse, tail] = await Promise.all([
    fetch(`https://technocore.chat/r/${OFFER_ROOM}?since=${since}&format=json&limit=200&n=${Date.now()}`, { headers: { accept: "application/json" }, cache: "no-store" }),
    readOfferTail(),
  ]);
  if (!windowResponse.ok) throw new Error(`Technocore offer window read failed (${windowResponse.status})`);
  const windowPayload = await windowResponse.json();
  const merged = new Map();
  for (const message of [...(windowPayload.messages || []), ...(tail.messages || [])]) merged.set(message.seq, message);
  return { messages: [...merged.values()].sort((left, right) => Number(left.seq) - Number(right.seq)) };
}

function payeeDeliveryRoom(deal) {
  return resolveDeliveryRoom(deal?.jobSnapshot?.text || "", deal?.room, deal?.deliveryRoom);
}

async function readPayeeDeliveryRoom(deal) {
  const room = payeeDeliveryRoom(deal);
  const response = await fetch(`https://technocore.chat/r/${room}?limit=200&format=json&n=${Date.now()}`, { cache: "no-store" });
  if (response.status === 404) return { room, payload: { messages: [] } };
  if (!response.ok) throw new Error(`Delivery room read failed (${response.status})`);
  return { room, payload: await response.json() };
}
function resetPayeeUi() {
  $("#check-payee-deal").disabled = true;
  $("#discard-payee-deal").disabled = true;
  $("#work-complete").checked = false;
  $("#work-complete").disabled = true;
  $("#payee-delivery").value = "";
  $("#payee-delivery").disabled = true;
  $("#publish-payee-delivery").disabled = true;
  $("#publish-reveal").disabled = true;
  $("#claim-paper").disabled = true;
  $("#publish-receipt").disabled = true;
  $("#payee-status").textContent = "No offer accepted by this browser.";
  renderPayeeJobNote();
}

function renderPayeeOffers(items) {
  const root = $("#payee-candidates"); root.classList.toggle("empty", !items.length);
  root.replaceChildren(...(items.length ? items.map(({ offer, seq, spec }) => {
    const card = document.createElement("article"); card.className = "mission";
    const id = document.createElement("code"); id.textContent = `seq #${seq} · ${offer.id.slice(0, 18)}…`;
    const title = document.createElement("h2"); title.textContent = `${offer.job.proto.toUpperCase()} · ${offer.job.id}`;
    const remaining = (deadline) => {
      const minutes = Math.max(0, Math.floor((deadline - Date.now()) / 60_000));
      if (minutes < 60) return `${minutes}m`;
      const hours = Math.floor(minutes / 60); const rest = minutes % 60;
      return `${hours}h ${rest}m`;
    };
    const noteKind = spec.bound ? "HASH-BOUND JOB NOTE" : spec.declared ? "SELF-HASHED SNAPSHOT" : "SNAPSHOTTED JOB NOTE";
    const detail = document.createElement("p"); detail.textContent = `${offer.amount} ${offer.asset} · hash lock\nAccept left: ${remaining(offer.expiresMs)} · Finish left: ${remaining(offer.claimByMs)}\n${noteKind}\n${spec.text.slice(0, 900)}`;
    const link = document.createElement("a"); link.href = contextUrl(offer.job.context); link.target = "_blank"; link.rel = "noopener noreferrer"; link.textContent = "REVIEW JOB CONTEXT ↗";
    const accept = document.createElement("button"); accept.textContent = "ACCEPT NOW →";
    accept.addEventListener("click", () => acceptPaperOffer(offer, spec));
    const arm = document.createElement("button"); arm.textContent = "ARM AUTO-ACCEPT →";
    arm.addEventListener("click", () => armPaperOfferAutoAccept(offer, spec, seq));
    card.append(id, title, detail, link, accept, arm); return card;
  }) : [document.createTextNode("No actionable, signed, unexpired PaperRail jobs found.")]));
}

async function verifyPaperOffers(offers) {
  const checked = await Promise.all(offers.map(async (candidate) => {
    try {
      const specResponse = await fetch(freshContextUrl(candidate.offer.job.context), {
        cache: "no-store",
        signal: AbortSignal.timeout(6_000),
      });
      if (!specResponse.ok) return null;
      const spec = await reviewJobSpec(await specResponse.text(), candidate.offer);
      return spec ? { ...candidate, spec } : null;
    } catch { return null; }
  }));
  return checked.filter(Boolean);
}

async function verifyFirstPaperOffer(offers) {
  if (!offers.length) return null;
  const preferredAvailable = offers.some((candidate) => hasVerifiedPayerLock(candidate.offer.from));
  try {
    return await Promise.any(offers.map(async (candidate) => {
      const specResponse = await fetch(freshContextUrl(candidate.offer.job.context), {
        cache: "no-store",
        signal: AbortSignal.timeout(3_000),
      });
      if (!specResponse.ok) throw new Error("Job note unavailable");
      const spec = await reviewJobSpec(await specResponse.text(), candidate.offer);
      if (!spec) throw new Error("Job note failed verification");
      if (preferredAvailable && !hasVerifiedPayerLock(candidate.offer.from)) {
        await new Promise((resolve) => setTimeout(resolve, 75));
      }
      return { ...candidate, spec };
    }));
  } catch {
    return null;
  }
}

$("#scan-offers").addEventListener("click", async () => {
  const identity = readIdentity(); if (!identity) { notice("Restore the existing DID before scanning offers"); return; }
  const button = $("#scan-offers"); button.disabled = true;
  try {
    $("#payee-candidates").textContent = "Scanning the latest 200 signed records…";
    notice("Fast PAPER scan running");
    let verified = await verifyPaperOffers(await listSafePaperOffers(await readOfferTail(), identity.did));
    if (!verified.length) {
      $("#payee-candidates").textContent = "No current offer in the fast scan. Searching the full retained history…";
      notice("Fast scan found none; full retained-history scan running");
      verified = await verifyPaperOffers(await listSafePaperOffers(await readOfferHistory(), identity.did));
    }
    renderPayeeOffers(verified);
    void refreshPayerLockPriority(verified);
    notice(`${verified.length} signed, unexpired actionable PAPER job${verified.length === 1 ? "" : "s"} found`);
  } catch (error) {
    const message = error?.name === "TimeoutError"
      ? "Scan timed out while reading Technocore. No job was accepted; try again."
      : `Scan failed: ${error.message}`;
    $("#payee-candidates").textContent = message;
    $("#payee-status").textContent = message;
    notice(message);
  }
  finally { button.disabled = false; }
});

$("#payee-auto-hunter").addEventListener("click", async () => {
  const identity = readIdentity();
  if (!identity) { notice("Restore the existing DID before arming the auto-job hunter"); return; }
  let existing = readPayeeDeal();
  if (existing && await archiveCompletedPayeeDeal(existing, identity)) existing = null;
  if (existing?.acceptSeq && !["auto-accept-expired", "auto-accept-unavailable"].includes(existing.state)) {
    rememberPayeeDeal(existing);
    localStorage.removeItem(PAYEE_DEAL_KEY);
    resetPayeeUi();
    renderPayeeDealQueue();
    notice(`Offer #${existing.offerSeq ?? "?"} parked safely in the payee queue`);
    existing = null;
  }
  if (existing) {
    if (!["auto-accept-expired", "auto-accept-unavailable"].includes(existing.state)) {
      notice("Finish or discard the active/prepared payee deal before hunting another job");
      return;
    }
    try {
      const accepted = await verifyAcceptRecord(await readOfferHistory(), existing.offer, existing.accept);
      if (accepted) {
        existing.state = "accepted";
        existing.acceptSeq = accepted.seq;
        existing.autoAcceptStatus = `ACCEPT VERIFIED · seq #${accepted.seq ?? "?"}`;
        savePayeeDeal(existing);
        $("#check-payee-deal").disabled = false;
        $("#discard-payee-deal").disabled = true;
        notice(`Hunter not armed — the previous accept exists at seq #${accepted.seq ?? "?"}`);
        return;
      }
      stopPayeeAutoAccept("VERIFIED UNACCEPTED STALE CANDIDATE CLEARED", null);
      localStorage.removeItem(PAYEE_DEAL_KEY);
      resetPayeeUi();
      renderPayeeAutoHunter();
      notice("Previous candidate had no matching accept and was safely cleared");
    } catch (error) {
      notice(`Hunter not armed — stale candidate verification failed: ${error.message}`);
      return;
    }
  }
  const queuedCount = activePayeeDeals().length;
  if (queuedCount >= MAX_ACTIVE_PAYEE_DEALS) {
    notice(`Payee queue is full (${queuedCount}/${MAX_ACTIVE_PAYEE_DEALS}); complete or archive one job first`);
    return;
  }
  const minFinishMinutes = Number($("#payee-auto-hunter-minutes").value);
  if (!Number.isInteger(minFinishMinutes) || minFinishMinutes < 10 || minFinishMinutes > 1440) {
    notice("Minimum finish time must be 10-1440 whole minutes"); return;
  }
  if (!window.confirm(`Arm the automatic PAPER job hunter?\n\nIt will keep up to ${MAX_ACTIVE_PAYEE_DEALS} accepted jobs in a local queue. For each newly verified actionable job with at least ${minFinishMinutes} minutes left, it immediately publishes accept, creates the deal room, parks that job, and resumes hunting. Public-web research, repository work, audits, comparisons, extraction, writing and local code/test tasks are eligible; nothing from a job runs automatically. Credential/value requests, unsafe URLs and third-party account mutations remain blocked. If another agent wins first, it verifies that our accept is absent and continues. Keep this tab open.`)) return;
  const vaultPassword = window.prompt("Create one deal-vault password for the automatically selected job (minimum 12 characters). Save it now; it stays only in this open tab and is required later to reveal.");
  if (!vaultPassword || vaultPassword.length < 12) { notice("Auto-job hunter cancelled — vault password must be at least 12 characters"); return; }
  let notificationPermission = "unsupported";
  if ("Notification" in window) {
    try { notificationPermission = Notification.permission === "default" ? await Notification.requestPermission() : Notification.permission; }
    catch { notificationPermission = Notification.permission; }
  }
  try {
    payeeAutoHunterVaultPassword = vaultPassword;
    savePayeeAutoHunter({
      armed: true,
      cursor: 0,
      minFinishMinutes,
      notificationPermission,
      armedAt: new Date().toISOString(),
      status: `ARMING · ${queuedCount}/${MAX_ACTIVE_PAYEE_DEALS} JOBS SECURED · READING CURRENT OFFERS`,
    });
    notice("Auto-job hunter is arming; reading the current signed offers");
    const tail = await readOfferTail();
    const cursor = Number(tail.last_seq || tail.messages?.at(-1)?.seq || 0);
    savePayeeAutoHunter({ ...readPayeeAutoHunter(), cursor, status: "Checking current offers first" });
    notice("Auto-job hunter armed; checking current offers, then watching new signed offers");
    if (!await tryAutoHuntFromPayload(tail)) void runPayeeAutoHunter();
  } catch (error) {
    stopPayeeAutoHunter(`AUTO-JOB HUNTER WAS NOT ARMED · ${error.message}`);
    notice(`Auto-job hunter failed to arm: ${error.message}`);
  }
});

$("#payee-auto-hunter-stop").addEventListener("click", () => {
  if (!readPayeeAutoHunter().armed) return;
  stopPayeeAutoHunter("STOPPED BY USER · NO JOB SELECTED");
  notice("Auto-job hunter stopped");
});

async function acceptPaperOffer(offer, jobSnapshot) {
  const identity = readIdentity(); if (!identity) return;
  if (activePayeeDeals().length >= MAX_ACTIVE_PAYEE_DEALS) { notice(`Payee queue is full (${MAX_ACTIVE_PAYEE_DEALS}/${MAX_ACTIVE_PAYEE_DEALS})`); return; }
  let existing = readPayeeDeal();
  if (existing && await archiveCompletedPayeeDeal(existing, identity)) {
    existing = null;
    notice("Previous completed deal archived locally; continuing with the new job");
  }
  if (existing?.acceptSeq) {
    rememberPayeeDeal(existing);
    localStorage.removeItem(PAYEE_DEAL_KEY);
    resetPayeeUi();
    renderPayeeDealQueue();
    notice(`Offer #${existing.offerSeq ?? "?"} parked safely in the payee queue; continuing with the selected job`);
    existing = null;
  }
  if (existing) { notice("Finish or discard the unverified payee deal before accepting another"); return; }
  const prepared = makePayeeAcceptance(offer, identity.did);
  if (!window.confirm(`Accept this exact PAPER job as payee?\n\nJob: ${offer.job.id}\nPayer: ${offer.from}\nContract: ${prepared.contract}\n\nThe hash-lock secret will be encrypted locally and never sent before reveal.`)) return;
  const vaultPassword = window.prompt("Create a separate deal-vault password (minimum 12 characters). It is not stored and cannot be recovered.");
  if (!vaultPassword || vaultPassword.length < 12) { notice("Accept cancelled — deal-vault password must be at least 12 characters"); return; }
  const sealedSecret = await sealSecret(vaultPassword, prepared.contract, prepared.secret);
  const deal = { offer, accept: prepared.accept, room: prepared.room, sealedSecret, jobSnapshot, acceptedAt: new Date().toISOString(), state: "room-reservation-pending" };
  savePayeeDeal(deal);
  const nonce = Date.now(); const signature = await sign(identity, prepared.room, nonce, prepared.line);
  window.open(signedUrl(prepared.room, identity, signature, nonce, prepared.line), "_blank", "noopener,noreferrer");
  $("#check-payee-deal").disabled = false;
  $("#discard-payee-deal").disabled = false;
  $("#payee-status").textContent = `DEAL ROOM RESERVATION OPENED — JOB NOT ACCEPTED YET\nContract: ${prepared.contract}\nDeal room: /r/${prepared.room}\nSecret: encrypted in this browser\nNEXT: Confirm Technocore says ok, then press CHECK ACTIVE DEAL.`;
  notice("Deal-room reservation opened; a 400 means stop — no accept will be published");
}

async function startPayeeAutoAccept(deal, notificationPermission = "unsupported") {
  deal.acceptLine ||= encodeFrame(deal.accept);
  deal.state = "auto-accept-armed";
  deal.armedAt = new Date().toISOString();
  deal.autoAcceptStatus = "ARMED · PUBLISHING ACCEPT NOW";
  savePayeeDeal(deal);
  localStorage.setItem(PAYEE_AUTO_ACCEPT_KEY, JSON.stringify({
    armed: true,
    contract: deal.accept.contract,
    cursor: 0,
    offerSeq: deal.offerSeq,
    notificationPermission,
    armedAt: deal.armedAt,
  }));
  $("#discard-payee-deal").disabled = false;
  renderPayeeAutoAccept();
  notice(`Auto-accept armed for offer #${deal.offerSeq ?? "?"}; publishing accept now, then creating its room`);
  try {
    await tryAutoAcceptPayeeDeal(deal, "IMMEDIATE");
  } catch (error) {
    deal.autoAcceptStatus = `INITIAL TRY BLOCKED · ${error.message} · RETRYING`;
    savePayeeDeal(deal);
  }
  if (readPayeeAutoAccept().armed) void runPayeeAutoAccept();
}

async function archiveCompletedPayeeDeal(deal, identity) {
  if (!deal?.accept || !deal?.room || !identity || deal.accept.from !== identity.did) return false;
  try {
    const receipt = makePayeeReceipt(deal.accept, identity.did, "claimed");
    const response = await fetch(`https://technocore.chat/r/${deal.room}?limit=200&format=json&n=${Date.now()}`, { headers: { accept: "application/json" }, cache: "no-store" });
    if (!response.ok) return false;
    const verified = await verifyExactFrameRecord(await response.json(), receipt.frame, receipt.room);
    if (!verified) return false;
    stopPayeeAutoAccept(`COMPLETED DEAL ARCHIVED · RECEIPT #${verified.seq ?? "?"}`, null);
    localStorage.removeItem(PAYEE_DEAL_KEY);
    resetPayeeUi();
    renderPayeeAutoAccept();
    return true;
  } catch {
    return false;
  }
}

async function armPaperOfferAutoAccept(offer, jobSnapshot, offerSeq) {
  const identity = readIdentity(); if (!identity) return;
  if (activePayeeDeals().length >= MAX_ACTIVE_PAYEE_DEALS) { notice(`Payee queue is full (${MAX_ACTIVE_PAYEE_DEALS}/${MAX_ACTIVE_PAYEE_DEALS})`); return; }
  let existing = readPayeeDeal();
  if (existing && await archiveCompletedPayeeDeal(existing, identity)) {
    existing = null;
    notice("Previous completed deal archived locally; arming the new job");
  }
  if (existing) {
    const reusable = existing.offer?.id === offer.id && ["room-reservation-pending", "auto-accept-armed", "accepted-room-pending"].includes(existing.state);
    if (!reusable) { notice("Finish or discard the saved payee deal before arming another"); return; }
    if (!window.confirm(`Resume this exact prepared deal with auto-accept?\n\nOffer seq: #${offerSeq}\nJob: ${offer.job.id}\nContract: ${existing.accept.contract}\n\nThe existing encrypted secret will be preserved. The accept is published first; room-capacity 400 keeps retrying the derived room.`)) return;
    existing.offerSeq = offerSeq;
    existing.acceptLine ||= encodeFrame(existing.accept);
    existing.jobSnapshot ||= jobSnapshot;
    let notificationPermission = "unsupported";
    if ("Notification" in window) {
      try { notificationPermission = Notification.permission === "default" ? await Notification.requestPermission() : Notification.permission; }
      catch { notificationPermission = Notification.permission; }
    }
    try {
      await startPayeeAutoAccept(existing, notificationPermission);
    } catch (error) {
      stopPayeeAutoAccept(`AUTO-ACCEPT WAS NOT ARMED · ${error.message}`, existing);
      $("#payee-status").textContent = `Auto-accept failed to arm: ${error.message}\nThe encrypted pending deal was preserved.`;
    }
    return;
  }
  const prepared = makePayeeAcceptance(offer, identity.did);
  if (!window.confirm(`Arm auto-accept for this exact PAPER job?\n\nOffer seq: #${offerSeq}\nJob: ${offer.job.id}\nPayer: ${offer.from}\nContract: ${prepared.contract}\n\nTask Relay will publish the signed accept to tclk-offers immediately. After it verifies, the open tab repeatedly creates and verifies the derived room. A capacity 400 no longer blocks claiming the offer; it only delays the deal room.`)) return;
  const vaultPassword = window.prompt("Create a separate deal-vault password (minimum 12 characters). Save it now; it is not stored and is required later to reveal.");
  if (!vaultPassword || vaultPassword.length < 12) { notice("Auto-accept cancelled — deal-vault password must be at least 12 characters"); return; }
  let notificationPermission = "unsupported";
  if ("Notification" in window) {
    try { notificationPermission = Notification.permission === "default" ? await Notification.requestPermission() : Notification.permission; }
    catch { notificationPermission = Notification.permission; }
  }
  try {
    const sealedSecret = await sealSecret(vaultPassword, prepared.contract, prepared.secret);
    const deal = { offer, offerSeq, accept: prepared.accept, acceptLine: prepared.line, room: prepared.room, sealedSecret, jobSnapshot };
    await startPayeeAutoAccept(deal, notificationPermission);
  } catch (error) {
    const pending = readPayeeDeal();
    stopPayeeAutoAccept(`AUTO-ACCEPT WAS NOT ARMED · ${error.message}`, pending);
    $("#payee-status").textContent = `Auto-accept failed to arm: ${error.message}${pending ? "\nThe encrypted pending deal was preserved." : ""}`;
  }
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

function successfulTrackEntry(entry) {
  return isSuccessfulTrackEntry(entry);
}

function statusLabel(entry) {
  if (successfulTrackEntry(entry)) return "SUCCESSFUL · DELIVERY VERIFIED";
  if (entry.noDeliveryRejected) return "CLAIMED · NO DELIVERY · REJECTED";
  if (entry.deliveryRejected) return "CLAIMED · DELIVERY REJECTED";
  if (entry.status === "claimed" && entry.deliveryVerified === true && !entry.payerReceiptVerified) return "CLAIMED · DELIVERY VERIFIED · PAYER RECEIPT PENDING";
  if (entry.status === "claimed" && entry.seqs?.receipt && entry.deliverySeq == null) return "CLAIMED · RECEIPT PRESENT · NO DELIVERY";
  if (entry.status === "claimed" && entry.seqs?.receipt) return "CLAIMED · DELIVERY UNVERIFIED";
  if (entry.status === "claimed") return "CLAIMED · RECEIPT PENDING";
  if (entry.status === "refunded" && entry.seqs?.receipt) return "REFUNDED · RECEIPT SIGNED";
  return String(entry.status || "unknown").toUpperCase();
}

function resumePayerDeal(entry) {
  if (entry.role !== "payer" || !entry.accept || !entry.contract) return;
  const current = readPayerDeal();
  if (current) rememberPayerDeal(current);
  const saved = readPayerDeals()[entry.contract];
  const deal = saved || {
    offer: entry.offer,
    offerSeq: entry.offerSeq,
    accept: entry.accept,
    acceptSeq: entry.acceptSeq,
    lock: makePaperLock(entry.offer, entry.accept, entry.offer.from),
    state: ["locked", "claimed", "refunded"].includes(entry.status) ? entry.status : "accepted",
    railState: ["locked", "claimed", "refunded"].includes(entry.status) ? "check required" : undefined,
  };
  deal.offerSeq ??= entry.offerSeq;
  deal.acceptSeq ??= entry.acceptSeq;
  saveActivePayerDeal(deal);
  $("#create-paper-lock").disabled = false;
  $("#publish-payer-lock").disabled = !(deal.railState === "locked" && deal.state !== "locked");
  renderPayerDeal();
  document.querySelector("#payer-deal-status").scrollIntoView({ behavior: "smooth", block: "center" });
  notice(`Payer deal restored: OFFER #${entry.offerSeq ?? "?"} → ACCEPT #${entry.acceptSeq ?? "?"}`);
}

function renderTrackRecord() {
  const entries = readTrackRecords();
  $("#track-given").textContent = entries.filter((entry) => entry.role === "payer").length;
  $("#track-attempted").textContent = entries.filter((entry) => entry.role === "payee").length;
  $("#track-successful").textContent = entries.filter(successfulTrackEntry).length;
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
    const receiptLabel = entry.role === "payer"
      ? String(entry.payerReceiptSeq) === String(entry.seqs?.receipt) ? "PAYER RECEIPT" : "PAYEE RECEIPT"
      : "RECEIPT";
    const seqOrder = [["offer", "OFFER"], ["accept", "ACCEPT"], ["lock", "LOCK"], ["delivery", "DELIVERY"], ["reveal", "REVEAL"], ["refund", "REFUND"], ["cancel", "CANCEL"], ["receipt", receiptLabel], ["review", "REVIEW"]];
    const seqs = { ...entry.seqs, delivery: entry.deliverySeq };
    const parts = seqOrder.filter(([type]) => seqs?.[type] != null).map(([type, label]) => `${label} #${seqs[type]}`);
    if (entry.role === "payer" && entry.payerReceiptSeq != null && String(entry.payerReceiptSeq) !== String(entry.seqs?.receipt)) parts.push(`PAYER RECEIPT #${entry.payerReceiptSeq}`);
    chain.textContent = parts.length ? parts.join(" → ") : "No verified seq";
    const status = document.createElement("td");
    const label = document.createElement("div"); label.textContent = statusLabel(entry); status.append(label);
    if (entry.role === "payer" && entry.accept && (["accepted", "locked"].includes(entry.status) || (entry.status === "claimed" && !entry.deliveryVerified && !entry.deliveryRejected && !entry.noDeliveryRejected))) {
      const resume = document.createElement("button");
      const expired = entry.offer.refundAfterMs <= Date.now();
      resume.textContent = entry.status === "claimed" ? "REVIEW DELIVERY" : expired ? "REFUND EXPIRED DEAL" : "RESUME DEAL";
      resume.addEventListener("click", () => resumePayerDeal(entry));
      status.append(resume);
    }
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
    const currentActivity = await listMyPaperActivity(await readOfferHistory(), identity.did);
    const savedRecords = readTrackRecords();
    const savedByKey = new Map(savedRecords.map((entry) => [trackKey(entry), entry]));
    const activityByKey = new Map(currentActivity.map((entry) => {
      const saved = savedByKey.get(trackKey(entry));
      return [trackKey(entry), { ...saved, ...entry, seqs: { ...saved?.seqs, ...entry.seqs } }];
    }));
    for (const saved of savedRecords) {
      if (saved?.offer && saved?.accept && !activityByKey.has(trackKey(saved))) activityByKey.set(trackKey(saved), { ...saved });
    }
    const activity = [...activityByKey.values()];
    for (const entry of activity) {
      let spec = null;
      const rememberedPayeeDeal = entry.contract ? readPayeeDeals()[entry.contract] : null;
      entry.jobText ||= rememberedPayeeDeal?.jobSnapshot?.text || null;
      const rememberedExternalRoom = [rememberedPayeeDeal?.deliveryRoom, entry.deliveryRoom]
        .find((room) => room && room !== entry.room) || null;
      const jobUrl = contextUrl(entry.offer.job.context);
      if (jobUrl.startsWith("https://technocore.chat/")) {
        const specResponse = await fetch(`${jobUrl}?n=${Date.now()}`);
        if (specResponse.ok) {
          spec = await reviewJobSpec(await specResponse.text(), entry.offer);
          if (spec) entry.jobText = spec.text;
        }
      }
      let roomPayload = null;
      if (entry.accept && entry.room) {
        const roomResponse = await fetch(`https://technocore.chat/r/${entry.room}?limit=200&format=json&n=${Date.now()}`, { headers: { accept: "application/json" } });
        if (roomResponse.ok) {
          roomPayload = await roomResponse.json();
          const deal = await summarizeDealActivity(roomPayload, entry.offer, entry.accept);
          entry.status = deal.status; entry.seqs = { ...entry.seqs, ...deal.seqs };
          const deliveryRoom = resolveDeliveryRoom(entry.jobText || "", entry.room, rememberedExternalRoom);
          let deliveryPayload = roomPayload;
          if (deliveryRoom !== entry.room) {
            const deliveryResponse = await fetch(`https://technocore.chat/r/${deliveryRoom}?limit=200&format=json&n=${Date.now()}`, { headers: { accept: "application/json" } });
            deliveryPayload = deliveryResponse.ok ? await deliveryResponse.json() : { messages: [] };
          }
          entry.deliveryRoom = deliveryRoom;
          const deliveries = await listSignedDeliveries(deliveryPayload, entry.accept, deliveryRoom);
          const delivery = deal.times?.lock ? latestDeliveryBeforeReveal(deliveries, {
            sameRoom: deliveryRoom === entry.room,
            revealSeq: deal.seqs.reveal,
            revealTs: deal.times?.reveal,
            claimByMs: entry.offer.claimByMs,
            notBeforeTs: deal.times.lock,
          }) : null;
          entry.deliverySeq = delivery?.seq ?? null;
          entry.deliveryText = delivery?.text ?? null;
          const payerReceiptOutcome = ["claimed", "refunded"].includes(deal.status) ? deal.status : null;
          const expectedPayerReceipt = payerReceiptOutcome
            ? makePayeeReceipt(entry.accept, entry.offer.from, payerReceiptOutcome)
            : null;
          const payerReceipt = expectedPayerReceipt
            ? await verifyExactFrameRecord(roomPayload, expectedPayerReceipt.frame, expectedPayerReceipt.room)
            : null;
          entry.payerReceiptSeq = payerReceipt?.seq ?? null;
          entry.payerReceiptVerified = Boolean(payerReceipt);
          entry.deliveryVerified = Boolean(delivery && payerReceipt);
          entry.deliveryRejected = false;
          entry.noDeliveryRejected = false;
          if (deal.status === "claimed" && !delivery) {
            const noDeliveryReview = makePayerNoDeliveryReview(entry.offer, entry.accept, entry.offer.from);
            const verifiedNoDeliveryFailure = await verifyExactSignedTextRecord(roomPayload, noDeliveryReview.line, entry.offer.from, noDeliveryReview.room);
            entry.noDeliveryRejected = Boolean(verifiedNoDeliveryFailure);
            entry.seqs.review = verifiedNoDeliveryFailure?.seq ?? entry.seqs.review;
          }
        }
      } else if (entry.offer.expiresMs <= Date.now()) entry.status = "expired";
      if (spec && entry.deliveryText) {
        const evaluation = evaluateObjectiveDelivery(spec.text, entry.deliveryText, entry.offer);
        const saved = readPayerDeals()[entry.contract];
        const manuallyApproved = deliveryNeedsHumanReview(evaluation) && String(saved?.manualDeliveryApprovedSeq) === String(entry.deliverySeq);
        const failedReview = !evaluation.ok && !deliveryNeedsHumanReview(evaluation)
          ? makePayerDeliveryReview(entry.offer, entry.accept, entry.offer.from, Number(entry.deliverySeq), "FAIL", evaluation.reason)
          : null;
        const verifiedFailure = failedReview && roomPayload
          ? await verifyExactSignedTextRecord(roomPayload, failedReview.line, entry.offer.from, failedReview.room)
          : null;
        entry.deliveryRejected = Boolean(verifiedFailure);
        entry.seqs.review = verifiedFailure?.seq ?? entry.seqs.review;
        entry.deliveryVerified = !entry.deliveryRejected && (entry.payerReceiptVerified || evaluation.ok || manuallyApproved);
        entry.deliveryEvaluationReason = evaluation.reason;
      }
      if (!entry.deliveryText) entry.deliveryVerified = false;
    }
    mergeTrackRecords(activity);
    $("#track-sync-status").textContent = `Verified from Technocore · ${new Date().toLocaleString()}`;
    if (announce) notice(`${activity.length} verified current or locally retained tclk record${activity.length === 1 ? "" : "s"} refreshed`);
  } catch (error) {
    $("#track-sync-status").textContent = `History refresh failed: ${error.message}. Saved records were preserved.`;
  } finally { button.disabled = false; }
}

$("#refresh-track-record").addEventListener("click", () => syncTrackRecord());

$("#payer-autopilot").addEventListener("click", async () => {
  const current = readPayerAutopilot();
  if (current.armed) {
    localStorage.setItem(PAYER_AUTOPILOT_KEY, JSON.stringify({ ...current, armed: false, stoppedAt: new Date().toISOString() }));
    renderPayerAutopilot();
    notice("Payer auto-publish stopped locally");
    return;
  }
  const deals = pendingPayerDeals();
  if (!deals.length) { notice("No unexpired accepted payer deals are ready for auto-publish"); return; }
  if (!window.confirm(`Arm local auto-publish for ${deals.length} pending payer deal${deals.length === 1 ? "" : "s"}?\n\nWhile this tab stays open, Task Relay may create an exact missing PAPER note and sign/publish each saved payer lock when a server-created room event appears. The DID key stays in this browser.`)) return;
  try {
    const tail = await fetch(`https://technocore.chat/r/events?format=json&limit=1&n=${Date.now()}`, { headers: { accept: "application/json" }, cache: "no-store" });
    if (!tail.ok) throw new Error(`Event cursor failed (${tail.status})`);
    const payload = await tail.json();
    const cursor = Number(payload.last_seq || payload.messages?.at(-1)?.seq || 0);
    localStorage.setItem(PAYER_AUTOPILOT_KEY, JSON.stringify({ armed: true, cursor, armedAt: new Date().toISOString() }));
    for (const deal of deals) {
      deal.autoPublishStatus = "ARMED · WAITING FOR NEW ROOM EVENT";
      updateStoredPayerDeal(deal);
    }
    for (const deal of deals) {
      try {
        const room = await inspectPayerDealRoom(deal);
        if (room.exists && !room.locked) await tryAutoPublishPayerLock(deal, "EXISTING ROOM");
      } catch (error) {
        deal.autoPublishStatus = `PREFLIGHT BLOCKED: ${error.message}`;
        updateStoredPayerDeal(deal);
      }
    }
    renderPayerAutopilot();
    notice(`${deals.length} payer deal${deals.length === 1 ? "" : "s"} armed for local auto-publish`);
    void runPayerAutopilot();
  } catch (error) { $("#payer-autopilot-status").textContent = `Auto-publish was not armed: ${error.message}`; }
});

$("#payer-auto-settle").addEventListener("click", async () => {
  const current = readPayerAutoSettle();
  if (current.armed) {
    localStorage.setItem(PAYER_AUTO_SETTLE_KEY, JSON.stringify({ ...current, armed: false, stoppedAt: new Date().toISOString() }));
    renderPayerAutoSettle();
    notice("Safe auto-settle stopped locally");
    return;
  }
  const deals = autoSettleDeals();
  if (!deals.length) { notice("No locked payer deals are ready for safe auto-settle"); return; }
  if (!window.confirm(`Arm safe auto-settle for ${deals.length} payer deal${deals.length === 1 ? "" : "s"}?\n\nWhile this tab stays open, Task Relay will verify signed deliveries, reveal, contract, hash lock, PaperRail and supported deterministic job criteria. It will publish a terminal receipt only when every check passes. Ambiguous work and refunds remain manual. The DID key stays in this browser.`)) return;
  let notificationPermission = "unsupported";
  if ("Notification" in window) {
    try { notificationPermission = Notification.permission === "default" ? await Notification.requestPermission() : Notification.permission; }
    catch { notificationPermission = Notification.permission; }
  }
  localStorage.setItem(PAYER_AUTO_SETTLE_KEY, JSON.stringify({ armed: true, armedAt: new Date().toISOString(), notificationPermission, notified: current.notified || {} }));
  for (const deal of deals) {
    deal.autoSettleStatus = "ARMED · CHECKING SIGNED DELIVERY / REVEAL";
    updateStoredPayerDeal(deal);
  }
  renderPayerAutoSettle();
  notice(`${deals.length} payer deal${deals.length === 1 ? "" : "s"} armed for safe auto-settle`);
  void runPayerAutoSettle();
});

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
      const specResponse = await fetch(freshContextUrl(deal.offer.job.context));
      if (!specResponse.ok) throw new Error(`Job note recheck failed (${specResponse.status})`);
      const currentSpec = await reviewJobSpec(await specResponse.text(), deal.offer);
      if (!currentSpec || currentSpec.hash !== deal.jobSnapshot?.hash) throw new Error("Job note changed after selection; accept blocked");
      if (Date.now() >= deal.offer.expiresMs) throw new Error("Offer expired before acceptance; discard the local reservation");
      const line = encodeFrame(deal.accept); const nonce = Date.now(); const signature = await sign(identity, OFFER_ROOM, nonce, line);
      deal.state = "accept-pending"; deal.reservationSeq = reserved.seq;
      savePayeeDeal(deal);
      window.open(signedUrl(OFFER_ROOM, identity, signature, nonce, line), "_blank", "noopener,noreferrer");
      $("#payee-status").textContent = `DEAL ROOM RESERVED · seq #${reserved.seq}\nACCEPT SUBMISSION OPENED — confirm Technocore says ok, then press CHECK ACTIVE DEAL again.`;
      notice("Room is confirmed; the signed offer acceptance is now open for your confirmation");
      return;
    }
    const accepted = deal.acceptSeq
      ? { seq: deal.acceptSeq }
      : await verifyAcceptRecord(await readOfferWindow(deal.offerSeq), deal.offer, deal.accept);
    if (!accepted) { $("#payee-status").textContent = "Accept is not yet confirmed in tclk-offers."; return; }
    const roomResponse = await fetch(`https://technocore.chat/r/${deal.room}?limit=200&format=json&n=${Date.now()}`);
    if (!roomResponse.ok) throw new Error(`Deal room read failed (${roomResponse.status})`);
    const roomPayload = await roomResponse.json();
    const folded = await foldPayeeDeal(roomPayload, deal.offer, deal.accept);
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
    const deliveryRoom = payeeDeliveryRoom(deal);
    const deliveryPayload = deliveryRoom === deal.room ? roomPayload : (await readPayeeDeliveryRoom(deal)).payload;
    const deliveries = await listSignedDeliveries(deliveryPayload, deal.accept, deliveryRoom);
    const revealEvent = folded.applied.find((item) => item.frame.type === "reveal");
    const lockEvent = folded.applied.find((item) => item.frame.type === "lock");
    const delivery = lockEvent?.ts ? latestDeliveryBeforeReveal(deliveries, {
      sameRoom: deliveryRoom === deal.room,
      revealSeq: revealEvent?.seq,
      revealTs: revealEvent?.ts,
      claimByMs: deal.offer.claimByMs,
      notBeforeTs: lockEvent.ts,
    }) : null;
    deal.state = folded.state.status; deal.acceptSeq = accepted.seq; deal.lockValid = lockValid; deal.railState = railState;
    deal.lockTs = lockEvent?.ts ?? null;
    deal.deliveryRoom = deliveryRoom;
    deal.deliverySeq = delivery?.seq ?? null;
    deal.deliveryText = delivery?.text ?? null;
    savePayeeDeal(deal);
    $("#payee-delivery").disabled = folded.state.status !== "locked" || !lockValid || Boolean(delivery);
    $("#publish-payee-delivery").disabled = folded.state.status !== "locked" || !lockValid || Boolean(delivery);
    if (delivery) $("#payee-delivery").value = delivery.text;
    $("#work-complete").disabled = folded.state.status !== "locked" || !lockValid || !delivery;
    $("#claim-paper").disabled = !(folded.state.status === "claimed" && railState === "locked");
    $("#publish-receipt").disabled = !(folded.state.status === "claimed" && railState === "claimed");
    $("#payee-status").textContent = `ACCEPT VERIFIED · seq #${accepted.seq}\nContract: ${deal.accept.contract}\nDeal room: /r/${deal.room}\nDelivery room: /r/${deliveryRoom}${deliveryRoom === deal.room ? " (deal room)" : " (job-required external room)"}\nTranscript state: ${folded.state.status}\nPaperRail state: ${railState}\nSigned delivery: ${delivery ? `VERIFIED · seq #${delivery.seq ?? "?"}` : "NOT PUBLISHED"}`;
    notice(`Payee deal state: ${folded.state.status}`);
    void syncTrackRecord({ announce: false });
  } catch (error) { $("#payee-status").textContent = `Deal check failed: ${error.message}`; }
});

$("#discard-payee-deal").addEventListener("click", async () => {
  const deal = readPayeeDeal();
  if (!deal || !["auto-accept-armed", "auto-accept-expired", "auto-accept-unavailable", "room-reservation-pending", "accept-pending"].includes(deal.state)) return;
  $("#discard-payee-deal").disabled = true;
  try {
    const accepted = await verifyAcceptRecord(await readOfferHistory(), deal.offer, deal.accept);
    if (accepted) {
      deal.state = "accepted"; deal.acceptSeq = accepted.seq;
      savePayeeDeal(deal);
      $("#payee-status").textContent = `DISCARD BLOCKED — ACCEPT VERIFIED · seq #${accepted.seq}\nContract: ${deal.accept.contract}\nContinue with CHECK ACTIVE DEAL.`;
      notice("This accept exists on Technocore and cannot be discarded");
      return;
    }
    if (!window.confirm("No matching accept was found on Technocore. Stop auto-accept and discard this local pending deal and its encrypted secret? This cannot be undone.")) return;
    stopPayeeAutoAccept("STOPPED AND DISCARDED", null);
    if (deal.selectedBy === "auto-job-hunter") payeeAutoHunterVaultPassword = null;
    forgetPayeeDeal(deal.accept.contract);
    localStorage.removeItem(PAYEE_DEAL_KEY);
    resetPayeeUi();
    notice("Unconfirmed local payee deal discarded");
  } catch (error) {
    $("#payee-status").textContent = `Discard blocked: ${error.message}\nThe local encrypted secret was preserved.`;
  } finally {
    const current = readPayeeDeal();
    $("#discard-payee-deal").disabled = !current || !["auto-accept-armed", "auto-accept-expired", "auto-accept-unavailable", "room-reservation-pending", "accept-pending"].includes(current.state);
  }
});

$("#payee-auto-accept-stop").addEventListener("click", () => {
  const deal = readPayeeDeal();
  if (!readPayeeAutoAccept().armed || !deal) return;
  stopPayeeAutoAccept("STOPPED BY USER · NO ACCEPT PUBLISHED UNLESS SHOWN AS VERIFIED", deal);
  if (deal.selectedBy === "auto-job-hunter") payeeAutoHunterVaultPassword = null;
  $("#discard-payee-deal").disabled = false;
  notice("Payee auto-accept stopped; the encrypted pending deal was preserved");
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
  const deal = readPayeeDeal(); $("#publish-reveal").disabled = !(event.target.checked && deal?.state === "locked" && deal?.lockValid && deal?.deliverySeq != null);
});

$("#publish-payee-delivery").addEventListener("click", async () => {
  const identity = readIdentity(); const deal = readPayeeDeal();
  if (!identity || !deal?.lockValid || deal.state !== "locked") return;
  const text = clean($("#payee-delivery").value);
  if (text.length < 3 || text.length > 2000 || text.startsWith("tclk1 ")) {
    notice("Delivery must be a 3-2000 character non-tclk result"); return;
  }
  try {
    const { room: deliveryRoom, payload } = await readPayeeDeliveryRoom(deal);
    const existing = (await listSignedDeliveries(payload, deal.accept, deliveryRoom)).find((item) => {
      const deliveredAt = Date.parse(item.ts || "");
      const lockedAt = Date.parse(deal.lockTs || "");
      return item.text === text && (!Number.isFinite(lockedAt) || (Number.isFinite(deliveredAt) && deliveredAt >= lockedAt));
    });
    if (existing) {
      deal.deliveryRoom = deliveryRoom; deal.deliverySeq = existing.seq ?? null; deal.deliveryText = existing.text;
      savePayeeDeal(deal);
      notice(`Exact signed delivery already exists at seq #${existing.seq ?? "?"}; no duplicate opened`);
      return;
    }
    if (!window.confirm(`Publish this exact signed job delivery to /r/${deliveryRoom} before reveal?\n\n${text}`)) return;
    const nonce = Date.now(); const signature = await sign(identity, deliveryRoom, nonce, text);
    deal.deliveryRoom = deliveryRoom;
    savePayeeDeal(deal);
    window.open(signedUrl(deliveryRoom, identity, signature, nonce, text), "_blank", "noopener,noreferrer");
    notice(`Signed delivery opened for /r/${deliveryRoom}; confirm Technocore says ok, then press CHECK ACTIVE DEAL`);
  } catch (error) { notice(`Delivery publication blocked: ${error.message}`); }
});

$("#publish-reveal").addEventListener("click", async () => {
  const identity = readIdentity(); const deal = readPayeeDeal(); if (!identity || !deal?.lockValid || deal.state !== "locked") return;
  let deliveryRoom; let deliveryPayload;
  try {
    ({ room: deliveryRoom, payload: deliveryPayload } = await readPayeeDeliveryRoom(deal));
  } catch (error) { notice(`Reveal blocked: ${error.message}`); return; }
  const delivery = latestDeliveryBeforeReveal(await listSignedDeliveries(deliveryPayload, deal.accept, deliveryRoom), {
    sameRoom: deliveryRoom === deal.room,
    claimByMs: deal.offer.claimByMs,
    notBeforeTs: deal.lockTs,
  });
  if (!delivery) { notice("Reveal blocked: publish and verify the signed job delivery first"); return; }
  deal.deliveryRoom = deliveryRoom; deal.deliverySeq = delivery.seq ?? null; deal.deliveryText = delivery.text;
  savePayeeDeal(deal);
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
if (readPayerDeal()) rememberPayerDeal(readPayerDeal());
if (localStorage.getItem(TCLK_OFFER_KEY)) { $("#check-tclk").disabled = false; }
if (localStorage.getItem(TCLK_PAYER_DEAL_KEY)) { $("#create-paper-lock").disabled = false; }
renderPayerDeal();
renderTrackRecord();
renderPayerAutopilot();
renderPayerAutoSettle();
renderPayeeAutoAccept();
if (readPayeeDeal()) rememberPayeeDeal(readPayeeDeal());
renderPayeeDealQueue();
renderPayeeJobNote();
void reconcilePayeeDealQueue();
setInterval(() => { void reconcilePayeeDealQueue(); }, 30_000);
if (readPayeeAutoHunter().armed) {
  const staleHunter = readPayeeAutoHunter();
  localStorage.setItem(PAYEE_AUTO_HUNTER_KEY, JSON.stringify({
    ...staleHunter,
    armed: false,
    stoppedAt: new Date().toISOString(),
    reason: "STOPPED AFTER REFRESH · ARM AGAIN BECAUSE THE VAULT PASSWORD IS NEVER STORED",
  }));
}
renderPayeeAutoHunter();
if (readPayerAutopilot().armed) void runPayerAutopilot();
if (readPayerAutoSettle().armed) void runPayerAutoSettle();
if (readPayeeAutoAccept().armed) void runPayeeAutoAccept();
if (readIdentity()) void syncTrackRecord({ announce: false });
if (readPayeeDeal()) {
  const payeeDeal = readPayeeDeal();
  $("#check-payee-deal").disabled = ["auto-accept-armed", "auto-accept-expired", "auto-accept-unavailable"].includes(payeeDeal.state);
  $("#discard-payee-deal").disabled = !["auto-accept-armed", "auto-accept-expired", "auto-accept-unavailable", "room-reservation-pending", "accept-pending"].includes(payeeDeal.state);
  const payeeLabel = payeeDeal.state === "auto-accept-armed"
    ? "AUTO-ACCEPT ARMED — JOB NOT ACCEPTED"
    : payeeDeal.state === "auto-accept-expired"
      ? "EXPIRED BEFORE ACCEPT — NO ACCEPT VERIFIED"
    : payeeDeal.state === "auto-accept-unavailable"
      ? "OFFER UNAVAILABLE — NO ACCEPT VERIFIED"
    : payeeDeal.state === "room-reservation-pending"
    ? "DEAL ROOM RESERVATION PENDING — JOB NOT ACCEPTED"
    : payeeDeal.state === "accept-pending"
      ? "ACCEPT PREPARED LOCALLY — NOT YET VERIFIED ON TECHNOCORE"
      : "ACTIVE VERIFIED DEAL";
  $("#payee-status").textContent = `${payeeLabel}\nContract: ${payeeDeal.accept.contract}\nCheck the deal state to continue.`;
}
