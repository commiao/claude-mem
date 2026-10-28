#!/usr/bin/env python3
"""Compatibility CLI for the business-owned, packaged filter metric calculator."""
import argparse
import importlib.util
import json
from pathlib import Path

_PATH = Path(__file__).resolve().parents[1] / 'adapters/evaluation/src/claude_mem_eval/filter_quality.py'
_SPEC = importlib.util.spec_from_file_location('claude_mem_filter_quality', _PATH)
_MODULE = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_MODULE)
aggregate = _MODULE.aggregate


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--labels', required=True, type=Path)
    parser.add_argument('--out', required=True, type=Path)
    args = parser.parse_args()
    result = aggregate(json.loads(args.labels.read_text()))
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(result, ensure_ascii=False, indent=2))
    print(json.dumps({'out': str(args.out), 'cases': result['inputs']['cases'],
                      'generated': result['generated']['count'], 'newly_persisted': result['newly_persisted']['count']}))


if __name__ == '__main__':
    main()
