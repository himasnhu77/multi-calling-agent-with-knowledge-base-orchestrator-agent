# 🤖 Multi-Calling Agent with Knowledge Base — Refactored Architecture

> **Branch:** `refactor/class-based-architecture`
> A production-grade, class-based refactor of the original flat-file server into a clean `src/` folder structure with proper encapsulation, singletons, and separation of concerns.

---

## 📁 Folder Structure

```
├── server.js                          # Lean bootstrap — mounts routes, starts HTTP + WS
└── src/
    ├── config/
    │   └── index.js                   # AppConfig singleton (all env vars in one place)
    ├── utils/
    │   ├── logger.js                  # Logger class (prefix-based, swappable)
    │   └── textCleaner.js             # TextCleaner (static helpers for TTS-safe text)
    ├── database/
    │   └── Neo4jClient.js             # Neo4jClient class (driver, cypher, schema init)
    ├── memory/
    │   └── MemoryService.js           # MemoryService class (save, recall, CRUD)
    ├── knowledgebase/
    │   ├── ZendeskService.js          # ZendeskService class (search, push, graph ops)
    │   └── DocumentProcessor.js       # DocumentProcessor class (PDF → chunks → Zendesk)
    ├── agents/
    │   ├── OrchestratorAgent.js       # OrchestratorAgent class (fan-out → LLM → reply)
    │   └── SearchAgent.js             # SearchAgent class (intent detection + Tavily + cache)
    ├── tools/
    │   ├── TTSService.js              # TTSService class (ElevenLabs → μ-law → Twilio)
    │   └── TwilioClient.js            # TwilioClient class (makeCall, buildTwiML)
    ├── websocket/
    │   ├── CallSession.js             # CallSession class (per-call state machine)
    │   └── WebSocketServer.js         # WebSocketServer class (upgrade handler)
    └── routes/
        ├── CallRoutes.js              # POST /call, /twilio-answer, /twilio-status
        ├── KnowledgeRoutes.js         # /upload-pdf, /kb-documents, /graph, /search
        └── MemoryRoutes.js            # GET/DELETE /memory/:phone
```

---

## 🏛️ Architecture Overview

```
Twilio (phone call)
      │
      ▼
WebSocketServer          ← handles WS upgrade from HTTP server
      │
      ▼
CallSession              ← owns all per-call state (one instance per call)
  ├── Deepgram WS        ← Speech-to-Text (STT)
  ├── history[]          ← conversation history
  └── gate{}             ← barge-in prevention

      │  (transcript ready)
      ▼
OrchestratorAgent        ← pure logic, no I/O, fully testable
  ├── MemoryService      ← recalls caller's past memories from Neo4j
  ├── ZendeskService     ← fetches KB articles for product/policy questions
  └── SearchAgent        ← Tavily live web search (only when needed)
      │
      ▼
  OpenAI GPT-4o-mini     ← generates spoken reply
      │
      ▼
TTSService               ← ElevenLabs → μ-law audio frames → Twilio WS
```

---

## 🧱 Class Breakdown

### `src/config/index.js` — `AppConfig`
Central singleton that reads all environment variables once at startup.
```js
const config = require('./src/config');
config.openai.model      // "gpt-4o-mini"
config.neo4j.uri         // NEO4J_URI
config.elevenlabs.voiceId
```

---

### `src/utils/logger.js` — `Logger`
Prefix-based logger with private fields. Swap to `winston` later by editing just this file.
```js
const Logger = require('./src/utils/logger');
const log = new Logger('MyModule');
log.info('Server started');
log.warn('Something off');
log.error('Crashed:', err.message);
log.debug('Only shown if DEBUG=true');
```

---

### `src/utils/textCleaner.js` — `TextCleaner`
Static helpers to strip markdown and truncate text for TTS output.
```js
TextCleaner.forSpeech('**Hello** world')  // "Hello world"
TextCleaner.truncate(longText, 550)       // cuts at word boundary + "… Want more detail?"
```

---

### `src/database/Neo4jClient.js` — `Neo4jClient`
Singleton Neo4j driver. Lazy-connects on first use.
```js
const db = require('./src/database/Neo4jClient');
const records = await db.cypher('MATCH (c:Caller) RETURN c LIMIT 10');
await db.initSchema();   // creates indexes on startup
await db.close();        // called on SIGTERM
```

---

### `src/memory/MemoryService.js` — `MemoryService`
Saves and recalls per-caller memories and entities in Neo4j using OpenAI for extraction.
```js
await memoryService.upsertCaller('+911234567890');
await memoryService.saveMemory(phone, callId, userText, assistantText);
const ctx = await memoryService.recallMemory(phone);  // returns formatted string or null
await memoryService.clearCallerMemories(phone);
```

---

### `src/knowledgebase/ZendeskService.js` — `ZendeskService`
Searches Zendesk Help Center and pushes new articles. Also links callers to KB docs in Neo4j.
```js
const { ctx, articleIds } = await zendeskService.fetchArticles('refund policy');
const article = await zendeskService.pushArticle('Title', 'Body text');
await zendeskService.saveKBMemory(phone, callId, question, articleIds);
```

---

### `src/knowledgebase/DocumentProcessor.js` — `DocumentProcessor`
Parses uploaded PDFs, splits into ~800-word chunks, pushes each chunk as a Zendesk article.
```js
const result = await documentProcessor.processUpload(buffer, 'manual.pdf', 'Product Manual');
// { filename, chunks: 3, articles: [{ id, title, url }] }
```

---

### `src/agents/SearchAgent.js` — `SearchAgent`
Intent detection + Tavily web search with 5-minute in-memory cache. Only searches when needed.
```js
const ctx = await searchAgent.searchIfNeeded('latest AI news today');
// Returns null for static questions like "what is gravity"
// Returns live search results for time-sensitive queries
```

---

### `src/agents/OrchestratorAgent.js` — `OrchestratorAgent`
Fan-out orchestrator — runs memory recall, KB lookup, and web search in parallel, then calls OpenAI.
```js
const reply = await orchestrator.reply(history, callerPhone, callId);
// Pure logic — no WebSocket, no audio, fully unit-testable
```

---

### `src/tools/TTSService.js` — `TTSService`
Fetches μ-law audio from ElevenLabs and streams it frame-by-frame (20ms frames) to Twilio.
```js
await ttsService.sendVoice(ws, streamSid, text, history, gate);
ttsService.cleanupStream(streamSid);  // call on session end
```

---

### `src/tools/TwilioClient.js` — `TwilioClient`
Makes outbound calls and generates TwiML for inbound answer.
```js
const { sid } = await twilioClient.makeCall('+911234567890');
const twiml   = twilioClient.buildAnswerTwiML();
```

---

### `src/websocket/CallSession.js` — `CallSession`
One instance per active call. Owns Deepgram WS, conversation history, barge-in gate, and processing state.

Key design: `onStart()` → `startDeepgram()` → STT transcript → `#handleUserTurn()` → `OrchestratorAgent` → `TTSService`

---

### `src/websocket/WebSocketServer.js` — `WebSocketServer`
Handles the HTTP→WS upgrade for `/media-stream`. Creates a `CallSession` per connection and routes events to it.

---

## ⚙️ Environment Variables

Create a `.env` file in the root:

```env
# Server
PORT=3000
NGROK_URL=https://your-ngrok-url.ngrok.io

# OpenAI
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4o-mini

# Neo4j (Aura or self-hosted)
NEO4J_URI=neo4j+s://xxxxxxxx.databases.neo4j.io
NEO4J_USER=neo4j
NEO4J_PASS=your-password

# Twilio
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=your-auth-token
TWILIO_PHONE_NUMBER=+1xxxxxxxxxx

# Deepgram
DEEPGRAM_API_KEY=your-deepgram-key

# ElevenLabs
ELEVEN_LABS_API_KEY=your-elevenlabs-key
ELEVEN_LABS_VOICE_ID=pNInz6obpgDQGcFmaJgB

# Zendesk (optional — KB features)
ZENDESK_SUBDOMAIN=yourcompany
ZENDESK_EMAIL=agent@yourcompany.com
ZENDESK_API_TOKEN=your-zendesk-token
ZENDESK_DEFAULT_SECTION_ID=123456
ZENDESK_PERMISSION_GROUP_ID=789012

# Tavily (optional — live web search)
TAVILY_API_KEY=tvly-...

# Debug (optional)
DEBUG=true
```

---

## 🚀 Setup & Run

```bash
# 1. Install dependencies
npm install

# 2. Copy env file
cp .env.example .env
# Fill in your keys

# 3. Start ngrok (in a separate terminal)
ngrok http 3000

# 4. Update NGROK_URL in .env with the https URL ngrok gives you

# 5. Start the server
node server.js
```

---

## 🌐 API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/call` | Initiate an outbound call `{ phoneNumber }` |
| `ALL` | `/api/twilio-answer` | TwiML response for inbound Twilio calls |
| `POST` | `/api/twilio-status` | Twilio call status webhook |
| `POST` | `/api/upload-pdf` | Upload a PDF to Zendesk KB |
| `GET` | `/api/kb-documents` | List all KB documents in Neo4j |
| `GET` | `/api/graph` | Full caller → memory → entity graph |
| `GET` | `/api/search?q=query` | Test live web search |
| `GET` | `/api/memory/:phone` | Get caller memories, entities, KB docs |
| `DELETE` | `/api/memory/:phone` | Clear all memories for a caller |

---

## 🔑 Key Design Decisions

| Decision | Reason |
|----------|--------|
| Private fields (`#field`) | True encapsulation, not just convention |
| Singletons (`module.exports = new Foo()`) | One shared instance, no global state |
| `CallSession` owns all per-call state | Clean lifecycle, easy to test and debug |
| `OrchestratorAgent` is pure logic | No I/O, no WebSocket — fully unit-testable |
| `setImmediate()` for Neo4j writes | Never blocks the voice response path |
| `Logger` wraps `console` | Swap to `winston`/`pino` by editing one file |
| Parallel fan-out in `OrchestratorAgent` | Memory + KB + Search run simultaneously |

---

## 📦 Dependencies

```json
{
  "openai": "^4.x",
  "neo4j-driver": "^5.x",
  "twilio": "^4.x",
  "ws": "^8.x",
  "axios": "^1.x",
  "express": "^4.x",
  "multer": "^1.x",
  "pdf-parse": "^1.x",
  "dotenv": "^16.x"
}
```