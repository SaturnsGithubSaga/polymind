"""
cost_tracker.py — Stateless cost calculation utilities.
All session state lives in the frontend. This module only does math and
fetches the OpenRouter balance on demand.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any

import httpx

logger = logging.getLogger(__name__)

OPENROUTER_KEY_URL = "https://openrouter.ai/api/v1/auth/key"


def calculate_cost(
    model: dict,
    input_tokens: int,
    output_tokens: int,
) -> dict[str, float]:
    """
    Calculate USD cost for a single model response.

    Args:
        model: Model dict from models_config.get_model_by_id()
        input_tokens: Number of prompt/input tokens used
        output_tokens: Number of completion/output tokens used

    Returns:
        Dict with input_cost_usd, output_cost_usd, total_cost_usd
    """
    input_cost = input_tokens / 1_000_000 * model["input_cost_per_million"]
    output_cost = output_tokens / 1_000_000 * model["output_cost_per_million"]
    return {
        "input_cost_usd": round(input_cost, 8),
        "output_cost_usd": round(output_cost, 8),
        "total_cost_usd": round(input_cost + output_cost, 8),
    }


def estimate_debate_cost(
    model_configs: list[dict],
    n_rounds: int = 3,
    avg_prompt_tokens: int = 400,
    avg_response_tokens: int = 400,
) -> dict[str, Any]:
    """
    Estimate the total cost of a debate before it runs.

    Token growth per round:
      Round 1 input: avg_prompt_tokens (system prompt + user prompt)
      Round 2 input: avg_prompt_tokens + n_models * avg_response_tokens
      Round 3 input: avg_prompt_tokens + 2 * n_models * avg_response_tokens

    Returns:
        {
          "per_model": { model_id: { "round_estimates": [...], "total_usd": float } },
          "total_usd": float,
          "rounds": n_rounds,
          "n_models": len(model_configs),
        }
    """
    n_models = len(model_configs)
    per_model: dict[str, Any] = {}
    grand_total = 0.0

    for model in model_configs:
        model_id = model["id"]
        round_estimates = []
        model_total = 0.0

        for r in range(1, n_rounds + 1):
            # Each round the input context grows with prior responses
            context_tokens = avg_prompt_tokens + (r - 1) * n_models * avg_response_tokens
            cost = calculate_cost(model, context_tokens, avg_response_tokens)
            round_estimates.append(
                {
                    "round": r,
                    "input_tokens": context_tokens,
                    "output_tokens": avg_response_tokens,
                    **cost,
                }
            )
            model_total += cost["total_cost_usd"]

        per_model[model_id] = {
            "round_estimates": round_estimates,
            "total_usd": round(model_total, 8),
        }
        grand_total += model_total

    return {
        "per_model": per_model,
        "total_usd": round(grand_total, 8),
        "rounds": n_rounds,
        "n_models": n_models,
    }


async def fetch_openrouter_balance(api_key: str) -> dict[str, Any]:
    """
    Fetch current OpenRouter credit balance.

    Returns:
        { "openrouter_balance_usd": float, "fetched_at": ISO8601 }
        or { "openrouter_balance_usd": None, "error": str, "fetched_at": ISO8601 }
        Never raises — always returns a safe dict.
    """
    fetched_at = datetime.now(timezone.utc).isoformat()

    if not api_key or api_key.startswith("your_"):
        return {
            "openrouter_balance_usd": None,
            "error": "No API key configured",
            "fetched_at": fetched_at,
        }

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(
                OPENROUTER_KEY_URL,
                headers={"Authorization": f"Bearer {api_key}"},
            )
            resp.raise_for_status()
            data = resp.json().get("data", {})

            # OpenRouter returns limit_remaining or (limit - usage)
            balance = data.get("limit_remaining")
            if balance is None:
                limit = data.get("limit")
                usage = data.get("usage", 0)
                if limit is not None:
                    balance = limit - usage

            return {
                "openrouter_balance_usd": balance,
                "fetched_at": fetched_at,
            }

    except httpx.HTTPStatusError as e:
        logger.warning("OpenRouter balance fetch HTTP error: %s", e)
        return {
            "openrouter_balance_usd": None,
            "error": f"HTTP {e.response.status_code}",
            "fetched_at": fetched_at,
        }
    except Exception as e:
        logger.warning("OpenRouter balance fetch failed: %s", e)
        return {
            "openrouter_balance_usd": None,
            "error": str(e),
            "fetched_at": fetched_at,
        }
