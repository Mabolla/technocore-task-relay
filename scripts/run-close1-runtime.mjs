import close1Worker from "../src/close1-worker.mjs";
import { CLOSE1_AGENT_DID } from "../src/close1-protocol.mjs";

for (const key of ["TECHNOCORE_AGENT_DID", "TECHNOCORE_AGENT_PRIVATE_KEY"]) {
  if (!process.env[key]) throw new Error(`${key} is required`);
}
if (process.env.TECHNOCORE_AGENT_DID !== CLOSE1_AGENT_DID) {
  throw new Error("Close-1 runtime identity mismatch");
}

await close1Worker.scheduled(null, process.env);
