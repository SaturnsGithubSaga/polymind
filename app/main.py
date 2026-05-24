"""
main.py — PolyMind FastAPI application.

Routes:
  GET  /                  → serves index.html
  GET  /api/models        → model list for frontend
  POST /api/prompt        → SSE: parallel multi-model streaming
  POST /api/debate        → SSE: multi-round debate streaming
  GET  /api/balance       → OpenRouter credit balance

All LiteLLM calls go through the sidecar container at LITELLM_BASE_URL.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from pathlib import Path
from typing import Any, AsyncIterator

import httpx
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from sse_starlette.sse import EventSourceResponse

from cost_tracker import calculate_cost, estimate_debate_cost, fetch_openrouter_balance
from debate import build_messages_for_round
from models_config import get_model_by_id, get_models, get_system_prompt

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
LITELLM_BASE_URL = os.getenv("LITELLM_BASE_URL", "http://litellm:4000")
LITELLM_MASTER_KEY = os.getenv("LITELLM_MASTER_KEY", "")
OPENROUTER_API_KEY = os.getenv("OPENROUTER_API_KEY", "")

STATIC_DIR = Path(__file__).parent / "static"

# ---------------------------------------------------------------------------
# App setup
# ---------------------------------------------------------------------------
app = FastAPI(title="PolyMind", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


# ---------------------------------------------------------------------------
# Root — serve SPA shell
# ---------------------------------------------------------------------------
@app.get("/")
async def root():
    return FileResponse(STATIC_DIR / "index.html")


# ---------------------------------------------------------------------------
# Request / response models
# ---------------------------------------------------------------------------
class PromptRequest(BaseModel):
    prompt: str
    image_base64: str | None = None
    image_media_type: str | None = None
    model_ids: list[str]
    model_roles: dict[str, str] = Field(default_factory=dict)


class DebateRequest(BaseModel):
    prompt: str
    model_ids: list[str]
    model_roles: dict[str, str] = Field(default_factory=dict)
    rounds: int = Field(default=3, ge=2, le=3)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _litellm_headers() -> dict[str, str]:
    return {
        "Authorization": f"Bearer {LITELLM_MASTER_KEY}",
        "Content-Type": "application/json",
    }


def _build_messages(
    user_prompt: str,
    system_prompt: str,
    image_base64: str | None = None,
    image_media_type: str | None = None,
    model_vision: bool = False,
) -> list[dict]:
    """Build the messages list for a single-turn prompt."""
    user_content: Any

    if image_base64 and model_vision:
        user_content = [
            {"type": "text", "text": user_prompt},
            {
                "type": "image_url",
                "image_url": {
                    "url": f"data:{image_media_type};base64,{image_base64}"
                },
            },
        ]
    else:
        user_content = user_prompt

    return [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_content},
    ]


async def _stream_model(
    client: httpx.AsyncClient,
    model_id: str,
    messages: list[dict],
    round_number: int | None = None,
) -> AsyncIterator[dict]:
    """
    Stream tokens from LiteLLM for one model.
    Yields SSE event dicts throughout streaming.
    Always yields a final 'done' or 'error' event.
    """
    model = get_model_by_id(model_id)
    if model is None:
        yield {
            "type": "error",
            "model_id": model_id,
            "round_number": round_number,
            "message": f"Unknown model: {model_id}",
        }
        return

    payload = {
        "model": model_id,
        "messages": messages,
        "stream": True,
        "stream_options": {"include_usage": True},
    }

    full_text = ""
    input_tokens = 0
    output_tokens = 0

    try:
        async with client.stream(
            "POST",
            f"{LITELLM_BASE_URL}/chat/completions",
            headers=_litellm_headers(),
            json=payload,
            timeout=120.0,
        ) as response:
            if response.status_code != 200:
                body = await response.aread()
                yield {
                    "type": "error",
                    "model_id": model_id,
                    "round_number": round_number,
                    "message": f"LiteLLM {response.status_code}: {body.decode()[:300]}",
                }
                return

            async for line in response.aiter_lines():
                if not line.startswith("data:"):
                    continue
                raw = line[5:].strip()
                if raw == "[DONE]":
                    break
                try:
                    chunk = json.loads(raw)
                except json.JSONDecodeError:
                    continue

                # Extract token text
                choices = chunk.get("choices", [])
                if choices:
                    delta = choices[0].get("delta", {})
                    text = delta.get("content") or ""
                    if text:
                        full_text += text
                        event: dict = {
                            "type": "token",
                            "model_id": model_id,
                            "text": text,
                        }
                        if round_number is not None:
                            event["round_number"] = round_number
                        yield event

                # Extract usage if present (comes in the final chunk with include_usage)
                usage = chunk.get("usage")
                if usage:
                    input_tokens = usage.get("prompt_tokens", 0)
                    output_tokens = usage.get("completion_tokens", 0)

    except httpx.TimeoutException:
        yield {
            "type": "error",
            "model_id": model_id,
            "round_number": round_number,
            "message": "Request timed out after 120s",
        }
        return
    except Exception as e:
        yield {
            "type": "error",
            "model_id": model_id,
            "round_number": round_number,
            "message": str(e),
        }
        return

    # Emit usage + done
    cost_info = calculate_cost(model, input_tokens, output_tokens)
    usage_event: dict = {
        "type": "usage",
        "model_id": model_id,
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        **cost_info,
    }
    if round_number is not None:
        usage_event["round_number"] = round_number
    yield usage_event

    done_event: dict = {"type": "done", "model_id": model_id}
    if round_number is not None:
        done_event["round_number"] = round_number
    yield done_event

    # Return the full text so the caller can collect it for debate context
    # We use a sentinel event type that the frontend ignores
    yield {"type": "_text", "model_id": model_id, "text": full_text}


async def _run_models_parallel(
    client: httpx.AsyncClient,
    model_ids: list[str],
    messages_map: dict[str, list[dict]],
    round_number: int | None,
    queue: asyncio.Queue,
):
    """
    Run all models in parallel, putting SSE events into a shared queue.
    Puts a sentinel None for each model when it finishes.
    """

    async def _run_one(model_id: str):
        msgs = messages_map[model_id]
        async for event in _stream_model(client, model_id, msgs, round_number):
            await queue.put(event)
        await queue.put(None)  # sentinel for this model

    await asyncio.gather(*[_run_one(mid) for mid in model_ids])


# ---------------------------------------------------------------------------
# GET /api/models
# ---------------------------------------------------------------------------
@app.get("/api/models")
async def api_models():
    return JSONResponse(get_models())


# ---------------------------------------------------------------------------
# POST /api/prompt  (SSE)
# ---------------------------------------------------------------------------
@app.post("/api/prompt")
async def api_prompt(request: PromptRequest):
    async def event_generator() -> AsyncIterator[dict]:
        valid_ids = [
            mid for mid in request.model_ids if get_model_by_id(mid) is not None
        ]
        if not valid_ids:
            yield {"data": json.dumps({"type": "error", "message": "No valid model IDs"})}
            return

        # Build per-model messages
        messages_map: dict[str, list[dict]] = {}
        for model_id in valid_ids:
            model = get_model_by_id(model_id)
            role = request.model_roles.get(model_id, "participant")
            sys_prompt = get_system_prompt(role)
            messages_map[model_id] = _build_messages(
                request.prompt,
                sys_prompt,
                request.image_base64,
                request.image_media_type,
                model["vision"],
            )

        queue: asyncio.Queue = asyncio.Queue()
        done_count = 0

        async with httpx.AsyncClient() as client:
            producer = asyncio.create_task(
                _run_models_parallel(client, valid_ids, messages_map, None, queue)
            )

            while done_count < len(valid_ids):
                event = await queue.get()
                if event is None:
                    done_count += 1
                    continue
                if event["type"].startswith("_"):
                    # Internal events (like _text) — skip
                    continue
                yield {"data": json.dumps(event)}

            await producer

    return EventSourceResponse(event_generator())


# ---------------------------------------------------------------------------
# POST /api/debate  (SSE)
# ---------------------------------------------------------------------------
@app.post("/api/debate")
async def api_debate(request: DebateRequest):
    async def event_generator() -> AsyncIterator[dict]:
        valid_ids = [
            mid for mid in request.model_ids if get_model_by_id(mid) is not None
        ]
        if not valid_ids:
            yield {"data": json.dumps({"type": "error", "message": "No valid model IDs"})}
            return

        model_display_names = {
            mid: get_model_by_id(mid)["display_name"] for mid in valid_ids
        }

        # Pre-debate cost estimate
        model_configs = [get_model_by_id(mid) for mid in valid_ids]
        estimate = estimate_debate_cost(model_configs, request.rounds)
        yield {
            "data": json.dumps({
                "type": "cost_estimate",
                "estimate": estimate,
            })
        }

        # Build role → system prompt map
        def sys_prompt_for(model_id: str) -> str:
            role = request.model_roles.get(model_id, "participant")
            return get_system_prompt(role)

        # Accumulated responses per round
        round_responses: dict[int, dict[str, str]] = {1: {}, 2: {}, 3: {}}
        total_cost = 0.0

        async with httpx.AsyncClient() as client:
            for round_num in range(1, request.rounds + 1):
                # Notify frontend that a new round is starting
                round_labels = {
                    1: "Independent answers",
                    2: "Critique & refine",
                    3: "Convergence",
                }
                yield {
                    "data": json.dumps({
                        "type": "round_start",
                        "round_number": round_num,
                        "label": round_labels.get(round_num, f"Round {round_num}"),
                    })
                }

                # Build messages for each model in this round
                messages_map: dict[str, list[dict]] = {}
                for model_id in valid_ids:
                    messages_map[model_id] = build_messages_for_round(
                        round_number=round_num,
                        user_prompt=request.prompt,
                        round1_responses=round_responses[1],
                        round2_responses=round_responses[2],
                        model_display_names=model_display_names,
                        system_prompt=sys_prompt_for(model_id),
                    )

                # Stream this round
                queue: asyncio.Queue = asyncio.Queue()
                done_count = 0

                producer = asyncio.create_task(
                    _run_models_parallel(client, valid_ids, messages_map, round_num, queue)
                )

                while done_count < len(valid_ids):
                    event = await queue.get()
                    if event is None:
                        done_count += 1
                        continue

                    # Collect full text for context building in subsequent rounds
                    if event["type"] == "_text":
                        round_responses[round_num][event["model_id"]] = event["text"]
                        continue

                    # Accumulate cost
                    if event["type"] == "usage":
                        total_cost += event.get("total_cost_usd", 0.0)

                    yield {"data": json.dumps(event)}

                await producer

        # Final summary
        yield {
            "data": json.dumps({
                "type": "debate_complete",
                "total_cost_usd": round(total_cost, 8),
                "rounds_completed": request.rounds,
            })
        }

    return EventSourceResponse(event_generator())


# ---------------------------------------------------------------------------
# GET /api/balance
# ---------------------------------------------------------------------------
@app.get("/api/balance")
async def api_balance():
    result = await fetch_openrouter_balance(OPENROUTER_API_KEY)
    return JSONResponse(result)
