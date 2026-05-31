require("dotenv").config();

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
