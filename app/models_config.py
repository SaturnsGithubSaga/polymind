"""
models_config.py — Loads litellm_config.yaml and exposes model metadata.
This is the single source of truth for model information used by the backend
and surfaced to the frontend via GET /api/models.
"""

from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path
from typing import Any

import yaml

# The config file is mounted into the container at /litellm_config.yaml
# Fall back to searching relative to this file for local dev.
_CONFIG_PATHS = [
    Path("/litellm_config.yaml"),
    Path(__file__).parent.parent / "litellm_config.yaml",
]

# ---------------------------------------------------------------------------
# Model metadata that is NOT in litellm_config.yaml (display / UI / cost)
# This acts as an overlay keyed by the LiteLLM model_name.
# ---------------------------------------------------------------------------
_MODEL_METADATA: dict[str, dict[str, Any]] = {
    "llama-3.3-70b": {
        "display_name": "Llama 3.3 70B",
        "provider_label": "OpenRouter",
        "tier": "free",
        "accent_color": "#888888",
        "vision": False,
        "input_cost_per_million": 0.0,
        "output_cost_per_million": 0.0,
        "context_window": 131072,
        "billing_note": None,
    },
    "gemini-flash-free": {
        "display_name": "Gemini 2.0 Flash",
        "provider_label": "OpenRouter",
        "tier": "free",
        "accent_color": "#888888",
        "vision": True,
        "input_cost_per_million": 0.0,
        "output_cost_per_million": 0.0,
        "context_window": 1048576,
        "billing_note": None,
    },
    "deepseek-r1": {
        "display_name": "DeepSeek R1",
        "provider_label": "OpenRouter",
        "tier": "free",
        "accent_color": "#888888",
        "vision": False,
        "input_cost_per_million": 0.0,
        "output_cost_per_million": 0.0,
        "context_window": 65536,
        "billing_note": None,
    },
    "qwen-2.5-72b": {
        "display_name": "Qwen 2.5 72B",
        "provider_label": "OpenRouter",
        "tier": "free",
        "accent_color": "#888888",
        "vision": False,
        "input_cost_per_million": 0.0,
        "output_cost_per_million": 0.0,
        "context_window": 131072,
        "billing_note": None,
    },
    "gpt-4o-mini": {
        "display_name": "GPT-4o mini",
        "provider_label": "OpenRouter",
        "tier": "paid",
        "accent_color": "#FCA3B7",
        "vision": True,
        "input_cost_per_million": 0.15,
        "output_cost_per_million": 0.60,
        "context_window": 128000,
        "billing_note": None,
    },
    "gemini-flash-paid": {
        "display_name": "Gemini Flash Pro",
        "provider_label": "Google API",
        "tier": "paid",
        "accent_color": "#4A90D9",
        "vision": True,
        "input_cost_per_million": 0.075,
        "output_cost_per_million": 0.30,
        "context_window": 1048576,
        "billing_note": "Billed to Google Gemini plan, not OpenRouter credits.",
    },
    "claude-haiku": {
        "display_name": "Claude Haiku 4.5",
        "provider_label": "OpenRouter",
        "tier": "paid",
        "accent_color": "#E8894A",
        "vision": True,
        "input_cost_per_million": 1.00,
        "output_cost_per_million": 5.00,
        "context_window": 200000,
        "billing_note": None,
    },
    "grok": {
        "display_name": "Grok 4.3",
        "provider_label": "OpenRouter",
        "tier": "paid",
        "accent_color": "#C8C8C8",
        "vision": False,
        "input_cost_per_million": 1.25,
        "output_cost_per_million": 2.50,
        "context_window": 1000000,
        "billing_note": None,
    },
}

# Prompts-per-$10 reference (800 avg tokens: 400 in + 400 out)
_AVG_INPUT_TOKENS = 400
_AVG_OUTPUT_TOKENS = 400
_REFERENCE_BUDGET = 10.0


def _prompts_per_10(meta: dict) -> str | None:
    """Return a human-readable prompts-per-$10 string for paid models."""
    if meta["tier"] == "free":
        return None
    cost_per_prompt = (
        meta["input_cost_per_million"] * _AVG_INPUT_TOKENS / 1_000_000
        + meta["output_cost_per_million"] * _AVG_OUTPUT_TOKENS / 1_000_000
    )
    if cost_per_prompt == 0:
        return None
    count = int(_REFERENCE_BUDGET / cost_per_prompt)
    return f"~{count:,} prompts / $10"


def _load_config() -> list[dict]:
    """Load litellm_config.yaml from the first path that exists."""
    for p in _CONFIG_PATHS:
        if p.exists():
            with open(p) as f:
                return yaml.safe_load(f).get("model_list", [])
    raise FileNotFoundError(
        f"litellm_config.yaml not found at any of: {_CONFIG_PATHS}"
    )


@lru_cache(maxsize=1)
def get_models() -> list[dict]:
    """Return all models with merged metadata, ready for the frontend."""
    raw_models = _load_config()
    result = []
    for entry in raw_models:
        model_id = entry.get("model_name", "")
        meta = _MODEL_METADATA.get(model_id)
        if meta is None:
            continue  # skip unknown models
        litellm_model = entry.get("litellm_params", {}).get("model", "")
        result.append(
            {
                "id": model_id,
                "display_name": meta["display_name"],
                "provider_label": meta["provider_label"],
                "litellm_model": litellm_model,
                "tier": meta["tier"],
                "accent_color": meta["accent_color"],
                "vision": meta["vision"],
                "input_cost_per_million": meta["input_cost_per_million"],
                "output_cost_per_million": meta["output_cost_per_million"],
                "context_window": meta["context_window"],
                "billing_note": meta["billing_note"],
                "prompts_per_10_usd": _prompts_per_10(meta),
            }
        )
    return result


def get_model_by_id(model_id: str) -> dict | None:
    """Return a single model dict by its ID, or None if not found."""
    for m in get_models():
        if m["id"] == model_id:
            return m
    return None


def get_system_prompt(role: str) -> str:
    """Return the system prompt string for a given model role."""
    if role == "product_owner":
        return (
            "You are the Product Owner and technical lead reviewing this discussion. "
            "Your job is NOT to solve the problem yourself. Instead: review all "
            "provided context and model outputs, identify the strongest approach, "
            "call out any errors or risks in the other models' reasoning, and deliver "
            "a clear decision or set of directives for the team. Be specific, "
            "opinionated, and concise. Sign off with your recommendation."
        )
    # Default: participant
    return (
        "You are a helpful AI assistant. Answer the user's question thoroughly "
        "and accurately. You may see context from other AI models — engage with "
        "it honestly."
    )
