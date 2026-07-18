"""DevOps Agent — kubectl, docker, git, and general infrastructure operations.

This is the Agent Framework equivalent of an AutoGen agent configured for
infrastructure work. It wraps common DevOps CLI tools as ai_functions so the
LLM can orchestrate real operations: inspect k8s pods, restart deployments,
check docker containers, manage git branches, and more.

Tools:
  kubectl      — run any kubectl command
  docker       — run any docker command
  git          — run any git command
  run_shell    — escape hatch for any other shell command
  read_yaml    — read a YAML/JSON config file
  write_yaml   — write a YAML/JSON config file
"""
import os
import subprocess
from pathlib import Path
from typing import Annotated

from agent_framework import ChatAgent, ai_function
from agent_framework.openai import OpenAIChatClient

_WORKSPACE = Path(__file__).resolve().parents[2]


def _run(cmd: list[str], timeout: int = 60, cwd: str = "") -> str:
    """Helper: run a subprocess and return formatted output."""
    try:
        result = subprocess.run(
            cmd,
            cwd=cwd or str(_WORKSPACE),
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        out = result.stdout[-8000:] if result.stdout else "(empty)"
        err = result.stderr[-4000:] if result.stderr else "(empty)"
        return f"exit_code: {result.returncode}\nstdout:\n{out}\nstderr:\n{err}"
    except FileNotFoundError:
        return f"Command not found: '{cmd[0]}'. Is it installed?"
    except subprocess.TimeoutExpired:
        return f"Command timed out after {timeout}s."
    except Exception as exc:
        return f"Error: {type(exc).__name__}: {exc}"


# ── Tools ────────────────────────────────────────────────────────────────────

@ai_function
def kubectl(
    args: Annotated[str, "kubectl arguments, e.g. 'get pods -n default' or 'describe pod my-pod'"],
    timeout_seconds: Annotated[int, "Timeout in seconds. Default 30."] = 30,
) -> str:
    """Run a kubectl command against the current kube context."""
    return _run(["kubectl"] + args.split(), timeout=timeout_seconds)


@ai_function
def docker(
    args: Annotated[str, "docker arguments, e.g. 'ps -a' or 'logs my-container --tail 50'"],
    timeout_seconds: Annotated[int, "Timeout in seconds. Default 30."] = 30,
) -> str:
    """Run a docker command on the local Docker daemon."""
    return _run(["docker"] + args.split(), timeout=timeout_seconds)


@ai_function
def git(
    args: Annotated[str, "git arguments, e.g. 'status' or 'log --oneline -10' or 'diff HEAD'"],
    working_dir: Annotated[str, "Repository path. Default: workspace root."] = "",
) -> str:
    """Run a git command in the given repository."""
    return _run(["git"] + args.split(), cwd=working_dir or str(_WORKSPACE))


@ai_function
def run_shell(
    command: Annotated[str, "Any shell command to run."],
    working_dir: Annotated[str, "Working directory. Default: workspace root."] = "",
    timeout_seconds: Annotated[int, "Timeout in seconds. Default 60."] = 60,
) -> str:
    """Run any shell command — use for tools not covered by the specific tools above."""
    try:
        result = subprocess.run(
            command,
            shell=True,
            cwd=working_dir or str(_WORKSPACE),
            capture_output=True,
            text=True,
            timeout=timeout_seconds,
        )
        out = result.stdout[-8000:] if result.stdout else "(empty)"
        err = result.stderr[-4000:] if result.stderr else "(empty)"
        return f"exit_code: {result.returncode}\nstdout:\n{out}\nstderr:\n{err}"
    except subprocess.TimeoutExpired:
        return f"Command timed out after {timeout_seconds}s."
    except Exception as exc:
        return f"run_shell error: {type(exc).__name__}: {exc}"


@ai_function
def read_yaml(
    path: Annotated[str, "Path to a YAML or JSON config file."],
) -> str:
    """Read and pretty-print a YAML or JSON configuration file."""
    try:
        p = Path(path.strip())
        if not p.is_absolute():
            p = _WORKSPACE / p
        content = p.read_text(encoding="utf-8", errors="replace")
        return content[:16000]
    except Exception as exc:
        return f"read_yaml error: {type(exc).__name__}: {exc}"


@ai_function
def write_yaml(
    path: Annotated[str, "Path to write the YAML/JSON file."],
    content: Annotated[str, "Full YAML or JSON content to write."],
) -> str:
    """Write a YAML or JSON configuration file."""
    try:
        p = Path(path.strip())
        if not p.is_absolute():
            p = _WORKSPACE / p
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content, encoding="utf-8")
        return f"Written {len(content)} chars to {p}"
    except Exception as exc:
        return f"write_yaml error: {type(exc).__name__}: {exc}"


# ── Agent ────────────────────────────────────────────────────────────────────

_model = os.getenv("OLLAMA_MODEL") or "qwen2.5-coder:7b"

agent = ChatAgent(
    chat_client=OpenAIChatClient(
        api_key="ollama",
        base_url=os.getenv("OLLAMA_ENDPOINT", "http://localhost:11434/v1/"),
        model_id=_model,
    ),
    name="DevOps Agent",
    description=(
        "Infrastructure and DevOps specialist. Can run kubectl, docker, git, and "
        "shell commands to inspect, diagnose, and fix infrastructure issues."
    ),
    instructions="""/no_think
You are a senior DevOps engineer. You have direct access to the host machine's CLI tools.

Your capabilities:
- kubectl: inspect and manage Kubernetes resources
- docker: manage containers, images, logs
- git: manage source control
- run_shell: run any other command (helm, terraform, aws, gcloud, etc.)
- read_yaml / write_yaml: read and modify config files

Workflow for diagnosing issues:
1. Gather information first — list resources, check status, read logs.
2. Identify the root cause before making any changes.
3. Apply the smallest fix possible.
4. Verify the fix worked by checking the state again.
5. Report what you found and what you changed.

Rules:
- Never delete resources without explicit permission.
- Always check current state before applying changes.
- Report exact command output — do not summarise errors.
- For Kubernetes: check pod logs (kubectl logs) when a pod is not Ready.
- For Docker: check container logs when a container is not running.""",
    tools=[kubectl, docker, git, run_shell, read_yaml, write_yaml],
)
