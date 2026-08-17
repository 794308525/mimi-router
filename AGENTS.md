# Project Update Rules

- Do not commit, push, package, or publish unless the user explicitly requests it.
- Only build installers for macOS Apple Silicon, macOS Intel, and Windows x64 and create a GitHub Release after the user confirms a release.
- Keep each GitHub Release to six public assets while preserving signed updates: two macOS DMGs, two macOS updater archives, one Windows x64 installer, and `latest.json`; do not publish temporary `.sig` files or checksum lists.
- Do not automatically start or install a development build.
- Keep changes narrowly scoped and avoid unrelated refactoring.
- Every user-facing feature or fix must increment the semantic version before handoff.
- Keep `package.json`, `package-lock.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`, and `src/release-notes.json` on the same version.
- Add matching Chinese and English notes to `src/release-notes.json`, `CHANGELOG.zh-CN.md`, and `CHANGELOG.md` for every version.
- Run `npm run check:version` after updating release metadata.
