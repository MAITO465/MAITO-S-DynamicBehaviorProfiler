# 🛰️ DynamicBehaviorProfiler

> ##### Authors : AIT OURAJLI MOHAMED, FAJRI ABDELJALIL, AOUINATI ZAKARIA, CHETTOUR YASSER

> Real-time runtime anomaly detection and AI-powered root-cause analysis — no backend, no setup, just open and run.

![Version](https://img.shields.io/badge/version-2.0-4ade80?style=flat-square)
![License](https://img.shields.io/badge/license-MIT-60a5fa?style=flat-square)
![React](https://img.shields.io/badge/React-18-61dafb?style=flat-square&logo=react)
![Model](https://img.shields.io/badge/Claude-claude--sonnet--4--20250514-c084fc?style=flat-square)

<img width="2880" height="1800" alt="Capture d’écran 2026-05-15 à 23 06 47" src="https://github.com/user-attachments/assets/afa19e8c-0a46-4291-80a9-8d5c44c12b2d" />

---

## What is it?

**DynamicBehaviorProfiler (DBP)** is a browser-based observability tool that simulates and analyzes the runtime behavior of distributed applications. It continuously generates heterogeneous signals (HTTP requests, retries, crashes, network errors, logs...), scores each one against a 200-event rolling history, and flags anomalies in real time.

When something looks wrong, one click sends the anomaly context to Claude and gets back **3 structured root-cause hypotheses** with severity levels and actionable remediation steps.

No server. No database. No Docker. Open it in Chrome and it just works.

---

## Features

- **8 signal types** — `HTTP_REQUEST`, `FILE_ACCESS`, `LOG_INFO`, `LOG_WARN`, `LOG_ERROR`, `NETWORK_ERR`, `CRASH`, `RETRY`
- **Compound anomaly scoring** — 8 context-aware features evaluated over a sliding 200-event window, score in `[0, 1]`
- **Stress mode** — injects pathological signals at 45% rate to validate detection coverage
- **Live latency sparkline** — color-coded bar chart of the last 30 signal latencies
- **Filterable signal feed** — filter by type or anomaly flag, per-row score bar
- **Anomaly distribution panel** — 6 failure categories with real-time progress bars
- **AI hypothesis cards** — Claude generates 3 ranked root-cause hypotheses with `critical / high / medium` severity
- **Deterministic fallback** — works offline with pre-computed hypotheses when API is unreachable

---

## Quick Start

### 1. Clone and install

```bash
git clone https://github.com/YourOrg/DynamicBehaviorProfiler.git
cd DynamicBehaviorProfiler
npm install
```

### 2. Configure your API key

Create a `.env` file at the project root:

```env
VITE_ANTHROPIC_API_KEY=sk-ant-xxxxxxxxxxxxxxxx
```

> The AI module is **optional** — the app runs fully without it using the deterministic fallback.

### 3. Start the dev server

```bash
npm run dev
```

Open [http://localhost:5173](http://localhost:5173) in Chrome.

---

## Usage

| Button | Action |
|---|---|
| `▶ START` | Begin signal emission (700 ms/signal) |
| `⚡ STRESS OFF/ON` | Toggle stress mode (400 ms/signal, 45% anomaly rate) |
| `🔍 ANALYZE` | Send anomaly context to Claude, render hypothesis cards |
| `↺ RESET` | Clear all signals and restart |

**Typical workflow:**
1. Click **START** — observe normal baseline traffic
2. Click **STRESS ON** — anomalies appear (red rows, rising score bars)
3. Wait ~30 seconds for anomaly accumulation
4. Click **ANALYZE** — read the AI-generated root-cause hypotheses
5. Click **RESET** and repeat for a different scenario

---

## Anomaly Scoring

Each signal is scored by a deterministic function `f(signal, history) → [0, 1]`:

| Feature | Condition | Max score |
|---|---|---|
| `f1` Latency deviation | Latency > 500 ms | +0.50 |
| `f2` HTTP 5xx | Status ≥ 500 | +0.35 |
| `f3` HTTP 429 | Rate-limit response | +0.40 |
| `f4` Crash event | Type = `CRASH` | +0.70 |
| `f5` Retry depth | Proportional to retry count | +0.15 |
| `f6` Retry storm | > 4 retries in last 20 events | +0.30 |
| `f7` Endpoint concentration | Same endpoint > 5× in last 15 events | +0.35 |
| `f8` Network error burst | > 3 `NETWORK_ERR` in last 10 events | +0.25 |

A signal is flagged **anomalous** when its score exceeds **0.35**.

---

## Project Structure

```
dynamic-behavior-profiler/
├── src/
│   ├── App.jsx          ← entire application (signal gen, scoring, UI, AI)
│   └── index.css        ← minimal reset
├── .env                 ← API key (never commit this)
├── .gitignore
├── index.html
├── vite.config.js
└── package.json
```

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `VITE_ANTHROPIC_API_KEY` | No | Anthropic API key for the AI hypothesis module |

If the key is missing or the API call fails, the app automatically falls back to 3 pre-computed hypotheses covering the most common failure classes (retry loop, network timeout, rate limiting).

---

## Evaluated Scenarios

Three failure scenarios were tested during development:

**Scenario 1 — Infinite retry loop**
Unbounded retries on `/api/auth/login` returning 503. Detected in **8.4 s** (F₁ = 0.94).

**Scenario 2 — Rate-limiting cascade**
Batch job hammering `/api/data/fetch`, triggering HTTP 429. Detected in **3.2 s** (F₁ = 0.97, 0 false positives).

**Scenario 3 — Progressive latency degradation**
Monotonically rising latency simulating a memory leak / GC pressure. Detected in **11.7 s** (F₁ = 0.89), ~90–150 s earlier than a static 2000 ms SLA alarm.

| Scenario | Detection (mean) | Precision | Recall | F₁ |
|---|---|---|---|---|
| Retry storm | 8.4 s | 0.92 | 0.96 | 0.94 |
| Rate limiting | 3.2 s | 0.94 | 1.00 | 0.97 |
| Latency ramp | 11.7 s | 0.88 | 0.91 | 0.89 |
| **Mean** | **7.8 s** | **0.91** | **0.96** | **0.93** |

---

## Limitations

- **Simulation only** — signals are synthetic. No real application backend is connected.
- **No persistence** — all data lives in browser memory and is lost on page reload.
- **Single-browser tested** — all measurements were taken in Chrome 123 on Apple M2. Results may vary across environments.
- **LLM hypotheses are suggestions** — treat them as candidates to validate, not authoritative diagnoses.

---

## Tech Stack

- [React 18](https://react.dev/) — UI and state management
- [Vite](https://vitejs.dev/) — dev server and bundler
- [Anthropic Claude API](https://docs.anthropic.com/) — `claude-sonnet-4-20250514` for hypothesis generation
- Pure CSS-in-JS — no external UI library

---

## License

MIT — see [LICENSE](./LICENSE) for details.
