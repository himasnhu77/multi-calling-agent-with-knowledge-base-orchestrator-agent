const OpenAI         = require("openai");
const config         = require("../config");
const memoryService  = require("../memory/MemoryService");
const zendeskService = require("../knowledgebase/ZendeskService");
const searchAgent    = require("./SearchAgent");
const TextCleaner    = require("../utils/textCleaner");
const Logger         = require("../utils/logger");

const log = new Logger("OrchestratorAgent");

class OrchestratorAgent {
  #openai;
  constructor() { this.#openai = new OpenAI({ apiKey: config.openai.apiKey }); }

  async #callLLM(history, searchCtx, memoryCtx, zendeskCtx) {
    let systemContent = history[0]?.content || "";
    if (memoryCtx)  systemContent += `\n\nMemory:\n${memoryCtx.slice(0, 1500)}`;
    if (zendeskCtx) systemContent += `\n\nKnowledge Base:\n${zendeskCtx.slice(0, 2500)}`;
    const trimmedHistory = history.slice(-12);
    const baseMessages = [{ role: "system", content: systemContent }, ...trimmedHistory.slice(1)];
    const messages = searchCtx
      ? [...baseMessages.slice(0, -1), { role: "user", content: `${baseMessages.at(-1)?.content || ""}\n\n--- Live Search ---\n${searchCtx}\n---\n\nAnswer naturally in 2-4 spoken sentences.` }]
      : baseMessages;
    const res = await this.#openai.chat.completions.create({ model: config.openai.model, messages, temperature: 0.7, max_tokens: 200 });
    let text = res?.choices?.[0]?.message?.content?.trim() || "Sorry, I couldn't generate a response.";
    text = TextCleaner.forSpeech(text);
    text = TextCleaner.truncate(text, config.openai.maxSpokenChars);
    return text;
  }

  async reply(history, callerPhone, callId) {
    const query = [...history].reverse().find((m) => m.role === "user")?.content || "";
    try {
      const [memoryCtx, zendeskResult, searchCtx] = await Promise.all([
        callerPhone ? memoryService.recallMemory(callerPhone) : null,
        zendeskService.fetchArticles(query),
        searchAgent.searchIfNeeded(query),
      ]);
      const { ctx: zendeskCtx, articleIds = [] } = zendeskResult || {};
      const replyText = await this.#callLLM(history, searchCtx, memoryCtx, zendeskCtx);
      if (callerPhone && query && replyText) {
        setImmediate(() => memoryService.saveMemory(callerPhone, callId, query, replyText).catch((e) => log.warn("saveMemory:", e.message)));
        if (articleIds.length) {
          setImmediate(() => zendeskService.saveKBMemory(callerPhone, callId, query, articleIds).catch((e) => log.warn("saveKBMemory:", e.message)));
        }
      }
      return replyText;
    } catch (err) {
      log.error("reply error:", err.message);
      return "Sorry, I had trouble processing that request.";
    }
  }
}

module.exports = new OrchestratorAgent();
