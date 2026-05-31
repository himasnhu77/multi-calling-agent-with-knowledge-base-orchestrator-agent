const WebSocket = require("ws");
const { cypher } = require("./db");
const { upsertCaller } = require("./memory");
const { agentReply } = require("./agent");
const { sendVoice, cleanupStream } = require("./tts");

const SYSTEM_PROMPT =
  "You are a helpful AI assistant on a phone call. " +
  "You have access to long-term graph memory, a company knowledge base, and live web search. " +
  "Answer from your own knowledge first. Use KB for company/product questions. " +
  "Keep answers to 2-4 spoken sentences. Never say you lack real-time data.";

function setupDeepgram(ws, state) {
  const dg = new WebSocket(
    "wss://api.deepgram.com/v1/listen?" +
      new URLSearchParams({
        encoding: "mulaw",
        sample_rate: "8000",
        model: "nova-2-phonecall",
        language: "en",
        interim_results: "true",
        endpointing: "700",
        smart_format: "true",
      }),
    {
      headers: {
        Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`,
      },
    }
  );

  dg.on("open", () => {
    console.log(`✅ Deepgram connected (${state.callId})`);

    if (state.pendingAudio.length) {
      for (const chunk of state.pendingAudio) {
        dg.send(chunk);
      }
      state.pendingAudio.length = 0;
    }
  });

  dg.on("error", (err) => {
    console.error("DG error:", err.message);
  });

  dg.on("close", (code, reason) => {
    console.warn(
      `DG closed (${state.callId}) code=${code} reason=${reason || ""}`
    );
  });

  dg.on("message", async (raw) => {
    let data;

    try {
      data = JSON.parse(raw);
    } catch {
      return;
    }

    const tx =
      data?.channel?.alternatives?.[0]?.transcript?.trim() || "";

    if (!data.is_final) return;
    if (!tx) return;
    if (!state.greetingDone) return;
    if (state.isProcessing) return;

    // ignore bot audio window
    if (Date.now() < state.gate.ignoreUntil) return;

    // duplicate Deepgram finals protection
    if (tx === state.lastTranscript) return;
    state.lastTranscript = tx;

    // small debounce
    if (Date.now() - state.lastTurnAt < 300) return;

    console.log(`🎤 [${state.callId}] ${tx}`);

    state.isProcessing = true;

    try {
      // keep history small
      if (state.history.length > 20) {
        state.history.splice(1, state.history.length - 20);
      }

      state.history.push({
        role: "user",
        content: tx,
      });

      const reply = await agentReply(
        state.history,
        state.callerPhone,
        state.callId
      );

      if (
        ws.readyState === WebSocket.OPEN &&
        state.streamSid
      ) {
        await sendVoice(
          ws,
          state.streamSid,
          reply,
          state.history,
          state.gate
        );
      }

      state.lastTurnAt = Date.now();
    } catch (err) {
      console.error(
        `Agent error (${state.callId}):`,
        err.message
      );
    } finally {
      state.isProcessing = false;
    }
  });

  return dg;
}

function createWsServer() {
  const wss = new WebSocket.Server({
    noServer: true,
  });

  wss.on("connection", (ws) => {
    console.log("📞 WS connected");

    const state = {
      streamSid: null,
      callerPhone: null,
      callId: `call_${Date.now()}_${Math.random()
        .toString(36)
        .slice(2, 8)}`,

      greetingDone: false,
      isProcessing: false,
      lastTurnAt: 0,
      lastTranscript: "",

      gate: {
        ignoreUntil: 0,
      },

      history: [
        {
          role: "system",
          content: SYSTEM_PROMPT,
        },
      ],

      deepgramWs: null,
      pendingAudio: [],
    };

    const cleanup = () => {
      try {
        if (state.streamSid) {
          cleanupStream(state.streamSid);
        }
      } catch {}

      try {
        state.deepgramWs?.close();
      } catch {}

      state.pendingAudio.length = 0;

      console.log(`🧹 Cleaned ${state.callId}`);
    };

    ws.on("close", cleanup);
    ws.on("error", cleanup);

    ws.on("message", async (raw) => {
      let msg;

      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }

      switch (msg.event) {
        case "start": {
          state.streamSid = msg.start.streamSid;
          state.callerPhone =
            msg.start?.customParameters?.callerPhone ||
            null;

          console.log(
            `🆔 ${state.callId} | caller: ${
              state.callerPhone || "unknown"
            }`
          );

          if (state.callerPhone) {
            upsertCaller(state.callerPhone).catch(
              console.warn
            );
          }

          state.deepgramWs = setupDeepgram(ws, state);

          let isReturning = false;

          try {
            if (state.callerPhone) {
              const result = await cypher(
                `
                MATCH (c:Caller { phone: $p })-[:HAS_MEMORY]->(m)
                RETURN count(m) AS n
                `,
                {
                  p: state.callerPhone,
                }
              );

              isReturning =
                (
                  result?.[0]
                    ?.get("n")
                    ?.toNumber?.() ?? 0
                ) > 0;
            }
          } catch (err) {
            console.error(
              "Memory lookup failed:",
              err.message
            );
          }

          setTimeout(async () => {
            try {
              if (
                ws.readyState !== WebSocket.OPEN ||
                !state.streamSid
              ) {
                return;
              }

              await sendVoice(
                ws,
                state.streamSid,
                isReturning
                  ? "Welcome back! I remember our previous chats. What can I help you with?"
                  : "Hello! I'm your AI assistant. Ask me anything!",
                state.history,
                state.gate
              );

              state.greetingDone = true;
            } catch (err) {
              console.error(
                "Greeting error:",
                err.message
              );
            }
          }, 1000);

          break;
        }

        case "media": {
          // Drop caller audio while bot is speaking — avoids echo in STT
          if (Date.now() < state.gate.ignoreUntil) {
            break;
          }

          const audio = Buffer.from(
            msg.media.payload,
            "base64"
          );

          if (
            state.deepgramWs &&
            state.deepgramWs.readyState ===
              WebSocket.OPEN
          ) {
            state.deepgramWs.send(audio);
          } else if (
            state.pendingAudio.length < 50
          ) {
            state.pendingAudio.push(audio);
          }
          break;
        }

        case "mark": {
          // Twilio finished playing outbound audio up to our mark
          state.gate.ignoreUntil = Date.now() + 400;
          console.log(
            `🏁 TTS mark received (${state.callId})`
          );
          break;
        }

        case "stop": {
          console.log(
            `📵 Call ended (${state.callId})`
          );
          cleanup();
          break;
        }
      }
    });
  });

  return wss;
}

module.exports = { createWsServer };