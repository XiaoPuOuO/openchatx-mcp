<p align="center">
  <img src="ui/public/openchatx-mcp-icon.png" width="96" alt="OpenChatX icon">
</p>

<h1 align="center">OpenChatX</h1>

<p align="center">
  <a href="README.md">English</a> · <strong>繁體中文</strong>
</p>

<p align="center">
  <strong>把 ChatGPT 變成你的本機 Agent Runtime。</strong><br>
  一條 MCP 連線，就能使用你的電腦、MCP Servers、自訂工具、Skills、Rules、Projects、Subagents 等能力。
</p>

<p align="center">
  <a href="https://github.com/XiaoPuOuO/openchatx-mcp/releases/latest"><strong>下載最新版</strong></a>
</p>

> [!CAUTION]
> OpenChatX 會以你目前作業系統使用者的權限執行。已授權的 ChatGPT 可以執行指令、編輯檔案、使用已連接的 MCP Servers，並控制支援的應用程式。

## 優先：安裝 Desktop App

這是建議的使用方式。你**不需要**自己安裝 Node.js、npm、PM2 或 `tunnel-client`。

### macOS

到最新 Release 下載：

- Apple Silicon：`OpenChatX-macos-arm64.dmg`
- Intel Mac：`OpenChatX-macos-x64.dmg`

macOS Release 會使用 Developer ID 簽章並提交 Apple Notarization。

### Windows

一般 Windows 電腦下載：

- `OpenChatX-Setup-x64.exe`

Windows on ARM 下載：

- `OpenChatX-Setup-arm64.exe`

也有 Portable ZIP 可用。

> [!WARNING]
> **Windows may warn because the binary is unsigned.**
> 目前 Windows 版本沒有 Authenticode 簽章，因此 Windows 可能顯示 SmartScreen 警告。請只從本專案的 GitHub Releases 下載。

最新版：

https://github.com/XiaoPuOuO/openchatx-mcp/releases/latest

## 連接到 ChatGPT

OpenChatX 使用 OpenAI Secure MCP Tunnel。Desktop App 已經內建本機 Runtime 與 `tunnel-client`，只需要設定一次 Tunnel。

### 1. 在 ChatGPT 建立 MCP App

在 ChatGPT 開啟 Developer Mode，建立新的 MCP App，Connection Type 選 **Tunnel**。

### 2. 在 OpenAI Platform 建立 Tunnel

打開 OpenAI Platform 的 Tunnels 頁面：

https://platform.openai.com/settings/organization/tunnels

按右上角 **Create tunnel**，然後設定：

1. **Name** — 例如 `OpenChatX Tunnel`。
2. **Description** — 例如 `OpenChatX Tunnel`。
3. **Organizations** — 選擇要擁有這個 Tunnel 的 Organization。
4. **ChatGPT workspaces** — 選擇要使用 OpenChatX 的 ChatGPT Workspace。
5. 按 **Create**。

![建立 OpenChatX Tunnel](docs/assets/secure-tunnel-platform-create.png)

建立完成後，複製產生的 `tunnel_...` ID。等等要填進 OpenChatX Desktop。

### 3. 建立 Runtime API Key

打開 OpenAI Platform 的 API Keys 頁面：

https://platform.openai.com/settings/organization/api-keys

建立一把給 OpenChatX Tunnel Runtime 使用的 Secret Key。建議名稱用 `OpenChatX Runtime Key`，之後比較容易辨識。

![建立 OpenChatX Runtime API Key](docs/assets/secure-tunnel-runtime-key.png)

Secret 只會完整顯示一次，請先複製保存。不要 commit 到 Git，也不要貼進 ChatGPT 對話。

### 4. 在 Desktop App 連接 Tunnel

打開 OpenChatX Desktop → **More → Connect Tunnel…**

填入：

- **Tunnel ID** — 第 2 步取得的 `tunnel_...` ID。
- **Control-plane API key** — 第 3 步建立的 Runtime API Key。

Desktop App 會把 API Key 存在系統安全儲存區：
- macOS：Keychain
- Windows：Credential Manager

### 5. 回到 ChatGPT 完成 MCP App

回到 ChatGPT：

1. 選擇剛建立的 `openchatx (tunnel_...)` Tunnel。
2. Authentication 選 **No authentication**。
3. 閱讀並接受 Custom MCP 的風險提示。
4. 按 **Create** 完成建立。

![選擇 Tunnel 並建立 OpenChatX App](docs/assets/secure-tunnel-chatgpt-finish.png)

如果希望 ChatGPT 使用 OpenChatX Tools 時不要每次都詢問，也可以把 OpenChatX App 權限設成 **Allow all tools**。

![允許所有 OpenChatX Tools](docs/assets/openchatx-allow-all-tools.png)

相關連結：

- OpenAI Secure MCP Tunnel：https://developers.openai.com/api/docs/guides/secure-mcp-tunnels
- Tunnel 設定：https://platform.openai.com/settings/organization/tunnels
- API Keys：https://platform.openai.com/settings/organization/api-keys

## OpenChatX 提供什麼

| 功能 | 用途 |
| --- | --- |
| MCP Servers | 把本機或遠端 MCP Server 集中到一條 OpenChatX 連線 |
| Toolboxes | 管理內建與自訂 TypeScript 工具 |
| Skills | 可攜的 `SKILL.md` 工作流，需要時才載入 |
| Rules | `.mdc` 規則，支援 Always / Auto Attached / Agent Requested / Manual |
| AGENTS.md | 可直接編輯的 `start_here` Prompt Template |
| Projects | 綁定現有專案資料夾，不需要移動檔案 |
| Subagents | 把工作委派給你明確設定的模型 |
| Capability Store | 安裝內建能力，或檢查後安裝 GitHub 社群能力 |
| Dashboard | 管理 Sessions、Tools、Skills、Rules、MCP、Projects、Status 等 |

外部 MCP 與 Toolbox Tool Schema 採 lazy discovery，不會一開始全部塞進 ChatGPT Context。

## Skills、Rules、AGENTS.md

### Skills

Skill 使用標準 Agent Skills 格式：

```text
~/.openchatx-mcp/skills/<name>/SKILL.md
```

Skill 只有 `name`、`description` 與 Markdown Instructions，不會在 Startup 預先注入。

- `skill_search`：依名稱與說明搜尋，最多回傳 5 個。
- `skill_load`：選定後才載入完整 Markdown。
- `skill_manage`：新增、編輯、刪除 Skill。

### Rules

Rule 放在：

```text
~/.openchatx-mcp/rules/*.mdc
```

例如：

```md
---
description: "React component conventions"
globs:
  - "src/**/*.tsx"
alwaysApply: false
---

Use accessible labels and named exports.
```

支援四種模式：

- **Always** — 由 `start_here` 自動注入。
- **Auto Attached** — 依 File Glob 自動套用。
- **Agent Requested** — Agent 依 description 判斷是否需要。
- **Manual** — 只有明確指定時才載入。

Rules 可以和 Cursor `.mdc`、Claude Rules、`AGENTS.md` 匯入 / 匯出。

### AGENTS.md

`~/.openchatx-mcp/AGENTS.md` 是 `start_here` 實際使用的可編輯範本。

工具箱 UI 可以直接編輯它。動態內容透過佔位符注入，例如：

- `{{MODE_INSTRUCTIONS}}`
- `{{PROJECT_CONTEXT}}`
- `{{CAPABILITY_CATALOG}}`
- `{{ALWAYS_RULES}}`

移動或刪除佔位符，就能直接控制 `start_here` 最後回傳的 Prompt。

## 連接更多能力

通常直接跟 ChatGPT 說就可以：

> 幫我把這個 MCP Server 加進 OpenChatX 並驗證能用。

或：

> 幫我做一個 OpenChatX Tool，可以啟動我的本機服務並回傳狀態。

你也可以從 Dashboard 手動管理 MCP Servers、Toolboxes、Skills、Rules、Projects 與 Subagents。

## 進階：不安裝 Desktop App

只有在你想從 Source 手動執行時才需要這一段。

### 需求

- Node.js 22.18+
- npm
- ripgrep
- OpenAI `tunnel-client`
- ChatGPT Developer Mode / Custom MCP 權限

### macOS

```bash
brew install ripgrep
git clone https://github.com/XiaoPuOuO/openchatx-mcp.git
cd openchatx-mcp
npm ci
npm run setup -- --config-only
```

### Windows PowerShell

```powershell
winget install BurntSushi.ripgrep.MSVC
git clone https://github.com/XiaoPuOuO/openchatx-mcp.git
Set-Location openchatx-mcp
npm ci
npm run setup -- --config-only
```

接著安裝官方 OpenAI `tunnel-client`、建立 `openchatx` Tunnel Profile、設定 `CONTROL_PLANE_API_KEY`，再執行：

```bash
npm run setup
npm start
```

常用指令：

| 指令 | 用途 |
| --- | --- |
| `npm run status` | 查看 Runtime / Tunnel 狀態 |
| `npm run logs` | 查看 Logs |
| `npm run print-url` | 顯示 MCP / UI / Tunnel URL |
| `npm run restart` | Rebuild 並重新載入 |
| `npm run stop` | 停止服務 |
| `npm run auth:reset` | 清除已綁定的 ChatGPT Subject |

## 開發

```bash
npm ci
npm --prefix ui ci
npm run lint
npm run typecheck
npm test
npm run build
npm --prefix ui run build
```

Desktop Build：

```bash
npm run desktop:build
npm run desktop:smoke
npm run desktop:windows:build
npm run desktop:windows:build:arm64
```

維護者文件：[wiki/](wiki/)

## 安全性

- 只連接你信任的 MCP Servers。
- Local MCP endpoint 應維持在 loopback。
- 遠端連線請使用 OpenAI Secure MCP Tunnel。
- Tool / Audit Logs 可能包含敏感輸入。
- 詳細安全模型與回報方式請看 [SECURITY.md](SECURITY.md)。

## License

MIT — 詳見 [LICENSE](LICENSE)。

本專案部分程式碼衍生自 [Shellby MCP](https://github.com/Serbyte-Development/shellby-mcp)，詳見 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
