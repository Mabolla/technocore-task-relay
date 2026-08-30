const QUESTION = /\?|\b(how|what|why|when|where|who|which|can|could|would|should|help|review|verify|explain)\b/i;
const LOW_VALUE = /^(interesting|great|nice|cool|good point|gm|hello|hi|thanks|thank you)[.! ]*$/i;
const RELEVANT = /\b(flop|technocore|agent|agents|did|identity|signature|signed|mission|task|validator|miner|inference|model|automation|autonomous|protocol|testnet|builder|build|api)\b/i;

export function normalize(text) {
  return String(text ?? "")
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(text) {
  return new Set(normalize(text).toLowerCase().match(/[a-z0-9_$-]{3,}/g) || []);
}

export function similarity(left, right) {
  const a = tokens(left); const b = tokens(right);
  if (!a.size && !b.size) return 1;
  const overlap = [...a].filter((token) => b.has(token)).length;
  return overlap / (a.size + b.size - overlap || 1);
}

export function decide(message, state = {}, options = {}) {
  const text = normalize(message?.text);
  const now = options.now ?? Date.now();
  const cooldownMs = options.cooldownMs ?? 5 * 60_000;
  const recentReplies = state.recentReplies || [];
  const lastReplyAt = state.lastReplyAt || 0;

  if (!text) return { action: "ignore", reason: "empty" };
  if (options.agentDid && (message?.from === options.agentDid || message?.did === options.agentDid)) return { action: "ignore", reason: "self" };
  if (now - lastReplyAt < cooldownMs) return { action: "ignore", reason: "cooldown" };
  if (LOW_VALUE.test(text)) return { action: "ignore", reason: "low-value" };
  if (options.requireRelevantTopic && !RELEVANT.test(text)) return { action: "ignore", reason: "off-topic" };

  const addressed = options.agentName && new RegExp(`\\b${options.agentName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text);
  const task = /\b(task|mission|issue|bug|build|implement|test|proof|review|verify)\b/i.test(text);
  if (!addressed && !task && !QUESTION.test(text)) return { action: "ignore", reason: "no-request" };
  if (recentReplies.some((reply) => similarity(text, reply.sourceText) >= 0.7)) return { action: "ignore", reason: "duplicate-prompt" };

  return { action: "respond", reason: addressed ? "addressed" : task ? "actionable-task" : "direct-question", text };
}

export function validateReply(reply, state = {}) {
  const text = normalize(reply);
  if (text.length < 24) return { ok: false, reason: "too-short" };
  if (text.length > 900) return { ok: false, reason: "too-long" };
  if (/interesting.{0,20}(view|thought)|how does (this|it) scale/i.test(text)) return { ok: false, reason: "generic-pattern" };
  if ((state.recentReplies || []).some((item) => similarity(text, item.replyText) >= 0.68)) return { ok: false, reason: "repetitive-reply" };
  return { ok: true, reason: "quality-gates-passed", text };
}
