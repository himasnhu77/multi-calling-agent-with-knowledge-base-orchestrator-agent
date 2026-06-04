const { Router }    = require("express");
const memoryService = require("../memory/MemoryService");
const Logger        = require("../utils/logger");

const log    = new Logger("MemoryRoutes");
const router = Router();

router.get("/memory/:phone", async (req, res) => {
  const phone = decodeURIComponent(req.params.phone);
  try {
    const [memRecs, entRecs, kbRecs] = await Promise.all([
      memoryService.getCallerMemories(phone),
      memoryService.getCallerEntities(phone),
      memoryService.getCallerKBDocs(phone),
    ]);
    res.json({
      phone,
      memories: memRecs.map((r) => ({ text: r.get("text"), callId: r.get("callId"), source: r.get("source") })),
      entities: entRecs.map((r) => ({ name: r.get("name"), type: r.get("type") })),
      kbDocs:   kbRecs.map((r)  => ({ title: r.get("title"), filename: r.get("filename"), count: r.get("count") })),
    });
  } catch (err) { log.error("getCallerMemories failed:", err.message); res.status(500).json({ error: err.message }); }
});

router.delete("/memory/:phone", async (req, res) => {
  const phone = decodeURIComponent(req.params.phone);
  try {
    await memoryService.clearCallerMemories(phone);
    res.json({ success: true, cleared: phone });
  } catch (err) { log.error("clearCallerMemories failed:", err.message); res.status(500).json({ error: err.message }); }
});

module.exports = router;
