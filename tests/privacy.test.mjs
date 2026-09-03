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
});

test("keeps payee secrets browser-local and requires explicit reveal approval", () => {
  assert.match(source, /TCLK\/1 PAYEE AGENT/);
  assert.match(source, /sealSecret\(vaultPassword, prepared\.contract, prepared\.secret\)/);
  assert.match(source, /PBKDF2/);
  assert.match(source, /sealedSecret/);
  assert.match(source, /FINAL CLAIM ACTION/);
  assert.doesNotMatch(source, /localStorage\.setItem\([^\n]+prepared\.secret/);
});

test("only discards a payee deal after confirming its accept is absent", () => {
  assert.match(source, /DISCARD UNCONFIRMED DEAL/);
  assert.match(source, /verifyAcceptRecord\(await response\.json\(\), deal\.offer, deal\.accept\)/);
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
  assert.match(source, /CHECK RESULT \/ REVEAL/);
  assert.match(source, /foldPayeeDeal\(await roomResponse\.json\(\), deal\.offer, deal\.accept\)/);
  assert.match(source, /SIGN CLAIMED RECEIPT/);
  assert.match(source, /Payer receipt opened for Technocore confirmation/);
});

test("refunds an expired locked payer deal before issuing its terminal receipt", () => {
  assert.match(source, /REFUND EXPIRED DEAL/);
  assert.match(source, /Date\.now\(\) >= deal\.offer\.refundAfterMs/);
  assert.match(source, /expectedPaperRefund\(deal\.offer, deal\.accept\)/);
  assert.match(source, /folded\.state\.status !== "locked"/);
  assert.match(source, /SIGN TERMINAL RECEIPT/);
});
