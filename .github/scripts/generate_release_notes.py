#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "openai>=1.55",
# ]
# ///
"""Generate bilingual markdown release notes from a git commit range via OpenAI.

Env:
  CUR              required — current tag (e.g., v1.6.3)
  PREV             optional — previous tag; if empty, full history is used
  OPENAI_API_KEY   required for AI summary; without it the commit list is returned
  OPENAI_MODEL     optional — default: gpt-5.4
  SYSTEM_PROMPT    optional — override default bilingual prompt

Stdout: markdown. Never exits non-zero for any failure — always emits a usable
fallback so release creation isn't blocked by an OpenAI outage or a bad git range.
"""
from __future__ import annotations

import os
import subprocess
import sys

from openai import OpenAI, OpenAIError

DEFAULT_SYSTEM_PROMPT = (
    "Generate bilingual release notes for the Electron desktop app (Listener.AI). "
    "Output markdown only — no preamble, no trailing explanation. "
    "Structure: English block first, then Korean block, separated by a horizontal rule. "
    "English block — header '## English' followed by sections "
    "'### New Features', '### Improvements', '### Bug Fixes', '### Internal Changes'. "
    "Korean block — header '## 한국어' followed by sections "
    "'### 신규 기능', '### 개선', '### 버그 수정', '### 내부 변경'. "
    "Omit empty sections in each block. "
    "Rewrite each commit as a user-facing bullet (not verbatim). "
    "The two blocks must describe the same changes — Korean is a translation of the English content, "
    "not independent notes."
)


def log(msg: str) -> None:
    print(msg, file=sys.stderr)


def git_commit_list(prev: str | None, cur: str) -> str:
    ref = f"{prev}..{cur}" if prev else cur
    try:
        result = subprocess.run(
            ["git", "log", "--pretty=format:- %s", ref],
            capture_output=True,
            text=True,
            check=True,
        )
        return result.stdout.strip()
    except subprocess.CalledProcessError as e:
        log(f"::warning::git log {ref} failed: {e.stderr.strip() or e}")
        return ""


def fallback(commits: str) -> str:
    return f"## 변경사항\n\n{commits}\n"


def generate_ai_notes(
    *,
    api_key: str,
    model: str,
    system_prompt: str,
    version: str,
    commits: str,
) -> str | None:
    try:
        client = OpenAI(api_key=api_key, timeout=60.0, max_retries=2)
        resp = client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": system_prompt},
                {
                    "role": "user",
                    "content": f"버전: {version}\n\n커밋 목록:\n{commits}",
                },
            ],
        )
        content = (resp.choices[0].message.content or "").strip()
        return content or None
    except OpenAIError as e:
        log(f"::warning::OpenAI request failed: {e}")
        return None


def main() -> int:
    cur = os.environ.get("CUR")
    if not cur:
        log("::error::CUR (current tag) env var is required")
        return 2

    prev = os.environ.get("PREV") or None
    api_key = os.environ.get("OPENAI_API_KEY")
    model = os.environ.get("OPENAI_MODEL", "gpt-5.4")
    system_prompt = os.environ.get("SYSTEM_PROMPT") or DEFAULT_SYSTEM_PROMPT

    commits = git_commit_list(prev, cur)

    if not api_key:
        log("::warning::OPENAI_API_KEY not set, using commit list fallback")
        sys.stdout.write(fallback(commits))
        return 0

    notes = generate_ai_notes(
        api_key=api_key,
        model=model,
        system_prompt=system_prompt,
        version=cur,
        commits=commits,
    )
    if notes is None:
        log("::warning::AI notes generation failed, using commit list fallback")
        sys.stdout.write(fallback(commits))
        return 0

    sys.stdout.write(notes)
    return 0


if __name__ == "__main__":
    sys.exit(main())
