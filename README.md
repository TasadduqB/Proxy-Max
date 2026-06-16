<p align="center">
  <img src="assets/logo.svg" width="120" alt="Proxy Max Logo" />
</p>

<h1 align="center">⚡ Proxy Max</h1>

<p align="center">
  <strong>Use GPT-5, Llama 4, DeepSeek R2, Nemotron Ultra — inside Claude Code</strong><br>
  <em>One proxy. Every model. Full tool calling. Zero config.</em>
</p>

<p align="center">
  <a href="#-quick-start"><img src="https://img.shields.io/badge/⚡_setup-30_seconds-brightgreen?style=for-the-badge" alt="Install" /></a>
  <a href="#-features"><img src="https://img.shields.io/badge/models-100+-blue?style=for-the-badge" alt="Models" /></a>
  <a href="#-provider-details"><img src="https://img.shields.io/badge/providers-4-orange?style=for-the-badge" alt="Providers" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green?style=for-the-badge" alt="License" /></a>
</p>

<p align="center">
  <a href="https://github.com/TasadduqB/Proxy-Layer-For-Anthropic-Foundry-BedRock-Nvidia/stargazers"><img src="https://img.shields.io/github/stars/TasadduqB/Proxy-Layer-For-Anthropic-Foundry-BedRock-Nvidia?style=social" alt="GitHub Stars" /></a>
  <a href="https://github.com/TasadduqB/Proxy-Layer-For-Anthropic-Foundry-BedRock-Nvidia/network/members"><img src="https://img.shields.io/github/forks/TasadduqB/Proxy-Layer-For-Anthropic-Foundry-BedRock-Nvidia?style=social" alt="GitHub Forks" /></a>
  <a href="https://github.com/TasadduqB/Proxy-Layer-For-Anthropic-Foundry-BedRock-Nvidia/issues"><img src="https://img.shields.io/github/issues/TasadduqB/Proxy-Layer-For-Anthropic-Foundry-BedRock-Nvidia?color=yellow" alt="Issues" /></a>
  <img src="https://img.shields.io/badge/node-%3E%3D18-339933?logo=node.js&logoColor=white" alt="Node" />
  <img src="https://img.shields.io/badge/PRs-welcome-ff69b4" alt="PRs Welcome" />
</p>

<br/>

<p align="center">
  <img src="assets/social-card.svg" width="700" alt="Proxy Max — Route Claude Code to Any Model" />
</p>

<p align="center">
  <sub>⭐ If this project helps you, consider giving it a star — it helps others find it!</sub>
</p>

---

## 🎯 The Problem

You love Claude Code's workflow — hooks, MCP servers, tool calling, `/compact`, agents — but you're **stuck paying Anthropic prices** or want to use **GPT-5, Llama 4, DeepSeek R2** instead.

## 💡 The Solution

**Proxy Max** sits between your tools and any AI backend. One `export` and you're running Claude Code with the model of your choice:

```bash
export ANTHROPIC_BASE_URL=http://localhost:8787
claude  # Now uses YOUR chosen model with full tool calling
```

**Proxy Max** speaks the **Anthropic Messages API** and routes to **any** backend:

| Provider | Models | Tool Calling | Streaming | Web Search |
|----------|--------|:---:|:---:|:---:|
| **AWS Bedrock** | Claude 4, 3.7, 3.5, 3 | ✅ | ✅ | ✅ |
| **Azure AI Foundry** | GPT-5.x, GPT-4.x, o3/o4, Phi, Mistral, Llama, DeepSeek, Cohere, Grok | ✅ | ✅ | ✅ |
| **NVIDIA NIM** | Nemotron, DeepSeek R2, Llama 4, Qwen 3.5, Mistral Large 3, Gemma 4, Kimi K2.6 | ✅ | ✅ | ✅ |
| **Any OpenAI-compatible** | Custom endpoints, self-hosted models | ✅ | ✅ | ✅ |

> **One proxy. Every model. Full Claude Code compatibility.**  
> Use GPT-5, Llama 4, DeepSeek R2, Nemotron Ultra — with tool calling, hooks, MCP servers, web search, and the entire Claude Code ecosystem.

---

## ✨ Features

<table>
<tr>
<td width="50%">

### 🔀 Universal Protocol Translation
- Anthropic Messages API ↔ OpenAI Chat Completions
- Full tool calling bridge (function calling, parallel tools)
- Streaming & non-streaming modes
- Extended thinking passthrough (Bedrock native)
- Computer use tool support

</td>
<td width="50%">

### 🧠 100+ Models, One Endpoint
- Claude 4 Opus & Sonnet (Bedrock)
- GPT-5.5, GPT-5, GPT-4o (Azure)
- Nemotron Ultra 550B, DeepSeek R2 (NVIDIA)
- Llama 4, Qwen 3.5, Mistral Large 3
- Custom model IDs — type any model name

</td>
</tr>
<tr>
<td width="50%">

### 📊 Real-time Dashboard
- Live request monitoring & analytics
- Token usage tracking per session
- Cost estimation with 50+ model pricing
- Model routing pool management
- Provider health & latency metrics

</td>
<td width="50%">

### 🛡️ Enterprise Ready
- Corporate SSL proxy support (auto-detect)
- SigV4 signing for Bedrock (zero SDK)
- API key masking in all UI surfaces
- Log rotation (10MB, 3 rotations)
- Graceful shutdown & session persistence

</td>
</tr>
<tr>
<td width="50%">

### ⚡ Token Optimization Engine
- 3-tier token estimation (BPE → Heuristics → Fallback)
- Output compression: reduce CLI output 60-90%
- Prompt compression: reduce token cost 65-75%
- Optimization suggestions per command

</td>
<td width="50%">

### 🔌 Full Claude Code Compatibility
- All hooks supported (SessionStart → SessionEnd)
- MCP server pass-through
- Web search tool translation
- Subagent & agent team support
- Permission modes & auto-mode

</td>
</tr>
</table>

---

## 🚀 Installation

```bash
# Clone the repository
git clone https://github.com/TasadduqB/Proxy-Layer-For-Anthropic-Foundry-BedRock-Nvidia.git
cd Proxy-Layer-For-Anthropic-Foundry-BedRock-Nvidia

# Install dependencies
npm install

# Start the proxy
npm start
```

**That's it.** The proxy is now running at `http://localhost:8787`.

### Configure Claude Code to use Proxy Max

```bash
# Set environment variable
export ANTHROPIC_BASE_URL=http://localhost:8787

# Start Claude Code normally
claude
```

Or configure in Claude Code settings:
```json
{
  "apiBaseUrl": "http://localhost:8787"
}
```

---

## 🖥️ Dashboard

Access the web dashboard at **http://localhost:8787** after starting the proxy.

<p align="center">
  <img src="assets/social-card.svg" width="700" alt="Proxy Max Dashboard" />
</p>

Everything lives on a **single page** (the old separate `/dashboard` route now
redirects to the `#dashboard` tab). The app provides:
- **Dashboard** — Live token, cost and savings analytics with per-model/provider breakdowns
- **Provider Setup** — Configure credentials with a guided wizard
- **Model Pool** — Create routing pools for load balancing & fallback
- **Optimization** — Toggle every cost-saving strategy; all run automatically inside the proxy
- **Model Catalog** — Browse 100+ supported models
- **Launch CLI** — Copy-paste commands to point Claude Code at the proxy
- **System / Diagnostics** — Install the CLI, inspect the request log

### Automatic cost-saving optimizations

All strategies run transparently in the proxy path — there is **no copy/paste**.
Point Claude Code at the proxy and they apply to every request:

**All stages ship enabled and tuned conservatively** for maximum savings without
breaking Claude Code's hooks, web search, subagents/Task spawning, tool use or
streaming. The lossless stages carry zero risk; the lossy ones use gentle
settings. Tune or disable any from the Optimization tab.

| Strategy | What it does | Default | Lossless? |
|----------|--------------|---------|-----------|
| **Prompt caching** | Injects Anthropic `cache_control` breakpoints on system + tool defs (Bedrock). Repeated prefixes cost ~10% of input. Capped at Anthropic's 4-breakpoint limit so it can never error. | On | Yes |
| **Response cache (SQLite)** | Stores upstream responses in a local SQLite DB keyed by exact request; identical requests replay verbatim (streaming included) at zero upstream cost. TTL-bounded. | On (60 min TTL) | Yes |
| **Tool-result ANSI stripping** | Strips display-only ANSI escape codes from terminal output. | On | Yes |
| **Conversation history window** | Sliding window (120 msgs, keeps opening context) to cap long-session cost. | On | Gentle |
| **Tool-definition compression** | Trims descriptions past 800 chars; preserves names + schemas exactly. | On | Gentle |
| **Prose compression** | Drops filler words from prose (`lite` mode; up to 6 modes). | On | Gentle |

### Storage

Persistence (analytics + the response cache) uses Node's **built-in
`node:sqlite`** (Node 22.5+) at `~/.proxy-max/proxy-max.db` — no native module to
compile. On older Node it transparently falls back to a JSON file, so the app is
always plug-and-play. The bundled portable-Node installer fetches Node 22 LTS so
SQLite is available out of the box.

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     YOUR AI TOOLS                            │
│  Claude Code · Cursor · Windsurf · Continue · Custom Apps   │
└──────────────────────────┬──────────────────────────────────┘
                           │ Anthropic Messages API
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                      PROXY MAX                               │
│                                                             │
│  ┌─────────────┐  ┌──────────────┐  ┌─────────────────┐   │
│  │  Protocol   │  │  Token       │  │  Analytics      │   │
│  │  Translator │  │  Optimizer   │  │  Engine         │   │
│  └─────────────┘  └──────────────┘  └─────────────────┘   │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │            Model Routing Pool                        │   │
│  │  Priority-based · Fallback chains · Load balancing   │   │
│  └─────────────────────────────────────────────────────┘   │
└────────┬──────────────────┬──────────────────┬──────────────┘
         │                  │                  │
         ▼                  ▼                  ▼
┌────────────────┐ ┌────────────────┐ ┌────────────────┐
│  AWS Bedrock   │ │  Azure AI      │ │  NVIDIA NIM    │
│  (SigV4 Auth)  │ │  (API Key)     │ │  (API Key)     │
└────────────────┘ └────────────────┘ └────────────────┘
```

---

## ⚙️ Configuration

Create a `config.json` in the project root (the dashboard can also configure this for you):

```jsonc
{
  "provider": "bedrock",
  "providers": {
    "bedrock": {
      "region": "us-east-1",
      "accessKeyId": "AKIA...",
      "secretAccessKey": "...",
      "model": "us.anthropic.claude-sonnet-4-20250514-v1:0"
    },
    "azure": {
      "endpoint": "https://YOUR-RESOURCE.openai.azure.com",
      "apiKey": "...",
      "model": "gpt-4o"
    },
    "nvidia": {
      "apiKey": "nvapi-...",
      "model": "nvidia/nemotron-3-ultra-550b-a55b"
    }
  }
}
```

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Proxy listening port | `8787` |
| `HOST` | Bind address | `127.0.0.1` |
| `PROXY_MAX_CONFIG` | Config file path | `./config.json` |
| `PROXY_INSECURE` | Skip TLS verification (corporate proxies) | `0` |

---

## 🔀 Model Routing Pool

Create intelligent routing pools that automatically distribute requests:

```jsonc
{
  "pools": {
    "coding": {
      "strategy": "priority",
      "models": [
        { "provider": "bedrock", "model": "us.anthropic.claude-sonnet-4-...", "priority": 1 },
        { "provider": "nvidia", "model": "deepseek-ai/deepseek-r2", "priority": 2 },
        { "provider": "azure", "model": "gpt-4o", "priority": 3, "fallback": true }
      ]
    }
  }
}
```

**Features:**
- **Priority-based routing** — Send to best model first, fall back on error/rate-limit
- **Round-robin** — Distribute load across equivalent models
- **Least-latency** — Automatically route to fastest responding provider
- **Circuit breaker** — Auto-disable providers returning errors
- **Budget caps** — Stop routing to a model after hitting a cost threshold

---

## 🔧 Tool Calling Support

Proxy Max translates Anthropic tool calling format to each provider's native format:

```
Anthropic tools[] → OpenAI functions[] (Azure/NVIDIA)
Anthropic tools[] → Bedrock tools[] (native passthrough)
```

**Supported tool features:**
- ✅ Tool definitions with JSON Schema
- ✅ Parallel tool calls
- ✅ Tool results (success & error)
- ✅ Streaming tool use events
- ✅ Computer use tools (Bedrock native)
- ✅ Server tools (web_search) translation
- ✅ MCP tool passthrough

---

## 🪝 Hooks Compatibility

Because Proxy Max speaks the exact Anthropic protocol, **all Claude Code hooks work identically** regardless of backend model:

| Hook Event | Status | Hook Event | Status |
|------------|:---:|------------|:---:|
| SessionStart / SessionEnd | ✅ | SubagentStart / SubagentStop | ✅ |
| UserPromptSubmit | ✅ | TaskCreated / TaskCompleted | ✅ |
| PreToolUse / PostToolUse | ✅ | TeammateIdle | ✅ |
| PermissionRequest | ✅ | ConfigChange | ✅ |
| Stop / StopFailure | ✅ | All other events | ✅ |

---

## 🌐 Provider Details

<details>
<summary><b>AWS Bedrock</b> — Native Anthropic format, SigV4 auth</summary>

- ✅ Native Anthropic payload (zero translation loss)
- ✅ Extended thinking support
- ✅ Computer use tools
- ✅ Cross-region inference (us/eu/apac)
- ✅ SigV4 signing (no AWS SDK needed)

| Model | ID |
|-------|-----|
| Claude Opus 4 | `us.anthropic.claude-opus-4-20250514-v1:0` |
| Claude Sonnet 4 | `us.anthropic.claude-sonnet-4-20250514-v1:0` |
| Claude 3.7 Sonnet | `us.anthropic.claude-3-7-sonnet-20250219-v1:0` |
| Claude 3.5 Sonnet v2 | `anthropic.claude-3-5-sonnet-20241022-v2:0` |
| Claude 3.5 Haiku | `anthropic.claude-3-5-haiku-20241022-v1:0` |

</details>

<details>
<summary><b>Azure AI Foundry</b> — OpenAI-compatible, broadest model selection</summary>

- ✅ Full tool calling translation
- ✅ Streaming support
- ✅ All OpenAI models (GPT-5.x, o3, o4)
- ✅ Azure-hosted open source (Phi, Llama, Mistral)
- ✅ Responses API support (GPT-5.5)

40+ models: GPT-5.5, GPT-5.2, GPT-5.1, GPT-5, GPT-4o, GPT-4.1, o3, o4-mini, Phi-4, Mistral Large, Llama 3.3 70B, DeepSeek R1, Grok 3, and more.

</details>

<details>
<summary><b>NVIDIA NIM</b> — Cutting-edge open models, massive scale</summary>

- ✅ OpenAI-compatible API
- ✅ Tool calling support
- ✅ Streaming
- ✅ 60+ models verified live
- ✅ Free tier available

60+ models: Nemotron 3 Ultra 550B, DeepSeek R2, Llama 4 Maverick, Qwen 3.5 397B, Mistral Large 3 675B, Gemma 4 31B, Kimi K2.6, GLM 5.1, and many more.

</details>

---

## 📁 Project Structure

```
proxy-max/
├── src/
│   ├── server.js              # Main HTTP server (port 8787)
│   ├── models.js              # 100+ model catalog
│   ├── providers/
│   │   ├── _common.js         # Protocol translation engine
│   │   ├── bedrock.js         # AWS Bedrock (SigV4)
│   │   └── openai_compat.js   # Azure/NVIDIA (OpenAI format)
│   ├── optimizers/            # Proxy-layer cost optimizers:
│   │   ├── cache-injector.js     #   prompt-cache breakpoints
│   │   ├── tool-result-filter.js #   ANSI/blank/size filtering
│   │   ├── history-trimmer.js    #   sliding-window history
│   │   └── tool-compressor.js    #   tool-description trimming
│   ├── cache/                 # Persistence + response cache:
│   │   ├── sqlite-store.js       #   node:sqlite store (JSON fallback)
│   │   └── response-cache.js     #   lossless exact-match response cache
│   ├── token-analyzer/        # Token counting engine
│   ├── cost-calculator/       # Pricing & cost tracking
│   ├── compression/           # Prose compression
│   ├── output-filters/        # CLI output compression
│   ├── analytics/             # Analytics engine (JSON store)
│   └── dashboard/             # Dashboard analytics API routes
├── ui/
│   └── index.html             # Single-page app (config + dashboard + optimization)
├── package.json
└── config.json                # Your configuration
```

---

## 🤝 Contributing

1. **Fork** the repository
2. **Create** a feature branch (`git checkout -b feature/amazing-feature`)
3. **Commit** your changes (`git commit -m 'Add amazing feature'`)
4. **Push** to the branch (`git push origin feature/amazing-feature`)
5. **Open** a Pull Request

---

## ⭐ Star History

If you find Proxy Max useful, **please star this repo** — it helps others discover it and motivates continued development!

<p align="center">
  <a href="https://github.com/TasadduqB/Proxy-Layer-For-Anthropic-Foundry-BedRock-Nvidia/stargazers">
    <img src="https://img.shields.io/github/stars/TasadduqB/Proxy-Layer-For-Anthropic-Foundry-BedRock-Nvidia?style=for-the-badge&color=gold&label=⭐%20Stars" alt="Star this repo" />
  </a>
</p>

[![Star History Chart](https://api.star-history.com/svg?repos=TasadduqB/Proxy-Layer-For-Anthropic-Foundry-BedRock-Nvidia&type=Date)](https://star-history.com/#TasadduqB/Proxy-Layer-For-Anthropic-Foundry-BedRock-Nvidia&Date)

---

## 🙏 Supporters

Thanks to all the amazing people who have starred and forked this project!

<a href="https://github.com/TasadduqB/Proxy-Layer-For-Anthropic-Foundry-BedRock-Nvidia/stargazers">
  <img src="https://reporoster.com/stars/TasadduqB/Proxy-Layer-For-Anthropic-Foundry-BedRock-Nvidia" alt="Stargazers" width="600"/>
</a>

<a href="https://github.com/TasadduqB/Proxy-Layer-For-Anthropic-Foundry-BedRock-Nvidia/network/members">
  <img src="https://reporoster.com/forks/TasadduqB/Proxy-Layer-For-Anthropic-Foundry-BedRock-Nvidia" alt="Forkers" width="600"/>
</a>

---

## 📜 License

MIT — Free for commercial and personal use. See [LICENSE](LICENSE).

---

<p align="center">
  <sub>Compatible with Claude Code · Cursor · Windsurf · Continue · Any Anthropic-compatible tool</sub><br><br>
  <sub>Created with ❤️ by Tasadduq Burney</sub>
</p>
