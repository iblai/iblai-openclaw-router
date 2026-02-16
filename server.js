#!/usr/bin/env node
/**
 * iblai-router — Local cost-optimizing proxy for Anthropic Claude models.
 *
 * Sits between OpenClaw and the Anthropic API, automatically routing each
 * request to the cheapest capable Claude model using weighted scoring.
 *
 * Inspired by BlockRunAI/ClawRouter's 15-dimension approach.
 * Zero dependencies — just Node.js standard library.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-ant-... node server.js
 *
 * Then configure OpenClaw to use http://127.0.0.1:8402 as an
 * anthropic-messages model provider.
 */

const http = require("http");
const https = require("https");

// ─── Configuration ───

const PORT = parseInt(process.env.ROUTER_PORT || "8402", 10);
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_BASE = "https://api.anthropic.com";
const LOG_ROUTING = process.env.ROUTER_LOG !== "0";

// ─── Model Tiers ───
// Swap these for any Anthropic model IDs.

const MODELS = {
  LIGHT:  "claude-3-5-haiku-20241022",    // $1/$5 per 1M tokens
  MEDIUM: "claude-sonnet-4-20250514",      // $3/$15 per 1M tokens
  HEAVY:  "claude-opus-4-20250514",        // $15/$75 per 1M tokens
};

const COSTS = {
  [MODELS.LIGHT]:  { input: 1.0,  output: 5.0  },
  [MODELS.MEDIUM]: { input: 3.0,  output: 15.0 },
  [MODELS.HEAVY]:  { input: 15.0, output: 75.0 },
};

// ─── Weighted Scoring Engine (14 dimensions) ───
//
// Each dimension scores [-1, 1]. Negative = simpler, positive = harder.
// Weighted sum maps to tiers via configurable boundaries.
// Adapt keyword lists and weights to your agent's domain.

const SCORING = {
  tokenThresholds: { simple: 80, complex: 800 },

  // --- Keyword lists (customize these for your use case) ---

  codeKeywords: [
    "function", "class", "import", "def", "select", "async", "await",
    "const", "let", "var", "return", "```", "api", "endpoint", "sdk",
    "component", "module", "interface", "type ", "struct",
  ],
  reasoningKeywords: [
    "prove", "theorem", "derive", "step by step", "chain of thought",
    "formally", "mathematical", "proof", "logically", "analyze why",
    "root cause", "trade-off", "compare and contrast", "evaluate",
  ],
  simpleKeywords: [
    "what is", "define", "translate", "hello", "yes or no", "capital of",
    "how old", "who is", "when was", "what time", "remind me",
    "heartbeat", "status check", "acknowledge", "react", "thumbs up",
  ],
  technicalKeywords: [
    "algorithm", "optimize", "architecture", "distributed", "kubernetes",
    "microservice", "database", "infrastructure", "deploy", "pipeline",
    "ci/cd", "terraform", "docker", "nginx", "security", "firewall",
    "harden", "vulnerability", "config",
  ],
  creativeKeywords: [
    "story", "poem", "compose", "brainstorm", "creative", "imagine",
    "write a", "draft", "narrative",
  ],
  multiStepPatterns: [
    /first.*then/i, /step \d/i, /\d\.\s/, /after that/i, /once done/i,
    /and also/i, /next,?\s/i,
  ],
  agenticKeywords: [
    "read file", "edit", "modify", "update the", "create file",
    "execute", "deploy", "install", "compile", "fix", "debug",
    "until it works", "keep trying", "iterate", "make sure", "verify",
    "triage all", "triage every", "broadcast",
    "assign to", "prioritize the", "prioritize all", "rank all",
    "summarize all", "review all", "audit", "investigate",
  ],
  imperativeVerbs: [
    "build", "create", "implement", "design", "develop", "generate",
    "configure", "set up", "construct",
  ],
  constraintKeywords: [
    "at most", "at least", "within", "no more than", "maximum",
    "minimum", "limit", "budget", "under ",
  ],
  formatKeywords: [
    "json", "yaml", "xml", "table", "csv", "markdown", "schema",
    "format as", "structured",
  ],
  domainKeywords: [
    "quantum", "fpga", "vlsi", "risc-v", "genomics", "proteomics",
    "homomorphic", "zero-knowledge", "lattice-based", "topological",
  ],
  relayKeywords: [
    // Pure relay: message forwarding, alerts, simple checks.
    // Add your own relay patterns here (e.g. "send to <name>").
    "send to", "post to", "forward to", "relay to",
    "ops alert", "healthcheck", "transcribe", "voice note",
    "check email", "check inbox", "new mail", "unread",
    "git pull", "git push", "git status", "git log",
    "ping ", "notify ", "tell ",
  ],

  // --- Dimension weights (roughly sum to 1.0) ---

  weights: {
    tokenCount:       0.08,
    codePresence:     0.14,
    reasoningMarkers: 0.18,
    technicalTerms:   0.10,
    creativeMarkers:  0.05,
    simpleIndicators: 0.06,
    multiStep:        0.10,
    questionCount:    0.04,
    imperativeVerbs:  0.04,
    constraints:      0.04,
    outputFormat:     0.03,
    domainSpecific:   0.03,
    agenticTask:      0.06,
    relayIndicators:  0.05,
  },

  // --- Tier boundaries on weighted score axis ---
  boundaries: {
    lightMedium: 0.0,    // below → LIGHT; raise to route more to LIGHT
    mediumHeavy: 0.35,   // above → HEAVY; lower to route more to HEAVY
  },

  // Sigmoid steepness for confidence calibration
  confidenceSteepness: 8,
  // Below this confidence → ambiguous → defaults to MEDIUM
  confidenceThreshold: 0.70,
};

// ─── Dimension Scorers ───

function scoreTokenCount(tokens) {
  if (tokens < SCORING.tokenThresholds.simple) return { score: -0.8, signal: `short(${tokens}t)` };
  if (tokens > SCORING.tokenThresholds.complex) return { score: 0.8, signal: `long(${tokens}t)` };
  return { score: 0, signal: null };
}

function scoreKeywords(text, keywords, threshLow, threshHigh, scoreLow, scoreHigh) {
  const matches = keywords.filter(kw => text.includes(kw.toLowerCase()));
  if (matches.length >= threshHigh) return { score: scoreHigh, signal: matches.slice(0, 3).join(",") };
  if (matches.length >= threshLow) return { score: scoreLow, signal: matches.slice(0, 2).join(",") };
  return { score: 0, signal: null };
}

function scorePatterns(text, patterns) {
  const hits = patterns.filter(p => p.test(text));
  if (hits.length > 0) return { score: 0.5, signal: "multi-step" };
  return { score: 0, signal: null };
}

function scoreQuestions(text) {
  const count = (text.match(/\?/g) || []).length;
  if (count > 3) return { score: 0.5, signal: `${count}q` };
  return { score: 0, signal: null };
}

// ─── Main Classifier ───

function classify(text, estimatedTokens) {
  const lower = text.toLowerCase();

  const dims = {
    tokenCount:       scoreTokenCount(estimatedTokens),
    codePresence:     scoreKeywords(lower, SCORING.codeKeywords, 1, 3, 0.5, 1.0),
    reasoningMarkers: scoreKeywords(lower, SCORING.reasoningKeywords, 1, 2, 0.6, 1.0),
    technicalTerms:   scoreKeywords(lower, SCORING.technicalKeywords, 2, 4, 0.5, 1.0),
    creativeMarkers:  scoreKeywords(lower, SCORING.creativeKeywords, 1, 2, 0.4, 0.7),
    simpleIndicators: scoreKeywords(lower, SCORING.simpleKeywords, 1, 2, -0.8, -1.0),
    multiStep:        scorePatterns(lower, SCORING.multiStepPatterns),
    questionCount:    scoreQuestions(text),
    imperativeVerbs:  scoreKeywords(lower, SCORING.imperativeVerbs, 1, 2, 0.3, 0.5),
    constraints:      scoreKeywords(lower, SCORING.constraintKeywords, 1, 3, 0.3, 0.7),
    outputFormat:     scoreKeywords(lower, SCORING.formatKeywords, 1, 2, 0.4, 0.7),
    domainSpecific:   scoreKeywords(lower, SCORING.domainKeywords, 1, 2, 0.5, 0.8),
    agenticTask:      scoreKeywords(lower, SCORING.agenticKeywords, 2, 4, 0.4, 0.8),
    relayIndicators:  scoreKeywords(lower, SCORING.relayKeywords, 1, 2, -0.9, -1.0),
  };

  // Weighted score
  let score = 0;
  const signals = [];
  for (const [name, dim] of Object.entries(dims)) {
    const w = SCORING.weights[name] || 0;
    score += dim.score * w;
    if (dim.signal) signals.push(`${name}:${dim.signal}`);
  }

  // Override: 2+ reasoning keywords → HEAVY
  const reasoningHits = SCORING.reasoningKeywords.filter(kw => lower.includes(kw.toLowerCase()));
  if (reasoningHits.length >= 2) {
    return { model: MODELS.HEAVY, tier: "HEAVY", score, confidence: 0.95, signals, reasoning: "reasoning-override" };
  }

  // Override: large context → HEAVY
  if (estimatedTokens > 50000) {
    return { model: MODELS.HEAVY, tier: "HEAVY", score, confidence: 0.95, signals, reasoning: "large-context" };
  }

  // Map score to tier
  const { lightMedium, mediumHeavy } = SCORING.boundaries;
  let tier, distFromBoundary;

  if (score < lightMedium) {
    tier = "LIGHT";
    distFromBoundary = lightMedium - score;
  } else if (score < mediumHeavy) {
    tier = "MEDIUM";
    distFromBoundary = Math.min(score - lightMedium, mediumHeavy - score);
  } else {
    tier = "HEAVY";
    distFromBoundary = score - mediumHeavy;
  }

  // Sigmoid confidence
  const confidence = 1 / (1 + Math.exp(-SCORING.confidenceSteepness * distFromBoundary));

  // Ambiguous → default MEDIUM
  if (confidence < SCORING.confidenceThreshold) {
    return { model: MODELS.MEDIUM, tier: "MEDIUM", score, confidence, signals, reasoning: "ambiguous→medium" };
  }

  const model = tier === "LIGHT" ? MODELS.LIGHT : tier === "HEAVY" ? MODELS.HEAVY : MODELS.MEDIUM;
  return { model, tier, score, confidence, signals, reasoning: "scored" };
}

// ─── Extract scoring text from Anthropic messages format ───

function extractText(body) {
  let text = "";
  // System prompt
  if (typeof body.system === "string") text += body.system + " ";
  if (Array.isArray(body.system)) {
    for (const s of body.system) {
      if (typeof s === "string") text += s + " ";
      else if (s.text) text += s.text + " ";
    }
  }
  // Last 3 messages for context
  if (Array.isArray(body.messages)) {
    const recent = body.messages.slice(-3);
    for (const msg of recent) {
      if (typeof msg.content === "string") text += msg.content + " ";
      else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === "text") text += block.text + " ";
        }
      }
    }
  }
  return text;
}

// ─── Proxy to Anthropic ───

function proxyToAnthropic(req, res, body, routedModel) {
  body.model = routedModel;
  const payload = JSON.stringify(body);

  const options = {
    hostname: "api.anthropic.com",
    port: 443,
    path: "/v1/messages",
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": req.headers["anthropic-version"] || "2023-06-01",
      "Content-Length": Buffer.byteLength(payload),
    },
  };

  // Forward beta headers (e.g. for prompt caching)
  if (req.headers["anthropic-beta"]) {
    options.headers["anthropic-beta"] = req.headers["anthropic-beta"];
  }

  const upstream = https.request(options, (upstreamRes) => {
    res.writeHead(upstreamRes.statusCode, upstreamRes.headers);
    upstreamRes.pipe(res);
  });

  upstream.on("error", (err) => {
    console.error("[router] upstream error:", err.message);
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { type: "proxy_error", message: err.message } }));
    }
  });

  upstream.write(payload);
  upstream.end();
}

// ─── Stats ───

const stats = {
  total: 0,
  byTier: {},
  estimatedCost: 0,
  baselineCost: 0,
  startedAt: new Date().toISOString(),
};

// ─── HTTP Server ───

const server = http.createServer((req, res) => {
  // Health check
  if (req.method === "GET" && (req.url === "/health" || req.url === "/")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", models: MODELS, port: PORT }));
    return;
  }

  // Stats endpoint
  if (req.method === "GET" && req.url === "/stats") {
    const savings = stats.baselineCost > 0
      ? ((1 - stats.estimatedCost / stats.baselineCost) * 100).toFixed(1) + "%"
      : "n/a";
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ...stats, savings }));
    return;
  }

  // Only handle POST /v1/messages
  if (req.method !== "POST" || !req.url.startsWith("/v1/messages")) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found. Use POST /v1/messages" }));
    return;
  }

  // Collect body
  let chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString());
    } catch (e) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid JSON" }));
      return;
    }

    const text = extractText(body);
    const estimatedTokens = Math.ceil(text.length / 4);
    const decision = classify(text, estimatedTokens);

    // Track stats
    stats.total++;
    stats.byTier[decision.tier] = (stats.byTier[decision.tier] || 0) + 1;
    const cost = COSTS[decision.model];
    stats.estimatedCost += (estimatedTokens / 1_000_000) * cost.input;
    const opusCost = (estimatedTokens / 1_000_000) * COSTS[MODELS.HEAVY].input;
    stats.baselineCost += opusCost;

    if (LOG_ROUTING) {
      const savings = opusCost > 0
        ? ((opusCost - (estimatedTokens / 1_000_000) * cost.input) / opusCost * 100).toFixed(0)
        : 0;
      console.log(
        `[router] ${decision.tier.padEnd(6)} → ${decision.model} ` +
        `| score=${decision.score.toFixed(3)} conf=${decision.confidence.toFixed(2)} ` +
        `| ${decision.reasoning} | -${savings}% | ${text.slice(0, 80).replace(/\n/g, " ")}...`
      );
    }

    proxyToAnthropic(req, res, body, decision.model);
  });
});

// ─── Start ───

if (!ANTHROPIC_API_KEY) {
  console.error("[router] ANTHROPIC_API_KEY not set. Exiting.");
  process.exit(1);
}

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[router] iblai-router listening on http://127.0.0.1:${PORT}`);
  console.log(`[router] Models: LIGHT=${MODELS.LIGHT} MEDIUM=${MODELS.MEDIUM} HEAVY=${MODELS.HEAVY}`);
  console.log(`[router] Proxying to ${ANTHROPIC_BASE}/v1/messages`);
});
