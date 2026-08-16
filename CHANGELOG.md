# Changelog

This project follows semantic versioning. Every feature update must keep the application version and both language variants of the release notes in sync.

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
