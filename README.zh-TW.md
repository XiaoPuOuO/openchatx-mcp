<p align="center">
  <img src="ui/public/openchatx-mcp-icon.png" width="96" alt="openchatx-mcp icon">
</p>

<h1 align="center">openchatx-mcp</h1>

<p align="center">
  <a href="README.md">English</a> · <strong>繁體中文</strong>
</p>

<p align="center">
  為 ChatGPT 打造的本機 MCP 平台，整合本機工具、Toolboxes、Skills、外部 MCP Server 與 Provider-backed Subagents。
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="MIT License"></a>
  <img src="https://img.shields.io/badge/platform-macOS-lightgrey.svg" alt="macOS">
</p>

<p align="center">
  <a href="#快速開始">快速開始</a> ·
  <a href="#操作與維護">操作與維護</a> ·
  <a href="#安全性">安全性</a> ·
  <a href="wiki/">維護者 Wiki</a>
</p>

> [!CAUTION]
> openchatx-mcp 會以目前 macOS 使用者的完整權限執行。經授權的 ChatGPT 呼叫可以執行指令、修改檔案、抓取網頁，以及控制支援的應用程式。

![openchatx-mcp architecture](docs/assets/openchatx-mcp-architecture.png)

## 功能

| 功能 | 說明 |
| --- | --- |
| Shell / Terminal | 提供非互動式 `bash` 與可互動 PTY Terminal，讓 ChatGPT 能直接操作本機開發環境。 |
| 檔案工具 | 提供 `file_read`、`file_edit`、`file_write` 與 `apply_patch`。 |
| MCP 聚合 | 將本機 stdio 與遠端 HTTP MCP Server 聚合到同一個 ChatGPT MCP 連線。 |
| Capability Catalog | `start_here` 只暴露輕量能力摘要，讓 ChatGPT 知道有哪些 MCP / Subagent / Toolbox，而不載入全部 Tool Schema。 |
| Toolboxes | 以資料夾為單位的 Plugin 系統，可包含 TypeScript tools 與 skills。 |
| Provider-backed Subagents | 可把本地 GPU、自架模型或其他 API 當作 ChatGPT 可委派的子 Agent。 |
| Dashboard | 本機 `/ui` 控制中心，可管理 MCP Servers、Toolboxes、Subagents 等設定。 |

## 系統需求

- macOS，支援 Apple Silicon 與 Intel
- Node.js 22.18.0 或更新版本
- npm
- [ngrok](https://ngrok.com/) 帳號與 CLI
- ChatGPT Plus 或更高方案，並開啟 Developer Mode

Computer Use 刻意設計成外部 MCP，而不是內建在 openchatx-mcp 裡。

## 快速開始

### 使用 Coding Agent 安裝

[skills/install-openchatx-mcp/SKILL.md](skills/install-openchatx-mcp/SKILL.md)

### 手動安裝

> [!TIP]
> 建議在 Terminal.app 執行第一次安裝，以取得較完整的 macOS 權限環境。

1. 安裝 ngrok、clone repository 並安裝 dependencies：

   ```bash
   brew install --cask ngrok
   git clone https://github.com/XiaoPuOuO/openchatx-mcp.git
   cd openchatx-mcp
   npm ci
   ```

2. 登入 ngrok：

   ```bash
   ngrok config add-authtoken <your-token>
   ```

   如果還沒有 token，可以到 [ngrok dashboard](https://dashboard.ngrok.com/get-started/your-authtoken) 取得。

3. 建立設定檔：

   ```bash
   npm run setup -- --config-only
   ```

   設定檔位於 `.openchatx/config.toml`。

4. 執行 guided setup：

   ```bash
   npm run setup
   ```

5. 第一次啟動請從 Terminal.app 執行：

   ```bash
   npm start
   ```

   這會啟動 openchatx-mcp 與 ngrok，等待 health check 通過，並輸出公開的 `/mcp` URL。

6. 開啟 ChatGPT Developer Mode，使用剛才輸出的 `https://.../mcp` URL 建立自訂 MCP App，Authentication 選擇 **No Auth**。

   1. 點擊左下角個人選單，選擇 **Settings**。

      ![從個人選單開啟 ChatGPT Settings](docs/assets/enable-developer-mode-step-1.png)

   2. 到 **Security & sign-in** 開啟 **Developer Mode**。

      ![在 Security & sign-in 開啟 Developer Mode](docs/assets/enable-developer-mode-step-2.png)

   3. 從左側欄開啟 **Plugins**，按下 **+**，選擇 **Create app**。

      ![開啟 Plugins 並選擇 Create app](docs/assets/create-chatgpt-plugin-step-1.png)

   4. 選擇 **Create MCP app**。

      ![選擇 Create MCP app](docs/assets/create-chatgpt-plugin-step-2.png)

   5. 填入：
      - Name：`OpenChatX`
      - Description：例如 `OpenChatX for Computer Agent`
      - Server URL：`npm run print-url` 輸出的 `https://.../mcp`
      - Authentication：**No Auth**
      - 勾選風險確認後按 **Create**

      ![填寫 OpenChatX MCP app 設定並建立](docs/assets/create-chatgpt-plugin-step-3.png)

   6. 開啟 OpenChatX Plugin 權限，選擇 **Allow all tools**。

      ![將 OpenChatX plugin 權限設為 Allow all tools](docs/assets/openchatx-allow-all-tools.png)

> [!IMPORTANT]
> 第一次受信任的遠端 Tool Call 會把這個 installation 綁定到當前 ChatGPT subject。只有在確定要清除綁定時才使用 `npm run auth:reset`。

### 驗證安裝

```bash
npm run status
curl -fsS http://127.0.0.1:3333/healthz
npm run print-url
```

預設本機 MCP endpoint：`http://127.0.0.1:3333/mcp`

Dashboard 永遠啟用：`http://127.0.0.1:3333/ui`

## External MCP Servers

新安裝預設不會建立任何 MCP Server。可以從 Dashboard 的 **MCP Server** 頁面新增，或自行建立 gitignored 的 `mcp-servers.json`。

本機 Server 使用 stdio，遠端 Server 使用 Streamable HTTP。

```json
{
  "open-computer-use": {
    "type": "local",
    "command": ["/opt/homebrew/bin/open-computer-use", "mcp"],
    "enabled": true,
    "description": "macOS GUI control"
  },
  "unreal-engine": {
    "type": "remote",
    "url": "http://127.0.0.1:8000/mcp",
    "enabled": true,
    "timeout": 300000,
    "description": "Unreal Engine editor control"
  }
}
```

外部 MCP Tools 採 lazy loading，不會把所有 Tool Schema 一次塞進 ChatGPT 主工具列表。

`start_here` 會回傳輕量 Capability Catalog，包含 Server ID、名稱、description、availability 與 tool count。

```text
External MCP capabilities:
- blender (Blender): available, 32 tools — 3D modeling and Blender scene control
- unreal-engine (Unreal Engine): available, 3 tools — Unreal Editor automation
```

需要真正工具時，ChatGPT 可以先限定 MCP Server 搜尋：

```text
tool_search(
  query="create and modify a 3D model",
  source="mcp",
  server="blender"
)
```

再使用 `tool_call` 呼叫需要的 Tool。

如果 MCP 已設定但目前無法連線，Capability Catalog 仍會顯示 `configured but unavailable`，而且不會阻止 openchatx-mcp 啟動。

## Provider-backed Subagents

Subagents 直接透過 openchatx-mcp 設定的 Provider 執行，不會自動操作其他 ChatGPT conversations。

這讓本地 GPU、自架模型與其他模型 API 都能成為 ChatGPT 可委派的 worker，而 ChatGPT 本身仍是主要 Planner。

Provider 不會自動把所有模型暴露給 ChatGPT。使用者自行建立 curated Model Profile，包含 Profile ID、Display Name、Provider Model ID、Description、Context Window、Optional Max Output Tokens 與 Thinking 設定。

新安裝預設沒有 Provider 或 Profile：

```json
{
  "providers": {},
  "models": {}
}
```

可以從 Dashboard 的 **Subagents** 頁面設定，或自行建立 gitignored 的 `subagents.json`。

- `subagent_list`：列出 Model Profiles 與用途
- `subagent_run`：把一個任務委派給指定 Profile

`start_here` 也會把已啟用的 Profiles 以輕量 Capability Summary 呈現給 ChatGPT。

## Toolboxes 與自訂 TypeScript Tools

所有內建 Tool 都屬於某個 Toolbox。使用者自己的 Toolbox 也使用相同 runtime。

```text
toolboxes/
└── my-tools/
    ├── toolbox.json
    ├── tools/
    │   └── hello.ts
    └── skills/
        └── debug-app/
            └── SKILL.md
```

Dashboard 的 **Toolboxes** 頁面可以管理整個 Toolbox、單一 Tool、Skill，也可以建立 Toolbox / Tool / Skill template。

新安裝不會自動建立 `My Tools` 範例 Toolbox；需要時再自行建立。

User-authored tools 透過 lazy catalog 被發現：

```text
tool_search(source="toolbox", ...)
→ tool_call(...)
```

`toolboxes/` 下的變更會自動 reload，不需要重新啟動 openchatx-mcp process。

## 內建檔案工具

### `file_read`

```text
file_read({
  filePath,
  offset?,
  limit?
})
```

- 回傳帶行號的文字
- 支援 offset / limit 分頁
- 單次最多 2000 行
- 限制單行長度與單次總輸出大小
- 可讀 directory listing
- 普通 binary file 會拒絕
- Image / PDF 使用 native MCP resource transport

### `file_edit`

```text
file_edit({
  filePath,
  oldString,
  newString,
  replaceAll?
})
```

- Exact match 優先
- 保守的 whitespace / line-trimmed fallback
- Ambiguous match 會拒絕
- 保留 CRLF / LF
- `oldString=""` 且檔案不存在時可以建立新檔
- 回傳 compact diff

Agent Guidance 預設：

- 已知文字檔優先 `file_read`
- 單一既有文字檔精確修改優先 `file_edit`
- Structural / multi-file / create / delete / move / rename 使用 `apply_patch`
- 不用 `bash + sed/cat` 取代專用檔案工具

## 操作與維護

| 指令 | 用途 |
| --- | --- |
| `npm start` | Build 並啟動或 reload openchatx-mcp、ngrok 與相關服務 |
| `npm run restart` | Rebuild 並使用現有 PM2 daemon reload services |
| `npm run restart -- --hard` | Rebuild 並從 Terminal.app 重建專用 PM2 daemon |
| `npm run status` | 顯示 PM2 process 狀態 |
| `npm run logs` | 查看 PM2 logs |
| `npm run print-url` | 顯示公開的 `/mcp` URL 與本機 UI URL |
| `npm run stop` | 停止 openchatx-mcp 與 ngrok |
| `npm run auth:reset` | 清除遠端 ChatGPT subject 綁定 |

PM2 使用 `<state_dir>/pm2` 保存自己的 daemon、socket、logs 與 process state，不會與其他專案預設的 `~/.pm2` 混在一起。

### 更新既有安裝

```bash
git pull
npm ci
npm run setup -- --config-only
npm start
```

## 設定

公開設定檔：`.openchatx/config.toml`

```toml
state_dir = "~/.openchatx-mcp"
workspace = "~/Desktop/agent-workspace"

[shell]
path = "/bin/zsh"
rtk = false

[ngrok]
enabled = true
api_port = 4040
# url = "https://your-static-domain.ngrok-free.dev"
pooling_enabled = false

[mcp]
tool_output = "compact"
```

Dashboard 沒有開關，永遠啟用。

其他設定位置：

- External MCP Servers：`mcp-servers.json`
- Subagent Providers / Profiles：`subagents.json`
- Toolboxes：`toolboxes/`

### 固定 ngrok URL

建議把 assigned / reserved static ngrok domain 寫進：

```toml
[ngrok]
url = "https://your-static-domain.ngrok-free.dev"
```

這樣 PM2 或 ngrok 重啟後，ChatGPT Connector URL 不需要重新修改。

如果不指定 `ngrok.url`，則由 ngrok 決定公開 endpoint。

### Local-only MCP

```toml
[ngrok]
enabled = false
```

然後照常使用 `npm start` 或 `npm run restart`。

## 疑難排解

```bash
npm run status
npm run logs
npm run preflight
```

如果 PM2 daemon 的 macOS service context 有問題，從新的 Terminal.app session 執行：

```bash
npm run restart -- --hard
```

更多啟動與 recovery 細節請看 [Configuration and Startup](wiki/pages/operations/configuration-and-startup.md)。

## 安全性

- 內建 ngrok traffic policy 只允許受信任的 ChatGPT remote MCP traffic。
- Direct localhost MCP access 沒有額外 authentication；不要把本機 endpoint 透過其他不受信任的 proxy 公開。
- Trusted remote Tool Calls 會綁定到 `<state_dir>/auth.json` 中保存的第一個 ChatGPT subject。
- OpenChatX 不會從舊的 `~/.shellby/auth.json` 匯入 auth state。
- `agent-commands.yaml` 可能包含敏感 Tool Input，已 gitignore 並限制權限，請視為私人資料。

安全性問題與範圍請看 [SECURITY.md](SECURITY.md)。

## 開發

```bash
npm run dev
npm run ui:dev
npm run lint
npm run typecheck
npm test
npm run build
npm run ui:build
```

Clone 後先執行一次 `npm run ui:install` 安裝 Dashboard dependencies。

使用 `npm run inspect` 開啟 MCP Inspector，使用 `npm run schemas` 輸出目前 published Tool Schemas。

## 文件

[Maintainer Wiki](wiki/) 包含更深入的實作與維運資訊：

- [Project Overview](wiki/pages/project-overview.md)
- [Architecture Map](wiki/pages/architecture-map.md)
- [Configuration and Startup](wiki/pages/operations/configuration-and-startup.md)
- [MCP Tool Surface](wiki/pages/mcp-tool-surface.md)
- [Build and Test](wiki/pages/operations/build-and-test.md)
- [Open Questions and Risks](wiki/pages/project/open-questions-and-risks.md)

## Contributing

送 Pull Request 前請先閱讀 [CONTRIBUTING.md](CONTRIBUTING.md)，並執行上面的開發驗證指令。

## License

[MIT](LICENSE)。Vendored `apply_patch` binary 保留 upstream OpenAI Codex license 與 notices，位於 [vendor/apply-patch/](vendor/apply-patch/)。

## Attribution

本專案部分程式碼衍生自 [Shellby MCP](https://github.com/Serbyte-Development/shellby-mcp)，原作者為 Serbyte Development，採 MIT License。原始授權聲明保留於 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
