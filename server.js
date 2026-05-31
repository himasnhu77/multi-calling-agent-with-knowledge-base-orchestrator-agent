const express = require("express");
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
  console.log(`🚀 Port    : ${config.port}`);
  console.log(`🔗 Ngrok   : ${config.ngrokUrl}`);
  console.log(`🤖 OpenAI  : ${config.openai.apiKey ? "✅ " + config.openai.model : "❌ missing"}`);
  console.log(`🧠 Neo4j   : ${config.neo4j.uri || "❌ missing"}`);
  console.log(`📚 Zendesk : ${config.zendesk.subdomain || "❌ not configured"}`);
  await initGraphSchema();
});

server.on("upgrade", (req, socket, head) => {
  if (req.url?.split("?")[0] === "/media-stream")
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  else socket.destroy();
});

process.on("SIGTERM", () => server.close(() => process.exit(0)));
process.on("SIGINT",  () => server.close(() => process.exit(0)));
