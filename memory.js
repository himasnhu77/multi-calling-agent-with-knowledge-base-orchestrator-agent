const { cypher } = require("./db");
const OpenAI = require("openai");
const config = require("./config");

const openai = new OpenAI({ apiKey: config.openai.apiKey });

async function upsertCaller(phone) {
  await cypher(
    `MERGE (c:Caller { phone: $phone })
     ON CREATE SET c.firstSeen = datetime(), c.lastSeen = datetime()
     ON MATCH  SET c.lastSeen = datetime()`,
    { phone }
  );
}

async function extractMemory(userText, assistantText) {
  const prompt =
    `You are an entity extractor for a knowledge graph memory system.\n` +
    `USER: ${userText}\nASSISTANT: ${assistantText}\n\n` +
    `Return ONLY valid JSON:\n{ "summary": "", "entities": [{ "name": "", "type": "" }] }\n` +
    `If nothing memorable, return { "summary": "", "entities": [] }.`;
  try {
    const res = await openai.chat.completions.create({
      model: config.openai.model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
      max_tokens: 300,
      response_format: { type: "json_object" },
    });
    return JSON.parse(res.choices[0].message.content.trim());
  } catch {
    return { summary: "", entities: [] };
  }
}

async function saveMemory(phone, callId, userText, assistantText) {
  const { summary, entities } = await extractMemory(userText, assistantText);
  if (!summary) return;
  await cypher(
    `MATCH (c:Caller { phone: $phone })
     CREATE (m:Memory { text: $summary, timestamp: datetime(), callId: $callId, source: 'conversation' })
     CREATE (c)-[:HAS_MEMORY]->(m)`,
    { phone, summary, callId }
  );
  for (const ent of entities) {
    if (!ent.name?.trim()) continue;
    await cypher(
      `MATCH (c:Caller { phone: $phone })
       MERGE (e:Entity { name: $name }) ON CREATE SET e.type = $type
       MERGE (c)-[:MENTIONED]->(e)
       WITH c, e
       MATCH (m:Memory { callId: $callId }) WHERE (c)-[:HAS_MEMORY]->(m)
       MERGE (m)-[:INVOLVES]->(e)`,
      { phone, name: ent.name.toLowerCase(), type: ent.type || "Topic", callId }
    );
  }
}

async function recallMemory(phone) {
  const [memRecs, entRecs, kbRecs] = await Promise.all([
    cypher(
      `MATCH (c:Caller { phone: $phone })-[:HAS_MEMORY]->(m:Memory)
       RETURN m.text AS text ORDER BY m.timestamp DESC LIMIT 12`,
      { phone }
    ),
    cypher(
      `MATCH (c:Caller { phone: $phone })-[:MENTIONED]->(e:Entity)
       RETURN e.name AS name, e.type AS type LIMIT 25`,
      { phone }
    ),
    cypher(
      `MATCH (c:Caller { phone: $phone })-[:USED_KB_DOC]->(k:KBDocument)
       RETURN k.title AS title ORDER BY k.createdAt DESC LIMIT 5`,
      { phone }
    ),
  ]);

  const memories = memRecs.map((r) => r.get("text")).filter(Boolean);
  const entities = entRecs.map((r) => `${r.get("name")} (${r.get("type")})`).filter(Boolean);
  const kbDocs = kbRecs.map((r) => r.get("title")).filter(Boolean);
  if (!memories.length && !entities.length && !kbDocs.length) return null;

  let ctx = "=== Caller memory ===\n";
  if (entities.length) ctx += `Entities: ${entities.join(", ")}\n`;
  if (kbDocs.length) ctx += `KB docs used: ${kbDocs.join(", ")}\n`;
  if (memories.length) {
    ctx += "Recent memories:\n";
    memories.forEach((m, i) => (ctx += ` ${i + 1}. ${m}\n`));
  }
  ctx += "=== Use this to personalise ===";
  return ctx;
}

module.exports = { upsertCaller, saveMemory, recallMemory };
