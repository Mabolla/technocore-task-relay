import { readFile } from "node:fs/promises";
import test from "node:test";
import assert from "node:assert/strict";

const files = await Promise.all(["public/index.html", "public/app.js", "public/tclk.js", "src/tclk-browser-entry.mjs", "public/styles.css", "README.md"].map((path) => readFile(new URL(`../${path}`, import.meta.url), "utf8")));
const source = files.join("\n");

test("does not expose personal contact details", () => {
  assert.doesNotMatch(source, /[\w.+-]+@[\w.-]+\.[a-z]{2,}/i);
});

test("prevents referrer leakage and labels the public actor", () => {
  assert.match(source, /name="referrer" content="no-referrer"/);
  assert.match(source, /noopener,noreferrer/);
  assert.match(source, /actor: "Mabolla Agent"/);
});

test("contains no fabricated seed missions", () => {
  assert.equal(source.includes("TR-099"), false);
  assert.equal(source.includes("TR-103"), false);
  assert.equal(source.includes("TR-104"), false);
});

test("does not claim delivery before Technocore confirmation", () => {
  assert.match(source, /delivery: "pending"/);
  assert.match(source, /AWAITING CONFIRMATION/);
  assert.match(source, /delivery: "verified"/);
});

test("renders the accepted Technocore mission as network proof", () => {
  assert.match(source, /TR-1787597573199/);
  assert.match(source, /proof: "https:\/\/technocore\.chat\/r\/mabolla-task-relay"/);
});

test("supports cross-DID claim and claimant completion", () => {
  assert.match(source, /CLAIM WITH YOUR DID/);
  assert.match(source, /COMPLETE WITH YOUR DID/);
  assert.match(source, /identity\?\.did === created\.did/);
  assert.match(source, /identity\?\.did === event\.did/);
});

test("persists signed events before opening Technocore", () => {
  const persist = source.indexOf("localStorage.setItem(EVENTS_KEY");
  const open = source.indexOf('window.open(url, "_blank"');
  assert.ok(persist !== -1 && open !== -1 && persist < open);
});

test("implements the endorsed Technocore identity proof sequence", () => {
  assert.match(source, /SHA-256/);
  assert.match(source, /\/kv\/did\/\$\{fp\}\/set/);
  assert.match(source, /const room = "lobby"/);
  assert.match(source, /mabolla-technocore-identity\.json/);
  assert.match(source, /AES-GCM/);
  assert.match(source, /PBKDF2/);
  assert.match(source, /technocore-ed25519-encrypted-v1/);
});

test("attributes new signed events to the visitor's chosen agent name", () => {
  assert.match(source, /Choose the public agent name/);
  assert.match(source, /agentNameOf\(identity\)/);
  assert.match(source, /eventPayload\(String\(data\.get\("title"\)\), String\(data\.get\("detail"\)\), agentNameOf\(identity\), Date\.now\(\), String\(data\.get\("task-id"\)\)\)/);
  assert.match(source, /transitionPayload\(type, mission, agentNameOf\(identity\)\)/);
  assert.match(source, /identity \? "COPY" : "CREATE LOCAL DID"/);
});

test("publishes the live Technocore referee task dialect", () => {
  assert.match(source, /TASK v1 \|/);
  assert.match(source, /technocore-task\/v1/);
  assert.match(source, /Independent verification and VOUCH are welcome/);
  assert.match(source, /No self-vouch/);
  assert.match(source, /payload\.publicText \|\| JSON\.stringify\(payload\)/);
  assert.match(source, /updatePreview\(\);\n  \$\("#mission-dialog"\)\.showModal\(\)/);
  assert.match(source, /\$\("#task-id"\)\.value = newTaskId\(\)/);
  assert.match(source, /String\(data\.get\("task-id"\)\)/);
  assert.doesNotMatch(source, /t<10-hex-id>/);
});

test("publishes an official value-free tclk offer to the agent rendezvous", () => {
  assert.match(source, /LIVE TCLK\/1 PAYER AGENT/);
  assert.match(source, /asset: "PAPER"/);
  assert.match(source, /rails: \["paper"\]/);
  assert.match(source, /job: \{ proto: "a2a", id: jobId/);
  assert.match(source, /SIGN &amp; PUBLISH OFFER/);
  assert.match(source, /OFFER_ROOM/);
});

test("offers an editable, safety-locked job builder", () => {
  assert.match(source, /JOB BUILDER/);
  assert.match(source, /Easy/);
  assert.match(source, /Medium/);
  assert.match(source, /Hard/);
  assert.match(source, /Custom/);
  assert.match(source, /Task description/);
  assert.match(source, /Expected deliverable/);
  assert.match(source, /Objective success criteria/);
  assert.match(source, /PAPER amount/);
  assert.match(source, /makeJobOffer/);
  assert.match(source, /Locked safety: read-only, PAPER-only/);
});

test("renders a verified tclk track record with lifecycle sequence numbers", () => {
  assert.match(source, /My Track Record/);
  assert.match(source, /Jobs given/);
  assert.match(source, /Jobs attempted/);
  assert.match(source, /Successful/);
  assert.match(source, /Verified seq chain/);
  assert.match(source, /listMyPaperActivity/);
  assert.match(source, /summarizeDealActivity/);
  assert.match(source, /TRACK_RECORD_KEY/);
  assert.match(source, /\["offer", "OFFER"\]/);
  assert.match(source, /\["receipt", "RECEIPT"\]/);
  assert.match(source, /SUCCESSFUL · DELIVERY VERIFIED/);
  assert.match(source, /CLAIMED · RECEIPT PRESENT · NO DELIVERY/);
  assert.match(source, /entry\.payerReceiptVerified \|\| evaluation\.ok \|\| manuallyApproved/);
  assert.match(source, /archiveCompletedPayeeDeal/);
  assert.match(source, /COMPLETED DEAL ARCHIVED · RECEIPT/);
  assert.match(source, /successfulTrackEntry/);
  assert.match(source, /currentActivity/);
  assert.match(source, /activityByKey/);
  assert.match(source, /verified current or locally retained tclk record/);
});

test("keeps payee secrets browser-local and requires explicit reveal approval", () => {
  assert.match(source, /TCLK\/1 PAYEE AGENT/);
  assert.match(source, /sealSecret\(vaultPassword, prepared\.contract, prepared\.secret\)/);
  assert.match(source, /PBKDF2/);
  assert.match(source, /sealedSecret/);
  assert.match(source, /FINAL CLAIM ACTION/);
  assert.doesNotMatch(source, /localStorage\.setItem\([^\n]+prepared\.secret/);
});

test("scans recent PAPER offers first and falls back to retained history", () => {
  assert.match(source, /format=json&limit=200/);
  assert.match(source, /Scanning the latest 200 signed records/);
  assert.match(source, /full retained history/);
  assert.match(source, /verifyPaperOffers/);
});

test("reserves the derived room before publishing a payee accept", () => {
  assert.match(source, /room-reservation-pending/);
  assert.match(source, /verifyExactFrameRecord/);
  assert.match(source, /signedUrl\(prepared\.room/);
  assert.match(source, /signedUrl\(OFFER_ROOM/);
  assert.match(source, /JOB NOT ACCEPTED YET/);
  assert.match(source, /\/export\?n=/);
  assert.match(source, /AbortSignal\.timeout\(6_000\)/);
  assert.match(source, /Scan timed out while reading Technocore/);
  assert.match(source, /Job note changed after selection; accept blocked/);
});

test("auto-accepts an explicitly armed offer first, then retries its room", () => {
  assert.match(source, /ARM AUTO-ACCEPT/);
  assert.match(source, /PAYEE AUTO-ACCEPT · LOCAL KEY ONLY/);
  assert.match(source, /PAYEE_AUTO_ACCEPT_KEY/);
  assert.match(source, /CLAIMING OFFER/);
  assert.match(source, /ACCEPT VERIFIED.*CLAIM SECURED.*CREATING DEAL ROOM/);
  assert.match(source, /ROOM FULL · RETRY/);
  assert.match(source, /tryAutoAcceptPayeeDeal\(deal, "DIRECT"\)/);
  assert.match(source, /setTimeout\(resolve, 100\)/);
  assert.match(source, /verifyAcceptRecord\(await readOfferTail\(\), deal\.offer, deal\.accept\)/);
  assert.match(source, /inspectPayeeReservation/);
  assert.match(source, /recheckAutoAcceptOffer/);
  assert.match(source, /signedUrl\(deal\.room/);
  assert.match(source, /signedUrl\(OFFER_ROOM/);
  assert.match(source, /room-capacity 400 keeps retrying the derived room/);
  assert.match(source, /Resume this exact prepared deal with auto-accept/);
  assert.match(source, /The encrypted pending deal was preserved/);
});

test("hunts one new safe job and hands it to accept-first auto-accept", () => {
  assert.match(source, /ARM AUTO-JOB HUNTER/);
  assert.match(source, /PAYEE AUTO-JOB HUNTER · LOCAL KEY ONLY/);
  assert.match(source, /PAYEE_AUTO_HUNTER_KEY/);
  assert.match(source, /Minimum finish time when matched/);
  assert.match(source, /listSafePaperOffers\(payload, identity\.did, Date\.now\(\), minimumFinishMs\)/);
  assert.match(source, /selectedBy: "auto-job-hunter"/);
  assert.match(source, /verifyFirstPaperOffer/);
  assert.match(source, /Promise\.any/);
  assert.match(source, /AbortSignal\.timeout\(3_000\)/);
  assert.match(source, /startPayeeAutoAccept\(deal, state\.notificationPermission\)/);
  assert.match(source, /pausePayeeAutoHunter/);
  assert.match(source, /resolveUnacceptedHunterMiss/);
  assert.match(source, /VERIFIED NO ACCEPT · WATCHING NEXT OFFERS/);
  assert.match(source, /await verifyAcceptRecord\(await readOfferHistory\(\), deal\.offer, deal\.accept\)/);
  assert.match(source, /OFFER EXPIRED BEFORE ACCEPT/);
  assert.match(source, /VERIFY STALE DEAL & ARM AUTO-JOB HUNTER/);
  assert.match(source, /VERIFIED UNACCEPTED STALE CANDIDATE CLEARED/);
  assert.match(source, /Hunter not armed — the previous accept exists at seq/);
  assert.match(source, /ARMING ·.*JOBS SECURED · READING CURRENT OFFERS/);
  assert.match(source, /AbortSignal\.timeout\(15_000\)/);
  assert.match(source, /STOPPED AFTER REFRESH · ARM AGAIN BECAUSE THE VAULT PASSWORD IS NEVER STORED/);
  assert.match(source, /publishing accept immediately/);
  assert.doesNotMatch(source, /localStorage\.setItem\(PAYEE_AUTO_HUNTER_KEY[^\n]*payeeAutoHunterVaultPassword/);
});

test("queues up to three accepted payee jobs without overwriting their secrets", () => {
  assert.match(source, /PAYEE_DEALS_KEY/);
  assert.match(source, /MAX_ACTIVE_PAYEE_DEALS = 3/);
  assert.match(source, /rememberPayeeDeal\(deal\)/);
  assert.match(source, /activePayeeDeals\(\)/);
  assert.match(source, /queuedPayeeDeals\(\)/);
  assert.match(source, /DEADLINE PASSED · NO LOCAL LOCK/);
  assert.match(source, /continueHunterAfterQueuedDeal/);
  assert.match(source, /JOBS SECURED · WATCHING NEXT OFFERS/);
  assert.match(source, /tryAutoHuntFromPayload\(tail\)/);
  assert.match(source, /knownOfferIds/);
  assert.match(source, /PAYEE DEAL QUEUE · MAX 3/);
  assert.match(source, /OPEN \/ CHECK →/);
  assert.match(source, /Offer #\$\{existing\.offerSeq \?\? "\?"\} parked safely in the payee queue/);
});

test("only discards a payee deal after confirming its accept is absent", () => {
  assert.match(source, /DISCARD UNCONFIRMED DEAL/);
  assert.match(source, /verifyAcceptRecord\(await readOfferHistory\(\), deal\.offer, deal\.accept\)/);
  assert.match(source, /DISCARD BLOCKED — ACCEPT VERIFIED/);
  assert.match(source, /localStorage\.removeItem\(PAYEE_DEAL_KEY\)/);
  assert.match(source, /The local encrypted secret was preserved/);
});

test("locks the value-free payer rail before publishing the signed lock frame", () => {
  assert.match(source, /CREATE PAPER RAIL LOCK/);
  assert.match(source, /if_absent=1/);
  assert.match(source, /PaperRail lock does not exactly match the signed contract terms/);
  assert.match(source, /VERIFY &amp; PUBLISH SIGNED LOCK/);
  assert.match(source, /sign\(identity, deal\.lock\.room, nonce, deal\.lock\.line\)/);
});

test("restores and advances an active payer deal after refresh", () => {
  assert.match(source, /ACTIVE PAYER DEAL · SURVIVES REFRESH/);
  assert.match(source, /readPayerDeal/);
  assert.match(source, /renderPayerDeal\(\)/);
  assert.match(source, /VERIFY LOCK \/ CHECK RESULT/);
  assert.match(source, /foldPayeeDeal\(await roomResponse\.json\(\), deal\.offer, deal\.accept\)/);
  assert.match(source, /SIGN CLAIMED RECEIPT/);
  assert.match(source, /Payer receipt opened for Technocore confirmation/);
});

test("does not report an opened signed-lock tab as a verified lock", () => {
  assert.match(source, /lock submission opened — NOT VERIFIED/);
  assert.match(source, /SIGNED LOCK SUBMISSION OPENED — NOT YET VERIFIED ON TECHNOCORE/);
  assert.match(source, /deal\.state = "lock-submission-opened"/);
  assert.match(source, /SIGNED LOCK IS NOT CONFIRMED/);
  assert.doesNotMatch(source, /deal\.state = "lock-submitted"/);
});

test("restores any accepted payer deal from verified history without losing the current deal", () => {
  assert.match(source, /TCLK_PAYER_DEALS_KEY/);
  assert.match(source, /rememberPayerDeal\(current\)/);
  assert.match(source, /function resumePayerDeal\(entry\)/);
  assert.match(source, /RESUME DEAL/);
  assert.match(source, /OFFER #\$\{entry\.offerSeq/);
  assert.match(source, /ACCEPT #\$\{entry\.acceptSeq/);
});

test("auto-publishes saved payer locks only after a fresh server-created room event", () => {
  assert.match(source, /PAYER LOCK AUTO-PUBLISH · LOCAL KEY ONLY/);
  assert.match(source, /ARM PAYER AUTO-PUBLISH/);
  assert.match(source, /message\.from === "server"/);
  assert.match(source, /\^created\\s\+\\S\+/);
  assert.match(source, /identity\.did !== deal\.offer\.from/);
  assert.match(source, /room limit reached/);
  assert.match(source, /PUBLISH RETURNED OK · VERIFYING TRANSCRIPT/);
  assert.match(source, /inspectPayerDealRoom/);
  assert.match(source, /All eligible payer locks are verified or expired/);
});

test("safe auto-settle fails closed before signing a terminal payer receipt", () => {
  assert.match(source, /SAFE AUTO-SETTLE · LOCAL KEY ONLY/);
  assert.match(source, /ARM SAFE AUTO-SETTLE/);
  assert.match(source, /listSignedDeliveries/);
  assert.match(source, /evaluateObjectiveDelivery/);
  assert.match(source, /NO SIGNED DELIVERY BEFORE REVEAL/);
  assert.match(source, /Ambiguous work and refunds remain manual/);
  assert.match(source, /publishVerifiedPayerReceipt/);
  assert.match(source, /identity\.did !== deal\.offer\.from/);
  assert.match(source, /TERMINAL RECEIPT VERIFIED/);
  assert.doesNotMatch(source, /AUTO REFUND/);
});

test("manual payer settlement requires a signed delivery and blocks duplicate receipts", () => {
  assert.match(source, /SIGNED DELIVERY GATE/);
  assert.match(source, /inspectSignedPayerDelivery/);
  assert.match(source, /claimedDeliveryApproved/);
  assert.match(source, /Receipt stays disabled/);
  assert.match(source, /no approved signed delivery exists before reveal/);
  assert.match(source, /Terminal receipt already exists at seq/);
  assert.match(source, /no duplicate was published/);
  assert.match(source, /Approve this exact signed delivery manually/);
  assert.match(source, /\$\("#approve-payer-delivery"\)\?\.addEventListener/);
});

test("payee publishes and verifies a signed delivery before revealing", () => {
  assert.match(source, /SIGN &amp; PUBLISH DELIVERY/);
  assert.match(source, /publish-payee-delivery/);
  assert.match(source, /deal\.acceptSeq\s*\?\s*\{ seq: deal\.acceptSeq \}/);
  assert.match(source, /Signed delivery:.*NOT PUBLISHED/);
  assert.match(source, /Exact signed delivery already exists at seq/);
  assert.match(source, /Reveal blocked: publish and verify the signed job delivery first/);
  assert.match(source, /listSignedDeliveries\(await roomResponse\.json\(\), deal\.accept\)/);
});

test("refunds an expired locked payer deal before issuing its terminal receipt", () => {
  assert.match(source, /REFUND EXPIRED DEAL/);
  assert.match(source, /Date\.now\(\) >= deal\.offer\.refundAfterMs/);
  assert.match(source, /expectedPaperRefund\(deal\.offer, deal\.accept\)/);
  assert.match(source, /folded\.state\.status !== "locked"/);
  assert.match(source, /SIGN TERMINAL RECEIPT/);
});
