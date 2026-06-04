const axios  = require("axios");
const config = require("../config");
const Logger = require("../utils/logger");

const log = new Logger("SearchAgent");

const NEVER_SEARCH = [
  /^(hi|hello|hey|thanks|thank you|bye|goodbye|ok|okay|yes|no|sure|great|good)\b/i,
  /\b(explain|define|what is a|how does|tell me about)\b.{0,50}\b(physics|chemistry|biology|math|gravity|atom|dna|photosynthesis|quantum)\b/i,
  /\b(recipe|how to cook|how to make|how to bake)\b/i,
  /\b(how to (code|program|write|implement)|what is (a )?(function|class|variable|loop|array|api))\b/i,
  /\b(capital of|flag of|currency of|who invented|who wrote)\b/i,
];

const LIVE_DATA = [
  /\b(today|latest|current|recent|news)\b/i,
  /\b(weather|temperature|forecast)\b/i,
  /\b(stock|price|market)\b/i,
  /\b(score|match|game|result)\b/i,
  /\b(who is the ceo|ceo of)\b/i,
  /\b(released|launch|announcement)\b/i,
  /\b(this week|this month|right now)\b/i,
];

class SearchAgent {
  #cache = new Map();
  #TTL   = 5 * 60 * 1000;

  async shouldSearch(query) {
    if (!query?.trim())           return false;
    if (!config.tavily?.apiKey)   return false;
    if (NEVER_SEARCH.some((r) => r.test(query))) return false;
    return LIVE_DATA.some((r) => r.test(query));
  }

  async search(query) {
    const key    = query.toLowerCase().trim();
    const cached = this.#cache.get(key);
    if (cached && Date.now() - cached.timestamp < this.#TTL) return cached.value;
    try {
      const { data } = await axios.post(
        "https://api.tavily.com/search",
        { api_key: config.tavily.apiKey, query, max_results: 5, search_depth: "basic", include_answer: true },
        { timeout: 10000 }
      );
      const snippets = [];
      if (data.answer) snippets.push(`[Answer] ${data.answer}`);
      for (const r of (data.results || []).slice(0, 4)) {
        if (r.content) snippets.push(`[Web] ${r.title}: ${r.content.slice(0, 300)}`);
      }
      const result = snippets.length ? `Live search for "${query}":\n${snippets.join("\n")}` : null;
      this.#cache.set(key, { value: result, timestamp: Date.now() });
      return result;
    } catch (err) {
      log.error("Tavily search failed:", err.message);
      return null;
    }
  }

  async searchIfNeeded(query) {
    return (await this.shouldSearch(query)) ? this.search(query) : null;
  }
}

module.exports = new SearchAgent();
