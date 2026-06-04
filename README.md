# 🤖 AI Multi-Calling Agent — with Knowledge Base & Orchestrator Agent

> **Branch:** `refactor/class-based-architecture`
> Production-grade AI voice agent platform — class-based, folder-modular, interview-ready.

A real-time AI phone agent that handles inbound and outbound calls, maintains long-term caller memory via a **Neo4j graph database**, retrieves knowledge from **Zendesk Help Center**, performs live **Tavily web search**, and responds with natural voice using **ElevenLabs TTS** — all over **Twilio Media Streams** with **Deepgram** real-time speech recognition.

---

## Table of Contents

- [What This Does](#what-this-does)
- [Tech Stack](#tech-stack)
- [Folder Structure](#folder-structure)
- [Layer-by-Layer Explanation](#layer-by-layer-explanation)
- [Working Flow](#working-flow)
- [Complete Call Flow Diagram](#complete-call-flow-diagram)
- [API Endpoints](#api-endpoints)
- [Environment Variables](#environment-variables)
- [Running Locally](#running-locally)
- [Design Decisions](#design-decisions)

---

## What This Does

When someone calls your Twilio phone number:

1. Audio streams in real-time over WebSocket
2. **Deepgram** transcribes speech → text instantly
3. **OrchestratorAgent** fans out to memory, KB, and web search simultaneously
4. **OpenAI** generates a context-aware reply
5. **ElevenLabs** converts text → voice, streamed back frame-by-frame
6. Caller memory is saved to **Neo4j** asynchronously (never blocks the voice)

The agent remembers callers across sessions, knows your company's knowledge base, and can look up live information from the web — all in one natural voice conversation.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Telephony | Twilio (Voice + Media Streams) |
| Speech-to-Text | Deepgram Nova-2 Phonecall |
| LLM | OpenAI GPT-4o-mini |
| Text-to-Speech | ElevenLabs Turbo v2 |
| Graph Memory | Neo4j Aura |
| Knowledge Base | Zendesk Help Center API |
| Web Search | Tavily API |
| Runtime | Node.js + Express + ws |
| PDF Processing | pdf-parse |

---

## Folder Structure

```
multi-calling-agent/
│
├── server.js                          # Lean entrypoint — boot, routes, WS upgrade, shutdown
├── package.json
├── .env                               # Never commit this
│
└── src/
    │
    ├── config/
    │   └── index.js                   # AppConfig class (singleton) — all env vars
    │
    ├── utils/
    │   ├── logger.js                  # Logger class — prefixed, levelled logging
    │   └── textCleaner.js             # TextCleaner — strips markdown before TTS
    │
    ├── database/
    │   └── Neo4jClient.js             # Neo4jClient class — driver, cypher(), schema init
    │
    ├── memory/
    │   └── MemoryService.js           # MemoryService class — save/recall caller memories
    │
    ├── knowledgebase/
    │   ├── ZendeskService.js          # ZendeskService class — article search + push
    │   └── DocumentProcessor.js       # DocumentProcessor class — PDF parse + chunk + index
    │
    ├── agents/
    │   ├── OrchestratorAgent.js       # OrchestratorAgent class — system brain, LLM call
    │   └── SearchAgent.js             # SearchAgent class — intent detection + Tavily
    │
    ├── tools/
    │   ├── TTSService.js              # TTSService class — ElevenLabs → µ-law → Twilio frames
    │   └── TwilioClient.js            # TwilioClient class — outbound calls + TwiML
    │
    ├── websocket/
    │   ├── CallSession.js             # CallSession class — per-call state + Deepgram lifecycle
    │   └── WebSocketServer.js         # WebSocketServer class — ws.Server, delegates to session
    │
    └── routes/
        ├── CallRoutes.js              # /api/call, /api/twilio-answer, /api/twilio-status
        ├── KnowledgeRoutes.js         # /api/upload-pdf, /api/kb-documents, /api/graph, /api/search
        └── MemoryRoutes.js            # GET/DELETE /api/memory/:phone
```

### Why this folder structure?

Each folder = one responsibility. You can open any folder and immediately know what it does:

- **`config/`** — one place for all environment config, nothing scattered
- **`utils/`** — shared helpers used by every other layer
- **`database/`** — all Neo4j driver logic isolated, easy to swap DB later
- **`memory/`** — graph memory read/write, separated from DB transport
- **`knowledgebase/`** — Zendesk + PDF, both are "retrieve knowledge" concerns
- **`agents/`** — AI reasoning layer, separated from infrastructure
- **`tools/`** — external communication (Twilio, ElevenLabs), not business logic
- **`websocket/`** — real-time layer, isolated from HTTP routes
- **`routes/`** — thin Express wrappers only, zero business logic here

---

## Layer-by-Layer Explanation

### `config/` — Configuration Layer

**`AppConfig`** is a singleton class that loads all environment variables in one place on startup.

```js
const config = require('./src/config');
config.openai.apiKey    // ✅ always available
config.neo4j.uri        // ✅ type-safe, centralised
```

Every other class imports `config` — no `process.env` scattered across files. If an env var changes, you update one file.

---

### `utils/` — Utility Layer

**`Logger`** — every class instantiates its own logger with a prefix:
```js
const log = new Logger('MemoryService');
log.info('Caller upserted');
// → [2026-06-04T10:23:11Z] [MemoryService] Caller upserted
```
Makes logs filterable in PM2 / CloudWatch without touching every file.

**`TextCleaner`** — strips markdown from LLM responses before they go to ElevenLabs:
```js
TextCleaner.forSpeech('**Bold text** and `code`')
// → 'Bold text and code'
```
Without this, ElevenLabs would literally say "asterisk asterisk bold asterisk asterisk".

---

### `database/` — Database Layer

**`Neo4jClient`** manages one shared driver instance (lazy-initialised, singleton export).

```js
// Anywhere in the app:
const db = require('./src/database/Neo4jClient');
const records = await db.cypher(
  'MATCH (c:Caller { phone: $p }) RETURN c',
  { p: '+919876543210' }
);
```

Graph schema it initialises on startup:

```
(:Caller { phone, firstSeen, lastSeen })
    │
    ├──[:HAS_MEMORY]──► (:Memory  { text, timestamp, callId, source })
    │                        └──[:INVOLVES]──► (:Entity { name, type })
    │
    ├──[:MENTIONED]───► (:Entity  { name, type })
    │
    └──[:USED_KB_DOC]──► (:KBDocument { articleId, title, filename })
```

---

### `memory/` — Memory Layer

**`MemoryService`** handles long-term caller memory using the Neo4j graph.

**On every conversation turn:**
1. LLM extracts `{ summary, entities }` from the user↔assistant exchange
2. A `Memory` node is created and linked to the `Caller` node
3. `Entity` nodes are merged and linked to both the `Memory` and `Caller`

**On next call:**
1. Last 12 memories + 25 entities + 5 KB docs are fetched in parallel
2. Formatted as a context string and injected into the LLM system prompt
3. Agent greets returning callers with full context

```
Caller +919876543210 ──[:HAS_MEMORY]──► "User is evaluating enterprise pricing"
                                              └──[:INVOLVES]──► Entity "enterprise plan"
                    ──[:MENTIONED]──► Entity "pricing"
                    ──[:USED_KB_DOC]──► KBDocument "Pricing FAQ"
```

---

### `knowledgebase/` — Knowledge Base Layer

**`ZendeskService`** searches Zendesk Help Center articles for every user query and returns the top 3 most relevant articles as context for the LLM.

It also:
- Pushes new articles programmatically via `pushArticle()`
- Tracks which KB articles a caller triggered in `(:KBDocument)` nodes in Neo4j

**`DocumentProcessor`** handles PDF uploads:

```
POST /api/upload-pdf
       │
       ▼
pdf-parse → raw text
       │
       ▼
chunkText() → paragraphs split at ~800 words each
       │
       ▼
for each chunk:
  ZendeskService.pushArticle()  → Zendesk article created
  ZendeskService.saveKBDocument() → Neo4j node saved
```

This means any PDF you upload is automatically searchable during calls.

---

### `agents/` — Agent Layer

**`OrchestratorAgent`** is the system brain. For every user utterance it:

```
user transcript
      │
      ▼
Promise.all([
  memoryService.recallMemory(phone),    ← Neo4j  (parallel)
  zendeskService.fetchArticles(query),  ← Zendesk (parallel)
  searchAgent.searchIfNeeded(query)     ← Tavily  (parallel, if needed)
])
      │
      ▼
Build system prompt with all three contexts injected
      │
      ▼
openai.chat.completions.create()
      │
      ├──► TextCleaner.forSpeech() + truncate to 550 chars
      │
      └──► setImmediate: save memory to Neo4j (non-blocking)
```

`Promise.all` ensures all three context sources are fetched simultaneously. If each takes 300ms, total wait is still ~300ms — not 900ms.

`setImmediate` means the voice reply is sent to the caller immediately, while Neo4j writes happen in the background. The caller never waits for DB writes.

**`SearchAgent`** decides when to search using intent patterns:

| Pattern type | Examples | Action |
|---|---|---|
| Never search | `hi`, `thanks`, `what is a function`, basic facts | Skip Tavily |
| Always search | `latest news`, `today's weather`, `current CEO of X` | Call Tavily |

Results are cached in-memory for 5 minutes to avoid duplicate API calls for the same query.

---

### `tools/` — Communication Tools Layer

**`TTSService`** converts text to voice and streams it to Twilio frame-by-frame.

Twilio Media Streams require µ-law audio at exactly **8000 Hz in 20ms frames (160 bytes)**. The service:

1. Fetches full µ-law audio from ElevenLabs API
2. Sends exactly 160 bytes every 20ms using nanosecond-precision busy-wait (`process.hrtime.bigint()`)
3. Queues concurrent TTS calls per `streamSid` so audio never overlaps
4. Sends a "clear" event to Twilio before each response to interrupt any pending audio
5. Sets `gate.ignoreUntil` to suppress STT transcripts while the bot is speaking (barge-in prevention)

**`TwilioClient`** handles outbound calls and TwiML generation:

```js
// Outbound call
await twilioClient.makeCall('+919876543210');

// TwiML for inbound (connects to Media Stream)
twilioClient.buildAnswerTwiML();
// → <Connect><Stream url="wss://your-ngrok/media-stream"/></Connect>
```

---

### `websocket/` — Real-Time Layer

**`CallSession`** owns the entire lifecycle of one phone call:

| Property | What it tracks |
|---|---|
| `streamSid` | Twilio stream identifier |
| `callerPhone` | Caller's E.164 phone number |
| `history` | LLM conversation window (last 20 turns) |
| `gate` | `{ ignoreUntil: timestamp }` — barge-in suppression |
| `isProcessing` | Prevents overlapping LLM calls |
| `lastTranscript` | Deduplicates Deepgram double-firing |
| `#deepgramWs` | Private — Deepgram WebSocket connection |
| `#pendingAudio` | Audio buffer before Deepgram connects |

Event flow inside a session:
```
Twilio "start"  → onStart()   → upsertCaller + startDeepgram + send greeting
Twilio "media"  → onMedia()   → forward audio bytes → Deepgram
Deepgram final  → #handleUserTurn() → OrchestratorAgent → TTSService
Twilio "mark"   → onMark()   → gate.ignoreUntil = now + 400ms
Twilio "stop"   → cleanup()  → close DG ws, clear TTS queue
```

**`WebSocketServer`** runs in `noServer` mode — it shares port 3000 with Express. The `http.Server` "upgrade" event in `server.js` routes `/media-stream` connections here.

---

### `routes/` — API Layer

Routes are **thin wrappers only** — they validate input, call a service, return JSON. No business logic lives here.

| File | Routes |
|---|---|
| `CallRoutes.js` | `POST /api/call`, `ALL /api/twilio-answer`, `POST /api/twilio-status` |
| `KnowledgeRoutes.js` | `POST /api/upload-pdf`, `GET /api/kb-documents`, `GET /api/graph`, `GET /api/search` |
| `MemoryRoutes.js` | `GET /api/memory/:phone`, `DELETE /api/memory/:phone` |

---

## Working Flow

### Inbound Call Flow

```
Caller dials Twilio number
         │
         ▼
Twilio → POST /api/twilio-answer
         │
         ▼
TwilioClient.buildAnswerTwiML()
Returns: <Connect><Stream url="wss://.../media-stream"/>
         │
         ▼
Twilio opens WebSocket to /media-stream
         │
         ▼
WebSocketServer creates new CallSession(ws)
         │
         ▼
Twilio sends "start" event { streamSid, customParameters: { callerPhone } }
         │
         ▼
CallSession.onStart():
  ├── memoryService.upsertCaller(phone)      → MERGE Caller node in Neo4j
  ├── CallSession.startDeepgram()            → Open Deepgram WebSocket
  └── Query Neo4j → isReturning caller?
         │
         ▼
After 1s: TTSService.sendVoice(greeting)
  "Welcome back! I remember our previous chats." (returning)
  "Hello! I'm your AI assistant." (new caller)
         │
         ▼ (caller speaks)

Twilio sends "media" events (µ-law audio chunks, base64)
         │
         ▼
CallSession.onMedia() → audio → Deepgram WebSocket
(skipped if gate.ignoreUntil > now — barge-in suppression)
         │
         ▼
Deepgram fires "message" { is_final: true, transcript: "..." }
         │
         ▼
CallSession.#handleUserTurn(transcript):
  ├── history.push({ role: "user", content: transcript })
  └── OrchestratorAgent.reply(history, phone, callId)
         │
         ▼
OrchestratorAgent.reply():
  ├── Promise.all([                           ← all 3 in parallel
  │     memoryService.recallMemory(phone),    ← Neo4j graph query
  │     zendeskService.fetchArticles(query),  ← Zendesk REST API
  │     searchAgent.searchIfNeeded(query)     ← Tavily (if live data needed)
  │   ])
  ├── Build system prompt with all contexts injected
  ├── openai.chat.completions.create()
  ├── TextCleaner.forSpeech() + truncate(550 chars)
  └── setImmediate:
        memoryService.saveMemory(...)         ← async Neo4j write
        zendeskService.saveKBMemory(...)      ← async Neo4j write
         │
         ▼
TTSService.sendVoice(ws, streamSid, replyText):
  ├── ElevenLabs API → µ-law audio buffer
  ├── streamFrames(): 160 bytes every 20ms (nanosecond precision)
  └── ws.send({ event: "mark" }) when done
         │
         ▼
Twilio → Caller hears the response
         │
         ▼
Twilio sends "mark" → gate.ignoreUntil = now + 400ms
         │
         ▼ (repeat from "caller speaks")

Caller hangs up → Twilio "stop" → CallSession.cleanup()
```

### Outbound Call Flow

```
POST /api/call { phoneNumber: "+919876543210" }
         │
         ▼
TwilioClient.makeCall(phoneNumber)
  → Twilio REST: calls.create({ to, from, url: /api/twilio-answer })
         │
         ▼
Twilio dials the number → callee picks up
         │
         ▼
Twilio fetches /api/twilio-answer → same flow as inbound from here
```

### PDF Upload Flow

```
POST /api/upload-pdf (multipart, field: "pdf")
         │
         ▼
Multer: memoryStorage, 20MB limit, .pdf only
         │
         ▼
DocumentProcessor.processUpload(buffer, filename)
  ├── pdfParse(buffer) → raw text
  ├── chunkText(text, 800 words) → ["chunk1", "chunk2", ...]
  └── for each chunk:
        ZendeskService.pushArticle(title, chunk) → Zendesk article created
        ZendeskService.saveKBDocument({ articleId }) → Neo4j node saved
         │
         ▼
Response: { filename, chunks: N, articles: [{ id, title, url }] }
```

---

## Complete Call Flow Diagram

```
                    ┌──────────────┐
                    │ Phone Caller │
                    └──────┬───────┘
                           │ PSTN
                           ▼
                    ┌──────────────┐
                    │    Twilio    │
                    └──────┬───────┘
                           │ WebSocket (µ-law audio)
                           ▼
               ┌───────────────────────┐
               │    WebSocketServer    │
               │  new CallSession(ws)  │
               └───────────┬───────────┘
                           │ audio bytes
                           ▼
               ┌───────────────────────┐
               │     Deepgram STT      │
               │   nova-2-phonecall    │
               └───────────┬───────────┘
                           │ final transcript
                           ▼
               ┌───────────────────────┐
               │  OrchestratorAgent   │   ← System brain
               └───┬───────┬───────┬───┘
                   │       │       │
          ┌────────┘  ┌────┘  ┌───┘
          ▼           ▼       ▼
   ┌──────────┐ ┌──────────┐ ┌──────────────┐
   │ Memory   │ │ Zendesk  │ │   Tavily     │
   │ Service  │ │ Service  │ │ SearchAgent  │
   │ (Neo4j)  │ │ (KB)     │ │ (web search) │
   └────┬─────┘ └────┬─────┘ └──────┬───────┘
        └────────────┴───────────────┘
                      │ merged context
                      ▼
              ┌───────────────┐
              │  OpenAI LLM   │
              └───────┬───────┘
                      │ response text
                      ▼
              ┌───────────────┐
              │  TTSService   │
              │  ElevenLabs   │
              └───────┬───────┘
                      │ µ-law frames (160B / 20ms)
                      ▼
                ┌───────────┐
                │  Twilio   │
                └─────┬─────┘
                      │
              ┌───────▼───────┐
              │ Phone Caller  │  ← hears response
              └───────────────┘
```

---

## API Endpoints

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/call` | Trigger outbound AI call `{ phoneNumber }` |
| `GET/POST` | `/api/twilio-answer` | Twilio webhook — returns TwiML |
| `POST` | `/api/twilio-status` | Twilio status callback |
| `POST` | `/api/upload-pdf` | Upload PDF → chunk → index to Zendesk |
| `GET` | `/api/kb-documents` | List all indexed KB documents |
| `GET` | `/api/graph` | Full Neo4j graph (callers, memories, entities, KB docs) |
| `GET` | `/api/search?q=query` | Debug: run Tavily search intent check |
| `GET` | `/api/memory/:phone` | Fetch memories, entities, KB docs for a caller |
| `DELETE` | `/api/memory/:phone` | Clear all memories for a caller |

---

## Environment Variables

```env
# Server
PORT=3000
NGROK_URL=https://your-ngrok-url.ngrok.io

# OpenAI
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4o-mini

# Neo4j Aura
NEO4J_URI=neo4j+s://xxxxxxxx.databases.neo4j.io
NEO4J_USER=neo4j
NEO4J_PASS=your-password

# Twilio
TWILIO_ACCOUNT_SID=ACxxxxxxxxxx
TWILIO_AUTH_TOKEN=your-auth-token
TWILIO_PHONE_NUMBER=+1xxxxxxxxxx

# Deepgram
DEEPGRAM_API_KEY=your-deepgram-key

# ElevenLabs
ELEVEN_LABS_API_KEY=your-elevenlabs-key
ELEVEN_LABS_VOICE_ID=pNInz6obpgDQGcFmaJgB

# Zendesk
ZENDESK_SUBDOMAIN=yourcompany
ZENDESK_EMAIL=admin@yourcompany.com
ZENDESK_API_TOKEN=your-zendesk-token
ZENDESK_DEFAULT_SECTION_ID=123456789
ZENDESK_PERMISSION_GROUP_ID=987654321

# Tavily
TAVILY_API_KEY=tvly-...
```

---

## Running Locally

```bash
# 1. Clone and install
git clone https://github.com/himasnhu77/multi-calling-agent-with-knowledge-base-orchestrator-agent
cd multi-calling-agent-with-knowledge-base-orchestrator-agent
git checkout refactor/class-based-architecture
npm install

# 2. Copy env and fill in your keys
cp .env.example .env

# 3. Start ngrok (Twilio needs a public URL)
ngrok http 3000
# Copy the https URL → paste into NGROK_URL in .env

# 4. Run dev server
npm run dev

# 5. Configure Twilio webhook
# In Twilio console → Phone Numbers → your number
# Voice webhook → https://your-ngrok.ngrok.io/api/twilio-answer
```

---

## Design Decisions

### Why class-based + singletons?

```js
// Every module does:
module.exports = new MemoryService();

// Every consumer does:
const memoryService = require('../memory/MemoryService');
```

One shared instance across the entire app. No DI framework needed. No global state. Just Node's module cache acting as a singleton container.

### Why `Promise.all` for context fetching?

Memory, KB, and web search are fetched in parallel — not sequentially. If each takes 300ms, total wait is ~300ms, not 900ms. Voice latency is the #1 UX metric in phone agents.

### Why `setImmediate` for Neo4j writes?

```js
setImmediate(() => memoryService.saveMemory(...));
```

The voice response is returned to the caller immediately. Neo4j writes happen after the event loop tick. The caller never waits for database writes to complete.

### Why Neo4j over a relational DB?

"Caller X mentioned enterprise pricing during call Z, which also triggered KB article W, and entity 'enterprise plan' appeared in 3 separate calls" — this is a graph traversal, not a SQL JOIN. Neo4j Cypher makes this a single `MATCH` pattern.

### Why `#privateFields` everywhere?

```js
class TTSService {
  #playbackQueues = new Map();  // real private — not just convention
  #fetchAudio(text) { ... }     // truly encapsulated
}
```

ES2022 private fields give real encapsulation. `_conventionPrivate` can still be accessed from outside. `#realPrivate` cannot.

### Why frame-accurate TTS streaming?

Twilio requires µ-law audio at exactly 8000 Hz — 160 bytes every 20ms (50 frames/sec). Sending audio in bulk causes playback speed issues. The service uses `process.hrtime.bigint()` nanosecond precision to maintain exactly 50fps delivery.

---

## Branch History

| Branch | What changed |
|---|---|
| `main` | Original monolithic `server.js` |
| `refactor/clean-modular` | Functions split into separate files |
| `refactor/class-based-architecture` | **This branch** — classes, standard folder structure, full docs |
| `docs/architecture-deep-dive` | Deep-dive architecture doc + Hinglish interview cheat sheet |