"""Per-token prices (USD per 1M tokens, Anthropic first-party API) for cost reporting."""

from __future__ import annotations

from typing import Optional

# (input, output). Cache writes bill at 1.25x input (5-minute TTL), cache reads at 0.1x.
PRICES: dict[str, tuple[float, float]] = {
    "claude-fable-5-1": (10.0, 50.0),
    "claude-opus-5-5": (4.0, 20.0),
    "claude-opus-5": (5.0, 25.0),
    "claude-opus-4-8": (5.0, 25.0),
    "claude-sonnet-5": (2.0, 10.0),
    "claude-haiku-4-5": (1.0, 5.0),
}


def price_for(model: str) -> Optional[tuple[float, float]]:
    # Longest prefix first, so "claude-opus-5-5" is not priced as "claude-opus-5".
    for name in sorted(PRICES, key=len, reverse=True):
        if model.startswith(name):
            return PRICES[name]
    return None


def cost_usd(model: str, usage) -> Optional[float]:
    price = price_for(model)
    if price is None or usage is None:
        return None
    p_in, p_out = price
    uncached = getattr(usage, "input_tokens", 0) or 0
    cache_write = getattr(usage, "cache_creation_input_tokens", 0) or 0
    cache_read = getattr(usage, "cache_read_input_tokens", 0) or 0
    out = getattr(usage, "output_tokens", 0) or 0
    return (uncached * p_in + cache_write * p_in * 1.25 + cache_read * p_in * 0.1 + out * p_out) / 1e6
