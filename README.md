# PolyMind

[![Docker](https://img.shields.io/badge/Docker-Compose-2496ED?logo=docker&logoColor=white)](https://docs.docker.com/compose/)
[![Python](https://img.shields.io/badge/Python-3.11+-3776AB?logo=python&logoColor=white)](https://python.org)
[![License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

**PolyMind** is a self-hosted personal web app that sends a single prompt to multiple LLMs simultaneously and displays every response side by side in real time. It includes a **Debate mode** where models critique each other's answers across multiple rounds and try to converge, and a **Thread Composer** that lets you cherry-pick specific outputs to chain into a follow-up prompt. It's a Progressive Web App (PWA) — installable on Android, ChromeOS, and macOS like a native app.

---

## Screenshots

> Screenshots coming soon — PRs welcome!
>
> Planned: Prompt tab (multi-model grid), Debate tab (rounds), Thread Composer panel, mobile PWA view.

---

## Features

- **Multi-model prompting** — send one prompt to multiple LLMs at once, see all responses side by side
- **Real-time streaming** — tokens stream into each card as they arrive, per model
- **Free + paid models** — OpenRouter (most models) and Google Gemini API (direct billing)
- **Image input** — paste or drag-drop images; vision-capable models receive the image, others get text only with a visual warning
- **Session history** — scroll through past prompts in the sidebar without page reload
- **Copy as Markdown** — copy any individual response with one click
- **Cost tracking** — token counts and USD cost per model, per session, with a resettable counter
- **Live OpenRouter balance** — shown in the header, updated after every prompt
- **Debate mode** — 2 or 3 rounds: independent answers → critique & refine → convergence
- **Thread Composer** — after a debate, cherry-pick responses from any round/model into a new follow-up prompt
- **Product Owner role** — assign one model as a reviewer/director instead of a participant; useful for coding tasks
- **PWA** — installable on Android (Chrome), ChromeOS, macOS (Safari)
- **Dark theme** — hot pink/magenta accent palette, optimized for readability
- **Fully self-hosted** — nothing leaves your server except calls to the LLM APIs you configure

---

## Supported Models (defaults)

| Model | Provider | Tier | Input / Output (per 1M tok) | ~Prompts per $10 |
|---|---|---|---|---|
| Llama 3.3 70B | OpenRouter | Free | $0 / $0 | unlimited* |
| Gemini 2.0 Flash | OpenRouter | Free | $0 / $0 | unlimited* |
| DeepSeek R1 | OpenRouter | Free | $0 / $0 | unlimited* |
| Qwen 2.5 72B | OpenRouter | Free | $0 / $0 | unlimited* |
| GPT-4o mini | OpenRouter | Paid | $0.15 / $0.60 | ~37,000 |
| Gemini Flash Pro | Google API | Paid† | $0.075 / $0.30 | ~125,000 |
| Claude Haiku 4.5 | OpenRouter | Paid | $1.00 / $5.00 | ~4,200 |
| Grok 4.3 | OpenRouter | Paid | $1.25 / $2.50 | ~6,700 |

\* Free models have rate limits: ~20 req/min, ~200 req/day per OpenRouter  
† Billed to your Google Gemini plan, not OpenRouter credits — cost shown in app is an estimate

> **Tip:** Models are defined in `litellm_config.yaml`. Add or remove any model supported by LiteLLM without changing application code.

---

## Requirements

- Docker and Docker Compose (v2+)
- An [OpenRouter](https://openrouter.ai) account and API key — the free tier works for all free models
- A [Google Gemini API key](https://aistudio.google.com/app/apikey) — only needed if you want to use Gemini Flash Pro
- A server or machine running Linux (or any Docker-capable host)
- ~512 MB RAM available for the containers

---

## Setup

```bash
# 1. Clone the repo
git clone https://github.com/your-username/polymind
cd polymind

# 2. Copy the environment template
cp .env.example .env

# 3. Edit .env and fill in your keys
#    OPENROUTER_API_KEY — from openrouter.ai/keys
#    GOOGLE_API_KEY     — from aistudio.google.com (optional)
#    LITELLM_MASTER_KEY — any random string (internal auth)
nano .env

# 4. Start PolyMind
docker compose up -d

# 5. Open in your browser
open http://localhost:7860
```

First startup pulls Docker images — allow 1–2 minutes.

---

## Accessing from other devices

Replace `localhost` with your server's LAN IP:

```
http://192.168.1.60:7860
```

If you use **Tailscale**, use your Tailscale IP from anywhere:

```
http://100.90.190.127:7860
```

---

## Installing as a PWA

**Android (Chrome):** Open the app URL → tap the ⋮ menu → "Add to Home Screen"

**ChromeOS:** Same as Android, or look for the install icon in the address bar

**macOS (Safari):** Open the URL → click Share → "Add to Dock"

Once installed, PolyMind behaves like a native app with its own icon and standalone window. The shell is cached by the service worker, so it loads instantly even on slow connections — but LLM API calls always require internet.

---

## Adding or removing models

Edit `litellm_config.yaml` and add or remove a model block following the existing format:

```yaml
- model_name: my-new-model
  litellm_params:
    model: openrouter/provider/model-name
    api_key: os.environ/OPENROUTER_API_KEY
    api_base: https://openrouter.ai/api/v1
```

Then add the corresponding entry to `models_config.py`'s `_MODEL_METADATA` dict (display name, cost, vision support, etc.) and restart:

```bash
docker compose restart
```

Model strings must follow [LiteLLM's format](https://docs.litellm.ai/docs/providers) — the provider prefix (e.g., `openrouter/`) is required.

---

## The Debate feature

The Debate tab runs a structured multi-round conversation between your selected models:

- **Round 1 — Independent answers:** each model responds without knowing what the others said
- **Round 2 — Critique & refine:** each model sees all Round 1 responses and refines its answer
- **Round 3 — Convergence:** each model synthesizes everything into a final answer

Because context grows with each round (Round 2 includes all Round 1 responses, Round 3 includes both), a 3-round debate with 4 models costs roughly 5–6× a single prompt. The cost estimate banner shows you the expected cost before you start.

### Thread Composer

After a debate, click **Build Thread →** to open the Thread Composer. It lets you:

1. Check individual responses by round and model to include in a composed context
2. See a live preview of the context as it will be sent
3. Add a follow-up question or instruction
4. Choose which models receive the follow-up (can be different from the debate participants)
5. Click **Send to Prompt tab →** — the follow-up fires automatically with the composed context pre-loaded

### Product Owner role

Right-click any model chip in the Thread Composer to assign it the **Product Owner** role (crown 👑). Instead of answering the follow-up directly, the PO model reviews all other models' outputs, identifies the strongest approach, flags risks or mistakes, and delivers a clear recommendation. Only one PO is allowed at a time — assigning a new one demotes the previous. This is especially useful for coding tasks where you want one model to review and direct rather than just solve.

---

## Checking your OpenRouter balance

Your current OpenRouter credit balance is shown live in the top-right corner of the app. It's updated on page load and after every completed prompt. You can also check it at [openrouter.ai/account](https://openrouter.ai/account).

Gemini usage is billed separately by Google and the cost shown in the app is an estimate based on published per-token rates — check [Google AI Studio](https://aistudio.google.com) for actual billing.

---

## Contributing

PRs and issues are welcome. This is a personal tool built for fun and productivity — if you add something useful, please share it back.

A few guidelines:
- One feature or fix per PR
- Keep dependencies minimal — the goal is a lightweight, self-hostable tool
- Test with at least one free model before submitting

---

## License

MIT
