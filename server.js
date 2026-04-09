require("dotenv").config();
const express = require("express");
const twilio = require("twilio");
const axios = require("axios");
const WebSocket = require("ws");
const neo4j = require("neo4j-driver");
const multer = require("multer");
const pdfParse = require("pdf-parse");
const path = require("path");
const OpenAI = require("openai");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static("public"));

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// ============================================================
// OPENAI CLIENT
// ============================================================

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

const MAX_SPOKEN_CHARS = 550;

// ============================================================
// MULTER — PDF UPLOAD (memory storage, PDF only, 20 MB max)
// ============================================================

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    path.extname(file.originalname).toLowerCase() === ".pdf"
      ? cb(null, true)
      : cb(new Error("Only PDF files are allowed"));
  },
});

// ============================================================
// NEO4J AURA — GRAPH MEMORY
// ============================================================

let _neo4jDriver = null;

function getDriver() {
  if (!_neo4jDriver) {
    // Neo4j Aura connection URIs start with neo4j+s:// (encrypted)
    // Set NEO4J_URI to your Aura instance URI, e.g.:
    //   neo4j+s://<instance-id>.databases.neo4j.io
    const uri  = process.env.NEO4J_URI;
    const user = process.env.NEO4J_USER || "neo4j";
    const pass = process.env.NEO4J_PASS;

    if (!uri || !pass) {
      throw new Error(
        "NEO4J_URI and NEO4J_PASS must be set for Neo4j Aura. " +
        "Your Aura URI looks like: neo4j+s://<id>.databases.neo4j.io"
      );
    }

// AFTER (fixed)
_neo4jDriver = neo4j.driver(
  uri,
  neo4j.auth.basic(user, pass)
);
    console.log("🧠 Neo4j Aura driver →", uri);
  }
  return _neo4jDriver;
}

async function cypher(query, params = {}) {
  const session = getDriver().session();
  try {
    const result = await session.run(query, params);
    return result.records;
  } catch (err) {
    console.error("Neo4j cypher error:", err.message);
    return [];
  } finally {
    await session.close();
  }
}

async function initGraphSchema() {
  try {
    await cypher(`CREATE INDEX caller_phone IF NOT EXISTS FOR (c:Caller) ON (c.phone)`);
    await cypher(`CREATE INDEX entity_name  IF NOT EXISTS FOR (e:Entity) ON (e.name)`);
    await cypher(`CREATE INDEX kb_doc_id    IF NOT EXISTS FOR (k:KBDocument) ON (k.articleId)`);
    console.log("🧠 Neo4j Aura schema ready");
  } catch (err) {
    console.warn("Neo4j schema init:", err.message);
  }
}

async function upsertCaller(phone) {
  await cypher(
    `MERGE (c:Caller { phone: $phone })
     ON CREATE SET c.firstSeen = datetime(), c.lastSeen = datetime()
     ON MATCH  SET c.lastSeen  = datetime()`,
    { phone }
  );
}

// ============================================================
// NEO4J AURA — KB DOCUMENT GRAPH STORAGE
// ============================================================

async function saveKBDocument({ articleId, title, filename, chunkIndex, totalChunks }) {
  await cypher(
    `MERGE (k:KBDocument { articleId: $articleId })
     SET k.title = $title,
         k.filename = $filename,
         k.chunkIndex = $chunkIndex,
         k.totalChunks = $totalChunks,
         k.createdAt = datetime()`,
    { articleId: String(articleId), title, filename, chunkIndex, totalChunks }
  );
}

async function linkCallerToKBDoc(phone, articleId, question) {
  await cypher(
    `MATCH (c:Caller { phone: $phone })
     MATCH (k:KBDocument { articleId: $articleId })
     MERGE (c)-[r:USED_KB_DOC]->(k)
     ON CREATE SET r.firstUsed = datetime(), r.count = 1, r.sampleQuestion = $question
     ON MATCH  SET r.lastUsed  = datetime(), r.count = r.count + 1`,
    { phone, articleId: String(articleId), question }
  );
}

async function saveKBMemory(phone, callId, question, articleIds) {
  if (!articleIds.length) return;
  await cypher(
    `MATCH (c:Caller { phone: $phone })
     CREATE (m:Memory {
       text: $text,
       timestamp: datetime(),
       callId: $callId,
       source: 'zendesk_kb'
     })
     CREATE (c)-[:HAS_MEMORY]->(m)`,
    {
      phone,
      callId,
      text: `KB lookup: "${question}" → matched ${articleIds.length} article(s)`,
    }
  );
  for (const id of articleIds) {
    await linkCallerToKBDoc(phone, id, question).catch(e =>
      console.warn("linkCallerToKBDoc error:", e.message)
    );
  }
}

// ============================================================
// MEMORY — EXTRACT + SAVE + RECALL (now using OpenAI)
// ============================================================

async function extractMemory(userText, assistantText) {
  const prompt =
    `You are an entity extractor for a knowledge graph memory system.\n` +
    `Given this phone call exchange:\n` +
    `USER: ${userText}\n` +
    `ASSISTANT: ${assistantText}\n\n` +
    `Return ONLY valid JSON — no markdown, no extra text:\n` +
    `{\n` +
    `  "summary": "<one sentence capturing the key fact, preference, or info shared>",\n` +
    `  "entities": [\n` +
    `    { "name": "<canonical lowercase name>", "type": "<Person|Place|Topic|Preference|Fact>" }\n` +
    `  ]\n` +
    `}\n` +
    `If nothing memorable was said, return { "summary": "", "entities": [] }.`;

  try {
    const response = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
      max_tokens: 300,
      response_format: { type: "json_object" },
    });
    const raw = response.choices[0].message.content.trim();
    return JSON.parse(raw);
  } catch (err) {
    console.warn("Memory extraction skipped:", err.message);
    return { summary: "", entities: [] };
  }
}

async function saveMemory(phone, callId, userText, assistantText) {
  const { summary, entities } = await extractMemory(userText, assistantText);
  if (!summary) return;

  console.log(`🧠 Saving memory [${phone}]:`, summary);

  await cypher(
    `MATCH (c:Caller { phone: $phone })
     CREATE (m:Memory { text: $summary, timestamp: datetime(), callId: $callId, source: 'conversation' })
     CREATE (c)-[:HAS_MEMORY]->(m)`,
    { phone, summary, callId }
  );

  for (const ent of entities) {
    if (!ent.name?.trim()) continue;
    await cypher(
      `MATCH (c:Caller { phone: $phone })
       MERGE (e:Entity { name: $name }) ON CREATE SET e.type = $type
       MERGE (c)-[:MENTIONED]->(e)
       WITH c, e
       MATCH (m:Memory { callId: $callId }) WHERE (c)-[:HAS_MEMORY]->(m)
       MERGE (m)-[:INVOLVES]->(e)`,
      { phone, name: ent.name.toLowerCase(), type: ent.type || "Topic", callId }
    );
  }
}

async function recallMemory(phone) {
  const [memRecs, entRecs, kbRecs] = await Promise.all([
    cypher(
      `MATCH (c:Caller { phone: $phone })-[:HAS_MEMORY]->(m:Memory)
       RETURN m.text AS text ORDER BY m.timestamp DESC LIMIT 12`,
      { phone }
    ),
    cypher(
      `MATCH (c:Caller { phone: $phone })-[:MENTIONED]->(e:Entity)
       RETURN e.name AS name, e.type AS type LIMIT 25`,
      { phone }
    ),
    cypher(
      `MATCH (c:Caller { phone: $phone })-[:USED_KB_DOC]->(k:KBDocument)
       RETURN k.title AS title, k.filename AS filename ORDER BY k.createdAt DESC LIMIT 5`,
      { phone }
    ),
  ]);

  const memories = memRecs.map(r => r.get("text")).filter(Boolean);
  const entities = entRecs.map(r => `${r.get("name")} (${r.get("type")})`).filter(Boolean);
  const kbDocs   = kbRecs.map(r => r.get("title")).filter(Boolean);

  if (!memories.length && !entities.length && !kbDocs.length) return null;

  let ctx = "=== Caller long-term memory (from knowledge graph) ===\n";
  if (entities.length) ctx += `Known interests/entities: ${entities.join(", ")}\n`;
  if (kbDocs.length)   ctx += `Previously accessed KB docs: ${kbDocs.join(", ")}\n`;
  if (memories.length) {
    ctx += "Recent conversation memories (newest first):\n";
    memories.forEach((m, i) => { ctx += `  ${i + 1}. ${m}\n`; });
  }
  ctx += "=== Use this to personalise your response ===";
  return ctx;
}

// ============================================================
// ZENDESK KB — FETCH ARTICLES FOR VOICE AI
// ============================================================

async function fetchZendeskArticles(query) {
  if (!process.env.ZENDESK_SUBDOMAIN || !process.env.ZENDESK_API_TOKEN) return null;
  try {
    const res = await axios.get(
      `https://${process.env.ZENDESK_SUBDOMAIN}.zendesk.com/api/v2/help_center/articles/search`,
      {
        params: { query, per_page: 3, locale: "en-us" },
        auth: {
          username: `${process.env.ZENDESK_EMAIL}/token`,
          password: process.env.ZENDESK_API_TOKEN,
        },
        timeout: 8000,
      }
    );
    const articles = res.data.results?.slice(0, 3) || [];
    if (!articles.length) return { ctx: null, articleIds: [] };

    console.log(`📚 Zendesk KB: ${articles.length} article(s) for "${query}"`);

    const ctx =
      `=== Zendesk Knowledge Base ===\n` +
      articles.map(a => `- ${a.title}: ${a.snippet}`).join("\n") +
      `\n=== Prefer KB answers for product/policy questions ===`;

    return { ctx, articleIds: articles.map(a => String(a.id)) };
  } catch (err) {
    console.warn("Zendesk KB error:", err.message);
    return { ctx: null, articleIds: [] };
  }
}

// ============================================================
// ZENDESK KB — PUSH PDF CHUNKS AS ARTICLES
// ============================================================

function chunkText(text, chunkSize = 800) {
  const paragraphs = text.split(/\n\s*\n/).filter(p => p.trim().length > 50);
  const chunks = [];
  let current = "";

  for (const para of paragraphs) {
    const words = (current + " " + para).trim().split(/\s+/).length;
    if (words > chunkSize && current) {
      chunks.push(current.trim());
      current = para;
    } else {
      current = current ? current + "\n\n" + para : para;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.length ? chunks : [text.trim()];
}

async function pushArticleToZendesk(title, body) {
  const sectionId    = process.env.ZENDESK_DEFAULT_SECTION_ID;
  const permGroupId  = process.env.ZENDESK_PERMISSION_GROUP_ID;

  const payload = {
    article: {
      title,
      body: `<p>${body.replace(/\n/g, "</p><p>")}</p>`,
      locale: "en-us",
      ...(permGroupId && { permission_group_id: parseInt(permGroupId) }),
      user_segment_id: null,
    },
  };

  const url = sectionId
    ? `https://${process.env.ZENDESK_SUBDOMAIN}.zendesk.com/api/v2/help_center/sections/${sectionId}/articles`
    : `https://${process.env.ZENDESK_SUBDOMAIN}.zendesk.com/api/v2/help_center/articles`;

  const res = await axios.post(url, payload, {
    auth: {
      username: `${process.env.ZENDESK_EMAIL}/token`,
      password: process.env.ZENDESK_API_TOKEN,
    },
    headers: { "Content-Type": "application/json" },
    timeout: 15000,
  });

  return res.data.article;
}

// ============================================================
// PDF UPLOAD ENDPOINT
// ============================================================

app.post("/api/upload-pdf", upload.single("pdf"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No PDF file provided" });

  const zendeskReady =
    process.env.ZENDESK_SUBDOMAIN &&
    process.env.ZENDESK_EMAIL &&
    process.env.ZENDESK_API_TOKEN;

  if (!zendeskReady) {
    return res.status(503).json({
      error: "Zendesk is not configured. Set ZENDESK_SUBDOMAIN, ZENDESK_EMAIL, ZENDESK_API_TOKEN in .env",
    });
  }

  try {
    console.log(`📄 Processing: ${req.file.originalname} (${(req.file.size / 1024).toFixed(1)} KB)`);

    const parsed = await pdfParse(req.file.buffer);
    const rawText = parsed.text?.trim();

    if (!rawText || rawText.length < 100) {
      return res.status(422).json({
        error: "PDF has no extractable text. Please upload a text-based PDF (not a scanned image).",
      });
    }

    const docTitle = (req.body.title || path.basename(req.file.originalname, ".pdf"))
      .replace(/[-_]/g, " ")
      .trim();

    const chunks = chunkText(rawText, 800);
    console.log(`📄 Split "${docTitle}" into ${chunks.length} chunk(s)`);

    const articles = [];

    for (let i = 0; i < chunks.length; i++) {
      const articleTitle =
        chunks.length === 1 ? docTitle : `${docTitle} — Part ${i + 1} of ${chunks.length}`;

      const article = await pushArticleToZendesk(articleTitle, chunks[i]);

      await saveKBDocument({
        articleId:   article.id,
        title:       article.title,
        filename:    req.file.originalname,
        chunkIndex:  i,
        totalChunks: chunks.length,
      });

      articles.push({
        id:    article.id,
        title: article.title,
        url:   article.html_url,
      });

      console.log(`✅ Article created [${i + 1}/${chunks.length}]: ${articleTitle}`);
    }

    res.json({
      success:  true,
      filename: req.file.originalname,
      pages:    parsed.numpages,
      chunks:   chunks.length,
      articles,
    });
  } catch (err) {
    console.error("PDF upload error:", err.response?.data || err.message);
    res.status(500).json({
      error: err.response?.data?.description || err.message,
    });
  }
});

// ============================================================
// SMART SEARCH GUARDRAILS
// ============================================================

const NEVER_SEARCH_PATTERNS = [
  /^(hi|hello|hey|thanks|thank you|bye|goodbye|ok|okay|yes|no|sure|great|good|help me|what can you do)\b/i,
  /\b(explain|define|what is a|how does|tell me about)\b.{0,50}\b(physics|chemistry|biology|math|algebra|calculus|gravity|evolution|atom|molecule|dna|cell|photosynthesis|relativity|quantum)\b/i,
  /\b(history of|who was|who were|when was|what happened in|founded|invented|discovered|born in|died in)\b.{0,60}\b(ancient|medieval|world war|revolution|empire|century|bc\b|ad\b|\b1[0-9]{3}\b|\b20[01][0-9]\b)\b/i,
  /\b(recipe|how to cook|how to make|how to bake|how to prepare|ingredients for|what goes in)\b/i,
  /\b(translate|meaning of|what does .{1,30} mean|synonym|antonym|grammar|how to spell|pronunciation of)\b/i,
  /\b(how to (code|program|write|implement)|what is (a )?(function|class|variable|loop|array|api|rest|sql|json|database|algorithm|recursion))\b/i,
  /\b(capital of|flag of|currency of|language spoken in|largest country|smallest country|who invented|who wrote|who painted|how many (planets|continents|oceans))\b/i,
  /^[\d\s\+\-\*\/\^\(\)\.]+[=\?]?\s*$/,
];

async function openaiNeedsSearch(query) {
  const prompt =
    `You are a routing classifier. A user on a phone call asked:\n"${query}"\n\n` +
    `Does answering this accurately require LIVE or REAL-TIME information?\n` +
    `Live data examples: today's weather, current news, live sports scores, ` +
    `stock prices, events after 2024, who currently holds a position, today's date.\n\n` +
    `Reply with ONLY one word — YES or NO.\n` +
    `YES = live data is needed.\n` +
    `NO  = your training knowledge is fully sufficient.`;

  try {
    const response = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
      max_tokens: 5,
    });
    const answer = (response.choices[0].message.content || "").trim().toUpperCase();
    console.log(`🤔 Search classifier → ${answer}`);
    return answer.startsWith("YES");
  } catch (err) {
    console.warn("Search classifier error (defaulting NO):", err.message);
    return false;
  }
}

async function shouldSearch(query) {
  if (!query?.trim()) return false;
  if (!process.env.TAVILY_API_KEY) return false;
  if (NEVER_SEARCH_PATTERNS.some(r => r.test(query))) {
    console.log("🚫 Search skipped — Gate 1 (timeless topic)");
    return false;
  }
  return openaiNeedsSearch(query);
}

// ============================================================
// TAVILY SEARCH
// ============================================================

async function tavilySearch(query) {
  if (!process.env.TAVILY_API_KEY) return null;
  try {
    console.log("🔍 Tavily:", query);
    const { data } = await axios.post(
      "https://api.tavily.com/search",
      {
        api_key:        process.env.TAVILY_API_KEY,
        query,
        max_results:    5,
        search_depth:   "basic",
        include_answer: true,
      },
      { timeout: 10000 }
    );

    const snippets = [];
    if (data.answer) snippets.push(`[Direct Answer] ${data.answer}`);
    (data.results || []).slice(0, 4).forEach(r => {
      if (r.content) snippets.push(`[Web] ${r.title || ""}: ${r.content.slice(0, 300)}`);
    });

    if (!snippets.length) return null;
    const ctx = `Live web search for "${query}":\n` + snippets.join("\n");
    console.log("🔍 Preview:", ctx.slice(0, 200) + "…");
    return ctx;
  } catch (err) {
    console.error("Tavily error:", err.response ? JSON.stringify(err.response.data) : err.message);
    return null;
  }
}

// ============================================================
// OPENAI CHAT (replaces askOllama)
// ============================================================

async function askOpenAI(history, searchCtx, memoryCtx, zendeskCtx) {
  try {
    // Build system message with optional context injected
    let systemContent = history[0].content;
    if (memoryCtx)  systemContent += "\n\n" + memoryCtx;
    if (zendeskCtx) systemContent += "\n\n" + zendeskCtx;

    const base = [{ role: "system", content: systemContent }, ...history.slice(1)];

    const messages = searchCtx
      ? [
          ...base.slice(0, -1),
          {
            role: "user",
            content:
              `${base[base.length - 1].content}\n\n` +
              `--- Live search results ---\n${searchCtx}\n--- End ---\n\n` +
              `Use these results to answer accurately. Keep it to 2–4 spoken sentences.`,
          },
        ]
      : base;

    const response = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      messages,
      temperature: 0.7,
      max_tokens: 200,
    });

    let text = (response.choices[0].message.content || "").trim();
    if (text.length > MAX_SPOKEN_CHARS) {
      text = text.slice(0, MAX_SPOKEN_CHARS).trim() + " …I'll keep it brief. Want more detail?";
    }
    return text;
  } catch (err) {
    console.error("OpenAI error:", err.message);
    return "Sorry, something went wrong on my end.";
  }
}

// ============================================================
// MAIN AGENT — memory + KB + web + LLM all wired together
// ============================================================

async function agentReply(history, callerPhone, callId) {
  const lastUser = [...history].reverse().find(m => m.role === "user");
  const query    = lastUser?.content || "";

  const [memoryCtx, needsWeb, zendeskResult] = await Promise.all([
    callerPhone ? recallMemory(callerPhone) : Promise.resolve(null),
    shouldSearch(query),
    fetchZendeskArticles(query),
  ]);

  const { ctx: zendeskCtx, articleIds = [] } = zendeskResult || {};

  const searchCtx = needsWeb ? await tavilySearch(query) : null;

  if (memoryCtx)  console.log("🧠 Memory recalled for", callerPhone);
  if (zendeskCtx) console.log("📚 Zendesk KB context injected");
  if (searchCtx)  console.log("🌐 Web context injected");
  if (!needsWeb)  console.log("💡 Answering from OpenAI knowledge (Tavily skipped)");

  const reply = await askOpenAI(history, searchCtx, memoryCtx, zendeskCtx);

  if (callerPhone && query && reply) {
    saveMemory(callerPhone, callId, query, reply).catch(e =>
      console.warn("saveMemory error:", e.message)
    );
    if (articleIds.length) {
      saveKBMemory(callerPhone, callId, query, articleIds).catch(e =>
        console.warn("saveKBMemory error:", e.message)
      );
    }
  }

  return reply;
}

// ============================================================
// TWILIO REST
// ============================================================

app.post("/api/call", async (req, res) => {
  const { phoneNumber } = req.body;
  if (!phoneNumber) return res.status(400).json({ error: "phoneNumber required" });
  try {
    const call = await twilioClient.calls.create({
      to:   phoneNumber,
      from: process.env.TWILIO_PHONE_NUMBER,
      url:  `${process.env.NGROK_URL}/api/twilio-answer`,
      statusCallback:      `${process.env.NGROK_URL}/api/twilio-status`,
      statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
    });
    console.log("📞 Call:", call.sid);
    res.json({ success: true, sid: call.sid });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.all("/api/twilio-answer", (req, res) => {
  const host        = process.env.NGROK_URL.replace("https://", "");
  const callerPhone = req.body.From || req.query.From || "";
  res.type("text/xml").send(
    `<Response><Connect><Stream url="wss://${host}/media-stream">` +
    `<Parameter name="callerPhone" value="${callerPhone}"/>` +
    `</Stream></Connect></Response>`
  );
});

app.post("/api/twilio-status", (req, res) => {
  const status = req.body.CallStatus || req.query.CallStatus;
  const sid    = req.body.CallSid    || req.query.CallSid;
  if (status) console.log("📊 Status:", status, sid || "");
  res.sendStatus(200);
});

// ============================================================
// REST — MEMORY & GRAPH INSPECTION
// ============================================================

app.get("/api/memory/:phone", async (req, res) => {
  const phone = decodeURIComponent(req.params.phone);
  const [memRecs, entRecs, kbRecs] = await Promise.all([
    cypher(
      `MATCH (c:Caller { phone: $p })-[:HAS_MEMORY]->(m:Memory)
       RETURN m.text AS text, m.timestamp AS ts, m.callId AS callId, m.source AS source
       ORDER BY m.timestamp DESC LIMIT 30`,
      { p: phone }
    ),
    cypher(
      `MATCH (c:Caller { phone: $p })-[:MENTIONED]->(e:Entity)
       RETURN e.name AS name, e.type AS type`,
      { p: phone }
    ),
    cypher(
      `MATCH (c:Caller { phone: $p })-[r:USED_KB_DOC]->(k:KBDocument)
       RETURN k.title AS title, k.filename AS filename, r.count AS count, r.sampleQuestion AS question
       ORDER BY r.count DESC`,
      { p: phone }
    ),
  ]);
  res.json({
    phone,
    memories: memRecs.map(r => ({
      text:   r.get("text"),
      callId: r.get("callId"),
      source: r.get("source"),
    })),
    entities: entRecs.map(r => ({ name: r.get("name"), type: r.get("type") })),
    kbDocs:   kbRecs.map(r => ({
      title:    r.get("title"),
      filename: r.get("filename"),
      count:    r.get("count"),
      question: r.get("question"),
    })),
  });
});

app.delete("/api/memory/:phone", async (req, res) => {
  const phone = decodeURIComponent(req.params.phone);
  await cypher(
    `MATCH (c:Caller { phone: $p })-[:HAS_MEMORY]->(m:Memory) DETACH DELETE m`,
    { p: phone }
  );
  res.json({ success: true, cleared: phone });
});

app.get("/api/graph", async (req, res) => {
  const recs = await cypher(
    `MATCH (c:Caller)-[r]->(n)
     RETURN c.phone AS caller, type(r) AS rel,
            labels(n)[0] AS nodeType,
            CASE labels(n)[0]
              WHEN 'Memory'     THEN n.text
              WHEN 'Entity'     THEN n.name
              WHEN 'KBDocument' THEN n.title
              ELSE toString(n)
            END AS value
     LIMIT 200`
  );
  res.json(recs.map(r => ({
    caller: r.get("caller"),
    rel:    r.get("rel"),
    type:   r.get("nodeType"),
    value:  r.get("value"),
  })));
});

app.get("/api/kb-documents", async (req, res) => {
  const recs = await cypher(
    `MATCH (k:KBDocument)
     RETURN k.articleId AS articleId, k.title AS title,
            k.filename AS filename, k.chunkIndex AS chunkIndex,
            k.totalChunks AS totalChunks, k.createdAt AS createdAt
     ORDER BY k.createdAt DESC LIMIT 100`
  );
  res.json(recs.map(r => ({
    articleId:   r.get("articleId"),
    title:       r.get("title"),
    filename:    r.get("filename"),
    chunkIndex:  r.get("chunkIndex"),
    totalChunks: r.get("totalChunks"),
  })));
});

app.get("/api/search", async (req, res) => {
  const { q } = req.query;
  if (!q) return res.status(400).json({ error: "q required" });
  const needed  = await shouldSearch(q);
  const context = needed ? await tavilySearch(q) : null;
  res.json({ query: q, searchPerformed: needed, context });
});

// ============================================================
// TTS — ElevenLabs μ-law
// ============================================================

const ULAW_FRAME_BYTES = 160;
const ULAW_FRAME_MS   = 20;

function padUlaw(chunk) {
  if (chunk.length === ULAW_FRAME_BYTES) return chunk;
  const p = Buffer.alloc(ULAW_FRAME_BYTES, 0xff);
  chunk.copy(p);
  return p;
}

async function sendVoice(ws, streamSid, text, history, gate) {
  try {
    if (!streamSid || ws.readyState !== WebSocket.OPEN) return;
    console.log("🔊 TTS:", text.slice(0, 80) + "…");
    history.push({ role: "assistant", content: text });

    const { data } = await axios.post(
      `https://api.elevenlabs.io/v1/text-to-speech/JBFqnCBsd6RMkjVDRZzb/stream?output_format=ulaw_8000`,
      {
        text,
        model_id: "eleven_turbo_v2",
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
      },
      {
        headers: {
          "xi-api-key":   process.env.ELEVEN_LABS_API_KEY,
          "Content-Type": "application/json",
        },
        responseType: "arraybuffer",
        timeout:      60000,
      }
    );

    const buf = Buffer.from(data);
    if (!buf.length) { console.error("TTS: empty audio"); return; }

    gate.ignoreUntil =
      Date.now() + Math.ceil(buf.length / ULAW_FRAME_BYTES) * ULAW_FRAME_MS + 800;

    for (let i = 0; i < buf.length; i += ULAW_FRAME_BYTES) {
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({
        event: "media",
        streamSid,
        media: { payload: padUlaw(buf.subarray(i, i + ULAW_FRAME_BYTES)).toString("base64") },
      }));
      if (i + ULAW_FRAME_BYTES < buf.length)
        await new Promise(r => setTimeout(r, ULAW_FRAME_MS));
    }
    console.log("🔊 TTS done");
  } catch (err) {
    console.error("TTS error:", err.response
      ? (Buffer.isBuffer(err.response.data)
          ? err.response.data.toString()
          : JSON.stringify(err.response.data))
      : err.message);
  }
}

// ============================================================
// WEBSOCKET
// ============================================================

const wss = new WebSocket.Server({ noServer: true });

wss.on("connection", (ws) => {
  console.log("📞 WS connected");

  let streamSid    = null;
  let deepgramWs   = null;
  let isProcessing = false;
  let greetingDone = false;
  let lastTurnAt   = 0;
  let callerPhone  = null;
  const callId     = `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const gate       = { ignoreUntil: 0 };
  const COOLDOWN   = 1000;

  const history = [
    {
      role: "system",
      content:
        "You are a helpful AI assistant on a phone call. " +
        "You have access to long-term graph memory about this caller, " +
        "a company knowledge base (Zendesk KB), and occasionally live web search results. " +
        "Always answer from your own knowledge first. " +
        "Use KB articles when they are explicitly provided — they are the most authoritative source for company/product questions. " +
        "Use memory to personalise answers and reference past conversations when relevant. " +
        "Keep answers to 2–4 spoken sentences. Never say you lack real-time data.",
    },
  ];

  function setupDeepgram() {
    const dg = new WebSocket(
      "wss://api.deepgram.com/v1/listen?" +
        new URLSearchParams({
          encoding:        "mulaw",
          sample_rate:     "8000",
          model:           "nova-2-phonecall",
          language:        "en",
          interim_results: "true",
          endpointing:     "700",
          smart_format:    "true",
        }),
      { headers: { Authorization: `Token ${process.env.DEEPGRAM_API_KEY}` } }
    );

    dg.on("error", e => console.error("DG error:", e.message));
    dg.on("close",  (c, r) => {
      if (c !== 1000) console.warn("DG closed:", c, r?.toString());
    });

    dg.on("message", async raw => {
      let data;
      try { data = JSON.parse(raw); } catch { return; }
      const tx = data?.channel?.alternatives?.[0]?.transcript || "";
      if (!data.is_final || !tx.trim() || isProcessing || !greetingDone) return;
      if (Date.now() - lastTurnAt < COOLDOWN || Date.now() < gate.ignoreUntil) return;

      console.log("🎤:", tx);
      isProcessing = true;
      try {
        if (history.length > 21) history.splice(1, history.length - 21);
        history.push({ role: "user", content: tx });
        const reply = await agentReply(history, callerPhone, callId);
        await sendVoice(ws, streamSid, reply, history, gate);
        lastTurnAt = Date.now();
      } finally {
        isProcessing = false;
      }
    });

    return dg;
  }

  ws.on("message", async raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.event) {
      case "start": {
        streamSid   = msg.start.streamSid;
        callerPhone = msg.start?.customParameters?.callerPhone || null;

        console.log(`🆔 callId: ${callId} | caller: ${callerPhone || "unknown"}`);
        if (callerPhone) upsertCaller(callerPhone).catch(console.warn);

        deepgramWs   = setupDeepgram();
        greetingDone = false;

        const isReturning = callerPhone
          ? ((await cypher(
              `MATCH (c:Caller { phone: $p })-[:HAS_MEMORY]->(m) RETURN count(m) AS n`,
              { p: callerPhone }
            ))[0]?.get("n")?.toNumber() ?? 0) > 0
          : false;

        setTimeout(async () => {
          try {
            await sendVoice(
              ws, streamSid,
              isReturning
                ? "Welcome back! I remember our previous chats. What can I help you with today?"
                : "Hello! I'm your AI assistant with a knowledge base, live web search, and memory. Ask me anything!",
              history, gate
            );
          } catch (e) {
            console.error("Greeting error:", e.message);
          } finally {
            greetingDone = true;
            console.log("✅ Greeting done");
          }
        }, 1000);
        break;
      }

      case "media":
        if (deepgramWs?.readyState === WebSocket.OPEN)
          deepgramWs.send(Buffer.from(msg.media.payload, "base64"));
        break;

      case "stop":
        console.log("📵 Call ended:", callId);
        deepgramWs?.close();
        break;
    }
  });
});

// ============================================================
// START SERVER
// ============================================================

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, async () => {
  console.log(`🚀  Port      : ${PORT}`);
  console.log(`🔗  Ngrok     : ${process.env.NGROK_URL}`);
  console.log(`🤖  OpenAI    : ${process.env.OPENAI_API_KEY   ? "✅ " + OPENAI_MODEL  : "❌ missing OPENAI_API_KEY"}`);
  console.log(`🔍  Tavily    : ${process.env.TAVILY_API_KEY   ? "✅"                  : "❌ missing"}`);
  console.log(`🧠  Neo4j     : ${process.env.NEO4J_URI        || "❌ missing NEO4J_URI (Aura)"}`);
  console.log(`📚  Zendesk   : ${process.env.ZENDESK_SUBDOMAIN ? "✅ " + process.env.ZENDESK_SUBDOMAIN : "❌ not configured"}`);
  await initGraphSchema();
});

server.on("upgrade", (req, socket, head) => {
  if (req.url?.split("?")[0] === "/media-stream") {
    wss.handleUpgrade(req, socket, head, ws => wss.emit("connection", ws, req));
  } else {
    socket.destroy();
  }
});