# Changelog

This project follows semantic versioning. Every feature update must keep the application version and both language variants of the release notes in sync.

## 0.2.38 - 2026-08-19

- Fixed Codex conversation ID detection by reading thread/session headers, Codex metadata, and compatible body fields so rawchat safety blocks can be tied to the affected conversation.
- Dashboard, request history, and request details now show `initial provider → final provider` when routing switches channels; unchanged and same-provider retries show only one provider.

## 0.2.37 - 2026-08-19

- Cleared rawchat conversation blocks when a provider API key or base URL changes.
- Stopped active circuit-recovery probes cleanly during gateway shutdown.

## 0.2.36 - 2026-08-19

- Added rawchat-only conversation safety blocking: a safety-sensitive-content response now skips only that conversation for the matching rawchat base URL, keeps the provider healthy, and records the session ID in dashboard and request history.

## 0.2.35 - 2026-08-18

- Fixed different-provider race records so a request is marked as raced only after a second provider actually starts; requests without an available fallback remain ordinary requests.

## 0.2.34 - 2026-08-18

- Added background circuit recovery probes for transient upstream failures while keeping the configured cooldown fixed after failed half-open probes.

## 0.2.33 - 2026-08-18

- Fixed macOS Intel releases failing during DMG Finder customization by using a CI-compatible DMG generation path.

## 0.2.32 - 2026-08-18

- Fixed the dashboard final-provider hint so it is hidden for requests without a retry or with same-provider retries.

## 0.2.31 - 2026-08-18

- Increased body, model/provider, and supporting text sizes on the dashboard and request history for better readability.

## 0.2.30 - 2026-08-18

- Dashboard recent usage now shows the final provider only when it differs from the first attempt; same-provider retries no longer repeat the provider name.

## 0.2.29 - 2026-08-18

- Adaptive first-token timing now records each upstream attempt, includes race and first-token-timeout samples, and backfills historical attempt data.
- Adaptive sampling now uses up to 200 samples with a 20-sample minimum, refreshes every five minutes with bounded step changes, and different-provider races avoid known unhealthy providers.

## 0.2.28 - 2026-08-18

- Request detail dialogs can now be closed by clicking the surrounding backdrop without changing confirmation-dialog behavior.

## 0.2.27 - 2026-08-18

- Dashboard records now omit the redundant attempt count when a request used only one upstream attempt.

## 0.2.26 - 2026-08-18

- Request details opened from the dashboard now stay in the dashboard, show attempt and final-provider information, and stop their live timer as soon as the request reaches a terminal state.

## 0.2.25 - 2026-08-18

- HTTP `200` stream failure events without a specific classification code are now retried as upstream semantic failures, still bounded by the provider and route-group retry settings.

## 0.2.24 - 2026-08-18

- Based on production request records, HTTP `200` failure events containing `Upstream request failed` or WebSocket `1006 unexpected EOF` now retry as transient server failures.

## 0.2.23 - 2026-08-18

- Treat `openai_error` events inside HTTP `200` upstream streams as transient server failures so configured retries and failover can proceed.

## 0.2.22 - 2026-08-18

- Adaptive first-token previews now refresh as soon as a new eligible request completes, while the cached value for that provider and model is invalidated.
- Windows online updates now stop the bundled Node gateway after downloading and before launching the installer, with an installer-side targeted cleanup to prevent `node.exe` file-lock failures.

## 0.2.21 - 2026-08-18

- Fixed reused upstream connections being interrupted by the connection timeout while a large request body was still uploading: the connection timer now stops as soon as the request starts writing to the connection.
- Both normal forwarding and same-provider racing cover reused connections, with regression coverage for delayed uploads.

## 0.2.20 - 2026-08-18

- Fixed the connection timeout timer from covering the response-header wait: once the connection is ready or the request body is sent, a slow response header is no longer misclassified as a connection timeout.
- Normal forwarding and same-provider racing now share real network-phase callbacks while preserving total-request, first-token, and streaming timeouts; regression coverage prevents unnecessary retries, circuit penalties, and missing usage records.

## 0.2.19 - 2026-08-17

- Streaming requests now use phase-aware timeouts: first-token handling remains unchanged, while streams stop after 20 seconds without upstream data or 40 seconds without meaningful progress, with a 900-second total safety limit.
- Text, reasoning, tool-argument deltas, and managed-tool work states refresh the progress deadline; SSE heartbeats and comments no longer hide stalled upstream streams.
- Responses streams stop monitoring immediately after completed, incomplete, or failed terminal events; Chat Completions waits for `[DONE]` so final usage remains available.
- Post-first-token timeouts no longer switch providers transparently; Responses and Chat clients receive protocol-compatible stream errors while the exact failure and provider health impact are recorded.
- Provider settings now expose total, post-first-token no-data, and post-first-token no-progress timeouts; only recognized legacy default combinations are migrated once, preserving user-customized values.

## 0.2.18 - 2026-08-17

- Reduced each GitHub Release to six public assets: two macOS installers, two macOS updater archives, the Windows x64 installer, and the updater manifest.
- Signature files are now used only as temporary workflow inputs while preserving signed online updates for macOS and Windows.
- Adaptive first-token limits now use the P75 of normal single-attempt successes plus 2 seconds, constrained to 8–15 seconds, while excluding retries, races, and failovers.
- Same-provider racing now supports client-executed `function` and `custom` tools; managed upstream tools continue to use the safer non-racing path.
- Request details now record the applied first-token limit, whether racing started, and which attempt won.
- Stream observations now distinguish the longest upstream chunk gap, the longest meaningful-output gap, and the final idle period before an upstream failure or timeout; normal terminal events stop sampling immediately, and current routing and timeout behavior remains unchanged.

## 0.2.17 - 2026-08-17

- Added same-provider retries for transient HTTP `408`, `425`, `502`, `503`, `504`, and Cloudflare `520-527` failures.
- HTML `400` responses with clear nginx, Cloudflare, or OpenResty gateway signatures are retried without affecting ordinary JSON request errors.
- Wrapped `524`, gateway timeout, and transient connection failures inside HTTP `200` streams are now detected before configured retries and failover.
- Explicitly unsupported errors such as `501` are not retried, while unsupported Chat endpoints continue to use the Responses compatibility bridge.

## 0.2.16 - 2026-08-17

- Added an OpenAI Chat Completions endpoint with native streaming and non-streaming Chat forwarding.
- Channels that explicitly do not support Chat now fall back to streaming Responses, translated into Chat text, tool calls, finish reasons, and token usage.
- Added persistent Chat capability detection per channel while preventing rate limits, authentication failures, timeouts, and server errors from being misclassified as unsupported.
- Request details and upstream attempts now record the client protocol, upstream protocol, and compatibility conversion path.

## 0.2.15 - 2026-08-16

- Added server-side pagination, status and provider filters, and live refresh enabled by default for request records.
- Provider editing now selects a test model from the synchronized system catalog, with `gpt-5.6-terra` as the default for new providers.
- Provider benchmarks now use each provider's configured test model and show the actual model in benchmark results.

## 0.2.14 - 2026-08-16

- Added startup update checks and manual checks on the About page, with release details, download progress, and restart-to-install support.
- Integrated official Tauri update signature verification so the app only installs macOS or Windows packages signed by the project key.
- Added a manually confirmed GitHub Release workflow that builds macOS Apple Silicon, macOS Intel, and Windows x64 packages in parallel.
- A bilingual GitHub Release, updater manifest, signatures, and SHA-256 checksums are now created only after all three platforms build successfully.
- Expanded the README project overview, author contact details, and release documentation.

## 0.2.13 - 2026-08-16

- Added normal, circuit-open, observing, and disabled provider counts to the dashboard while hiding provider names entirely in privacy mode.
- Moved provider names onto the reasoning-effort line in recent usage records to reduce vertical space while respecting privacy settings.
- Added Today, Yesterday, and 7-day ranges to provider management, with requests, average TTFT, error rate, spend, and cache rate per provider.
- Added a default-masked eye control to provider management; visible provider names now open the website origin derived from the Base URL.

## 0.2.12 - 2026-08-16

- Added concurrent test-all and reset-all circuit actions to provider management, with a single refresh and summarized results.
- Standardized anonymized provider labels, replaced the privacy switch with a compact eye button, and rebalanced the model and token columns in recent usage records.
- Added priority, spend, speed, and cache-rate sorting to Provider Overview, with every metric scoped to the selected time range.
- Removed the separate usage-trend range selector so the chart follows the Today, Yesterday, and 7-day range selected in Usage Overview.

## 0.2.11 - 2026-08-16

- Adaptive mode now displays a reference timeout calculated by the routing engine, with its sample source and dynamic behavior explained.

## 0.2.10 - 2026-08-16

- Renamed the first-token control to better describe slow-response switching and display a dynamic marker in adaptive mode without changing the saved fixed timeout.
- Renamed provider performance to Provider Overview and clearly labeled the provider-name privacy mode.
- Active request durations now continuously retain one decimal place for clearer real-time updates.

## 0.2.9 - 2026-08-16

- Moved live requests ahead of local requests and consolidated first-token controls and runtime statistics into one compact overview area.
- Reduced vertical dashboard usage to expose more of the trend chart and request history above the fold.

## 0.2.8 - 2026-08-16

- Merged usage and live status into a single left-column card, with provider performance moved up and matched to the left-column height.
- Removed the provider performance subtitle and enabled internal scrolling for overflow content.

## 0.2.7 - 2026-08-16

- Identical requested and returned models are no longer repeated, while model changes are highlighted with a clear arrow.
- Fixed token and cache-rate overlap in narrow columns and increased the minimum interface font size.

## 0.2.6 - 2026-08-16

- Usage trends now use boundary-constrained smooth curves for softer transitions between data points.

## 0.2.5 - 2026-08-16

- Usage trends now overlay all metrics by default and allow each series to be toggled independently from the legend.

## 0.2.4 - 2026-08-16

- Added weighted cache hit rates across request records, summaries, provider performance, and usage trends.
- Fixed usage trends and provider statistics dropping known token usage when one token field is missing.

## 0.2.3 - 2026-08-16

- Fixed false version-check failures with CRLF line endings so Windows installer builds can complete.

## 0.2.2 - 2026-08-16

- Request history now captures reasoning effort and the model actually returned by upstream responses across streaming, non-streaming, and race requests.
- Dashboard and request history now stack input, cached, and output tokens vertically while using narrower status and action columns.
- Reduced the active-request interrupt button size to leave more horizontal space for model and routing details.

## 0.2.1 - 2026-08-16

- Codex takeover now distinguishes new, standard, custom-provider, and already-managed configurations and offers the appropriate action for each state.
- Existing custom providers are preserved by default: only the API URL and, when enabled, the local authentication key are updated while the provider ID, model, and other settings remain unchanged.
- An optional independent-provider flow remains available with a clear warning about possible session recognition impact.

## 0.2.0 - 2026-08-16

- Added OpenAI-compatible API key authentication with copy, reset, and persistent local gateway credentials.
- Expanded dashboard trends with average time to first token, cost, and error count; provider performance now follows the selected time range and supports masked names.
- Fixed the Windows backend launch path and removed the extra console window for more reliable packaged startup.
- Added GitHub project links to the brand area and settings page.
- Added the About page, version consistency checks, and bilingual release notes.

## 0.1.1 - 2026-08-15

- Added a persistent benchmark timeout; timed-out runs are marked failed before continuing to the next attempt.
- Fixed completed requests being misclassified as client disconnects and repaired derived historical data at startup.
- Expanded automatic retries for HTTP 429, capacity, and in-stream failures, with failure reasons shown in request records.
- Improved recovery when every provider is circuit-broken by probing the earliest opened circuit first.

## 0.1.0 - 2026-08-15

- Released the local-first Responses API smart routing gateway and desktop manager.
- Added support for `/v1/responses`, `/v1/responses/compact`, and `/v1/models`.
- Added provider management, drag sorting, benchmarking, automatic retries, failover, and circuit recovery.
- Added request history, token and cost statistics, time to first token, and stage-level latency analysis.
- Added Codex configuration takeover and desktop packaging for macOS and Windows.
