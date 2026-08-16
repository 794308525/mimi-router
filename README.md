# 咪咪 Router

咪咪 Router 是一个开源、本地优先的 OpenAI Responses API 路由网关与桌面管理工具。它位于客户端和多个兼容上游之间，在保留原始模型与请求参数的前提下，提供路由、重试、故障转移、熔断恢复和运行分析能力。

项目适合需要统一管理多个 API 上游、提高请求可用性，并希望在本地查看 Token、费用和各阶段耗时的个人或小型团队使用。

## 主要能力

- **Responses API 兼容**：支持 `/v1/responses`、`/v1/responses/compact` 和 `/v1/models`。
- **透明请求转发**：支持 JSON 与 SSE 流式响应，不主动改写客户端指定的模型和参数。
- **多上游路由**：支持中转启停、优先级排序、健康检测、性能测评和快捷恢复。
- **故障处理**：支持同渠道重试、跨渠道故障转移、限流重试、熔断与自动恢复。
- **首字优化**：提供指定时限、自动均衡，以及稳妥、直切、同渠竞速和分渠竞速模式。
- **运行观测**：记录连接、响应头、首字、生成和总耗时，并展示具体失败原因。
- **用量统计**：统计输入、缓存、输出 Token、缓存命中率、费用、错误率和渠道表现。
- **本地桌面管理**：支持 macOS 与 Windows，可供本机或局域网内设备访问。
- **Codex 接入**：支持在保留已有配置和会话识别信息的前提下接管或恢复 Codex API 配置。

## 工作方式

```text
Codex / Responses API 客户端
              │
              ▼
        咪咪 Router 本地网关
              │
      路由 · 重试 · 竞速 · 熔断
              │
              ▼
       多个 OpenAI 兼容上游
```

## 快速开始

环境要求：Node.js 22、Rust 1.85 或更高版本。

```bash
npm install
npm run dev
```

启动后打开 `http://127.0.0.1:5176`，网关默认监听 `http://127.0.0.1:18080/v1`。

桌面开发模式：

```bash
npm run desktop:dev
```

构建当前平台的桌面安装包：

```bash
npm run desktop:build
```

开发环境会同时启动前端和本地网关。桌面安装版由应用自动管理网关进程，无需单独运行 Node.js 命令。

## 接入地址

- 本机：`http://127.0.0.1:18080/v1`
- 局域网：`http://<本机局域网 IP>:18080/v1`

请先在“中转管理”中添加至少一个兼容 Responses API 的上游地址。

如启用本地 API 认证，请按 OpenAI 协议发送请求头：

```http
Authorization: Bearer sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

## 数据与隐私

- SQLite 数据库保存在本地应用数据目录
- macOS 上的上游密钥保存到系统钥匙串
- 其他平台的密钥保存到本地受限文件
- 不保存提示词、代码和完整响应内容
- 运行数据、密钥、依赖和构建产物均已排除在 Git 版本库之外

## 更新记录

- [中文更新记录](CHANGELOG.zh-CN.md)
- [English changelog](CHANGELOG.md)

## 开源许可

本项目使用 [MIT License](LICENSE)。

## 作者与联系

- 微信：`chen129641`
- 官网：[https://iiar.cn](https://iiar.cn)

<img src="docs/assets/wechat-chen129641.jpg" alt="作者微信二维码" width="260">
