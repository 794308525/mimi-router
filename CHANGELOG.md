# Changelog

This project follows semantic versioning. Every feature update must keep the application version and both language variants of the release notes in sync.

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
