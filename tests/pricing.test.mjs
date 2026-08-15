import assert from "node:assert/strict";
import { test } from "node:test";
import { calculateOfficialCost, parseOfficialPricingPage, resolveOfficialPricing } from "../server/pricing.mjs";

test("estimates gpt-5.6-sol usage with official token prices", () => {
  const result = calculateOfficialCost({
    model: "gpt-5.6-sol",
    inputTokens: 687,
    outputTokens: 8,
  });
  assert.equal(result.total_cost_usd, 0.003675);
  assert.equal(result.pricing_model, "gpt-5.6-sol");
});

test("always bills at official 1x pricing regardless of a channel multiplier", () => {
  const usage = {
    model: "gpt-5.6-sol",
    inputTokens: 687,
    outputTokens: 8,
  };
  const official = calculateOfficialCost(usage);
  const withChannelMultiplier = calculateOfficialCost({ ...usage, costMultiplier: 0.25 });
  assert.equal(withChannelMultiplier.total_cost_usd, official.total_cost_usd);
});

test("prices cached input and cache writes separately", () => {
  const result = calculateOfficialCost({
    model: "gpt-5.6-sol",
    inputTokens: 1000,
    cachedTokens: 400,
    cacheCreationTokens: 100,
    outputTokens: 100,
  });
  assert.equal(result.input_cost_usd, 0.0025);
  assert.equal(result.cached_input_cost_usd, 0.0002);
  assert.equal(result.cache_creation_cost_usd, 0.000625);
  assert.equal(result.output_cost_usd, 0.003);
  assert.equal(result.total_cost_usd, 0.006325);
});

test("applies official long-context multipliers above 272K input tokens", () => {
  const result = calculateOfficialCost({
    model: "gpt-5.6-terra",
    inputTokens: 300_000,
    outputTokens: 10_000,
  });
  assert.equal(result.long_context_pricing, true);
  assert.equal(result.total_cost_usd, 1.38);
});

test("does not invent a price for an unknown model", () => {
  assert.equal(resolveOfficialPricing("unknown-model"), null);
  assert.equal(calculateOfficialCost({ model: "unknown-model", inputTokens: 1, outputTokens: 1 }), null);
});

test("parses the Standard catalog and ignores other pricing tiers", () => {
  const standard = encodedPricingIsland("standard", [
    ["gpt-next", 3, 0.3, 3.75, 18],
    ["gpt-legacy", 1, null, 4],
    ["gpt-context (<272K context length)", 2, 0.2, "-", 12],
  ], 1);
  const batch = encodedPricingIsland("batch", [
    ["gpt-next", 1.5, 0.15, 1.875, 9],
    ["gpt-legacy", 0.5, null, 2],
    ["gpt-context", 1, 0.1, "-", 6],
  ], 1);
  const models = parseOfficialPricingPage(`${batch}${standard}`);
  assert.equal(models.length, 3);
  assert.equal(models[0].model, "gpt-next");
  assert.equal(models[0].input_per_million, 3);
  assert.equal(models[0].long_context_output_per_million, 27);
  assert.equal(models[1].cache_write_per_million, null);
  assert.equal(models[2].model, "gpt-context");
  assert.equal(models[2].long_context_threshold, 272_000);
});

function encodedPricingIsland(tier, rows, latestCount) {
  const encodedRows = rows.map((row) => [1, row.map((value) => [0, value])]);
  const props = JSON.stringify({
    tier: [0, tier],
    collapsedLatestRowCount: [0, latestCount],
    rows: [1, encodedRows],
  })
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return `<astro-island component-export="TextTokenPricingTables" props="${props}"></astro-island>`;
}
