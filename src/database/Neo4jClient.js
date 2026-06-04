const neo4j  = require("neo4j-driver");
const config = require("../config");
const Logger = require("../utils/logger");

const log = new Logger("Neo4j");

class Neo4jClient {
  #driver = null;

  getDriver() {
    if (!this.#driver) {
      const { uri, user, pass } = config.neo4j;
      if (!uri || !pass) throw new Error("NEO4J_URI and NEO4J_PASS are required");
      this.#driver = neo4j.driver(uri, neo4j.auth.basic(user, pass));
      log.info(`Connected → ${uri}`);
    }
    return this.#driver;
  }

  async cypher(query, params = {}) {
    const session = this.getDriver().session();
    try {
      const result = await session.run(query, params);
      return result.records;
    } catch (err) {
      log.error("Query failed:", err.message);
      return [];
    } finally {
      await session.close();
    }
  }

  async initSchema() {
    const constraints = [
      "CREATE INDEX caller_phone IF NOT EXISTS FOR (c:Caller)     ON (c.phone)",
      "CREATE INDEX entity_name  IF NOT EXISTS FOR (e:Entity)     ON (e.name)",
      "CREATE INDEX kb_doc_id    IF NOT EXISTS FOR (k:KBDocument) ON (k.articleId)",
    ];
    try {
      for (const q of constraints) await this.cypher(q);
      log.info("Schema ready");
    } catch (err) {
      log.warn("Schema init warning:", err.message);
    }
  }

  async close() {
    if (this.#driver) {
      await this.#driver.close();
      this.#driver = null;
      log.info("Driver closed");
    }
  }
}

module.exports = new Neo4jClient();
