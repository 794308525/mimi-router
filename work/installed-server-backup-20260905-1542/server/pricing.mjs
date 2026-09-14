export const OFFICIAL_PRICING_URL = "https://developers.openai.com/api/docs/pricing";
const DEFAULT_LONG_CONTEXT_THRESHOLD = 272_000;

export const OFFICIAL_PRICING = Object.freeze([
  Object.freeze({
    model: "gpt-5.6-sol",
    display_name: "GPT-5.6 Sol",
    input_per_million: 5,
    cached_input_per_million: 0.5,
    cache_write_per_million: 6.25,
    output_per_million: 30,
    long_context_threshold: DEFAULT_LONG_CONTEXT_THRESHOLD,
    long_context_input_per_million: 10,
    long_context_cached_input_per_million: 1,
    long_context_cache_write_per_million: 12.5,
    long_context_output_per_million: 45,
    source_url: OFFICIAL_PRICING_URL,
  }),
  Object.freeze({
    model: "gpt-5.6-terra",
    display_name: "GPT-5.6 Terra",
    input_per_million: 2,
    cached_input_per_million: 0.2,
    cache_write_per_million: 2.5,
    output_per_million: 12,
    long_context_threshold: DEFAULT_LONG_CONTEXT_THRESHOLD,
    long_context_input_per_million: 4,
    long_context_cached_input_per_million: 0.4,
    long_context_cache_write_per_million: 5,
    long_context_output_per_million: 18,
    source_url: OFFICIAL_PRICING_URL,
  }),
]);

export function listOfficialPricing() {
  return OFFICIAL_PRICING.map((pricing) => ({ ...pricing }));
}

export function resolveOfficialPricing(model, catalog = OFFICIAL_PRICING) {
  const normalized = String(model || "").trim().toLowerCase();
  if (!normalized) return null;
  return catalog.find((pricing) => (
    normalized === pricing.model.toLowerCase() || normalized.startsWith(`${pricing.model.toLowerCase()}-`)
  )) ?? null;
}

export function calculateOfficialCost({
  model,
  inputTokens,
  outputTokens,
  cachedTokens = 0,
  cacheCreationTokens = 0,
  pricing: suppliedPricing,
}) {
  const pricing = suppliedPricing === undefined ? resolveOfficialPricing(model) : suppliedPricing;
  if (!pricing) return null;

  const input = tokenCount(inputTokens);
  const output = tokenCount(outputTokens);
  const cached = Math.min(tokenCount(cachedTokens), input);
  const cacheCreation = Math.min(tokenCount(cacheCreationTokens), input - cached);
  const uncached = Math.max(0, input - cached - cacheCreation);
  const longContext = Boolean(pricing.long_context_threshold && input > pricing.long_context_threshold);
  const inputRate = longContext
    ? pricing.long_context_input_per_million ?? pricing.input_per_million
    : pricing.input_per_million;
  const cachedRate = longContext
    ? pricing.long_context_cached_input_per_million ?? inputRate
    : pricing.cached_input_per_million ?? inputRate;
  const cacheWriteRate = longContext
    ? pricing.long_context_cache_write_per_million ?? inputRate
    : pricing.cache_write_per_million ?? inputRate;
  const outputRate = longContext
    ? pricing.long_context_output_per_million ?? pricing.output_per_million
    : pricing.output_per_million;

  const inputCost = cost(uncached, inputRate);
  const cachedInputCost = cost(cached, cachedRate);
  const cacheCreationCost = cost(cacheCreation, cacheWriteRate);
  const outputCost = cost(output, outputRate);

  return {
    input_cost_usd: inputCost,
    cached_input_cost_usd: cachedInputCost,
    cache_creation_cost_usd: cacheCreationCost,
    output_cost_usd: outputCost,
    total_cost_usd: rounded(inputCost + cachedInputCost + cacheCreationCost + outputCost),
    pricing_model: pricing.model,
    pricing_source: pricing.source_url,
    long_context_pricing: longContext,
  };
}

export async function fetchOfficialPricing(fetchImpl = fetch) {
  const response = await fetchImpl(OFFICIAL_PRICING_URL, {
    headers: {
      accept: "text/html,application/xhtml+xml",
      "user-agent": "Codex-Relay-Router/0.1",
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`OpenAI 官方定价页返回 ${response.status}`);
  const html = await response.text();
  const models = parseOfficialPricingPage(html);
  return {
    models,
    source_url: OFFICIAL_PRICING_URL,
    updated_at: new Date().toISOString(),
  };
}

export function parseOfficialPricingPage(html) {
  const islands = String(html).match(/<astro-island\b[^>]*>/gi) ?? [];
  let standard = null;
  for (const island of islands) {
    if (!island.includes('component-export="TextTokenPricingTables"')) continue;
    const encoded = island.match(/\bprops="([^"]+)"/i)?.[1];
    if (!encoded) continue;
    try {
      const props = unwrapAstroValue(JSON.parse(decodeHtmlAttribute(encoded)));
      if (props?.tier === "standard") {
        standard = props;
        break;
      }
    } catch {
      // Continue searching in case another island is still parseable.
    }
  }
  if (!standard || !Array.isArray(standard.rows)) {
    throw new Error("无法识别 OpenAI 官方 Standard 定价表");
  }

  const latestCount = Math.max(0, Number(standard.collapsedLatestRowCount) || 0);
  const models = [];
  const seen = new Set();
  for (const [index, row] of standard.rows.entries()) {
    if (!Array.isArray(row) || row.length < 4) continue;
    const rawModel = String(row[0] ?? "").trim();
    const contextMatch = rawModel.match(/\(<\s*([\d.]+)K\s+context length\)/i);
    const model = rawModel.replace(/\s*\(<[^)]+context length\)\s*$/i, "").trim();
    if (!model || seen.has(model)) continue;

    const input = priceValue(row[1]);
    const cached = priceValue(row[2]);
    const hasCacheWrite = row.length >= 5;
    const cacheWrite = hasCacheWrite ? priceValue(row[3]) : null;
    const output = priceValue(hasCacheWrite ? row[4] : row[3]);
    if (input == null || output == null) continue;

    const threshold = contextMatch
      ? Math.round(Number(contextMatch[1]) * 1000)
      : index < latestCount ? DEFAULT_LONG_CONTEXT_THRESHOLD : null;
    models.push({
      model,
      display_name: model,
      input_per_million: input,
      cached_input_per_million: cached,
      cache_write_per_million: cacheWrite,
      output_per_million: output,
      long_context_threshold: threshold,
      long_context_input_per_million: threshold ? input * 2 : null,
      long_context_cached_input_per_million: threshold && cached != null ? cached * 2 : null,
      long_context_cache_write_per_million: threshold && cacheWrite != null ? cacheWrite * 2 : null,
      long_context_output_per_million: threshold ? output * 1.5 : null,
      source_url: OFFICIAL_PRICING_URL,
    });
    seen.add(model);
  }

  if (models.length < 3) throw new Error("OpenAI 官方定价表内容不完整，已保留上次价格");
  return models;
}

function unwrapAstroValue(value) {
  if (Array.isArray(value) && value.length === 2 && Number.isInteger(value[0])) {
    if (value[0] === 0) return unwrapAstroValue(value[1]);
    if (value[0] === 1 && Array.isArray(value[1])) return value[1].map(unwrapAstroValue);
    return unwrapAstroValue(value[1]);
  }
  if (Array.isArray(value)) return value.map(unwrapAstroValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, unwrapAstroValue(item)]));
  }
  return value;
}

function decodeHtmlAttribute(value) {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function priceValue(value) {
  if (value == null || value === "-") return null;
  const parsed = Number(String(value).replace(/^\$/, ""));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function tokenCount(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

function cost(tokens, perMillion) {
  return rounded((tokens * perMillion) / 1_000_000);
}

function rounded(value) {
  return Math.round((value + Number.EPSILON) * 1_000_000_000_000) / 1_000_000_000_000;
}
