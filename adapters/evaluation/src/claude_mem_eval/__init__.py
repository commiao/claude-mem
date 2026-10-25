"""Business-owned scenarios; the installed wheel needs Bun but no checkout or live DB."""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

ASSETS = Path(__file__).parent / "assets"


def bridge(action, value):
    runtime = shutil.which("bun")
    if runtime is None:
        raise ValueError("claude-mem-eval requires its tested Bun runtime")
    with tempfile.TemporaryDirectory(prefix="claude-mem-eval-private-") as directory:
        env = dict(os.environ, CLAUDE_MEM_DATA_DIR=directory, CLAUDE_MEM_MODES_DIR=str(ASSETS / "modes"))
        result = subprocess.run([runtime, str(ASSETS / "bridge.cjs"), action, directory, str(ASSETS / "modes")],
            input=json.dumps(value, ensure_ascii=False, allow_nan=False), text=True, capture_output=True, env=env,
            cwd=directory, timeout=60)
        if result.returncode:
            raise ValueError("business bridge rejected input: " + result.stderr[-1500:])
        return json.loads(result.stdout)


class Observation:
    kind = "observation"

    def describe(self):
        provenance=json.loads((ASSETS/'provenance.json').read_text())
        return {"sdk": 1, "id": "claude_mem." + self.kind, "version": "1", "policy_version": "mem-unvalidated-1",
            "business_provenance":{"source_revision":provenance['source_revision'],
                                   "bridge_sha256":provenance['bridge_sha256']},
            "unit": "frozen source case; one or more independent requests", "modes": ["smoke", "admission", "blind"],
            "runtime": "Bun (bundled business bridge)", "production_route": "claude_mem.observation",
            "profile": {"maxItems":20,"maxBytes":64000,"max_tokens":4096,"source":"production ObserverBatchRequest"},
            "metrics": {"diagnostic_anchor_coverage": {"unit":"ratio","denominator":"labeled lexical anchors", "semantic_truth":False},
                        "character_ratio": {"unit":"characters/characters","denominator":"source text characters", "tokens":False}},
            "policy": {"minimum_cases":30,"minimum_random_reviews":10,"minimum_source_quote":1,
                       "minimum_identity":"local-observed","requires_output_budget":True,"calibrated":False}}

    def validate_case(self, case):
        if case.get("kind") != self.kind:
            raise ValueError("keep observation and summary datasets separate")
        if case.get("request"):
            request=case["request"]
            if not isinstance(request.get("system"),str) or not isinstance(request.get("messages"),list):
                raise ValueError("invalid frozen production request")
        elif self.kind == "observation" and not case.get("records"):
            raise ValueError("raw tool records required")
        elif self.kind == "summary" and not isinstance(case.get("persisted_observations",[]),list):
            raise ValueError("freeze historical observation context; live lookups unsupported")

    def build_requests(self, cases, profile):
        unknown = set(profile)-{"maxItems","maxBytes","max_tokens"}
        if unknown or profile.get("max_tokens",4096) != 4096:
            raise ValueError("unsupported production profile knobs: " + str(sorted(unknown)))
        result=bridge("build", {"cases":cases,"profile":profile})
        return [{"id":row["id"],"case_ids":[row["case_id"]],"system":row["body"]["system"],
                 "query":"\n\n".join(m["content"] for m in row["body"]["messages"]),
                 "body":row["body"],"wire_bytes":row["bytes"],"records":row["records"],
                 "production_profile":row["profile"],"production_equivalence":row["equivalence"]} for row in result]

    def parse_response(self, request, text):
        return bridge("parse", {"text":text,"records":request.get("records",[]),"kind":self.kind})

    def aggregate_case(self, case, outputs):
        valid=bool(outputs) and all(o.get("valid") for o in outputs)
        return {"valid":valid,"value":[o.get("value") for o in outputs],
                "parser_valid":all(o.get("parser_valid",False) for o in outputs),
                "persistence":"pure normalization checked; no database write performed"}

    def evaluate_case(self, case, aggregate):
        if aggregate.get("valid") is None:
            return {}
        values=[v for v in aggregate.get("value",[]) if v]
        observations=[o for v in values for o in v.get("observations",[])]
        summaries=[v["summary"] for v in values if v.get("summary")]
        text="\n".join(json.dumps(v,ensure_ascii=False) for v in values)
        normalized=" ".join(text.casefold().split())
        expected=case.get("expected",{})
        required=[f for f in expected.get("required_facts",[]) if f.get("anchors")]
        forbidden=[f for f in expected.get("forbidden_claims",[]) if f.get("anchors")]
        skipped=bool(values) and all(v.get("skipped") for v in values)
        facts=[" ".join(f.casefold().split()) for o in observations for f in o.get("facts",[])]
        hits=sum(any(" ".join(a.casefold().split()) in normalized for a in f["anchors"]) for f in required)
        source=json.dumps(case.get("records",case.get("request",case.get("last_assistant_message",""))),ensure_ascii=False)
        return {"valid":bool(aggregate["valid"]),"skipped":skipped,
            "expected_action_correct":(skipped == (expected["action"]=="skip")) if expected.get("action") else None,
            "diagnostic_anchor_hits":hits,"diagnostic_anchor_total":len(required),
            "diagnostic_anchor_coverage":hits/len(required) if required else None,
            "diagnostic_forbidden_anchor_hits":sum(any(a.casefold() in normalized for a in f["anchors"]) for f in forbidden),
            "duplicate_facts":len(facts)-len(set(facts)),"knowledge_characters":len(text),
            "source_characters":len(source),"character_ratio":len(text)/len(source) if source and aggregate["valid"] else None,
            "observations":len(observations),"summaries":len(summaries),"semantic_quality":None}

    def review_spec(self, case, aggregate):
        required=[{"id":"required-"+str(i+1),"description":f.get("statement",str(f))} for i,f in enumerate(case.get("expected",{}).get("required_facts",[]))]
        forbidden=[{"id":"forbidden-"+str(i+1),"description":"Must not invent: "+f.get("statement",str(f))} for i,f in enumerate(case.get("expected",{}).get("forbidden_claims",[]))]
        return required+forbidden+[{"id":"source-support","description":"Actual output supported; preserve ownership, completed vs planned, numbers, skip and file evidence"}]

    def review_source(self, case):
        return {k:case[k] for k in ("user_prompt","records","request","last_assistant_message","persisted_observations","context") if k in case}


class Summary(Observation):
    kind = "summary"
