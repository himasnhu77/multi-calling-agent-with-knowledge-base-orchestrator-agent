require("dotenv").config();

class AppConfig {
  constructor() {
    this.port     = parseInt(process.env.PORT || "3000", 10);
    this.ngrokUrl = process.env.NGROK_URL || "";

    this.openai = {
      apiKey:         process.env.OPENAI_API_KEY || "",
      model:          process.env.OPENAI_MODEL || "gpt-4o-mini",
      maxSpokenChars: 550,
    };
    this.neo4j = {
      uri:  process.env.NEO4J_URI  || "",
      user: process.env.NEO4J_USER || "neo4j",
      pass: process.env.NEO4J_PASS || "",
    };
    this.twilio = {
      accountSid:  process.env.TWILIO_ACCOUNT_SID  || "",
      authToken:   process.env.TWILIO_AUTH_TOKEN   || "",
      phoneNumber: process.env.TWILIO_PHONE_NUMBER || "",
    };
    this.deepgram   = { apiKey: process.env.DEEPGRAM_API_KEY || "" };
    this.elevenlabs = {
      apiKey:  process.env.ELEVEN_LABS_API_KEY  || "",
      voiceId: process.env.ELEVEN_LABS_VOICE_ID || "pNInz6obpgDQGcFmaJgB",
    };
    this.zendesk = {
      subdomain:   process.env.ZENDESK_SUBDOMAIN            || "",
      email:       process.env.ZENDESK_EMAIL                || "",
      apiToken:    process.env.ZENDESK_API_TOKEN            || "",
      sectionId:   process.env.ZENDESK_DEFAULT_SECTION_ID   || "",
      permGroupId: process.env.ZENDESK_PERMISSION_GROUP_ID  || "",
    };
    this.tavily = { apiKey: process.env.TAVILY_API_KEY || "" };
  }
}

module.exports = new AppConfig();
