const axios     = require("axios");
const WebSocket = require("ws");
const config    = require("../config");
const Logger    = require("../utils/logger");

const log        = new Logger("TTSService");
const FRAME_BYTES = 160;
const FRAME_MS    = 20;

class TTSService {
  #playbackQueues = new Map();

  async #fetchAudio(text) {
    const { data, status } = await axios.post(
      `https://api.elevenlabs.io/v1/text-to-speech/${config.elevenlabs.voiceId}?output_format=ulaw_8000`,
      { text, model_id: "eleven_turbo_v2", voice_settings: { stability: 0.55, similarity_boost: 0.75 } },
      { headers: { "xi-api-key": config.elevenlabs.apiKey, "Content-Type": "application/json" }, responseType: "arraybuffer", timeout: 60000, validateStatus: () => true }
    );
    if (status < 200 || status >= 300) throw new Error(`ElevenLabs HTTP ${status}: ${Buffer.from(data).toString("utf8").slice(0, 500)}`);
    const buffer = Buffer.from(data);
    if (!buffer.length) throw new Error("Empty audio received from ElevenLabs");
    return buffer;
  }

  #padFrame(chunk) {
    if (chunk.length === FRAME_BYTES) return chunk;
    const padded = Buffer.alloc(FRAME_BYTES, 0xff);
    chunk.copy(padded);
    return padded;
  }

  #clearOutbound(ws, streamSid) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ event: "clear", streamSid }));
  }

  async #streamFrames(ws, streamSid, buffer, gate) {
    const totalFrames    = Math.ceil(buffer.length / FRAME_BYTES);
    const audioDurationMs = totalFrames * FRAME_MS;
    gate.ignoreUntil = Date.now() + audioDurationMs + 600;
    const startTime = process.hrtime.bigint();
    for (let frame = 0, offset = 0; offset < buffer.length; offset += FRAME_BYTES, frame++) {
      if (ws.readyState !== WebSocket.OPEN) return;
      const chunk = buffer.subarray(offset, offset + FRAME_BYTES);
      ws.send(JSON.stringify({ event: "media", streamSid, media: { payload: this.#padFrame(chunk).toString("base64") } }));
      const targetNs  = BigInt((frame + 1) * FRAME_MS) * 1_000_000n;
      const elapsedNs = process.hrtime.bigint() - startTime;
      const waitNs    = targetNs - elapsedNs;
      if (waitNs > 0n) await new Promise((r) => setTimeout(r, Number(waitNs) / 1_000_000));
    }
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ event: "mark", streamSid, mark: { name: "tts_done" } }));
    log.info(`Streamed ${totalFrames} frames (${audioDurationMs} ms)`);
  }

  sendVoice(ws, streamSid, text, history, gate) {
    if (!streamSid || ws.readyState !== WebSocket.OPEN) return Promise.resolve();
    const previous = this.#playbackQueues.get(streamSid) || Promise.resolve();
    const current  = previous.catch(() => {}).then(async () => {
      if (ws.readyState !== WebSocket.OPEN) return;
      log.info("TTS:", text.slice(0, 100));
      this.#clearOutbound(ws, streamSid);
      history.push({ role: "assistant", content: text });
      const audioBuffer = await this.#fetchAudio(text);
      await this.#streamFrames(ws, streamSid, audioBuffer, gate);
    }).catch((err) => log.error("TTS error:", err.message));
    this.#playbackQueues.set(streamSid, current);
    return current;
  }

  cleanupStream(streamSid) { this.#playbackQueues.delete(streamSid); }
}

module.exports = new TTSService();
