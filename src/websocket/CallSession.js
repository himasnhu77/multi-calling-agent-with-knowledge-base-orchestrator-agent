const WebSocket     = require("ws");
const db            = require("../database/Neo4jClient");
const memoryService = require("../memory/MemoryService");
const orchestrator  = require("../agents/OrchestratorAgent");
const ttsService    = require("../tools/TTSService");
const Logger        = require("../utils/logger");

const log = new Logger("CallSession");

const SYSTEM_PROMPT =
  "You are a helpful AI assistant on a phone call. " +
  "You have access to long-term graph memory, a company knowledge base, and live web search. " +
  "Answer from your own knowledge first. Use KB for company/product questions. " +
  "Keep answers to 2-4 spoken sentences. Never say you lack real-time data.";

const DEEPGRAM_WS_URL =
  "wss://api.deepgram.com/v1/listen?" +
  new URLSearchParams({ encoding: "mulaw", sample_rate: "8000", model: "nova-2-phonecall", language: "en", interim_results: "true", endpointing: "700", smart_format: "true" }).toString();

class CallSession {
  streamSid      = null;
  callerPhone    = null;
  greetingDone   = false;
  isProcessing   = false;
  lastTurnAt     = 0;
  lastTranscript = "";
  gate           = { ignoreUntil: 0 };
  history        = [{ role: "system", content: SYSTEM_PROMPT }];

  #callId;
  #deepgramWs   = null;
  #pendingAudio = [];
  #ws;

  constructor(twilioWs) {
    this.#ws     = twilioWs;
    this.#callId = `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    log.info(`Session created — ${this.#callId}`);
  }

  get callId() { return this.#callId; }

  startDeepgram() {
    const dg = new WebSocket(DEEPGRAM_WS_URL, { headers: { Authorization: `Token ${process.env.DEEPGRAM_API_KEY}` } });
    dg.on("open", () => { log.info(`Deepgram connected (${this.#callId})`); for (const chunk of this.#pendingAudio) dg.send(chunk); this.#pendingAudio = []; });
    dg.on("error", (err) => log.error("Deepgram error:", err.message));
    dg.on("close", (code, reason) => log.warn(`Deepgram closed (${this.#callId}) code=${code} ${reason || ""}`));
    dg.on("message", async (raw) => {
      let data; try { data = JSON.parse(raw); } catch { return; }
      const tx = data?.channel?.alternatives?.[0]?.transcript?.trim() || "";
      if (!data.is_final)                     return;
      if (!tx)                                return;
      if (!this.greetingDone)                 return;
      if (this.isProcessing)                  return;
      if (Date.now() < this.gate.ignoreUntil) return;
      if (tx === this.lastTranscript)         return;
      this.lastTranscript = tx;
      if (Date.now() - this.lastTurnAt < 300) return;
      log.info(`STT [${this.#callId}]: ${tx}`);
      await this.#handleUserTurn(tx);
    });
    this.#deepgramWs = dg;
  }

  async #handleUserTurn(transcript) {
    this.isProcessing = true;
    try {
      if (this.history.length > 20) this.history.splice(1, this.history.length - 20);
      this.history.push({ role: "user", content: transcript });
      const reply = await orchestrator.reply(this.history, this.callerPhone, this.#callId);
      if (this.#ws.readyState === WebSocket.OPEN && this.streamSid) {
        await ttsService.sendVoice(this.#ws, this.streamSid, reply, this.history, this.gate);
      }
      this.lastTurnAt = Date.now();
    } catch (err) {
      log.error(`Agent error (${this.#callId}):`, err.message);
    } finally {
      this.isProcessing = false;
    }
  }

  async onStart(msg) {
    this.streamSid   = msg.start.streamSid;
    this.callerPhone = msg.start?.customParameters?.callerPhone || null;
    log.info(`Call started — ${this.#callId} | caller: ${this.callerPhone || "unknown"}`);
    if (this.callerPhone) memoryService.upsertCaller(this.callerPhone).catch(log.warn.bind(log));
    this.startDeepgram();
    let isReturning = false;
    try {
      if (this.callerPhone) {
        const result = await db.cypher(`MATCH (c:Caller { phone: $p })-[:HAS_MEMORY]->(m) RETURN count(m) AS n`, { p: this.callerPhone });
        isReturning = (result?.[0]?.get("n")?.toNumber?.() ?? 0) > 0;
      }
    } catch (err) { log.error("Returning caller check failed:", err.message); }
    setTimeout(async () => {
      if (this.#ws.readyState !== WebSocket.OPEN || !this.streamSid) return;
      const greeting = isReturning ? "Welcome back! I remember our previous chats. What can I help you with?" : "Hello! I'm your AI assistant. Ask me anything!";
      try { await ttsService.sendVoice(this.#ws, this.streamSid, greeting, this.history, this.gate); this.greetingDone = true; }
      catch (err) { log.error("Greeting error:", err.message); }
    }, 1000);
  }

  onMedia(msg) {
    if (Date.now() < this.gate.ignoreUntil) return;
    const audio = Buffer.from(msg.media.payload, "base64");
    if (this.#deepgramWs?.readyState === WebSocket.OPEN) { this.#deepgramWs.send(audio); }
    else if (this.#pendingAudio.length < 50) { this.#pendingAudio.push(audio); }
  }

  onMark() { this.gate.ignoreUntil = Date.now() + 400; log.info(`TTS mark received (${this.#callId})`); }

  cleanup() {
    try { if (this.streamSid) ttsService.cleanupStream(this.streamSid); } catch {}
    try { this.#deepgramWs?.close(); } catch {}
    this.#pendingAudio = [];
    log.info(`Session cleaned up — ${this.#callId}`);
  }
}

module.exports = CallSession;
