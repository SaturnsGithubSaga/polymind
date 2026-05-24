"""
debate.py — Message construction for multi-round debate flows.
Pure functions — no I/O. All async streaming is handled in main.py.
"""

from __future__ import annotations


def _format_responses(responses: dict[str, str], model_display_names: dict[str, str]) -> str:
    """
    Format a dict of {model_id: response_text} into a readable multi-model block.
    """
    parts = []
    for model_id, text in responses.items():
        name = model_display_names.get(model_id, model_id)
        parts.append(f"[{name}]\n{text.strip()}")
    return "\n\n".join(parts)


def build_round1_messages(
    user_prompt: str,
    system_prompt: str,
) -> list[dict]:
    """
    Round 1: Independent answers. Models have no knowledge of each other.
    """
    return [
        {
            "role": "system",
            "content": (
                system_prompt
                + "\n\nAnswer the following question independently and thoroughly. "
                "Do not reference other AI models or assume collaboration."
            ),
        },
        {"role": "user", "content": user_prompt},
    ]


def build_round2_messages(
    user_prompt: str,
    round1_responses: dict[str, str],
    model_display_names: dict[str, str],
    system_prompt: str,
) -> list[dict]:
    """
    Round 2: Critique and refine, given all Round 1 responses as context.
    """
    formatted = _format_responses(round1_responses, model_display_names)
    return [
        {
            "role": "system",
            "content": (
                system_prompt
                + "\n\nYou are participating in a structured AI debate. "
                "Review the other models' responses, identify where you agree and disagree, "
                "and refine your own answer. Be specific about what you are changing and why."
            ),
        },
        {
            "role": "user",
            "content": (
                f"Original question: {user_prompt}\n\n"
                f"Other models' Round 1 answers:\n{formatted}\n\n"
                "Now provide your refined answer:"
            ),
        },
    ]


def build_round3_messages(
    user_prompt: str,
    round1_responses: dict[str, str],
    round2_responses: dict[str, str],
    model_display_names: dict[str, str],
    system_prompt: str,
) -> list[dict]:
    """
    Round 3: Final convergence, given all prior rounds as context.
    """
    r1_formatted = _format_responses(round1_responses, model_display_names)
    r2_formatted = _format_responses(round2_responses, model_display_names)
    return [
        {
            "role": "system",
            "content": (
                system_prompt
                + "\n\nThis is the final round of the debate. "
                "Provide a single converged answer that synthesizes the best points from all models. "
                "Note any remaining disagreements briefly if consensus is impossible."
            ),
        },
        {
            "role": "user",
            "content": (
                f"Original question: {user_prompt}\n\n"
                f"Round 1 answers:\n{r1_formatted}\n\n"
                f"Round 2 refined answers:\n{r2_formatted}\n\n"
                "Provide your final converged answer:"
            ),
        },
    ]


def build_messages_for_round(
    round_number: int,
    user_prompt: str,
    round1_responses: dict[str, str],
    round2_responses: dict[str, str],
    model_display_names: dict[str, str],
    system_prompt: str,
) -> list[dict]:
    """Dispatch to the correct round builder."""
    if round_number == 1:
        return build_round1_messages(user_prompt, system_prompt)
    elif round_number == 2:
        return build_round2_messages(
            user_prompt, round1_responses, model_display_names, system_prompt
        )
    elif round_number == 3:
        return build_round3_messages(
            user_prompt, round1_responses, round2_responses, model_display_names, system_prompt
        )
    else:
        raise ValueError(f"Invalid round number: {round_number}")
