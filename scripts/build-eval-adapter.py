#!/usr/bin/env python3
"""Build business assets before wheel packaging. Never copies private evaluation data."""
import hashlib
import json
import shutil
import re
import subprocess
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
ASSETS=ROOT/'adapters/evaluation/src/claude_mem_eval/assets'
ASSETS.mkdir(parents=True,exist_ok=True)
sources=['scripts/observer-bench/shared-bridge.ts','scripts/observer_triage_prepare.py','src/services/worker/ObserverBatchRequest.ts',
         'src/sdk/prompts.ts','src/sdk/parser.ts','src/services/worker/agents/ObservationNormalization.ts','plugin/modes/code.json',
         'adapters/evaluation/src/claude_mem_eval/filter_quality.py',
         'adapters/evaluation/src/claude_mem_eval/filter_metrics.py',
         'adapters/evaluation/src/claude_mem_eval/filter_persistence.py',
         'adapters/evaluation/src/claude_mem_eval/triage.py',
         'adapters/evaluation/src/claude_mem_eval/triage_context.py',
         'adapters/evaluation/src/claude_mem_eval/triage_v2.py',
         'adapters/evaluation/src/claude_mem_eval/triage_transport.py']
# Capture the complete local TS dependency closure, not just top-level business files.
seen=set(sources)
pending=list(sources)
while pending:
    current=pending.pop()
    if not current.endswith('.ts'):continue
    text=(ROOT/current).read_text()
    for specifier in re.findall(r"(?:from\s+|import\s*\()['\"](\.[^'\"]+)['\"]",text):
        dependency=(ROOT/current).parent/specifier
        if dependency.suffix=='.js':dependency=dependency.with_suffix('.ts')
        if dependency.is_file():
            name=str(dependency.resolve().relative_to(ROOT))
            if name not in seen:seen.add(name);pending.append(name)
sources=sorted(seen)
subprocess.run(['bun','build',str(ROOT/'scripts/observer-bench/shared-bridge.ts'),'--target=bun','--format=cjs','--minify',
                '--outfile='+str(ASSETS/'bridge.cjs')],cwd=ROOT,check=True)
(ASSETS/'modes').mkdir(exist_ok=True)
shutil.copyfile(ROOT/'plugin/modes/code.json',ASSETS/'modes/code.json')
shutil.copyfile(ROOT/'adapters/evaluation/FILTER-REVIEW.md',ASSETS/'filter-review.md')
release=ROOT/'RELEASE.json'
revision=json.loads(release.read_text())['commit'] if release.is_file() else subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip()
manifest={'source_revision':revision,
          'runtime':'bun','source_files':{p:hashlib.sha256((ROOT/p).read_bytes()).hexdigest() for p in sources},
          'bridge_sha256':hashlib.sha256((ASSETS/'bridge.cjs').read_bytes()).hexdigest(),
          'production_profile':{'maxItems':20,'maxBytes':64000,'max_tokens':4096}}
(ASSETS/'provenance.json').write_text(json.dumps(manifest,indent=2)+'\n')
print(json.dumps({'assets':str(ASSETS),'source_files':len(sources),'private_data_included':False}))
