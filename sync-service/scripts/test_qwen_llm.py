#!/usr/bin/env python3
"""Smoke-test GIOP LLM wiring (Qwen / DashScope or any OpenAI-compatible provider)."""

from __future__ import annotations

import os
import sys

from dotenv import load_dotenv

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
load_dotenv(os.path.join(os.path.dirname(ROOT), ".env"))

from agents.llm.provider import complete_chat, llm_configured


def main() -> int:
    if not llm_configured():
        print("FAIL: set GIOP_LLM_API_KEY in .env")
        return 1

    model = os.getenv("GIOP_LLM_MODEL") or "qwen-plus"
    print(f"Testing model={model} …")
    try:
        result = complete_chat(
            [{"role": "user", "content": "Reply with exactly: GIOP Qwen OK"}],
            model=model,
            max_tokens=32,
        )
    except Exception as exc:
        print(f"FAIL: {exc}")
        print(
            "\nIf you see AccessDenied.Unpurchased: enable qwen-plus in DashScope Model Studio "
            "(Singapore/intl region) for your workspace, then retry."
        )
        print(
            "If you see Model.AccessDenied: set GIOP_LLM_WORKSPACE_ID=ws-… in .env "
            "(Workspace Management page)."
        )
        return 1

    content = (result.get("content") or "").strip()
    print(f"OK: model={result.get('model')} content={content[:120]!r}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
