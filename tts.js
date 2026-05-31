const axios = require("axios");
const WebSocket = require("ws");
const config = require("./config");

const FRAME_BYTES = 160;
const FRAME_MS = 20;

// Adam voice
const ELEVENLABS_VOICE = "pNInz6obpgDQGcFmaJgB";

const playbackQueues = new Map();

function padUlaw(chunk) {
  if (chunk.length === FRAME_BYTES) return chunk;

  const padded = Buffer.alloc(FRAME_BYTES, 0xff);
  chunk.copy(padded);

  return padded;
}

async function fetchAudio(text) {
  const outputFormat = "ulaw_8000";

  const { data, status } = await axios.post(
    `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE}/stream?output_format=${outputFormat}`,
    {
      text,
      model_id: "eleven_turbo_v2",
      voice_settings: {
        stability: 0.55,
        similarity_boost: 0.75,
      },
    },
    {
      headers: {
        "xi-api-key": config.elevenlabs.apiKey,
        "Content-Type": "application/json",
      },
      responseType: "arraybuffer",
      timeout: 60000,
      validateStatus: () => true,
    }
  );

  if (status < 200 || status >= 300) {
    const errText = Buffer.from(data)
      .toString("utf8")
      .slice(0, 500);

    throw new Error(
      `ElevenLabs HTTP ${status}: ${errText}`
    );
  }

  const buffer = Buffer.from(data);

  if (!buffer.length) {
    throw new Error(
      "Empty audio received from ElevenLabs"
    );
  }

  return buffer;
}

function clearOutboundAudio(ws, streamSid) {
  if (
    !streamSid ||
    ws.readyState !== WebSocket.OPEN
  ) {
    return;
  }

  ws.send(
    JSON.stringify({
      event: "clear",
      streamSid,
    })
  );
}

async function streamMulawToTwilio(
  ws,
  streamSid,
  buffer,
  gate
) {
  const totalFrames = Math.ceil(
    buffer.length / FRAME_BYTES
  );

  const audioDurationMs =
    totalFrames * FRAME_MS;

  gate.ignoreUntil =
    Date.now() + audioDurationMs + 600;

  const startTime =
    process.hrtime.bigint();

  for (
    let frame = 0, offset = 0;
    offset < buffer.length;
    offset += FRAME_BYTES, frame++
  ) {
    if (ws.readyState !== WebSocket.OPEN) {
      return;
    }

    const chunk = buffer.subarray(
      offset,
      offset + FRAME_BYTES
    );

    ws.send(
      JSON.stringify({
        event: "media",
        streamSid,
        media: {
          payload:
            padUlaw(chunk).toString("base64"),
        },
      })
    );

    const targetNs =
      BigInt((frame + 1) * FRAME_MS) *
      1000000n;

    const elapsedNs =
      process.hrtime.bigint() -
      startTime;

    const waitNs =
      targetNs - elapsedNs;

    if (waitNs > 0n) {
      await new Promise((resolve) =>
        setTimeout(
          resolve,
          Number(waitNs) / 1000000
        )
      );
    }
  }

  if (ws.readyState === WebSocket.OPEN) {
    ws.send(
      JSON.stringify({
        event: "mark",
        streamSid,
        mark: {
          name: "tts_done",
        },
      })
    );
  }

  console.log(
    `🔊 TTS done — ${totalFrames} frames (${audioDurationMs} ms)`
  );
}

async function sendVoice(
  ws,
  streamSid,
  text,
  history,
  gate
) {
  if (!streamSid) return;

  if (ws.readyState !== WebSocket.OPEN)
    return;

  const previous =
    playbackQueues.get(streamSid) ||
    Promise.resolve();

  const current = previous
    .catch(() => {})
    .then(async () => {
      if (
        ws.readyState !== WebSocket.OPEN
      ) {
        return;
      }

      console.log(
        "🔊 TTS:",
        text.slice(0, 100)
      );

      clearOutboundAudio(ws, streamSid);

      history.push({
        role: "assistant",
        content: text,
      });

      const audioBuffer =
        await fetchAudio(text);

      await streamMulawToTwilio(
        ws,
        streamSid,
        audioBuffer,
        gate
      );
    })
    .catch((err) => {
      console.error(
        "TTS error:",
        err.message
      );
    });

  playbackQueues.set(
    streamSid,
    current
  );

  return current;
}

function cleanupStream(streamSid) {
  playbackQueues.delete(streamSid);
}

console.log(
  "🔊 TTS initialized (ElevenLabs ulaw_8000 → Twilio)"
);

module.exports = {
  sendVoice,
  cleanupStream,
};