"""
ClawWork Sidecar — lightweight FastAPI bridge between Ailo endpoint and ClawWork engine.

Wraps TaskManager, WorkEvaluator, and EconomicTracker behind HTTP endpoints.
Data is stored in ClawWork-standard JSONL format so the Dashboard can read it directly.
"""

import json
import os
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Optional

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

# ── Load config & resolve paths ──────────────────────────────────────────────

SIDECAR_DIR = Path(__file__).parent
load_dotenv(SIDECAR_DIR / ".env")

with open(SIDECAR_DIR / "config.json", encoding="utf-8") as f:
    CFG = json.load(f)

def _resolve(rel: str) -> str:
    return str((SIDECAR_DIR / rel).resolve())

CLAWWORK_ROOT = _resolve(CFG["paths"]["clawwork_root"])
GDPVAL_PATH   = _resolve(CFG["paths"]["gdpval"])
TASK_VALUES   = _resolve(CFG["paths"]["task_values"])
META_PROMPTS  = _resolve(CFG["paths"]["meta_prompts"])
AGENT_DATA    = _resolve(CFG["paths"]["agent_data"])

SIGNATURE       = CFG["signature"]
INITIAL_BALANCE = CFG["initial_balance"]
INPUT_PRICE     = CFG["token_pricing"]["input_per_1m"]
OUTPUT_PRICE    = CFG["token_pricing"]["output_per_1m"]
PORT            = CFG.get("port", 8020)

# Put ClawWork on the Python path so we can import livebench.*
sys.path.insert(0, CLAWWORK_ROOT)

from livebench.agent.economic_tracker import EconomicTracker
from livebench.work.evaluator import WorkEvaluator
from livebench.work.task_manager import TaskManager

# ── Initialize engines ───────────────────────────────────────────────────────

AGENT_DIR = os.path.join(AGENT_DATA, SIGNATURE)

print(f"\n{'='*60}")
print(f"  ClawWork Sidecar — {SIGNATURE}")
print(f"{'='*60}")
print(f"  ClawWork root  : {CLAWWORK_ROOT}")
print(f"  GDPVal dataset : {GDPVAL_PATH}")
print(f"  Agent data     : {AGENT_DIR}")
print()

# TaskManager
task_mgr = TaskManager(
    task_source_type="parquet",
    task_source_path=GDPVAL_PATH,
    task_data_path=AGENT_DIR,
    task_values_path=TASK_VALUES,
    default_max_payment=50.0,
)
num_tasks = task_mgr.load_tasks()

# EconomicTracker
tracker = EconomicTracker(
    signature=SIGNATURE,
    initial_balance=INITIAL_BALANCE,
    input_token_price=INPUT_PRICE,
    output_token_price=OUTPUT_PRICE,
    data_path=os.path.join(AGENT_DIR, "economic"),
)
tracker.initialize()

# WorkEvaluator — may fail if no API key, that's OK
evaluator: Optional[WorkEvaluator] = None
try:
    evaluator = WorkEvaluator(
        max_payment=50.0,
        data_path=AGENT_DIR,
        use_llm_evaluation=True,
        meta_prompts_dir=META_PROMPTS,
    )
except (ValueError, Exception) as exc:
    print(f"\n⚠  WorkEvaluator init failed: {exc}")
    print("   /submit will be unavailable until EVALUATION_API_KEY is set in .env\n")

# Track current task in memory
_current_task: Optional[dict] = None

print(f"\n  Tasks loaded   : {num_tasks}")
print(f"  Balance        : ${tracker.get_balance():.2f}")
print(f"  Evaluator      : {'ready' if evaluator else 'NOT READY (no API key)'}")
print(f"  Listening on   : http://localhost:{PORT}")
print(f"{'='*60}\n")

# ── FastAPI app ──────────────────────────────────────────────────────────────

app = FastAPI(title="ClawWork Sidecar", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health():
    return {
        "status": "ok",
        "signature": SIGNATURE,
        "tasks_loaded": num_tasks,
        "balance": tracker.get_balance(),
        "survival_status": tracker.get_survival_status(),
        "evaluator_ready": evaluator is not None,
    }


@app.get("/status")
def status():
    summary = tracker.get_summary()
    summary["current_task"] = _current_task.get("task_id") if _current_task else None
    return summary


@app.get("/task")
def get_task(date: Optional[str] = None):
    global _current_task

    if date is None:
        date = datetime.now().strftime("%Y-%m-%d")

    task = task_mgr.select_daily_task(date, signature=SIGNATURE)
    if task is None:
        raise HTTPException(404, detail="No tasks available for this date")

    tracker.start_task(task["task_id"], date)
    _current_task = task

    prompt = task.get("prompt", "")
    ref_files = task_mgr.get_task_reference_files(task)

    return {
        "task_id": task["task_id"],
        "date": date,
        "sector": task.get("sector", ""),
        "occupation": task.get("occupation", ""),
        "max_payment": task.get("max_payment", 50.0),
        "prompt": prompt,
        "reference_files": ref_files,
    }


class SubmitRequest(BaseModel):
    task_id: str
    work_summary: str
    artifact_paths: list[str] = []


@app.post("/submit")
def submit_work(req: SubmitRequest):
    global _current_task

    if evaluator is None:
        raise HTTPException(
            503,
            detail="Evaluator not ready — set EVALUATION_API_KEY in sidecar/.env and restart.",
        )

    task = task_mgr.get_task_by_id(req.task_id)
    if task is None:
        raise HTTPException(404, detail=f"Task {req.task_id} not found")

    if "max_payment" not in task and req.task_id in task_mgr.task_values:
        task["max_payment"] = task_mgr.task_values[req.task_id]

    FIXED_TASK_COST = 0.5
    tracker.track_tokens(input_tokens=0, output_tokens=0, cost=FIXED_TASK_COST)

    all_paths: list[str] = []

    if req.work_summary:
        work_dir = os.path.join(AGENT_DIR, "work")
        os.makedirs(work_dir, exist_ok=True)
        date_str = datetime.now().strftime("%Y-%m-%d")
        text_path = os.path.join(work_dir, f"{date_str}_{req.task_id}.txt")
        with open(text_path, "w", encoding="utf-8") as fh:
            fh.write(req.work_summary)
        all_paths.append(text_path)

    for p in req.artifact_paths:
        if os.path.exists(p):
            all_paths.append(p)
        else:
            print(f"  ⚠ artifact not found, skipping: {p}")

    if not all_paths:
        raise HTTPException(400, detail="No valid artifacts to evaluate")

    start_time = time.time()
    accepted, payment, feedback, score = evaluator.evaluate_artifact(
        signature=SIGNATURE,
        task=task,
        artifact_path=all_paths,
        description=req.work_summary[:500],
    )

    actual_payment = tracker.add_work_income(
        amount=payment,
        task_id=req.task_id,
        evaluation_score=score,
    )

    wall_clock = time.time() - start_time
    tracker.record_task_completion(
        task_id=req.task_id,
        work_submitted=True,
        wall_clock_seconds=wall_clock,
        evaluation_score=score,
        money_earned=actual_payment,
    )
    tracker.end_task()
    tracker.save_daily_state(
        date=datetime.now().strftime("%Y-%m-%d"),
        work_income=actual_payment,
    )

    _current_task = None

    return {
        "accepted": accepted,
        "evaluation_score": score,
        "payment": actual_payment,
        "feedback": feedback,
        "balance_after": tracker.get_balance(),
        "survival_status": tracker.get_survival_status(),
    }


@app.get("/leaderboard")
def leaderboard():
    """Read all agents' balance.jsonl and rank by current balance."""
    agents = []
    if not os.path.isdir(AGENT_DATA):
        return {"agents": agents}

    for entry in sorted(os.listdir(AGENT_DATA)):
        agent_dir = os.path.join(AGENT_DATA, entry)
        balance_file = os.path.join(agent_dir, "economic", "balance.jsonl")
        if not os.path.isfile(balance_file):
            continue

        latest = None
        with open(balance_file, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line:
                    try:
                        latest = json.loads(line)
                    except json.JSONDecodeError:
                        pass

        if latest is None:
            continue

        evals_file = os.path.join(agent_dir, "work", "evaluations.jsonl")
        scores = []
        if os.path.isfile(evals_file):
            with open(evals_file, encoding="utf-8") as f:
                for line in f:
                    try:
                        ev = json.loads(line.strip())
                        s = ev.get("evaluation_score")
                        if s is not None:
                            scores.append(s)
                    except json.JSONDecodeError:
                        pass

        agents.append({
            "signature": entry,
            "balance": latest.get("balance", 0),
            "total_work_income": latest.get("total_work_income", 0),
            "total_token_cost": latest.get("total_token_cost", 0),
            "survival_status": latest.get("survival_status", "unknown"),
            "avg_quality": (sum(scores) / len(scores)) if scores else None,
            "num_tasks": len(scores),
        })

    agents.sort(key=lambda a: a["balance"], reverse=True)

    for i, a in enumerate(agents):
        a["rank"] = i + 1

    return {"agents": agents}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=PORT)
