#!/usr/bin/env python3
"""Compatibility entry: common lifecycle now lives in the installed llm-eval package.

Use --scenario claude_mem.observation or claude_mem.summary. The former prototype's
--runtime-repo and repository imports have been removed. See docs/observer-model-bench.md.
"""
from llm_eval.cli import main
if __name__ == '__main__':
    raise SystemExit(main())
