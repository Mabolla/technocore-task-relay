import { registerClose1Owner } from "../src/close1-protocol.mjs";

const result = await registerClose1Owner({
  TECHNOCORE_URL: process.env.TECHNOCORE_URL || "https://technocore.chat",
  TECHNOCORE_AGENT_DID: process.env.TECHNOCORE_AGENT_DID,
  TECHNOCORE_AGENT_PRIVATE_KEY: process.env.TECHNOCORE_AGENT_PRIVATE_KEY,
  CLOSE1_REGISTRATION_ENABLED: process.env.CLOSE1_REGISTRATION_ENABLED || "false"
});

console.log(JSON.stringify(result));
if (result.action === "blocked") process.exitCode = 1;

