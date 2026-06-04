const { Router } = require("express");
const twilioClient = require("../tools/TwilioClient");
const Logger       = require("../utils/logger");

const log    = new Logger("CallRoutes");
const router = Router();

router.post("/call", async (req, res) => {
  const { phoneNumber } = req.body;
  if (!phoneNumber) return res.status(400).json({ error: "phoneNumber is required" });
  try {
    const result = await twilioClient.makeCall(phoneNumber);
    res.json({ success: true, sid: result.sid });
  } catch (err) {
    log.error("makeCall failed:", err.message);
    res.status(500).json({ error: err.message });
  }
});

router.all("/twilio-answer", (req, res) => res.type("text/xml").send(twilioClient.buildAnswerTwiML()));

router.post("/twilio-status", (req, res) => {
  log.info(`Call status: ${req.body.CallStatus} | SID: ${req.body.CallSid || "-"}`);
  res.sendStatus(200);
});

module.exports = router;
