const axios = require("axios");
const OpenAI = require("openai");

const config = require("./config");
const { recallMemory, saveMemory } = require("./memory");
const {
  fetchZendeskArticles,
  saveKBMemory,
} = require("./knowledge");

const openai = new OpenAI({
  apiKey: config.openai.apiKey,
});

const searchCache = new Map();

const NEVER_SEARCH = [
  /^(hi|hello|hey|thanks|thank you|bye|goodbye|ok|okay|yes|no|sure|great|good)\b/i,
  /\b(explain|define|what is a|how does|tell me about)\b.{0,50}\b(physics|chemistry|biology|math|gravity|atom|dna|photosynthesis|quantum)\b/i,
  /\b(recipe|how to cook|how to make|how to bake)\b/i,
  /\b(how to (code|program|write|implement)|what is (a )?(function|class|variable|loop|array|api))\b/i,
  /\b(capital of|flag of|currency of|who invented|who wrote)\b/i,
];

async function shouldSearch(query) {
  if (!query?.trim()) return false;
  if (!config.tavily?.apiKey) return false;

  if (NEVER_SEARCH.some((r) => r.test(query))) {
    return false;
  }

  const livePatterns = [
    /\b(today|latest|current|recent|news)\b/i,
    /\b(weather|temperature|forecast)\b/i,
    /\b(stock|price|market)\b/i,
    /\b(score|match|game|result)\b/i,
    /\b(who is the ceo|ceo of)\b/i,
    /\b(released|launch|announcement)\b/i,
    /\b(this week|this month|right now)\b/i,
  ];

  return livePatterns.some((r) => r.test(query));
}

async function tavilySearch(query) {
  try {
    const cacheKey = query.toLowerCase().trim();

    const cached = searchCache.get(cacheKey);

    if (
      cached &&
      Date.now() - cached.timestamp < 300000
    ) {
      return cached.value;
    }

    const { data } = await axios.post(
      "https://api.tavily.com/search",
      {
        api_key: config.tavily.apiKey,
        query,
        max_results: 5,
        search_depth: "basic",
        include_answer: true,
      },
      {
        timeout: 10000,
      }
    );

    const snippets = [];

    if (data.answer) {
      snippets.push(`[Answer] ${data.answer}`);
    }

    for (const r of (data.results || []).slice(0, 4)) {
      if (!r.content) continue;

      snippets.push(
        `[Web] ${r.title}: ${r.content.slice(0, 300)}`
      );
    }

    const result = snippets.length
      ? `Live search for "${query}":\n${snippets.join("\n")}`
      : null;

    searchCache.set(cacheKey, {
      value: result,
      timestamp: Date.now(),
    });

    return result;
  } catch (err) {
    console.error(
      "Tavily error:",
      err?.message || err
    );
    return null;
  }
}

async function askOpenAI(
  history,
  searchCtx,
  memoryCtx,
  zendeskCtx
) {
  try {
    let systemContent = history[0]?.content || "";

    if (memoryCtx) {
      systemContent +=
        "\n\nMemory:\n" +
        memoryCtx.slice(0, 1500);
    }

    if (zendeskCtx) {
      systemContent +=
        "\n\nKnowledge Base:\n" +
        zendeskCtx.slice(0, 2500);
    }

    const trimmedHistory = history.slice(-12);

    const baseMessages = [
      {
        role: "system",
        content: systemContent,
      },
      ...trimmedHistory.slice(1),
    ];

    const messages = searchCtx
      ? [
          ...baseMessages.slice(0, -1),
          {
            role: "user",
            content:
              `${baseMessages.at(-1)?.content || ""}\n\n` +
              `--- Live Search ---\n` +
              `${searchCtx}\n` +
              `---\n\n` +
              `Answer naturally in 2-4 spoken sentences.`,
          },
        ]
      : baseMessages;

    const res =
      await openai.chat.completions.create({
        model: config.openai.model,
        messages,
        temperature: 0.7,
        max_tokens: 200,
      });

    let text =
      res?.choices?.[0]?.message?.content?.trim() ||
      "Sorry, I couldn't generate a response.";

    text = text
      .replace(/\*\*/g, "")
      .replace(/#{1,6}/g, "")
      .replace(/\[(.*?)\]\((.*?)\)/g, "$1")
      .trim();

    if (
      text.length >
      config.openai.maxSpokenChars
    ) {
      text =
        text
          .slice(
            0,
            config.openai.maxSpokenChars
          )
          .trim() + " ... Want more detail?";
    }

    return text;
  } catch (err) {
    console.error(
      "OpenAI error:",
      err?.message || err
    );

    return "Sorry, something went wrong on my end.";
  }
}

async function agentReply(
  history,
  callerPhone,
  callId
) {
  const query =
    [...history]
      .reverse()
      .find((m) => m.role === "user")
      ?.content || "";

  try {
    const [
      memoryCtx,
      needsWeb,
      zendeskResult,
    ] = await Promise.all([
      callerPhone
        ? recallMemory(callerPhone)
        : null,

      shouldSearch(query),

      fetchZendeskArticles(query),
    ]);

    const {
      ctx: zendeskCtx,
      articleIds = [],
    } = zendeskResult || {};

    const searchCtx = needsWeb
      ? await tavilySearch(query)
      : null;

    const reply = await askOpenAI(
      history,
      searchCtx,
      memoryCtx,
      zendeskCtx
    );

    if (callerPhone && query && reply) {
      setImmediate(() => {
        saveMemory(
          callerPhone,
          callId,
          query,
          reply
        ).catch((e) =>
          console.warn(
            "saveMemory:",
            e.message
          )
        );
      });

      if (articleIds.length) {
        setImmediate(() => {
          saveKBMemory(
            callerPhone,
            callId,
            query,
            articleIds
          ).catch((e) =>
            console.warn(
              "saveKBMemory:",
              e.message
            )
          );
        });
      }
    }

    return reply;
  } catch (err) {
    console.error(
      "agentReply error:",
      err?.message || err
    );

    return "Sorry, I had trouble processing that request.";
  }
}

module.exports = {
  agentReply,
  shouldSearch,
  tavilySearch,
};