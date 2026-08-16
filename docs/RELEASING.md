# 发版说明

正式版本由 GitHub Actions 的 **Release Desktop Apps** 工作流发布。工作流会校验项目版本和中英文更新记录，并行构建以下安装包：

- macOS Apple Silicon（ARM64）
- macOS Intel（x64）
- Windows x64

三个平台全部构建和签名成功后，工作流才会创建 GitHub Release、`latest.json` 在线更新清单和 SHA-256 校验文件。

## 首次配置

更新私钥保存在本机：

```text
/Users/chen/.tauri/mimi-router-updater.key
```

该文件不能提交到仓库。首次启用工作流前，需要在 GitHub 仓库的 **Settings → Secrets and variables → Actions** 中新增：

- `TAURI_SIGNING_PRIVATE_KEY`：私钥文件的完整内容
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`：当前密钥没有密码，可不创建或留空

必须另外备份私钥。丢失私钥后，已经安装的旧版本将无法验证未来更新。

## 发布步骤

1. 完成功能开发并按规则更新版本号、中英文更新记录。
2. 提交并推送代码到 GitHub。
3. 打开 **Actions → Release Desktop Apps → Run workflow**。
4. 输入与项目一致的版本号，例如 `0.2.14`。
5. 在确认框输入 `RELEASE`。
6. 根据需要选择是否标记为预发布版本，然后运行工作流。

同一版本已经存在 Git Tag 时，工作流会拒绝重复发布。
