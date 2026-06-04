require("dotenv").config();

const express    = require("express");
const http       = require("http");
const config     = require("./src/config");
const db         = require("./src/database/Neo4jClient");
const Logger     = require("./src/utils/logger");

const callRoutes      = require("./src/routes/CallRoutes");
const knowledgeRoutes = require("./src/routes/KnowledgeRoutes");
const memoryRoutes    = require("./src/routes/MemoryRoutes");

const WebSocketServer = require("./src/websocket/WebSocketServer");

const log = new Logger("Server");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static("public"));

app.use("/api", callRoutes);
app.use("/api", knowledgeRoutes);
app.use("/api", memoryRoutes);

const server   = http.createServer(app);
const wsServer = new WebSocketServer();

server.on("upgrade", (req, socket, head) => {
  const path = req.url?.split("?")[0];
  if (path === "/media-stream") {
    wsServer.handleUpgrade(req, socket, head);
  } else {
    socket.destroy();
  }
});

server.listen(config.port, async () => {
  log.info(`Listening on port ${config.port}`);
  log.info(`Ngrok URL  : ${config.ngrokUrl || "(not set)"}`);
  log.info(`OpenAI     : ${config.openai.apiKey ? `✅ ${config.openai.model}` : "❌ missing"}`);
  log.info(`Neo4j      : ${config.neo4j.uri    || "❌ missing"}`);
  log.info(`Zendesk    : ${config.zendesk.subdomain || "not configured"}`);
  await db.initSchema();
});

const shutdown = async (signal) => {
  log.info(`${signal} received — shutting down`);
  server.close(async () => {
    await db.close();
    process.exit(0);
  });
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT",  () => shutdown("SIGINT"));
