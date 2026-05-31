const express = require("express");
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
      url: `${config.ngrokUrl}/api/twilio-answer`,
      statusCallback: `${config.ngrokUrl}/api/twilio-status`,
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
    `<Response><Connect><Stream url="wss://${host}/media-stream"/></Connect></Response>`
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
      const title = chunks.length === 1 ? docTitle : `${docTitle} — Part ${i + 1} of ${chunks.length}`;
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
    cypher(`MATCH (c:Caller { phone: $p })-[:HAS_MEMORY]->(m:Memory) RETURN m.text AS text, m.callId AS callId, m.source AS source ORDER BY m.timestamp DESC LIMIT 30`, { p: phone }),
    cypher(`MATCH (c:Caller { phone: $p })-[:MENTIONED]->(e:Entity) RETURN e.name AS name, e.type AS type`, { p: phone }),
    cypher(`MATCH (c:Caller { phone: $p })-[r:USED_KB_DOC]->(k:KBDocument) RETURN k.title AS title, k.filename AS filename, r.count AS count`, { p: phone }),
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
  await cypher(`MATCH (c:Caller { phone: $p })-[:HAS_MEMORY]->(m:Memory) DETACH DELETE m`, { p: phone });
  res.json({ success: true, cleared: phone });
});

router.get("/graph", async (req, res) => {
  const recs = await cypher(
    `MATCH (c:Caller)-[r]->(n)
     RETURN c.phone AS caller, type(r) AS rel, labels(n)[0] AS nodeType,
     CASE labels(n)[0] WHEN 'Memory' THEN n.text WHEN 'Entity' THEN n.name WHEN 'KBDocument' THEN n.title ELSE toString(n) END AS value
     LIMIT 200`
  );
  res.json(recs.map((r) => ({ caller: r.get("caller"), rel: r.get("rel"), type: r.get("nodeType"), value: r.get("value") })));
});

router.get("/kb-documents", async (req, res) => {
  const recs = await cypher(
    `MATCH (k:KBDocument) RETURN k.articleId AS articleId, k.title AS title, k.filename AS filename, k.chunkIndex AS chunkIndex, k.totalChunks AS totalChunks ORDER BY k.createdAt DESC LIMIT 100`
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
