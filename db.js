const neo4j = require("neo4j-driver");
const config = require("./config");

let _driver = null;

function getDriver() {
  if (!_driver) {
    const { uri, user, pass } = config.neo4j;
    if (!uri || !pass) throw new Error("NEO4J_URI and NEO4J_PASS required");
    _driver = neo4j.driver(uri, neo4j.auth.basic(user, pass));
    console.log("🧠 Neo4j connected →", uri);
  }
  return _driver;
}

async function cypher(query, params = {}) {
  const session = getDriver().session();
  try {
    const result = await session.run(query, params);
    return result.records;
  } catch (err) {
    console.error("Neo4j error:", err.message);
    return [];
  } finally {
    await session.close();
  }
}

async function initGraphSchema() {
  try {
    await cypher(`CREATE INDEX caller_phone IF NOT EXISTS FOR (c:Caller) ON (c.phone)`);
    await cypher(`CREATE INDEX entity_name IF NOT EXISTS FOR (e:Entity) ON (e.name)`);
    await cypher(`CREATE INDEX kb_doc_id IF NOT EXISTS FOR (k:KBDocument) ON (k.articleId)`);
    console.log("🧠 Neo4j schema ready");
  } catch (err) {
    console.warn("Neo4j schema init:", err.message);
  }
}

module.exports = { cypher, initGraphSchema };
