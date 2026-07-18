"""Shell Executor Agent — the Agent Framework equivalent of AutoGen's UserProxyAgent.

Runs ANY shell command: kubectl, bash, pip, git, docker, PowerShell, etc.
Give this agent to a GroupChat alongside a planner/writer agent and it can
carry out real operations on the host machine — exactly like AutoGen's
UserProxyAgent with LocalCommandLineCodeExecutor.

Tools:
  run_shell      — execute any shell command, capture stdout/stderr
  run_python     — execute a Python script string in-process
  install_package — pip install a package at runtime
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
_TIMEOUT = 60


# ── Tools ────────────────────────────────────────────────────────────────────

@ai_function
def run_shell(
    command: Annotated[str, "The shell command to run (e.g. 'kubectl get pods', 'git status', 'ls -la')"],
    working_dir: Annotated[str, "Optional working directory. Defaults to workspace root."] = "",
    timeout_seconds: Annotated[int, "Max seconds to wait before killing the process."] = 60,
) -> str:
    """Execute any shell command on the host machine and return stdout + stderr + exit code."""
    cwd = working_dir.strip() or str(_WORKSPACE)
    try:
        result = subprocess.run(
            command,
            shell=True,
            cwd=cwd,
            capture_output=True,
            text=True,
            timeout=timeout_seconds,
        )
    except subprocess.TimeoutExpired:
        return f"run_shell timed out after {timeout_seconds}s."
    except Exception as exc:
        return f"run_shell error: {type(exc).__name__}: {exc}"

    stdout = result.stdout[-8000:] if result.stdout else "(empty)"
    stderr = result.stderr[-4000:] if result.stderr else "(empty)"
    return (
        f"exit_code: {result.returncode}\n"
        f"stdout:\n{stdout}\n"
        f"stderr:\n{stderr}"
    )


@ai_function
def run_python(
    code: Annotated[str, "Complete, self-contained Python script to execute."],
    timeout_seconds: Annotated[int, "Max seconds to allow. Default 60."] = 60,
) -> str:
    """Execute a Python script string in a temporary file and return its output."""
    if not code.strip():
        return "run_python: no code provided."
    if len(code) > 16000:
        return "run_python: code too long (max 16000 chars)."
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
        return f"run_python timed out after {timeout_seconds}s."
    except Exception as exc:
        return f"run_python error: {type(exc).__name__}: {exc}"
    finally:
        Path(tmp).unlink(missing_ok=True)

    stdout = result.stdout[-8000:] if result.stdout else "(empty)"
    stderr = result.stderr[-4000:] if result.stderr else "(empty)"
    return (
        f"exit_code: {result.returncode}\n"
        f"stdout:\n{stdout}\n"
        f"stderr:\n{stderr}"
    )


@ai_function
def install_package(
    package: Annotated[str, "Package name to pip install, e.g. 'requests' or 'pandas==2.0.0'"],
) -> str:
    """Install a Python package via pip at runtime."""
    try:
        result = subprocess.run(
            [sys.executable, "-m", "pip", "install", package, "--quiet"],
            capture_output=True,
            text=True,
            timeout=120,
        )
        return (
            f"exit_code: {result.returncode}\n"
            f"stdout:\n{result.stdout[-2000:] or '(empty)'}\n"
            f"stderr:\n{result.stderr[-2000:] or '(empty)'}"
        )
    except Exception as exc:
        return f"install_package error: {exc}"


# ── Agent ────────────────────────────────────────────────────────────────────

_model = os.getenv("OLLAMA_MODEL") or "qwen2.5-coder:7b"

agent = ChatAgent(
    chat_client=OpenAIChatClient(
        api_key="ollama",
        base_url=os.getenv("OLLAMA_ENDPOINT", "http://localhost:11434/v1/"),
        model_id=_model,
    ),
    name="Shell Executor",
    description=(
        "General-purpose shell executor. Runs any command on the host machine — "
        "kubectl, bash, git, docker, pip, Python scripts, etc."
    ),
    instructions="""/no_think
You are a shell execution agent. Your ONLY job is to run code and commands — never write or plan them.

## When you see a Python code block in the conversation:
1. Extract the EXACT code from the ```python ... ``` block.
2. IMMEDIATELY call run_python with that code. Do not wait. Do not ask. Do not explain.
3. Report the EXACT output: stdout, stderr, and exit code.

## When you are told to run a shell command:
1. Call run_shell with the exact command.
2. Report the EXACT output.

## Rules (no exceptions):
- You MUST call a tool on every single turn. Producing text without a tool call is a failure.
- If there is a ```python ... ``` block anywhere in the conversation, run it NOW with run_python.
- If a shell command is mentioned, run it NOW with run_shell.
- Report output verbatim — do NOT paraphrase, summarise, or omit errors.
- If execution fails, report the exact error. Do not retry unless told to.
- If a package is missing (ImportError / ModuleNotFoundError), call install_package first, then re-run.

## Example — if you see this in the conversation:
```python
print("hello")
```
You must immediately call: run_python(code='print("hello")')

Do this NOW. No preamble.""",
    tools=[run_shell, run_python, install_package],
)
