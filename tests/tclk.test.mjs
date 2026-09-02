import test from "node:test";
import assert from "node:assert/strict";
import { decodeFrame, encodeFrame, makePaperOffer } from "../public/tclk.js";

const did = "did:key:z6MkfRm7VkjC52pff11L12dbFkChhVkiZqv5Wwd7VMo3fCsG";

test("builds a deterministic, task-bound PaperRail offer", async () => {
  const input = { from: did, jobId: "t3c9180d419", now: 1_800_000_000_000, nonce: "0123456789abcdef" };
  const a = await makePaperOffer(input); const b = await makePaperOffer(input);
  assert.equal(a.id, b.id);
  assert.deepEqual(a.job, { id: "t3c9180d419", proto: "technocore-task" });
  assert.equal(a.asset, "PAPER"); assert.deepEqual(a.rails, ["paper"]);
});

test("encodes canonical ASCII tclk/1 frames", async () => {
  const offer = await makePaperOffer({ from: did, jobId: "t3c9180d419", now: 1_800_000_000_000, nonce: "0123456789abcdef" });
  const wire = encodeFrame(offer);
  assert.ok(wire.startsWith("tclk1 {")); assert.deepEqual(decodeFrame(wire), offer);
});
