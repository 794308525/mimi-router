# Codex Relay Router

Codex Relay Router 是一个独立的本地 Responses API 路由网关和管理界面。它与 CC Switch 分开运行：

- CC Switch 默认端口：`15721`
- Codex Relay Router 默认端口：`18080`
- 开发界面：`http://127.0.0.1:5176`

## 桌面开发版

```bash
npm install
npm run desktop:dev
```

该命令会启动 Tauri 桌面窗口，并自动拉起本地网关和 Vite 开发服务。

如只需要浏览器调试界面，可以运行：

```bash
npm run dev
```

桌面开发版运行后：

- 打开 `http://127.0.0.1:5176`
- 在“中转管理”中添加至少一个兼容 `/v1/responses` 的服务
- 在“路由规则”中确认中转已加入默认路由组
- 在“设置”中显式接管 Codex 配置


## 数据与密钥

- SQLite 数据库保存在 `data/router.sqlite`
- macOS 上的 API Key 保存到系统钥匙串
- 请求正文、提示词、代码和完整响应默认不保存
- `data/` 已加入 `.gitignore`

## 主要能力

- Responses API JSON 与 SSE 透传
- 默认模型 `gpt-5.6-sol`
- 中转检测固定使用 SSE 流式请求，默认测试模型 `gpt-5.6-terra`
- 路由规则优先级
- 组内中转优先级和同级权重
- 自动故障转移
- Closed / Open / Half-Open 熔断状态机
- 请求发起后立即显示和实时计时
- 每次上游尝试、Token、耗时和错误记录
- 使用统计和 Codex 配置接管
