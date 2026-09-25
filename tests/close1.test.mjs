import test from "node:test";
import assert from "node:assert/strict";

import {
  CLOSE1_AGENT_DID,
  CLOSE1_MANIFEST_SHA256,
  CLOSE1_REFEREE_DID,
  CLOSE1_REFEREE_ROOMS,
  CLOSE1_SEED_RECORD,
  advanceClose1RoomRegistration,
  close1OwnerText,
  close1RoomText,
  observeClose1,
  registerClose1Owner,
  verifyPinnedSeed,
  verifySignedRecord
} from "../src/close1-protocol.mjs";

const OWNER_JOURNAL = [
  {
    seq: 29,
    ts: "2026-09-25T17:03:11.780280Z",
    from: CLOSE1_AGENT_DID,
    text: "{\"type\":\"close1.registration.intent.v1\",\"season\":\"close-1\",\"did\":\"did:key:z6MkfRm7VkjC52pff11L12dbFkChhVkiZqv5Wwd7VMo3fCsG\",\"observed_sweep\":59,\"package_sha256\":\"bae09812e25eb6f1369c611f24964f7ea0acafddfc45301a16f33f941296dafa\",\"request_id\":\"mabolla-close1-owner-v1\"}",
    nonce: 1790355785696,
    sig: "xEDSvj3qiVE7eVA2nq0ZHrg2T_sDYDhTJb2qzGM0s1FiJcL_9lsh0zhvQn9-wuZkkTiFdtOJfH8FW18q2idtAw"
  },
  {
    seq: 30,
    ts: "2026-09-25T17:03:22.305501Z",
    from: CLOSE1_AGENT_DID,
    text: "{\"type\":\"close1.registration.receipt.v1\",\"season\":\"close-1\",\"did\":\"did:key:z6MkfRm7VkjC52pff11L12dbFkChhVkiZqv5Wwd7VMo3fCsG\",\"observed_sweep\":59,\"registration_room\":\"close1\",\"registration_seq\":784880,\"registration_nonce\":\"1790355795828\",\"registration_sig\":\"9eKI4DXExjW60Q3f_60u7hcs1pOH0IzBsSnq8j44a3oZPPRmBfq6fpJzIiWDW1rBF8YCht_SUQvWPhmpckaTCg\",\"request_id\":\"mabolla-close1-owner-v1\"}",
    nonce: 1790355800114,
    sig: "bCGe-K7Qjm3bx2CZKYKqvh_AbXkzkqmEEl4meHpUlvsIWVbtXtFfzF7C-49J2G3CVqvR8u293Nqwp8qL-MZLAg"
  }
];

const SWEEP_ONE = {
  "d-close1-price": {
    seq: 2,
    ts: "2026-09-25T12:05:22.824751Z",
    from: CLOSE1_REFEREE_DID,
    text: "{\"age_s\":13,\"applied\":\"226.14\",\"file\":\"b71f2587d5a0963037232439985a1d939fd5e0766a968fe7117ecd8b20a29da4\",\"for\":2,\"global\":\"226.14\",\"limits\":[\"214.95\",\"237.57\"],\"n\":1,\"ref\":{\"px\":\"226.26\",\"tid\":801176715797948,\"time\":\"2026-09-25T12:04:46.823000Z\"},\"t\":\"price\"}",
    nonce: 1790337922787,
    sig: "DvfbMU2w1jH7cVi_XSPeQQrZtgljPf-Fmk6dNbsRl08pZlSodAagEn6Y9HgtG0tekgxp3cOuObtYLtX4v11lDA"
  },
  "d-close1-flow": {
    seq: 1,
    ts: "2026-09-25T12:05:22.943642Z",
    from: CLOSE1_REFEREE_DID,
    text: "{\"file\":\"b71f2587d5a0963037232439985a1d939fd5e0766a968fe7117ecd8b20a29da4\",\"mints\":[],\"missed\":[],\"n\":1,\"rooms\":[],\"settled\":[],\"t\":\"flow\",\"void\":[]}",
    nonce: 1790337922906,
    sig: "Ewbg1lNQhepSA8gcRpKcwlOImijnDzDhpFvrQ7DUJlyRMPz3uDevFGnqcK6yfSmDQwzlW7Ys5MrDyuf-jh6YAg"
  },
  "d-close1-state": {
    seq: 1,
    ts: "2026-09-25T12:05:23.454993Z",
    from: CLOSE1_REFEREE_DID,
    text: "{\"file\":\"b71f2587d5a0963037232439985a1d939fd5e0766a968fe7117ecd8b20a29da4\",\"n\":1,\"owners\":0,\"rooms\":1,\"root\":\"44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a\",\"t\":\"state\"}",
    nonce: 1790337923405,
    sig: "bLifr_x6jryoZEsOBBzSpphAdj59-h1SVMiiMD2GeYCw010K4rj8U6pmffIlYKhT64XE2HfZDc27E60pGRwdCw"
  },
  "d-close1-positions": {
    seq: 1,
    ts: "2026-09-25T12:05:23.090446Z",
    from: CLOSE1_REFEREE_DID,
    text: "{\"file\":\"b71f2587d5a0963037232439985a1d939fd5e0766a968fe7117ecd8b20a29da4\",\"longs\":0,\"n\":1,\"open\":\"0\",\"shorts\":0,\"t\":\"positions\",\"top\":[]}",
    nonce: 1790337923057,
    sig: "s8U0lgYb48tofckUpWoLa0xdBsY448q_pu2eF_yXg_jSnOWsPdajs8IhDpfj9erY7WZLjTFYIQ2NTBRs54x1Aw"
  },
  "d-close1-pnl": {
    seq: 1,
    ts: "2026-09-25T12:05:23.313670Z",
    from: CLOSE1_REFEREE_DID,
    text: "{\"file\":\"b71f2587d5a0963037232439985a1d939fd5e0766a968fe7117ecd8b20a29da4\",\"mark\":\"226.14\",\"n\":1,\"t\":\"pnl\",\"top\":[]}",
    nonce: 1790337923261,
    sig: "kkqcQ96IggTeoC3TRgwZprLM_xO_QstZbZ8GwqNWLJ-vCnNk2GVBCoBY53HuqB5Dpz89ikl5f_ZxphzTuND7BA"
  }
};

function refereeFetch(records = SWEEP_ONE) {
  return async (url) => {
    const room = CLOSE1_REFEREE_ROOMS.find((candidate) => String(url).includes(`/r/${candidate}?`));
    if (!room) return new Response("not found", { status: 404 });
    return Response.json({ room, messages: [records[room]] });
  };
}

test("pins and verifies the exact signed close-1 seed", async () => {
  assert.equal(await verifyPinnedSeed(), true);
  assert.equal(await verifySignedRecord("d-close1-price", CLOSE1_SEED_RECORD, CLOSE1_REFEREE_DID), true);
  assert.equal(
    await verifySignedRecord("d-close1-price", { ...CLOSE1_SEED_RECORD, text: `${CLOSE1_SEED_RECORD.text} ` }, CLOSE1_REFEREE_DID),
    false
  );
  assert.equal(JSON.parse(CLOSE1_SEED_RECORD.text).package, CLOSE1_MANIFEST_SHA256);
});

test("builds only Mabolla's exact compact owner registration", () => {
  assert.equal(
    close1OwnerText(),
    `{"t":"owner","season":"close-1","key":"${CLOSE1_AGENT_DID}"}`
  );
  assert.equal(close1RoomText(), '{"t":"room","season":"close-1","room":"mabolla-task-relay"}');
});

test("observes a fully signed common referee sweep", async () => {
  const result = await observeClose1(
    { TECHNOCORE_AGENT_DID: CLOSE1_AGENT_DID, CLOSE1_TRADING_ENABLED: "false" },
    { now: Date.parse("2026-09-25T12:06:00Z"), fetch: refereeFetch() }
  );
  assert.deepEqual(result, {
    action: "healthy",
    sweep: 1,
    file: "b71f2587d5a0963037232439985a1d939fd5e0766a968fe7117ecd8b20a29da4",
    reference: "226.26",
    limits: ["214.95", "237.57"],
    global: "226.14",
    owners: 0,
    rooms: 1,
    mark: "226.14",
    leaderboard: [],
    tradingEnabled: false
  });
});

test("fails closed on tampering, stale sweeps, and identity mismatch", async () => {
  const tampered = structuredClone(SWEEP_ONE);
  tampered["d-close1-flow"].text = tampered["d-close1-flow"].text.replace('"rooms":[]', '"rooms":["evil"]');
  assert.deepEqual(
    await observeClose1(
      { TECHNOCORE_AGENT_DID: CLOSE1_AGENT_DID },
      { now: Date.parse("2026-09-25T12:06:00Z"), fetch: refereeFetch(tampered) }
    ),
    { action: "blocked", reason: "no-common-signed-sweep" }
  );
  assert.deepEqual(
    await observeClose1(
      { TECHNOCORE_AGENT_DID: CLOSE1_AGENT_DID },
      { now: Date.parse("2026-09-25T13:00:00Z"), fetch: refereeFetch() }
    ),
    { action: "blocked", reason: "stale-signed-sweep", sweep: 1 }
  );
  await assert.rejects(
    observeClose1({ TECHNOCORE_AGENT_DID: "did:key:wrong" }, { fetch: refereeFetch() }),
    /Mabolla identity/
  );
});

test("close-1 registration is disabled by default", async () => {
  await assert.rejects(
    registerClose1Owner({ TECHNOCORE_AGENT_DID: CLOSE1_AGENT_DID }),
    /PRIVATE_KEY is required/
  );
  const result = await registerClose1Owner({
    TECHNOCORE_AGENT_DID: CLOSE1_AGENT_DID,
    TECHNOCORE_AGENT_PRIVATE_KEY: "unused"
  });
  assert.deepEqual(result, { action: "disabled" });
});

test("registers once through an intent and signed receipt journal", async () => {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const privateKey = Buffer.from(await crypto.subtle.exportKey("pkcs8", pair.privateKey)).toString("base64");
  const posted = [];
  let sequence = 800;
  const fetchMock = async (url, init = {}) => {
    const target = String(url);
    if (target.includes("/mabolla-task-relay/export")) return new Response("", { status: 404 });
    if (target.includes("/d-close1-price?")) return Response.json({ messages: [SWEEP_ONE["d-close1-price"]] });
    if (init.method === "POST") {
      const body = JSON.parse(init.body);
      posted.push({ room: target.split("/r/")[1], ...body, from: body.did, seq: ++sequence });
      return new Response("ok");
    }
    const room = target.split("/r/")[1].split("?")[0];
    return Response.json({ messages: posted.filter((record) => record.room === room) });
  };

  const result = await registerClose1Owner({
    TECHNOCORE_AGENT_DID: CLOSE1_AGENT_DID,
    TECHNOCORE_AGENT_PRIVATE_KEY: privateKey,
    CLOSE1_REGISTRATION_ENABLED: "true"
  }, {
    now: Date.parse("2026-09-25T12:06:00Z"),
    fetch: fetchMock
  });

  assert.equal(result.action, "registered");
  assert.equal(result.registrationSeq, 802);
  assert.equal(result.observedSweep, 1);
  assert.deepEqual(posted.map(({ room }) => room), ["mabolla-task-relay", "close1", "mabolla-task-relay"]);
  assert.equal(posted[1].text, close1OwnerText());
  assert.match(posted[0].text, /close1\.registration\.intent\.v1/);
  assert.match(posted[2].text, /close1\.registration\.receipt\.v1/);
});

test("waits two signed sweeps before registering the existing Mabolla room", async () => {
  const journalText = `${OWNER_JOURNAL.map((record) => JSON.stringify(record)).join("\n")}\n`;
  const fetchMock = async (url) => {
    const target = String(url);
    if (target.includes("/mabolla-task-relay/export")) return new Response(journalText);
    if (target.includes("/d-close1-flow?")) return Response.json({ messages: [SWEEP_ONE["d-close1-flow"]] });
    return new Response("not found", { status: 404 });
  };
  const result = await advanceClose1RoomRegistration({
    TECHNOCORE_AGENT_DID: CLOSE1_AGENT_DID,
    TECHNOCORE_AGENT_PRIVATE_KEY: "unused",
    CLOSE1_ROOM_REGISTRATION_ENABLED: "true"
  }, { action: "healthy", sweep: 60 }, {
    now: Date.parse("2026-09-25T17:04:00Z"),
    fetch: fetchMock
  });
  assert.deepEqual(result, { action: "waiting-for-mint", observedSweep: 59 });
});

test("submits the existing Mabolla room once after the mint window", async () => {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const privateKey = Buffer.from(await crypto.subtle.exportKey("pkcs8", pair.privateKey)).toString("base64");
  const posted = [];
  let sequence = 900;
  const journalText = `${OWNER_JOURNAL.map((record) => JSON.stringify(record)).join("\n")}\n`;
  const fetchMock = async (url, init = {}) => {
    const target = String(url);
    if (target.includes("/mabolla-task-relay/export")) return new Response(journalText);
    if (target.includes("/d-close1-flow?")) return Response.json({ messages: [SWEEP_ONE["d-close1-flow"]] });
    if (init.method === "POST") {
      const body = JSON.parse(init.body);
      posted.push({ room: target.split("/r/")[1], ...body, from: body.did, seq: ++sequence });
      return new Response("ok");
    }
    const room = target.split("/r/")[1].split("?")[0];
    return Response.json({ messages: posted.filter((record) => record.room === room) });
  };
  const result = await advanceClose1RoomRegistration({
    TECHNOCORE_AGENT_DID: CLOSE1_AGENT_DID,
    TECHNOCORE_AGENT_PRIVATE_KEY: privateKey,
    CLOSE1_ROOM_REGISTRATION_ENABLED: "true"
  }, { action: "healthy", sweep: 61 }, {
    now: Date.parse("2026-09-25T17:08:00Z"),
    fetch: fetchMock
  });
  assert.equal(result.action, "room-submitted");
  assert.equal(result.registrationSeq, 902);
  assert.deepEqual(posted.map(({ room }) => room), ["mabolla-task-relay", "close1", "mabolla-task-relay"]);
  assert.equal(posted[1].text, close1RoomText());
});
