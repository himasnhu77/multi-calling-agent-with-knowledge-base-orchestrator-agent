const axios = require("axios");
const { cypher } = require("./db");
const config = require("./config");

async function fetchZendeskArticles(query) {
  const { subdomain, email, apiToken } = config.zendesk;
  if (!subdomain || !apiToken) return null;
  try {
    const res = await axios.get(
      `https://${subdomain}.zendesk.com/api/v2/help_center/articles/search`,
      {
        params: { query, per_page: 3, locale: "en-us" },
        auth: { username: `${email}/token`, password: apiToken },
        timeout: 8000,
      }
    );
    const articles = res.data.results?.slice(0, 3) || [];
    if (!articles.length) return { ctx: null, articleIds: [] };
    const ctx =
      `=== Zendesk KB ===\n` +
      articles.map((a) => `- ${a.title}: ${a.snippet}`).join("\n") +
      `\n=== Prefer KB for product/policy questions ===`;
    return { ctx, articleIds: articles.map((a) => String(a.id)) };
  } catch (err) {
    console.warn("Zendesk error:", err.message);
    return { ctx: null, articleIds: [] };
  }
}

async function pushArticleToZendesk(title, body) {
  const { subdomain, email, apiToken, sectionId, permGroupId } = config.zendesk;
  const payload = {
    article: {
      title,
      body: `<p>${body.replace(/\n/g, "</p><p>")}</p>`,
      locale: "en-us",
      ...(permGroupId && { permission_group_id: parseInt(permGroupId) }),
      user_segment_id: null,
    },
  };
  const url = sectionId
    ? `https://${subdomain}.zendesk.com/api/v2/help_center/sections/${sectionId}/articles`
    : `https://${subdomain}.zendesk.com/api/v2/help_center/articles`;
  const res = await axios.post(url, payload, {
    auth: { username: `${email}/token`, password: apiToken },
    headers: { "Content-Type": "application/json" },
    timeout: 15000,
  });
  return res.data.article;
}

async function saveKBDocument({ articleId, title, filename, chunkIndex, totalChunks }) {
  await cypher(
    `MERGE (k:KBDocument { articleId: $articleId })
     SET k.title = $title, k.filename = $filename,
         k.chunkIndex = $chunkIndex, k.totalChunks = $totalChunks,
         k.createdAt = datetime()`,
    { articleId: String(articleId), title, filename, chunkIndex, totalChunks }
  );
}

async function saveKBMemory(phone, callId, question, articleIds) {
  if (!articleIds.length) return;
  await cypher(
    `MATCH (c:Caller { phone: $phone })
     CREATE (m:Memory { text: $text, timestamp: datetime(), callId: $callId, source: 'zendesk_kb' })
     CREATE (c)-[:HAS_MEMORY]->(m)`,
    { phone, callId, text: `KB lookup: "${question}" → ${articleIds.length} article(s)` }
  );
  for (const id of articleIds) {
    await cypher(
      `MATCH (c:Caller { phone: $phone })
       MATCH (k:KBDocument { articleId: $articleId })
       MERGE (c)-[r:USED_KB_DOC]->(k)
       ON CREATE SET r.firstUsed = datetime(), r.count = 1, r.sampleQuestion = $question
       ON MATCH  SET r.lastUsed = datetime(), r.count = r.count + 1`,
      { phone, articleId: String(id), question }
    ).catch((e) => console.warn("linkCallerToKBDoc:", e.message));
  }
}

function chunkText(text, chunkSize = 800) {
  const paragraphs = text.split(/\n\s*\n/).filter((p) => p.trim().length > 50);
  const chunks = [];
  let current = "";
  for (const para of paragraphs) {
    const words = (current + " " + para).trim().split(/\s+/).length;
    if (words > chunkSize && current) { chunks.push(current.trim()); current = para; }
    else current = current ? current + "\n\n" + para : para;
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.length ? chunks : [text.trim()];
}

module.exports = { fetchZendeskArticles, pushArticleToZendesk, saveKBDocument, saveKBMemory, chunkText };
