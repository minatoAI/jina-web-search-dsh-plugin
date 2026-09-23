/**
 * Model-facing contract of the web search tool (pure data, zero deps).
 *
 * `name`, `description` and `parameters` are forwarded verbatim to the model
 * API (index.js registers this tool by spreading this constant), so this file
 * is the entire selection signal the model sees for the web search tool:
 * `{ name, description, parameters }` — the tool name, the task-first
 * description with a when-to-use trigger, and the parameter guidance.
 */

export const WEB_SEARCH_TOOL = {
  name: 'jina_web_search',
  description: 'Search the web for current information via Jina, returning an optional summary plus a list of source URLs with official sources (government / company sites) ranked first. Use this whenever the user needs up-to-date web content or news — it supports time filters (last hour/day/week/month/year), region and language hints, and the images/blog domains. The built-in web_search is an alternative with broader general coverage when recency or official-source-first ranking does not matter. For academic papers, prefer jina_search_arxiv / jina_search_ssrn.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      query: { type: 'string', description: 'The search query. One string here — not the built-in web_search\'s `queries` array (that key is rejected). Pair it with the time parameter to narrow recency-sensitive searches (news, events, current info).' },
      type: { type: 'string', enum: ['web', 'arxiv', 'ssrn', 'images', 'blog'], description: 'Search domain. Default: web. For academic papers prefer the jina_search_arxiv / jina_search_ssrn tools.' },
      num: { type: 'number', description: 'Number of results. Default: 5.' },
      time: { type: 'string', enum: ['h', 'd', 'w', 'm', 'y'], description: 'Only results from the last hour/day/week/month/year.' },
      location: { type: 'string', description: 'Location hint for search results.' },
      gl: { type: 'string', description: 'Country code, e.g. us, de, jp.' },
      hl: { type: 'string', description: 'Language code, e.g. en, zh-cn.' },
      json: { type: 'boolean', description: 'Return the raw JSON response instead of formatted results.' },
      apiKey: { type: 'string', description: 'Optional Jina API key override.' },
    },
    required: ['query'],
  },
}
