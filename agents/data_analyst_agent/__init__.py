"""Data Analyst Agent — analyses data, runs statistical code, and produces insights.

Equivalent to an AutoGen AssistantAgent that specialises in data analysis.
Can run Python (pandas, numpy, matplotlib) directly, read CSV/JSON files,
and produce structured summaries. Use it in a team with a File Manager or
Shell Executor for end-to-end data pipelines.

Tools:
  run_analysis    — execute Python data analysis code, return output + any errors
  read_csv        — load and preview a CSV file
  describe_data   — get statistical summary of a dataset
"""
import os
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Annotated

from agent_framework import ChatAgent, ai_function
from agent_framework.openai import OpenAIChatClient

_WORKSPACE = Path(__file__).resolve().parents[2]


# ── Tools ────────────────────────────────────────────────────────────────────

@ai_function
def run_analysis(
    code: Annotated[str, "Self-contained Python code using pandas/numpy/etc. Print results explicitly."],
    timeout_seconds: Annotated[int, "Max execution time in seconds. Default 60."] = 60,
) -> str:
    """Execute Python data analysis code and return all printed output."""
    if not code.strip():
        return "run_analysis: no code provided."
    if len(code) > 16000:
        return "run_analysis: code too long (max 16000 chars)."

    with tempfile.NamedTemporaryFile(suffix=".py", delete=False, mode="w", encoding="utf-8") as f:
        f.write(code)
        tmp = f.name
    try:
        result = subprocess.run(
            [sys.executable, tmp],
            cwd=str(_WORKSPACE),
            capture_output=True,
            text=True,
            timeout=timeout_seconds,
        )
    except subprocess.TimeoutExpired:
        return f"run_analysis timed out after {timeout_seconds}s."
    except Exception as exc:
        return f"run_analysis error: {type(exc).__name__}: {exc}"
    finally:
        Path(tmp).unlink(missing_ok=True)

    out = result.stdout[-10000:] if result.stdout else "(no output — did you print the results?)"
    err = result.stderr[-4000:] if result.stderr else "(none)"
    return f"exit_code: {result.returncode}\noutput:\n{out}\nstderr:\n{err}"


@ai_function
def read_csv(
    path: Annotated[str, "Path to CSV file, relative to workspace or absolute."],
    max_rows: Annotated[int, "Number of rows to preview. Default 20."] = 20,
) -> str:
    """Load a CSV file and return its shape, column names, dtypes, and first N rows."""
    try:
        import csv
        p = Path(path.strip())
        if not p.is_absolute():
            p = _WORKSPACE / p
        if not p.exists():
            return f"read_csv: file not found: {p}"

        with p.open(encoding="utf-8", errors="replace") as f:
            reader = csv.DictReader(f)
            rows = [row for _, row in zip(range(max_rows), reader)]
            all_rows = list(reader)

        total = len(rows) + len(all_rows)
        columns = list(rows[0].keys()) if rows else []
        header = (
            f"File: {p.name}\n"
            f"Shape: {total} rows × {len(columns)} columns\n"
            f"Columns: {', '.join(columns)}\n\n"
            f"First {len(rows)} rows:\n"
        )
        col_widths = {c: max(len(c), max((len(str(r.get(c, ""))) for r in rows), default=0)) for c in columns}
        header_row = " | ".join(c.ljust(col_widths[c]) for c in columns)
        sep = "-+-".join("-" * col_widths[c] for c in columns)
        data_rows = "\n".join(" | ".join(str(r.get(c, "")).ljust(col_widths[c]) for c in columns) for r in rows)
        return header + header_row + "\n" + sep + "\n" + data_rows
    except Exception as exc:
        return f"read_csv error: {type(exc).__name__}: {exc}"


@ai_function
def describe_data(
    path: Annotated[str, "Path to CSV file to describe statistically."],
) -> str:
    """Run pandas describe() on a CSV and return the statistical summary."""
    code = f"""
import pandas as pd
import warnings
warnings.filterwarnings('ignore')
df = pd.read_csv(r"{path}")
print(f"Shape: {{df.shape[0]}} rows x {{df.shape[1]}} columns")
print(f"\\nColumn types:\\n{{df.dtypes.to_string()}}")
print(f"\\nNull counts:\\n{{df.isnull().sum().to_string()}}")
print(f"\\nStatistical summary:")
print(df.describe(include='all').to_string())
"""
    return run_analysis(code)  # type: ignore[return-value]


# ── Agent ────────────────────────────────────────────────────────────────────

_model = os.getenv("OLLAMA_MODEL") or "qwen2.5-coder:7b"

agent = ChatAgent(
    chat_client=OpenAIChatClient(
        api_key="ollama",
        base_url=os.getenv("OLLAMA_ENDPOINT", "http://localhost:11434/v1/"),
        model_id=_model,
    ),
    name="Data Analyst",
    description=(
        "Analyses datasets using Python (pandas, numpy, matplotlib). "
        "Reads CSVs, runs statistical analysis, identifies patterns, and produces insights."
    ),
    instructions="""/no_think
You are a data analyst who writes and runs Python code to analyse data.

Workflow:
1. Read the dataset with read_csv to understand its structure.
2. Use describe_data for a quick statistical overview.
3. Write targeted run_analysis code to answer the specific question.
4. Always print results explicitly — the output is captured from stdout.
5. Report findings in clear, structured prose with key numbers highlighted.

Code guidelines:
- Use pandas for tabular data, numpy for maths, matplotlib/seaborn for visualisation.
- Always handle missing values (dropna / fillna as appropriate).
- Print intermediate results so you can verify each step.
- For visualisations, save to a file and report the path.

Output format:
- Lead with the key finding.
- Support with specific numbers from the data.
- Note data quality issues (nulls, outliers, type mismatches).
- Suggest follow-up analyses when relevant.""",
    tools=[run_analysis, read_csv, describe_data],
)
