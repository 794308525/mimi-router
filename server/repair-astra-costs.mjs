import { calculateOfficialCost } from "./pricing.mjs";

export function repairAstraCosts(db, engine) {
  const ids = new Set();
  let repaired = 0;
  db.exec("BEGIN IMMEDIATE");
  try {
    const rows = db.prepare(`SELECT a.*, r.upstream_model, r.requested_model
      FROM request_attempts a JOIN requests r ON r.id = a.request_id
      WHERE r.ended_at IS NOT NULL AND a.total_cost_usd IS NULL
      AND (a.input_tokens IS NOT NULL OR a.output_tokens IS NOT NULL)`).all();
    for (const row of rows) {
      const model = row.actual_upstream_model || row.upstream_model || row.requested_model;
      if (model !== "gpt-6-astra" && !model.startsWith("gpt-6-astra-")) continue;
      const cost = calculateOfficialCost({ model, inputTokens: row.input_tokens,
        outputTokens: row.output_tokens, cachedTokens: row.cached_tokens,
        cacheCreationTokens: row.cache_creation_tokens });
      const { long_context_pricing, ...fields } = cost;
      fields.cost_status = row.status === "completed" ? "confirmed" : "partial";
      db.prepare(`UPDATE request_attempts SET ${Object.keys(fields).map((key) => `${key} = ?`).join(",")} WHERE id = ?`)
        .run(...Object.values(fields), row.id);
      ids.add(row.request_id);
      repaired++;
    }
    for (const id of ids) engine.syncRequestUsage(id);
    db.exec("COMMIT");
    return { attempts: repaired, requests: ids.size };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
