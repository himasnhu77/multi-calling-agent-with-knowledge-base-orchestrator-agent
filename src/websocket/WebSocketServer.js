const WebSocket   = require("ws");
const CallSession = require("./CallSession");
const Logger      = require("../utils/logger");

const log = new Logger("WebSocketServer");

class WebSocketServer {
  #wss;
  constructor() {
    this.#wss = new WebSocket.Server({ noServer: true });
    this.#wss.on("connection", this.#onConnection.bind(this));
    log.info("WebSocket server initialised");
  }

  handleUpgrade(req, socket, head) {
    this.#wss.handleUpgrade(req, socket, head, (ws) => this.#wss.emit("connection", ws, req));
  }

  #onConnection(ws) {
    log.info("Twilio WS connected");
    const session = new CallSession(ws);
    const cleanup = () => session.cleanup();
    ws.on("close", cleanup);
    ws.on("error", cleanup);
    ws.on("message", async (raw) => {
      let msg; try { msg = JSON.parse(raw); } catch { return; }
      switch (msg.event) {
        case "start":  await session.onStart(msg); break;
        case "media":  session.onMedia(msg);       break;
        case "mark":   session.onMark();           break;
        case "stop":   log.info(`Call ended (${session.callId})`); cleanup(); break;
        default:       log.debug("Unknown WS event:", msg.event);
      }
    });
  }
}

module.exports = WebSocketServer;
