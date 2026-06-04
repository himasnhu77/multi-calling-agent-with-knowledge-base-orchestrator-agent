const axios  = require("axios");
const db     = require("../database/Neo4jClient");
const config = require("../config");
const Logger = require("../utils/logger");

const log = new Logger("ZendeskService");

class ZendeskService {
  async fetchArticles(query) {
    const { subdomain, email, apiToken } = config.zendesk;
    if (!subdomain || !apiToken) return { ctx: null, articleIds: [] };
    try {
      const res = await axios.get(
        `https://${subdomain}.zendesk.com/api/v2/help_center/articles/search.json`,
        { params: { query, per_page: 3, locale: "en-us" }, auth: { username: `${email}/token`, password: apiToken }, timeout: 8000 }
      );
      const articles = res.data.results?.slice(0, 3) || [];
      if (!articles.length) return { ctx: null, articleIds: [] };
      const ctx =
        `=== Zendesk KB ===\n` +
        articles.map((a) => `- ${a.title}: ${a.snippet}`).join("\n") +
        `\n=== Prefer KB for product/policy questions ===`;
      return { ctx, articleIds: articles.map((a) => String(a.id)) };
    } catch (err) {
      log.warn("fetchArticles error:", err.message);
      return { ctx: null, articleIds: [] };
    }
  }

  async pushArticle(title, body) {
    const { subdomain, email, apiToken, sectionId, permGroupId } = config.zendesk;
    const payload = {
      article: {
        title,
        body: `<p>${body.replace(/\n/g, "</p><p>")}</p>`,
        locale: "en-us",
        ...(permGroupId && { permission_group_id: parseInt(permGroupId, 10) }),
        user_segment_id: null,
      },
    };
    const url = sectionId
      ? `https://${subdomain}.zendesk.com/api/v2/help_center/sections/${sectionId}/articles.json`
      : `https://${subdomain}.zendesk.com/api/v2/help_center/articles.json`;
    const res = await axios.post(url, payload, {
      auth: { username: `${email}/token`, password: apiToken },
      headers: { "Content-Type": "application/json" },
      timeout: 15000,
    });
    return res.data.article;
  }

  async saveKBDocument({ articleId, title, filename, chunkIndex, totalChunks }) {
    await db.cypher(
      `MERGE (k:KBDocument { articleId: $articleId })
       SET k.title=$title, k.filename=$filename, k.chunkIndex=$chunkIndex, k.totalChunks=$totalChunks, k.createdAt=datetime()`,
      { articleId: String(articleId), title, filename, chunkIndex, totalChunks }
    );
  }

  async saveKBMemory(phone, callId, question, articleIds) {
    if (!articleIds.length) return;
    await db.cypher(
      `MATCH (c:Caller { phone: $phone })
       CREATE (m:Memory { text: $text, timestamp: datetime(), callId: $callId, source: 'zendesk_kb' })
       CREATE (c)-[:HAS_MEMORY]->(m)`,
      { phone, callId, text: `KB lookup: "${question}" → ${articleIds.length} article(s)` }
    );
    for (const id of articleIds) {
      await db.cypher(
        `MATCH (c:Caller { phone: $phone })
         MATCH (k:KBDocument { articleId: $articleId })
         MERGE (c)-[r:USED_KB_DOC]->(k)
         ON CREATE SET r.firstUsed=datetime(), r.count=1, r.sampleQuestion=$question
         ON MATCH  SET r.lastUsed=datetime(),  r.count=r.count+1`,
        { phone, articleId: String(id), question }
      ).catch((e) => log.warn("linkCallerToKBDoc:", e.message));
    }
  }

  async listKBDocuments() {
    return db.cypher(
      `MATCH (k:KBDocument)
       RETURN k.articleId AS articleId, k.title AS title, k.filename AS filename,
              k.chunkIndex AS chunkIndex, k.totalChunks AS totalChunks
       ORDER BY k.createdAt DESC LIMIT 100`
    );
  }

  async getFullGraph() {
    return db.cypher(
      `MATCH (c:Caller)-[r]->(n)
       RETURN c.phone AS caller, type(r) AS rel, labels(n) AS nodeType,
         CASE labels(n)[0]
           WHEN 'Memory'     THEN n.text
           WHEN 'Entity'     THEN n.name
           WHEN 'KBDocument' THEN n.title
           ELSE toString(n)
         END AS value
       LIMIT 200`
    );
  }
}

module.exports = new ZendeskService();
