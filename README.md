# iblai-router — Local Cost-Optimizing Model Router for OpenClaw

A zero-dependency Node.js proxy that sits between OpenClaw and the Anthropic API, automatically routing each request to the cheapest Claude model capable of handling it. Inspired by [ClawRouter](https://github.com/BlockRunAI/ClawRouter)'s weighted scoring approach.

## How It Works

```
OpenClaw  →  localhost:8402  →  api.anthropic.com
               │
               ▼
        14-dimension weighted scorer (<1ms)
        Extracts text from system prompt + last 3 messages
        Scores across: token count, code presence, reasoning markers,
        technical terms, creative markers, simple indicators, multi-step
        patterns, question complexity, imperative verbs, constraints,
        output format, domain specificity, agentic tasks, relay indicators
               │
               ▼
        Maps weighted score to tier via sigmoid confidence
               │
               ├── score < 0.0  → LIGHT  (Haiku)    $1/$5 per 1M tokens
               ├── 0.0 – 0.35  → MEDIUM (Sonnet)   $3/$15 per 1M tokens
               └── score > 0.35 → HEAVY  (Opus)     $15/$75 per 1M tokens
               │
               ▼
        Overrides:
        • 2+ reasoning keywords in user message → HEAVY (0.95 confidence)
        • >50K estimated tokens → HEAVY (large context)
        • Low confidence (ambiguous) → defaults to MEDIUM
               │
               ▼
        Replaces model field in request body → proxies to Anthropic
```

The proxy speaks native **Anthropic Messages API** format — it receives the exact same request OpenClaw would send to Anthropic, scores it, swaps the model, and forwards it. Streaming works transparently.

---

## 1. Adapting to Any OpenClaw Agent

The router ships with keyword lists tuned for a PM/engineering workflow. To adapt it to your use case, edit the `SCORING` object in `server.js`:

### Change the models

```js
const MODELS = {
  LIGHT:  "claude-3-5-haiku-20241022",   // cheapest
  MEDIUM: "claude-sonnet-4-20250514",     // balanced
  HEAVY:  "claude-opus-4-20250514",       // most capable
};
```

Swap these for any Anthropic model IDs. You could also point at different providers entirely by changing the upstream URL and headers in `proxyToAnthropic()`.

### Customize keyword lists

Each dimension has a keyword list that shifts the score. Add words relevant to your domain:

```js
// If your agent does customer support:
simpleKeywords: ["order status", "tracking number", "return policy", "hours", ...],
relayKeywords: ["forward to agent", "escalate", "transfer to", ...],
technicalKeywords: ["refund api", "webhook", "stripe", "payment intent", ...],

// If your agent does research:
reasoningKeywords: ["analyze", "compare", "synthesize", "methodology", ...],
domainKeywords: ["regression", "p-value", "confidence interval", ...],
```

**Rule of thumb:**
- Words in `simpleKeywords` and `relayKeywords` push toward LIGHT (cheap)
- Words in `reasoningKeywords`, `domainKeywords`, `technicalKeywords` push toward HEAVY (capable)
- Words in `agenticKeywords`, `imperativeVerbs`, `codeKeywords` push toward MEDIUM/HEAVY

### Adjust tier boundaries

```js
boundaries: {
  lightMedium: 0.0,    // raise to send more traffic to LIGHT
  mediumHeavy: 0.35,   // lower to send more traffic to HEAVY
},
```

### Adjust confidence threshold

```js
confidenceThreshold: 0.70,  // below this → ambiguous → defaults to MEDIUM
```

Lower = more decisive routing (fewer MEDIUM defaults). Higher = more conservative (more MEDIUM).

### Adjust dimension weights

Weights control how much each signal matters. They roughly sum to 1.0:

```js
weights: {
  tokenCount:       0.08,  // long prompts → heavier model
  codePresence:     0.14,  // code → heavier
  reasoningMarkers: 0.18,  // reasoning keywords → heaviest weight
  technicalTerms:   0.10,
  simpleIndicators: 0.06,  // simple keywords → lighter model
  relayIndicators:  0.05,  // relay/forwarding → lightest model
  // ... etc
},
```

Increase a weight to make that dimension more influential.

---

## 2. Activation

### Prerequisites

- Node.js (any version OpenClaw supports)
- An Anthropic API key
- OpenClaw running in local gateway mode

### Step 1: Place the server

Copy `server.js` to your workspace (e.g. `~/.openclaw/workspace/skills/router/server.js`).

### Step 2: Create the systemd service

```bash
cat > /etc/systemd/system/iblai-router.service << 'EOF'
[Unit]
Description=iblai-router - Claude model routing
After=network.target

[Service]
Type=simple
ExecStart=/usr/bin/node /root/.openclaw/workspace/skills/router/server.js
Environment=ANTHROPIC_API_KEY=sk-ant-your-key-here
Environment=ROUTER_PORT=8402
Environment=ROUTER_LOG=1
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable iblai-router
systemctl start iblai-router
```

Verify it's running:

```bash
curl http://127.0.0.1:8402/health
# → {"status":"ok","models":{"LIGHT":"claude-3-5-haiku-20241022",...},"port":8402}
```

### Step 3: Register as an OpenClaw model provider

Add to your `openclaw.json` (or use `/config` or `config.patch`):

```json
{
  "models": {
    "providers": {
      "iblai-router": {
        "baseUrl": "http://127.0.0.1:8402",
        "api": "anthropic-messages",
        "apiKey": "passthrough",
        "models": [
          {
            "id": "auto",
            "name": "iblai-router (auto)",
            "reasoning": true,
            "input": ["text", "image"],
            "contextWindow": 200000,
            "maxTokens": 8192
          }
        ]
      }
    }
  }
}
```

### Step 4: Use it

**As the default model for all sessions:**
```json
{ "agents": { "defaults": { "model": { "primary": "iblai-router/auto" } } } }
```

**For subagents only:**
```json
{ "agents": { "defaults": { "subagents": { "model": "iblai-router/auto" } } } }
```

**For specific cron jobs:**
```json
{ "model": "iblai-router/auto" }
```

**Per-session override:**
```
/model iblai-router/auto
```

**Tip:** Keep your main interactive session on a fixed model (e.g. Opus) where latency and quality matter most. Use the router for cron jobs, subagents, and background tasks where cost savings compound.

---

## 3. Verifying Cost Savings

### Real-time: routing logs

```bash
journalctl -u iblai-router -f
```

Every request logs a line like:

```
[router] LIGHT  → haiku  | score=-0.112 conf=0.71 | scored     | -93% | what is 2+2? ...
[router] MEDIUM → sonnet | score=-0.040 conf=0.58 | ambiguous  | -80% | create an issue for the API bug ...
[router] HEAVY  → opus   | score=0.116  conf=0.95 | reasoning  |  -0% | prove sqrt(2) is irrational ...
```

The `-93%` / `-80%` / `-0%` is the savings vs always-Opus baseline for that request.

### Aggregate: stats endpoint

```bash
curl http://127.0.0.1:8402/stats
```

Returns:

```json
{
  "stats": {
    "total": 847,
    "byTier": { "LIGHT": 412, "MEDIUM": 340, "HEAVY": 95 },
    "estimatedCost": 0.0034,
    "baselineCost": 0.0189,
    "startedAt": "2026-02-16T20:36:34.000Z"
  }
}
```

- **`estimatedCost`**: what you actually spent (input tokens × model price)
- **`baselineCost`**: what Opus would have cost for the same traffic
- **Savings**: `1 - (estimatedCost / baselineCost)` → e.g. 82%

Note: these are input-cost estimates based on character count. Actual costs depend on output tokens too, which vary per response. For precise tracking, check your Anthropic dashboard.

### Expected savings profile

Based on typical agent workloads:

| Traffic mix | Tier | % of requests | Cost/M tokens |
|---|---|---|---|
| Simple queries, relays, alerts | LIGHT | ~45% | $1 |
| Issue creation, config, triage | MEDIUM | ~40% | $3 |
| Deep reasoning, architecture | HEAVY | ~15% | $15 |

**Blended average: ~$3.40/M** vs $15/M for always-Opus = **~77% savings**.

Actual savings depend on your workload. More relay/alert work = higher savings. More reasoning = lower savings.

### Cross-check with Anthropic billing

Compare your Anthropic usage dashboard before and after enabling the router. The model breakdown will show traffic shifting from a single model to a mix of Haiku/Sonnet/Opus.

---

## Files

```
skills/router/
├── server.js    # The proxy (Node.js, zero deps, ~300 lines)
└── SKILL.md     # This file
```

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | (required) | Your Anthropic API key |
| `ROUTER_PORT` | `8402` | Port to listen on |
| `ROUTER_LOG` | `1` | Set to `0` to disable per-request logging |
