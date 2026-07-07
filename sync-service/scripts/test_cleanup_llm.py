#!/usr/bin/env python3
"""Smoke-test GIOP cleanup agent LLM (DeepSeek, Qwen, or any OpenAI-compatible provider)."""

from __future__ import annotations

import os
import sys

from dotenv import load_dotenv

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
load_dotenv(os.path.join(os.path.dirname(ROOT), ".env"))

from agents.llm.provider import cleanup_llm_configured, complete_chat, get_llm_profile


def main() -> int:
    if not cleanup_llm_configured():
        print("FAIL: set GIOP_CLEANUP_LLM_API_KEY (or GIOP_LLM_API_KEY) in .env")
        return 1

    cfg = get_llm_profile("cleanup")
    print(f"Testing cleanup profile model={cfg.model} base={cfg.base_url} …")
    try:
        result = complete_chat(
            [{"role": "user", "content": "Reply with exactly: GIOP cleanup agent OK"}],
            profile="cleanup",
            max_tokens=32,
        )
    except Exception as exc:
        print(f"FAIL: {exc}")
        return 1

    content = (result.get("content") or "").strip()
    if result.get("model") == "deterministic-fallback":
        print(f"FAIL: fallback — {content[:200]}")
        return 1
    print(f"OK: model={result.get('model')} content={content[:120]!r}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
