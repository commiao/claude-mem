#!/usr/bin/env python3
"""MemCheck / 记忆质检: inspect installed integration or run offline candidate checks."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

REPO = Path(__file__).resolve().parents[1]


def integration_status():
    bundle_path = Path(os.environ.get('LLM_EVAL_ACTIVE_BUNDLE', str(Path.home() / '.local/share/llm-eval/active-bundle.json'))).expanduser().resolve()
    bundle = json.loads(bundle_path.read_text())
    launcher = shutil.which('llm-eval')
    if not launcher:
        raise RuntimeError('released llm-eval CLI is not installed')
    # The released launcher validates the bundle and loads its installed adapters.
    result = subprocess.run([launcher, 'scenarios'], capture_output=True, text=True, check=True)
    descriptors = json.loads(result.stdout)
    installed = {d['id']: d for d in descriptors if d['id'].startswith('claude_mem.')}
    expected = {'claude_mem.observation', 'claude_mem.summary'}
    if set(installed) != expected:
        raise RuntimeError('released observation/summary adapters are incomplete')
    revisions = {d['business_provenance']['source_revision'] for d in installed.values()}
    if len(revisions) != 1:
        raise RuntimeError('observation/summary source revisions differ')
    revision = next(iter(revisions))
    for ident, descriptor in installed.items():
        if bundle['adapters'][ident]['descriptor'] != descriptor:
            raise RuntimeError('active bundle changed or installed descriptor differs')
    git = subprocess.run(['git', '-C', str(REPO), 'rev-parse', 'HEAD'], capture_output=True, text=True)
    head = git.stdout.strip() if git.returncode == 0 else None
    git_status = subprocess.run(['git', '-C', str(REPO), 'status', '--porcelain'], capture_output=True, text=True)
    dirty = bool(git_status.stdout.strip()) if git_status.returncode == 0 else None
    python = bundle_path.parent / 'venv' / ('Scripts/python.exe' if os.name == 'nt' else 'bin/python')
    filter_keys = {'no_value_contamination', 'low_value_contamination', 'filter_quality'}
    return {'name': 'MemCheck / 记忆质检', 'active_bundle': str(bundle_path), 'runtime_python': str(python),
            'installed_scenarios': sorted(installed), 'installed_business_source_revision': revision,
            'candidate_source_revision': head, 'candidate_worktree_dirty': dirty,
            'candidate_matches_installed_source': head == revision and dirty is False,
            'filter_metrics_in_shared_report': any(filter_keys & set(d.get('metrics', {})) for d in installed.values()),
            'baseline_source': str(Path.home() / '.local/share/claude-mem-eval/releases' / revision),
            'new_model_calls': 0}


def quick(out: Path, evidence: Path | None):
    status = integration_status()
    out.mkdir(parents=True, mode=0o700, exist_ok=False)
    (out / 'integration-status.json').write_text(json.dumps(status, ensure_ascii=False, indent=2))
    env = dict(os.environ, LLM_EVAL_TEST_PYTHON=status['runtime_python'],
               LLM_EVAL_ACTIVE_BUNDLE=status['active_bundle'])
    commands = [
        ('summary-regressions', ['bun', 'test', 'tests/sdk/parse-summary-structure.test.ts',
                                  'tests/worker/agents/response-processor-notes-summary.test.ts']),
        ('filter-metrics-regressions', [status['runtime_python'], '-m', 'unittest', 'discover',
                                       '-s', 'tests/evaluation', '-p', 'test_observer_filter_quality.py', '-v']),
        ('synthetic-case-contract', ['llm-eval', 'adapter-validate', '--scenario', 'claude_mem.observation',
                                     '--cases', str(REPO / 'docs/examples/observer-semantic-regressions.json')]),
    ]
    if evidence:
        baseline = Path(status['baseline_source'])
        if not (baseline / 'src/sdk/parser.ts').is_file():
            raise RuntimeError('the installed adapter source snapshot is unavailable; no development-tree fallback')
        commands.append(('historical-parser-replay', ['bun', str(REPO / 'scripts/observer_parser_replay.ts'),
                         str(evidence.resolve()), str(baseline), str(REPO), str(out / 'parser-replay.json')]))
        labels = evidence / 'filter-quality/metrics-input.json'
        if labels.is_file():
            commands.append(('reviewed-filter-metrics', [sys.executable, str(REPO / 'scripts/observer_filter_quality.py'),
                             '--labels', str(labels.resolve()), '--out', str(out / 'filter-metrics.json')]))
    steps = []
    for name, command in commands:
        try:
            result = subprocess.run(command, cwd=REPO, env=env, capture_output=True, text=True, timeout=60)
            (out / (name + '.log')).write_text(result.stdout + result.stderr)
            steps.append({'name': name, 'exit_code': result.returncode, 'passed': result.returncode == 0})
        except (OSError, subprocess.TimeoutExpired) as exc:
            steps.append({'name': name, 'passed': False, 'error': type(exc).__name__})
    passed = all(s['passed'] for s in steps)
    report = {'name': 'MemCheck / 记忆质检', 'scope': 'offline candidate regression only',
              'passed': passed, 'steps': steps, 'integration': status, 'new_model_calls': 0,
              'changed_prompt_quality_verified': False, 'production_allowed': False,
              'notes': ['Tests and saved-output replay check parser/counting changes, not newly generated model quality.',
                        'The installed released bridge still uses its pinned source; candidate changes are tested explicitly.',
                        'Filter metrics aggregate existing review labels; recomputation does not improve model output.']}
    (out / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print(json.dumps({'name': report['name'], 'passed': passed, 'checks': len(steps),
                      'new_model_calls': 0, 'changed_prompt_quality_verified': False,
                      'report': str(out / 'report.json')}, ensure_ascii=False))
    return 0 if passed else 1


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    commands.add_parser('status', help='show released framework integration and candidate version differences')
    check = commands.add_parser('quick', help='run offline parser/counting regressions without model calls')
    check.add_argument('--out', required=True, type=Path, help='new private results directory')
    check.add_argument('--evidence', type=Path, help='optional existing audit directory; never reads live DB')
    args = parser.parse_args()
    if args.command == 'status':
        print(json.dumps(integration_status(), ensure_ascii=False, indent=2))
        return 0
    return quick(args.out.resolve(), args.evidence)


if __name__ == '__main__':
    raise SystemExit(main())
