# Project Update Rules

- Every user-facing feature or fix must increment the semantic version before handoff.
- Keep `package.json`, `package-lock.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`, and `src/release-notes.json` on the same version.
- Add matching Chinese and English notes to `src/release-notes.json`, `CHANGELOG.zh-CN.md`, and `CHANGELOG.md` for every version.
- Run `npm run check:version` after updating release metadata.
