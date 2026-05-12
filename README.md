# 🤖 Multi-Calling Agent with Knowledge Base & Orchestrator

> A production-grade **AI voice calling system** built on Node.js that combines real-time speech-to-text, LLM reasoning, text-to-speech, a live Zendesk knowledge base, and persistent cross-call graph memory — all orchestrated through a single server.

---

## 📋 Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
- [Tech Stack](#tech-stack)
- [Features](#features)
- [Prerequisites](#prerequisites)
- [Environment Variables](#environment-variables)
- [Installation](#installation)
- [Running the Server](#running-the-server)
- [API Reference](#api-reference)
- [Call Flow](#call-flow)
- [Knowledge Base Integration](#knowledge-base-integration)
- [Graph Memory (Neo4j)](#graph-memory-neo4j)
- [Deployment (AWS EC2)](#deployment-aws-ec2)
- [Project Structure](#project-structure)
- [Troubleshooting](#troubleshooting)

---

## Overview

This system enables intelligent, context-aware AI phone agents that can:

- **Answer inbound/outbound calls** via Twilio with a realistic cloned voice
- **Understand speech in real time** using Deepgram's `nova-2-phonecall` model
- **Query a live knowledge base** (Zendesk) to answer product/support questions accurately
- **Remember callers across sessions** using a Neo4j Aura graph database
- **Generate dynamic responses** using an LLM (OpenAI-compatible endpoint / Ollama)
- **Upload and query custom documents** (PDF parsing via `pdf-parse`) through a web UI

The **orchestrator agent** layer routes each caller utterance to the right sub-capability: knowledge retrieval, memory lookup, LLM reasoning, or a combination of all three.

---

## Architecture

```
Inbound/Outbound Call
        │
        ▼
  ┌─────────────┐
  │   Twilio    │  ◄── Media Stream (WebSocket, µlaw 8000 Hz)
  └──────┬──────┘
         │
         ▼
  ┌─────────────────────────────────────────────────────────────┐
  │                      server.js (Express + WS)               │
  │                                                             │
  │  ┌──────────┐    ┌────────────────┐    ┌─────────────────┐ │
  │  │ Deepgram │───►│  Orchestrator  │───►│   ElevenLabs    │ │
  │  │  (STT)   │    │    Agent       │    │     (TTS)       │ │
  │  └──────────┘    └───────┬────────┘    └─────────────────┘ │
  │                          │                                  │
  │            ┌─────────────┼─────────────┐                   │
  │            ▼             ▼             ▼                   │
  │     ┌────────────┐ ┌──────────┐ ┌──────────┐              │
  │     │  Zendesk   │ │  OpenAI  │ │  Neo4j   │              │
  │     │  KB (REST) │ │   LLM    │ │  Aura    │              │
  │     └────────────┘ └──────────┘ └──────────┘              │
  └─────────────────────────────────────────────────────────────┘
         │
         ▼
  ┌─────────────────┐
  │   Web UI        │  (public/ — PDF upload, call logs, agent config)
  └─────────────────┘
```

---

## Tech Stack

| Layer | Technology |
|---|---|
| **Runtime** | Node.js 18+ |
| **Web Framework** | Express.js |
| **Telephony** | Twilio (Voice, Media Streams) |
| **Speech-to-Text** | Deepgram (`nova-2-phonecall`, streaming WebSocket) |
| **Text-to-Speech** | ElevenLabs (cloned voice, `ulaw_8000` output) |
| **LLM** | OpenAI API (or Ollama-compatible endpoint) |
| **Knowledge Base** | Zendesk Help Center REST API |
| **Graph Memory** | Neo4j Aura (nodes: `Caller`, `Entity`, `Memory`) |
| **Document Parsing** | `pdf-parse` |
| **File Uploads** | Multer |
| **HTTP Client** | Axios |
| **WebSocket** | `ws` |
| **Config** | `dotenv` |

---

## Features

### 🎙️ Real-Time Voice Pipeline
- Bidirectional WebSocket with Twilio Media Streams
- Streaming STT via Deepgram with low-latency interim results
- TTS audio streamed back as `ulaw_8000` chunks for telephone-quality playback

### 🧠 Orchestrator Agent
- Routes each user turn to the correct sub-agent:
  - **KB Agent** — searches Zendesk articles for factual answers
  - **Memory Agent** — retrieves caller history from Neo4j
  - **LLM Agent** — generates contextual responses using conversation history
- Assembles multi-source context into a single coherent reply

### 📚 Knowledge Base (Zendesk)
- Live REST API queries to Zendesk Help Center
- Injects top-k relevant article snippets into the LLM prompt
- Handles 403/rate-limit errors gracefully with fallback responses

### 🗂️ Document Upload & RAG
- Web UI for uploading PDF documents
- `pdf-parse` extracts text and stores it for per-call retrieval
- Augments LLM context with relevant document chunks

### 🕸️ Cross-Call Graph Memory (Neo4j)
- Caller identified by phone number → `Caller` node
- Extracted entities (names, topics, preferences) stored as `Entity` nodes
- `Memory` nodes capture key facts with timestamps and relationships
- Persistent context survives across separate call sessions

### 📞 Outbound Calling
- Programmatic outbound calls via Twilio REST API
- Configurable call scripts and agent personas

---

## Prerequisites

- Node.js `>= 18.x`
- A [Twilio](https://twilio.com) account with a phone number and Media Streams enabled
- A [Deepgram](https://deepgram.com) API key
- An [ElevenLabs](https://elevenlabs.io) API key and a cloned voice ID
- An OpenAI API key (or a locally running Ollama instance)
- A [Neo4j Aura](https://neo4j.com/cloud/platform/aura-graph-database/) free/paid instance
- A [Zendesk](https://zendesk.com) account with a Help Center (for KB features)
- A publicly accessible server or tunnel (e.g. [ngrok](https://ngrok.com)) for Twilio webhooks

---

## Environment Variables

Create a `.env` file in the project root:

```env
# Server
PORT=3000

# Twilio
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=your_twilio_auth_token
TWILIO_PHONE_NUMBER=+1xxxxxxxxxx

# Deepgram
DEEPGRAM_API_KEY=your_deepgram_api_key

# ElevenLabs
ELEVENLABS_API_KEY=your_elevenlabs_api_key
ELEVENLABS_VOICE_ID=your_cloned_voice_id

# LLM (OpenAI or Ollama)
OPENAI_API_KEY=your_openai_api_key
OPENAI_BASE_URL=https://api.openai.com/v1   # or http://localhost:11434/v1 for Ollama
LLM_MODEL=gpt-4o-mini                       # or qwen2.5:1.5b for Ollama

# Neo4j Aura
NEO4J_URI=neo4j+s://xxxxxxxx.databases.neo4j.io
NEO4J_USERNAME=neo4j
NEO4J_PASSWORD=your_neo4j_password

# Zendesk
ZENDESK_SUBDOMAIN=your_subdomain
ZENDESK_EMAIL=your_email@example.com
ZENDESK_API_TOKEN=your_zendesk_api_token

# Public base URL (for Twilio webhooks)
BASE_URL=https://your-server.com
```

---

## Installation

```bash
# Clone the repository
git clone https://github.com/himasnhu77/multi-calling-agent-with-knowledge-base-orchestrator-agent.git
cd multi-calling-agent-with-knowledge-base-orchestrator-agent

# Install dependencies
npm install

# Set up environment
cp .env.example .env
# Edit .env with your credentials
```

---

## Running the Server

### Development

```bash
npm run dev       # nodemon with hot reload
```

### Production

```bash
npm start         # node server.js
```

### With PM2 (recommended for EC2)

```bash
pm2 start server.js --name "calling-agent"
pm2 save
pm2 startup
```

Once running, configure your Twilio phone number's **Voice webhook** to:

```
POST https://your-server.com/incoming-call
```

---

## API Reference

### Telephony Webhooks

| Method | Path | Description |
|---|---|---|
| `POST` | `/incoming-call` | Twilio webhook — returns TwiML to connect Media Stream |
| `WebSocket` | `/media-stream` | Bidirectional audio stream with Twilio |

### Outbound Calls

| Method | Path | Body | Description |
|---|---|---|---|
| `POST` | `/make-call` | `{ "to": "+1xxxxxxxxxx" }` | Initiate an outbound AI call |

### Knowledge Base

| Method | Path | Description |
|---|---|---|
| `GET` | `/kb/search?q=<query>` | Search Zendesk KB articles |

### Document Upload

| Method | Path | Body | Description |
|---|---|---|---|
| `POST` | `/upload-pdf` | `multipart/form-data` (field: `pdf`) | Upload and index a PDF document |
| `GET` | `/documents` | — | List all uploaded documents |

### Web UI

| Path | Description |
|---|---|
| `/` | Main dashboard (served from `public/`) |

---

## Call Flow

```
1. Inbound call hits POST /incoming-call
   └─► Server responds with TwiML <Connect><Stream url="wss://…/media-stream"/>

2. Twilio opens WebSocket to /media-stream
   └─► Server establishes Deepgram streaming STT connection

3. Caller speaks → µlaw audio chunks arrive over WebSocket
   └─► Forwarded to Deepgram in real time

4. Deepgram returns transcript (interim + final)
   └─► Final transcript triggers Orchestrator Agent

5. Orchestrator Agent:
   a. Queries Neo4j for caller memory (by caller phone number)
   b. Searches Zendesk KB for relevant articles
   c. Builds prompt: [system] + [memory] + [kb_context] + [conversation_history] + [user_turn]
   d. Calls LLM → gets response text

6. Response text sent to ElevenLabs TTS API
   └─► Audio streamed back as µlaw_8000 chunks to Twilio

7. Twilio plays audio to caller

8. Post-call: key entities and facts extracted and written to Neo4j graph
```

---

## Knowledge Base Integration

The system queries the Zendesk Help Center Search API:

```
GET https://{subdomain}.zendesk.com/api/v2/help_center/articles/search.json?query={q}
```

Top results are truncated and injected into the LLM system prompt as grounded context. This prevents hallucination on product-specific facts and keeps responses accurate.

**Known issues & mitigations:**
- **403 errors** — ensure your Zendesk API token has `Help Center` read permissions and that the subdomain is correct.
- **Rate limits** — responses are cached per session to avoid repeated identical queries.

---

## Graph Memory (Neo4j)

The memory schema uses three node types:

```
(:Caller {phone, name?, firstSeen, lastSeen})
    │
    ├─[:HAS_MEMORY]──►(:Memory {content, timestamp, callSid})
    │
    └─[:MENTIONED]───►(:Entity {type, value})
                       e.g. {type: "topic", value: "pricing"}
                            {type: "name", value: "Amit"}
```

At the **start of each call**, the system runs a Cypher query to fetch recent memories for the caller's phone number and prepends them as context.

At the **end of each call**, extracted entities and a summary of the conversation are written back to the graph.

This enables the agent to say things like:
> *"Welcome back! Last time we spoke, you were asking about the Enterprise plan. Are you still interested?"*

---

## Deployment (AWS EC2)

Tested on **t3.medium** (Ubuntu 22.04):

```bash
# 1. Install Node.js 18
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# 2. Clone & install
git clone https://github.com/himasnhu77/multi-calling-agent-with-knowledge-base-orchestrator-agent.git
cd multi-calling-agent-with-knowledge-base-orchestrator-agent
npm install

# 3. Configure environment
nano .env

# 4. Install PM2 and start
npm install -g pm2
pm2 start server.js --name "calling-agent"
pm2 startup && pm2 save

# 5. Nginx reverse proxy (WebSocket support required)
sudo apt install nginx
```

**Nginx config** (`/etc/nginx/sites-available/calling-agent`):

```nginx
server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

> ⚠️ For production, add SSL via `certbot --nginx` and update `BASE_URL` to use `https://`.

---

## Project Structure

```
multi-calling-agent-with-knowledge-base-orchestrator-agent/
├── server.js              # Main entry point — Express + WebSocket server
│                          # Twilio webhook handlers
│                          # Deepgram STT integration
│                          # ElevenLabs TTS integration
│                          # Orchestrator Agent logic
│                          # Neo4j memory read/write
│                          # Zendesk KB search
│                          # PDF upload & parsing
│
├── public/                # Static web UI
│   └── index.html         # Dashboard — upload PDFs, view call logs
│
├── package.json           # Dependencies & scripts
├── .gitignore
└── .env                   # (not committed) credentials
```

---

## Troubleshooting

| Issue | Likely Cause | Fix |
|---|---|---|
| Deepgram WebSocket closes with `1005` | No audio data sent before timeout | Ensure Twilio Media Stream connects before Deepgram keepalive window expires; send a silent frame if needed |
| Zendesk returns `403` | Invalid API token or missing KB permissions | Re-check token scope in Zendesk Admin → API |
| Neo4j `ServiceUnavailable` | Aura instance paused (free tier auto-pauses) | Wake it in the Neo4j Aura console or switch to a paid instance |
| TTS audio choppy / silent | ElevenLabs streaming not flushed correctly | Confirm `output_format=ulaw_8000` and that audio chunks are base64-encoded before sending to Twilio |
| ngrok tunnel resets webhook URL | ngrok free tier assigns a new URL on restart | Use a paid ngrok plan with a fixed domain, or deploy to EC2 with a static IP |

---

## License

MIT License — see [LICENSE](LICENSE) for details.

---

## Author

**Himanshu** — [@himasnhu77](https://github.com/himasnhu77)

> Built as part of a multi-product AI ecosystem including a CRM Copilot Chrome Extension, AI Email Client, and Animano anime generation platform.
