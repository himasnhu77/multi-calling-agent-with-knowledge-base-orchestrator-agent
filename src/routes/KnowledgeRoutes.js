const { Router }         = require("express");
const multer             = require("multer");
const path               = require("path");
const documentProcessor  = require("../knowledgebase/DocumentProcessor");
const zendeskService     = require("../knowledgebase/ZendeskService");
const searchAgent        = require("../agents/SearchAgent");
const config             = require("../config");
const Logger             = require("../utils/logger");

const log    = new Logger("KnowledgeRoutes");
const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    path.extname(file.originalname).toLowerCase() === ".pdf" ? cb(null, true) : cb(new Error("Only PDF files are allowed"));
  },
});

router.post("/upload-pdf", upload.single("pdf"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No PDF file provided" });
  const { subdomain, email, apiToken } = config.zendesk;
  if (!subdomain || !email || !apiToken) return res.status(503).json({ error: "Zendesk is not configured" });
  try {
    const result = await documentProcessor.processUpload(req.file.buffer, req.file.originalname, req.body.title);
    res.json({ success: true, ...result });
  } catch (err) {
    log.error("PDF upload failed:", err.message);
    res.status(err.message.includes("No extractable") ? 422 : 500).json({ error: err.response?.data?.description || err.message });
  }
});

router.get("/kb-documents", async (_req, res) => {
  try {
    const recs = await zendeskService.listKBDocuments();
    res.json(recs.map((r) => ({ articleId: r.get("articleId"), title: r.get("title"), filename: r.get("filename"), chunkIndex: r.get("chunkIndex"), totalChunks: r.get("totalChunks") })));
  } catch (err) { log.error("listKBDocuments failed:", err.message); res.status(500).json({ error: err.message }); }
});

router.get("/graph", async (_req, res) => {
  try {
    const recs = await zendeskService.getFullGraph();
    res.json(recs.map((r) => ({ caller: r.get("caller"), rel: r.get("rel"), type: r.get("nodeType"), value: r.get("value") })));
  } catch (err) { log.error("getFullGraph failed:", err.message); res.status(500).json({ error: err.message }); }
});

router.get("/search", async (req, res) => {
  const { q } = req.query;
  if (!q) return res.status(400).json({ error: "q query parameter is required" });
  try {
    const needed  = await searchAgent.shouldSearch(q);
    const context = needed ? await searchAgent.search(q) : null;
    res.json({ query: q, searchPerformed: needed, context });
  } catch (err) { log.error("search endpoint failed:", err.message); res.status(500).json({ error: err.message }); }
});

module.exports = router;
