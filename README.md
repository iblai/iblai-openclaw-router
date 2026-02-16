<div align="center">

<img src="https://ibl.ai/images/iblai-logo.png" alt="ibl.ai" width="300">

# ibl.ai Router

Route every OpenClaw request to the cheapest Claude model that can handle it.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A518-brightgreen.svg)](https://nodejs.org)
[![Zero Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen.svg)](#)
[![OpenClaw](https://img.shields.io/badge/OpenClaw-compatible-orange.svg)](https://github.com/openclaw/openclaw)

[Quick Start](#quick-start) · [How It Works](#how-it-works) · [Configuration](#configuration) · [Non-Anthropic Models](#non-anthropic-models) · [Troubleshooting](#troubleshooting)

</div>

---

```
"Check Gmail for alerts"      → Sonnet   $3/M    saved 80%
"Forward this message"        → Haiku    $1/M    saved 93%
"Triage all open issues"      → Opus    $15/M    best quality
"Is there a new email?"       → Haiku    $1/M    saved 93%
"Analyze architecture tradeoffs" → Opus  $15/M   reasoning
```

## Why ibl.ai Router?

- **80% cost savings** on real workloads — cron jobs, monitoring, inbox processing
- **100% local routing** — 14-dimension weighted scoring runs on your machine in <1ms
- **Zero dependencies** — single Node.js file, no npm install
- **Zero external calls** — no API calls for routing decisions, ever
- **Hot-reloadable config** — 350+ keywords across 11 categories, edit and save
- **OpenRouter support** — mix providers (OpenAI, Google, Anthropic) across tiers
- **Clean install/uninstall** — scripts handle everything, leave no traces

---

## Quick Start

**Ask your OpenClaw agent:**

> Install iblai-router from https://github.com/iblai/iblai-openclaw-router

**Or from the terminal:**

```bash
git clone https://github.com/iblai/iblai-openclaw-router.git router
cd router && bash scripts/install.sh
openclaw gateway restart
```

Done. `iblai-router/auto` is now available as a model.

### Sample savings after 30 days

| | Without router | With router | Saved |
|---|---|---|---|
| Cron jobs (ops alerts, inbox checks) | $121.63 | $24.33 | $97.31 (80%) |
| Subagent tasks (issue triage, comms) | $58.20 | $11.64 | $46.56 (80%) |
| Deep reasoning (strategy, analysis) | $25.00 | $25.00 | $0.00 |
| **Total** | **$204.83** | **$60.97** | **$143.87 (70%)** |

**Check your savings anytime:**

```bash
curl -s http://127.0.0.1:8402/stats | python3 -m json.tool
```

Or just ask your agent: *"What are my iblai-router cost savings?"*

---

## How It Works

**100% local, <1ms, zero API calls.**

```
OpenClaw  →  localhost:8402  →  Anthropic API
                  │
                  ▼
           14-dimension weighted scorer
           Scores only user messages (not system prompt)
                  │
                  ├── score < 0.0   → LIGHT  (Haiku)    $1/$5 per 1M tokens
                  ├── 0.0 – 0.35    → MEDIUM (Sonnet)   $3/$15 per 1M tokens
                  └── score > 0.35  → HEAVY  (Opus)     $15/$75 per 1M tokens
                  │
                  ▼
           Overrides:
           • 2+ reasoning keywords → HEAVY (0.95 confidence)
           • >50K tokens → HEAVY (large context)
           • Low confidence → defaults to MEDIUM
                  │
                  ▼
           Swaps model field → proxies to Anthropic
```

> **Important:** The scorer only evaluates user messages, not the system prompt. OpenClaw sends a large, keyword-rich system prompt with every request — scoring it inflates every request to HEAVY. Stripping it out is the difference between 0% savings and 80%.

### Scoring Dimensions

| Dimension | Effect | Routes toward |
|---|---|---|
| `simpleKeywords` | ↓ lowers score | LIGHT (Haiku) |
| `relayKeywords` | ↓ lowers score | LIGHT (Haiku) |
| `imperativeVerbs` | ↑ raises slightly | MEDIUM (Sonnet) |
| `codeKeywords` | ↑ raises score | MEDIUM → HEAVY |
| `agenticKeywords` | ↑ raises score | MEDIUM → HEAVY |
| `technicalKeywords` | ↑ raises score | HEAVY (Opus) |
| `reasoningKeywords` | ↑↑ raises strongly | HEAVY (Opus) |
| `domainKeywords` | ↑ raises score | HEAVY (Opus) |
| Token count | structural | Scales with length |
| Code presence | structural | Detects code blocks |
| Question complexity | structural | Multi-part questions |
| Multi-step patterns | structural | Sequential tasks |
| Output format | structural | Structured output requests |
| Constraints | structural | Specific requirements |

### Routing Logs

Every request logs a line:

```
[router] LIGHT  → haiku  | score=-0.112 conf=0.71 | scored    | -93% | what is 2+2? ...
[router] MEDIUM → sonnet | score= 0.127 conf=0.73 | scored    | -80% | Check Gmail for new emails ...
[router] HEAVY  → opus   | score= 0.548 conf=0.95 | reasoning |  -0% | Analyze the architecture ...
```

### Stats Endpoint

```bash
curl http://127.0.0.1:8402/stats
```

```json
{
  "total": 847,
  "byTier": { "LIGHT": 412, "MEDIUM": 340, "HEAVY": 95 },
  "estimatedCost": 0.0034,
  "baselineCost": 0.0189,
  "savings": "82.0%"
}
```

---

## Configuration

All scoring config lives in `config.json` — hot-reloaded on save, no restart needed.

### Change models

```json
{
  "models": {
    "LIGHT":  "claude-3-5-haiku-20241022",
    "MEDIUM": "claude-sonnet-4-20250514",
    "HEAVY":  "claude-opus-4-20250514"
  }
}
```

### Customize keywords

Add words relevant to your domain:

```json
{
  "scoring": {
    "simpleKeywords": ["order status", "tracking number", "return policy"],
    "technicalKeywords": ["refund api", "webhook", "stripe"],
    "reasoningKeywords": ["analyze", "compare", "synthesize"]
  }
}
```

### Adjust tier boundaries

```json
{
  "scoring": {
    "boundaries": {
      "lightMedium": 0.0,
      "mediumHeavy": 0.35
    }
  }
}
```

Raise `lightMedium` to send more traffic to LIGHT. Lower `mediumHeavy` to send more to HEAVY.

### Adjust confidence

```json
{
  "scoring": {
    "confidenceThreshold": 0.70
  }
}
```

Lower = more decisive routing. Higher = more conservative (defaults to MEDIUM more often).

### Adjust dimension weights

Weights control how much each signal matters:

```json
{
  "scoring": {
    "weights": {
      "tokenCount":       0.08,
      "codePresence":     0.14,
      "reasoningMarkers": 0.18,
      "technicalTerms":   0.10,
      "simpleIndicators": 0.06,
      "relayIndicators":  0.05
    }
  }
}
```

---

## Where to Use It

Use `iblai-router/auto` anywhere OpenClaw accepts a model ID:

| Scope | How |
|---|---|
| Default for all sessions | `agents.defaults.model.primary = "iblai-router/auto"` |
| Subagents only | `agents.defaults.subagents.model = "iblai-router/auto"` |
| Specific cron job | `"model": "iblai-router/auto"` in the cron config |
| Per-session override | `/model iblai-router/auto` |

**Tip:** Keep your main interactive session on a fixed model (e.g. Opus) for quality. Use the router for cron jobs, subagents, and background tasks where cost savings compound.

---

## Non-Anthropic Models

The scoring engine is model-agnostic. Swap in models from any provider via [OpenRouter](https://openrouter.ai):

### OpenAI via OpenRouter

```json
{
  "models": {
    "LIGHT":  "openai/gpt-4.1-mini",
    "MEDIUM": "openai/gpt-4.1",
    "HEAVY":  "openai/o3"
  },
  "apiBaseUrl": "https://openrouter.ai/api/v1"
}
```

Set your OpenRouter key in the systemd service:

```bash
Environment=ANTHROPIC_API_KEY=sk-or-YOUR-OPENROUTER-KEY
```

### Google via OpenRouter

```json
{
  "models": {
    "LIGHT":  "google/gemini-2.0-flash-lite",
    "MEDIUM": "google/gemini-2.5-flash",
    "HEAVY":  "google/gemini-2.5-pro"
  },
  "apiBaseUrl": "https://openrouter.ai/api/v1"
}
```

### Mixed providers

The most cost-effective setup often mixes providers:

```json
{
  "models": {
    "LIGHT":  "google/gemini-2.0-flash-lite",
    "MEDIUM": "anthropic/claude-sonnet-4-20250514",
    "HEAVY":  "openai/o3"
  },
  "apiBaseUrl": "https://openrouter.ai/api/v1"
}
```

---

## Troubleshooting

### `model not allowed: iblai-router/auto`

**Most common cause:** If `agents.defaults.models` exists in `openclaw.json`, it acts as a model allowlist. Add `iblai-router/auto` to it:

```json
{
  "agents": {
    "defaults": {
      "models": {
        "iblai-router/auto": {}
      }
    }
  }
}
```

Then restart OpenClaw.

### Cron jobs stuck in error backoff

After fixing a model error, cron jobs may be in exponential backoff. Force an immediate run:

```
/cron run <jobId>
```

### Router running but requests fail

```bash
# Check the service
curl -s http://127.0.0.1:8402/health

# Check logs
journalctl -u iblai-router -n 20

# Verify API key works
curl -s https://api.anthropic.com/v1/messages \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-3-5-haiku-20241022","max_tokens":10,"messages":[{"role":"user","content":"hi"}]}' | jq .
```

### Config changes not taking effect

`config.json` changes are hot-reloaded. Environment variable changes (API key, port) require:

```bash
sudo systemctl restart iblai-router
```

---

## Uninstall

```bash
bash scripts/uninstall.sh
```

Cleans up everything: systemd service, router files, `openclaw.json` provider config, model allowlist, cached `models.json`.

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | (required) | Anthropic or OpenRouter API key |
| `ROUTER_PORT` | `8402` | Port to listen on |
| `ROUTER_LOG` | `1` | `0` to disable per-request logging |
| `ROUTER_CONFIG` | `./config.json` | Path to scoring config |

## Files

```
├── server.js          # The proxy (~250 lines, zero deps)
├── config.json        # Scoring config (hot-reloaded)
├── scripts/
│   ├── install.sh     # Full install + OpenClaw registration
│   └── uninstall.sh   # Clean removal
├── SKILL.md           # OpenClaw skill definition
└── README.md
```

---

<div align="center">

**Everything runs locally.** No data is sent to ibl.ai or any third party.<br>
The router forwards directly to your LLM provider using your own API key.

[ibl.ai](https://ibl.ai) · [OpenClaw](https://github.com/openclaw/openclaw) · Inspired by [ClawRouter](https://github.com/BlockRunAI/ClawRouter)

</div>
