const fs = require("fs");
const path = require("path");

const files = {};

// ─────────────────────────────────────────
// config.js
// ─────────────────────────────────────────
files["config.js"] = `require("dotenv").config();

const config = {
  port: process.env.PORT || 3000,
  ngrokUrl: process.env.NGROK_URL,

  openai: {
    apiKey: process.env.OPENAI_API_KEY,
    model: process.env.OPENAI_MODEL || "gpt-4o-mini",
    maxSpokenChars: 550,
  },

  neo4j: {
    uri: process.env.NEO4J_URI,
    user: process.env.NEO4J_USER || "neo4j",
    pass: process.env.NEO4J_PASS,
  },

  twilio: {
    accountSid: process.env.TWILIO_ACCOUNT_SID,
    authToken: process.env.TWILIO_AUTH_TOKEN,
    phoneNumber: process.env.TWILIO_PHONE_NUMBER,
  },

  deepgram: {
    apiKey: process.env.DEEPGRAM_API_KEY,
  },

  elevenlabs: {
    apiKey: process.env.ELEVEN_LABS_API_KEY,
  },

  zendesk: {
    subdomain: process.env.ZENDESK_SUBDOMAIN,
    email: process.env.ZENDESK_EMAIL,
    apiToken: process.env.ZENDESK_API_TOKEN,
    sectionId: process.env.ZENDESK_DEFAULT_SECTION_ID,
    permGroupId: process.env.ZENDESK_PERMISSION_GROUP_ID,
  },

  tavily: {
    apiKey: process.env.TAVILY_API_KEY,
  },
};

module.exports = config;
`;

// ─────────────────────────────────────────
// db.js
// ─────────────────────────────────────────
files["db.js"] = `const neo4j = require("neo4j-driver");
const config = require("./config");

let _driver = null;

function getDriver() {
  if (!_driver) {
    const { uri, user, pass } = config.neo4j;
    if (!uri || !pass) throw new Error("NEO4J_URI and NEO4J_PASS required");
    _driver = neo4j.driver(uri, neo4j.auth.basic(user, pass));
    console.log("🧠 Neo4j connected →", uri);
  }
  return _driver;
}

async function cypher(query, params = {}) {
  const session = getDriver().session();
  try {
    const result = await session.run(query, params);
    return result.records;
  } catch (err) {
    console.error("Neo4j error:", err.message);
    return [];
  } finally {
    await session.close();
  }
}

async function initGraphSchema() {
  try {
    await cypher(\`CREATE INDEX caller_phone IF NOT EXISTS FOR (c:Caller) ON (c.phone)\`);
    await cypher(\`CREATE INDEX entity_name IF NOT EXISTS FOR (e:Entity) ON (e.name)\`);
    await cypher(\`CREATE INDEX kb_doc_id IF NOT EXISTS FOR (k:KBDocument) ON (k.articleId)\`);
    console.log("🧠 Neo4j schema ready");
  } catch (err) {
    console.warn("Neo4j schema init:", err.message);
  }
}

module.exports = { cypher, initGraphSchema };
`;

// ─────────────────────────────────────────
// memory.js
// ─────────────────────────────────────────
files["memory.js"] = `const { cypher } = require("./db");
const OpenAI = require("openai");
const config = require("./config");

const openai = new OpenAI({ apiKey: config.openai.apiKey });

async function upsertCaller(phone) {
  await cypher(
    \`MERGE (c:Caller { phone: $phone })
     ON CREATE SET c.firstSeen = datetime(), c.lastSeen = datetime()
     ON MATCH  SET c.lastSeen = datetime()\`,
    { phone }
  );
}

async function extractMemory(userText, assistantText) {
  const prompt =
    \`You are an entity extractor for a knowledge graph memory system.\\n\` +
    \`USER: \${userText}\\nASSISTANT: \${assistantText}\\n\\n\` +
    \`Return ONLY valid JSON:\\n{ "summary": "", "entities": [{ "name": "", "type": "" }] }\\n\` +
    \`If nothing memorable, return { "summary": "", "entities": [] }.\`;
  try {
    const res = await openai.chat.completions.create({
      model: config.openai.model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
      max_tokens: 300,
      response_format: { type: "json_object" },
    });
    return JSON.parse(res.choices[0].message.content.trim());
  } catch {
    return { summary: "", entities: [] };
  }
}

async function saveMemory(phone, callId, userText, assistantText) {
  const { summary, entities } = await extractMemory(userText, assistantText);
  if (!summary) return;
  await cypher(
    \`MATCH (c:Caller { phone: $phone })
     CREATE (m:Memory { text: $summary, timestamp: datetime(), callId: $callId, source: 'conversation' })
     CREATE (c)-[:HAS_MEMORY]->(m)\`,
    { phone, summary, callId }
  );
  for (const ent of entities) {
    if (!ent.name?.trim()) continue;
    await cypher(
      \`MATCH (c:Caller { phone: $phone })
       MERGE (e:Entity { name: $name }) ON CREATE SET e.type = $type
       MERGE (c)-[:MENTIONED]->(e)
       WITH c, e
       MATCH (m:Memory { callId: $callId }) WHERE (c)-[:HAS_MEMORY]->(m)
       MERGE (m)-[:INVOLVES]->(e)\`,
      { phone, name: ent.name.toLowerCase(), type: ent.type || "Topic", callId }
    );
  }
}

async function recallMemory(phone) {
  const [memRecs, entRecs, kbRecs] = await Promise.all([
    cypher(
      \`MATCH (c:Caller { phone: $phone })-[:HAS_MEMORY]->(m:Memory)
       RETURN m.text AS text ORDER BY m.timestamp DESC LIMIT 12\`,
      { phone }
    ),
    cypher(
      \`MATCH (c:Caller { phone: $phone })-[:MENTIONED]->(e:Entity)
       RETURN e.name AS name, e.type AS type LIMIT 25\`,
      { phone }
    ),
    cypher(
      \`MATCH (c:Caller { phone: $phone })-[:USED_KB_DOC]->(k:KBDocument)
       RETURN k.title AS title ORDER BY k.createdAt DESC LIMIT 5\`,
      { phone }
    ),
  ]);

  const memories = memRecs.map((r) => r.get("text")).filter(Boolean);
  const entities = entRecs.map((r) => \`\${r.get("name")} (\${r.get("type")})\`).filter(Boolean);
  const kbDocs = kbRecs.map((r) => r.get("title")).filter(Boolean);
  if (!memories.length && !entities.length && !kbDocs.length) return null;

  let ctx = "=== Caller memory ===\\n";
  if (entities.length) ctx += \`Entities: \${entities.join(", ")}\\n\`;
  if (kbDocs.length) ctx += \`KB docs used: \${kbDocs.join(", ")}\\n\`;
  if (memories.length) {
    ctx += "Recent memories:\\n";
    memories.forEach((m, i) => (ctx += \` \${i + 1}. \${m}\\n\`));
  }
  ctx += "=== Use this to personalise ===";
  return ctx;
}

module.exports = { upsertCaller, saveMemory, recallMemory };
`;

// ─────────────────────────────────────────
// knowledge.js
// ─────────────────────────────────────────
files["knowledge.js"] = `const axios = require("axios");
const { cypher } = require("./db");
const config = require("./config");

async function fetchZendeskArticles(query) {
  const { subdomain, email, apiToken } = config.zendesk;
  if (!subdomain || !apiToken) return null;
  try {
    const res = await axios.get(
      \`https://\${subdomain}.zendesk.com/api/v2/help_center/articles/search\`,
      {
        params: { query, per_page: 3, locale: "en-us" },
        auth: { username: \`\${email}/token\`, password: apiToken },
        timeout: 8000,
      }
    );
    const articles = res.data.results?.slice(0, 3) || [];
    if (!articles.length) return { ctx: null, articleIds: [] };
    const ctx =
      \`=== Zendesk KB ===\\n\` +
      articles.map((a) => \`- \${a.title}: \${a.snippet}\`).join("\\n") +
      \`\\n=== Prefer KB for product/policy questions ===\`;
    return { ctx, articleIds: articles.map((a) => String(a.id)) };
  } catch (err) {
    console.warn("Zendesk error:", err.message);
    return { ctx: null, articleIds: [] };
  }
}

async function pushArticleToZendesk(title, body) {
  const { subdomain, email, apiToken, sectionId, permGroupId } = config.zendesk;
  const payload = {
    article: {
      title,
      body: \`<p>\${body.replace(/\\n/g, "</p><p>")}</p>\`,
      locale: "en-us",
      ...(permGroupId && { permission_group_id: parseInt(permGroupId) }),
      user_segment_id: null,
    },
  };
  const url = sectionId
    ? \`https://\${subdomain}.zendesk.com/api/v2/help_center/sections/\${sectionId}/articles\`
    : \`https://\${subdomain}.zendesk.com/api/v2/help_center/articles\`;
  const res = await axios.post(url, payload, {
    auth: { username: \`\${email}/token\`, password: apiToken },
    headers: { "Content-Type": "application/json" },
    timeout: 15000,
  });
  return res.data.article;
}

async function saveKBDocument({ articleId, title, filename, chunkIndex, totalChunks }) {
  await cypher(
    \`MERGE (k:KBDocument { articleId: $articleId })
     SET k.title = $title, k.filename = $filename,
         k.chunkIndex = $chunkIndex, k.totalChunks = $totalChunks,
         k.createdAt = datetime()\`,
    { articleId: String(articleId), title, filename, chunkIndex, totalChunks }
  );
}

async function saveKBMemory(phone, callId, question, articleIds) {
  if (!articleIds.length) return;
  await cypher(
    \`MATCH (c:Caller { phone: $phone })
     CREATE (m:Memory { text: $text, timestamp: datetime(), callId: $callId, source: 'zendesk_kb' })
     CREATE (c)-[:HAS_MEMORY]->(m)\`,
    { phone, callId, text: \`KB lookup: "\${question}" → \${articleIds.length} article(s)\` }
  );
  for (const id of articleIds) {
    await cypher(
      \`MATCH (c:Caller { phone: $phone })
       MATCH (k:KBDocument { articleId: $articleId })
       MERGE (c)-[r:USED_KB_DOC]->(k)
       ON CREATE SET r.firstUsed = datetime(), r.count = 1, r.sampleQuestion = $question
       ON MATCH  SET r.lastUsed = datetime(), r.count = r.count + 1\`,
      { phone, articleId: String(id), question }
    ).catch((e) => console.warn("linkCallerToKBDoc:", e.message));
  }
}

function chunkText(text, chunkSize = 800) {
  const paragraphs = text.split(/\\n\\s*\\n/).filter((p) => p.trim().length > 50);
  const chunks = [];
  let current = "";
  for (const para of paragraphs) {
    const words = (current + " " + para).trim().split(/\\s+/).length;
    if (words > chunkSize && current) { chunks.push(current.trim()); current = para; }
    else current = current ? current + "\\n\\n" + para : para;
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.length ? chunks : [text.trim()];
}

module.exports = { fetchZendeskArticles, pushArticleToZendesk, saveKBDocument, saveKBMemory, chunkText };
`;

// ─────────────────────────────────────────
// agent.js
// ─────────────────────────────────────────
files["agent.js"] = `const axios = require("axios");
const OpenAI = require("openai");
const config = require("./config");
const { recallMemory, saveMemory } = require("./memory");
const { fetchZendeskArticles, saveKBMemory } = require("./knowledge");

const openai = new OpenAI({ apiKey: config.openai.apiKey });

const NEVER_SEARCH = [
  /^(hi|hello|hey|thanks|thank you|bye|goodbye|ok|okay|yes|no|sure|great|good)\\b/i,
  /\\b(explain|define|what is a|how does|tell me about)\\b.{0,50}\\b(physics|chemistry|biology|math|gravity|atom|dna|photosynthesis|quantum)\\b/i,
  /\\b(recipe|how to cook|how to make|how to bake)\\b/i,
  /\\b(how to (code|program|write|implement)|what is (a )?(function|class|variable|loop|array|api))\\b/i,
  /\\b(capital of|flag of|currency of|who invented|who wrote)\\b/i,
];

async function shouldSearch(query) {
  if (!query?.trim() || !config.tavily.apiKey) return false;
  if (NEVER_SEARCH.some((r) => r.test(query))) return false;
  try {
    const res = await openai.chat.completions.create({
      model: config.openai.model,
      messages: [{ role: "user", content: \`Does answering this need live/real-time data?\\n"\${query}"\\nReply ONLY: YES or NO\` }],
      temperature: 0,
      max_tokens: 5,
    });
    return res.choices[0].message.content.trim().toUpperCase().startsWith("YES");
  } catch {
    return false;
  }
}

async function tavilySearch(query) {
  try {
    const { data } = await axios.post(
      "https://api.tavily.com/search",
      { api_key: config.tavily.apiKey, query, max_results: 5, search_depth: "basic", include_answer: true },
      { timeout: 10000 }
    );
    const snippets = [];
    if (data.answer) snippets.push(\`[Answer] \${data.answer}\`);
    (data.results || []).slice(0, 4).forEach((r) => {
      if (r.content) snippets.push(\`[Web] \${r.title}: \${r.content.slice(0, 300)}\`);
    });
    return snippets.length ? \`Live search for "\${query}":\\n\` + snippets.join("\\n") : null;
  } catch (err) {
    console.error("Tavily error:", err.message);
    return null;
  }
}

async function askOpenAI(history, searchCtx, memoryCtx, zendeskCtx) {
  try {
    let systemContent = history[0].content;
    if (memoryCtx) systemContent += "\\n\\n" + memoryCtx;
    if (zendeskCtx) systemContent += "\\n\\n" + zendeskCtx;

    const base = [{ role: "system", content: systemContent }, ...history.slice(1)];
    const messages = searchCtx
      ? [...base.slice(0, -1), {
          role: "user",
          content: \`\${base.at(-1).content}\\n\\n--- Live search ---\\n\${searchCtx}\\n---\\nKeep answer to 2-4 spoken sentences.\`,
        }]
      : base;

    const res = await openai.chat.completions.create({
      model: config.openai.model,
      messages,
      temperature: 0.7,
      max_tokens: 200,
    });

    let text = res.choices[0].message.content.trim();
    if (text.length > config.openai.maxSpokenChars)
      text = text.slice(0, config.openai.maxSpokenChars).trim() + " …Want more detail?";
    return text;
  } catch (err) {
    console.error("OpenAI error:", err.message);
    return "Sorry, something went wrong on my end.";
  }
}

async function agentReply(history, callerPhone, callId) {
  const query = [...history].reverse().find((m) => m.role === "user")?.content || "";

  const [memoryCtx, needsWeb, zendeskResult] = await Promise.all([
    callerPhone ? recallMemory(callerPhone) : null,
    shouldSearch(query),
    fetchZendeskArticles(query),
  ]);

  const { ctx: zendeskCtx, articleIds = [] } = zendeskResult || {};
  const searchCtx = needsWeb ? await tavilySearch(query) : null;

  const reply = await askOpenAI(history, searchCtx, memoryCtx, zendeskCtx);

  if (callerPhone && query && reply) {
    saveMemory(callerPhone, callId, query, reply).catch((e) => console.warn("saveMemory:", e.message));
    if (articleIds.length)
      saveKBMemory(callerPhone, callId, query, articleIds).catch((e) => console.warn("saveKBMemory:", e.message));
  }

  return reply;
}

module.exports = { agentReply, shouldSearch, tavilySearch };
`;

// ─────────────────────────────────────────
// tts.js
// ─────────────────────────────────────────
files["tts.js"] = `const axios = require("axios");
const WebSocket = require("ws");
const config = require("./config");

const FRAME_BYTES = 160;
const FRAME_MS = 20;

function padUlaw(chunk) {
  if (chunk.length === FRAME_BYTES) return chunk;
  const p = Buffer.alloc(FRAME_BYTES, 0xff);
  chunk.copy(p);
  return p;
}

async function sendVoice(ws, streamSid, text, history, gate) {
  if (!streamSid || ws.readyState !== WebSocket.OPEN) return;
  console.log("🔊 TTS:", text.slice(0, 80));
  history.push({ role: "assistant", content: text });

  try {
    const { data } = await axios.post(
      \`https://api.elevenlabs.io/v1/text-to-speech/JBFqnCBsd6RMkjVDRZzb/stream?output_format=ulaw_8000\`,
      { text, model_id: "eleven_turbo_v2", voice_settings: { stability: 0.5, similarity_boost: 0.75 } },
      {
        headers: { "xi-api-key": config.elevenlabs.apiKey, "Content-Type": "application/json" },
        responseType: "arraybuffer",
        timeout: 60000,
      }
    );

    const buf = Buffer.from(data);
    if (!buf.length) { console.error("TTS: empty audio"); return; }

    gate.ignoreUntil = Date.now() + Math.ceil(buf.length / FRAME_BYTES) * FRAME_MS + 800;

    for (let i = 0; i < buf.length; i += FRAME_BYTES) {
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({
        event: "media",
        streamSid,
        media: { payload: padUlaw(buf.subarray(i, i + FRAME_BYTES)).toString("base64") },
      }));
      if (i + FRAME_BYTES < buf.length) await new Promise((r) => setTimeout(r, FRAME_MS));
    }
    console.log("🔊 TTS done");
  } catch (err) {
    console.error("TTS error:", err.message);
  }
}

module.exports = { sendVoice };
`;

// ─────────────────────────────────────────
// websocket.js
// ─────────────────────────────────────────
files["websocket.js"] = `const WebSocket = require("ws");
const { cypher } = require("./db");
const { upsertCaller } = require("./memory");
const { agentReply } = require("./agent");
const { sendVoice } = require("./tts");

const SYSTEM_PROMPT =
  "You are a helpful AI assistant on a phone call. " +
  "You have access to long-term graph memory, a company knowledge base, and live web search. " +
  "Answer from your own knowledge first. Use KB for company/product questions. " +
  "Keep answers to 2-4 spoken sentences. Never say you lack real-time data.";

function setupDeepgram(ws, state) {
  const dg = new WebSocket(
    "wss://api.deepgram.com/v1/listen?" +
    new URLSearchParams({
      encoding: "mulaw", sample_rate: "8000", model: "nova-2-phonecall",
      language: "en", interim_results: "true", endpointing: "700", smart_format: "true",
    }),
    { headers: { Authorization: \`Token \${process.env.DEEPGRAM_API_KEY}\` } }
  );

  dg.on("error", (e) => console.error("DG error:", e.message));
  dg.on("close", (c, r) => { if (c !== 1000) console.warn("DG closed:", c, r?.toString()); });

  dg.on("message", async (raw) => {
    let data;
    try { data = JSON.parse(raw); } catch { return; }
    const tx = data?.channel?.alternatives?.[0]?.transcript || "";
    if (!data.is_final || !tx.trim() || state.isProcessing || !state.greetingDone) return;
    if (Date.now() - state.lastTurnAt < 1000 || Date.now() < state.gate.ignoreUntil) return;

    console.log("🎤:", tx);
    state.isProcessing = true;
    try {
      if (state.history.length > 21) state.history.splice(1, state.history.length - 21);
      state.history.push({ role: "user", content: tx });
      const reply = await agentReply(state.history, state.callerPhone, state.callId);
      await sendVoice(ws, state.streamSid, reply, state.history, state.gate);
      state.lastTurnAt = Date.now();
    } finally {
      state.isProcessing = false;
    }
  });

  return dg;
}

function createWsServer() {
  const wss = new WebSocket.Server({ noServer: true });

  wss.on("connection", (ws) => {
    console.log("📞 WS connected");

    const state = {
      streamSid: null,
      callerPhone: null,
      callId: \`call_\${Date.now()}_\${Math.random().toString(36).slice(2, 8)}\`,
      greetingDone: false,
      isProcessing: false,
      lastTurnAt: 0,
      gate: { ignoreUntil: 0 },
      history: [{ role: "system", content: SYSTEM_PROMPT }],
      deepgramWs: null,
    };

    ws.on("message", async (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }

      switch (msg.event) {
        case "start": {
          state.streamSid = msg.start.streamSid;
          state.callerPhone = msg.start?.customParameters?.callerPhone || null;
          console.log(\`🆔 \${state.callId} | caller: \${state.callerPhone || "unknown"}\`);

          if (state.callerPhone) upsertCaller(state.callerPhone).catch(console.warn);
          state.deepgramWs = setupDeepgram(ws, state);

          const isReturning = state.callerPhone
            ? ((await cypher(
                \`MATCH (c:Caller { phone: $p })-[:HAS_MEMORY]->(m) RETURN count(m) AS n\`,
                { p: state.callerPhone }
              ))[0]?.get("n")?.toNumber() ?? 0) > 0
            : false;

          setTimeout(async () => {
            await sendVoice(
              ws, state.streamSid,
              isReturning
                ? "Welcome back! I remember our previous chats. What can I help you with?"
                : "Hello! I'm your AI assistant. Ask me anything!",
              state.history, state.gate
            ).catch((e) => console.error("Greeting error:", e.message));
            state.greetingDone = true;
          }, 1000);
          break;
        }
        case "media":
          if (state.deepgramWs?.readyState === WebSocket.OPEN)
            state.deepgramWs.send(Buffer.from(msg.media.payload, "base64"));
          break;
        case "stop":
          console.log("📵 Call ended:", state.callId);
          state.deepgramWs?.close();
          break;
      }
    });
  });

  return wss;
}

module.exports = { createWsServer };
`;

// ─────────────────────────────────────────
// routes.js
// ─────────────────────────────────────────
files["routes.js"] = `const express = require("express");
const multer = require("multer");
const path = require("path");
const pdfParse = require("pdf-parse");
const twilio = require("twilio");
const { cypher } = require("./db");
const { pushArticleToZendesk, saveKBDocument, chunkText } = require("./knowledge");
const { shouldSearch, tavilySearch } = require("./agent");
const config = require("./config");

const router = express.Router();
const twilioClient = twilio(config.twilio.accountSid, config.twilio.authToken);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    path.extname(file.originalname).toLowerCase() === ".pdf"
      ? cb(null, true)
      : cb(new Error("Only PDF files allowed"));
  },
});

// ── Twilio ──────────────────────────────
router.post("/call", async (req, res) => {
  const { phoneNumber } = req.body;
  if (!phoneNumber) return res.status(400).json({ error: "phoneNumber required" });
  try {
    const call = await twilioClient.calls.create({
      to: phoneNumber,
      from: config.twilio.phoneNumber,
      url: \`\${config.ngrokUrl}/api/twilio-answer\`,
      statusCallback: \`\${config.ngrokUrl}/api/twilio-status\`,
      statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
    });
    res.json({ success: true, sid: call.sid });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.all("/twilio-answer", (req, res) => {
  const host = config.ngrokUrl.replace("https://", "");
  res.type("text/xml").send(
    \`<Response><Connect><Stream url="wss://\${host}/media-stream"/></Connect></Response>\`
  );
});

router.post("/twilio-status", (req, res) => {
  console.log("📊 Status:", req.body.CallStatus, req.body.CallSid || "");
  res.sendStatus(200);
});

// ── PDF upload ──────────────────────────
router.post("/upload-pdf", upload.single("pdf"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No PDF provided" });
  const { subdomain, email, apiToken } = config.zendesk;
  if (!subdomain || !email || !apiToken)
    return res.status(503).json({ error: "Zendesk not configured" });

  try {
    const parsed = await pdfParse(req.file.buffer);
    const rawText = parsed.text?.trim();
    if (!rawText || rawText.length < 100)
      return res.status(422).json({ error: "No extractable text in PDF" });

    const docTitle = (req.body.title || path.basename(req.file.originalname, ".pdf"))
      .replace(/[-_]/g, " ").trim();
    const chunks = chunkText(rawText, 800);
    const articles = [];

    for (let i = 0; i < chunks.length; i++) {
      const title = chunks.length === 1 ? docTitle : \`\${docTitle} — Part \${i + 1} of \${chunks.length}\`;
      const article = await pushArticleToZendesk(title, chunks[i]);
      await saveKBDocument({ articleId: article.id, title: article.title, filename: req.file.originalname, chunkIndex: i, totalChunks: chunks.length });
      articles.push({ id: article.id, title: article.title, url: article.html_url });
    }

    res.json({ success: true, filename: req.file.originalname, chunks: chunks.length, articles });
  } catch (err) {
    res.status(500).json({ error: err.response?.data?.description || err.message });
  }
});

// ── Memory & graph ──────────────────────
router.get("/memory/:phone", async (req, res) => {
  const phone = decodeURIComponent(req.params.phone);
  const [memRecs, entRecs, kbRecs] = await Promise.all([
    cypher(\`MATCH (c:Caller { phone: $p })-[:HAS_MEMORY]->(m:Memory) RETURN m.text AS text, m.callId AS callId, m.source AS source ORDER BY m.timestamp DESC LIMIT 30\`, { p: phone }),
    cypher(\`MATCH (c:Caller { phone: $p })-[:MENTIONED]->(e:Entity) RETURN e.name AS name, e.type AS type\`, { p: phone }),
    cypher(\`MATCH (c:Caller { phone: $p })-[r:USED_KB_DOC]->(k:KBDocument) RETURN k.title AS title, k.filename AS filename, r.count AS count\`, { p: phone }),
  ]);
  res.json({
    phone,
    memories: memRecs.map((r) => ({ text: r.get("text"), callId: r.get("callId"), source: r.get("source") })),
    entities: entRecs.map((r) => ({ name: r.get("name"), type: r.get("type") })),
    kbDocs: kbRecs.map((r) => ({ title: r.get("title"), filename: r.get("filename"), count: r.get("count") })),
  });
});

router.delete("/memory/:phone", async (req, res) => {
  const phone = decodeURIComponent(req.params.phone);
  await cypher(\`MATCH (c:Caller { phone: $p })-[:HAS_MEMORY]->(m:Memory) DETACH DELETE m\`, { p: phone });
  res.json({ success: true, cleared: phone });
});

router.get("/graph", async (req, res) => {
  const recs = await cypher(
    \`MATCH (c:Caller)-[r]->(n)
     RETURN c.phone AS caller, type(r) AS rel, labels(n)[0] AS nodeType,
     CASE labels(n)[0] WHEN 'Memory' THEN n.text WHEN 'Entity' THEN n.name WHEN 'KBDocument' THEN n.title ELSE toString(n) END AS value
     LIMIT 200\`
  );
  res.json(recs.map((r) => ({ caller: r.get("caller"), rel: r.get("rel"), type: r.get("nodeType"), value: r.get("value") })));
});

router.get("/kb-documents", async (req, res) => {
  const recs = await cypher(
    \`MATCH (k:KBDocument) RETURN k.articleId AS articleId, k.title AS title, k.filename AS filename, k.chunkIndex AS chunkIndex, k.totalChunks AS totalChunks ORDER BY k.createdAt DESC LIMIT 100\`
  );
  res.json(recs.map((r) => ({ articleId: r.get("articleId"), title: r.get("title"), filename: r.get("filename"), chunkIndex: r.get("chunkIndex"), totalChunks: r.get("totalChunks") })));
});

router.get("/search", async (req, res) => {
  const { q } = req.query;
  if (!q) return res.status(400).json({ error: "q required" });
  const needed = await shouldSearch(q);
  const context = needed ? await tavilySearch(q) : null;
  res.json({ query: q, searchPerformed: needed, context });
});

module.exports = router;
`;

// ─────────────────────────────────────────
// server.js (new clean bootstrap)
// ─────────────────────────────────────────
files["server.js"] = `const express = require("express");
const { initGraphSchema } = require("./db");
const { createWsServer } = require("./websocket");
const routes = require("./routes");
const config = require("./config");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static("public"));
app.use("/api", routes);

const wss = createWsServer();

const server = app.listen(config.port, async () => {
  console.log(\`🚀 Port    : \${config.port}\`);
  console.log(\`🔗 Ngrok   : \${config.ngrokUrl}\`);
  console.log(\`🤖 OpenAI  : \${config.openai.apiKey ? "✅ " + config.openai.model : "❌ missing"}\`);
  console.log(\`🧠 Neo4j   : \${config.neo4j.uri || "❌ missing"}\`);
  console.log(\`📚 Zendesk : \${config.zendesk.subdomain || "❌ not configured"}\`);
  await initGraphSchema();
});

server.on("upgrade", (req, socket, head) => {
  if (req.url?.split("?")[0] === "/media-stream")
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  else socket.destroy();
});

process.on("SIGTERM", () => server.close(() => process.exit(0)));
process.on("SIGINT",  () => server.close(() => process.exit(0)));
`;

// ─────────────────────────────────────────
// Write all files
// ─────────────────────────────────────────
let created = 0;
for (const [filename, content] of Object.entries(files)) {
  fs.writeFileSync(path.join(process.cwd(), filename), content, "utf8");
  console.log("✅ Created:", filename);
  created++;
}

console.log("\n🎉 Done! " + created + " files created.");
console.log("\nNext steps:");
console.log("  mv server.js server.old.js   <- only if you haven't already");
console.log("  node server.js               <- test it");
