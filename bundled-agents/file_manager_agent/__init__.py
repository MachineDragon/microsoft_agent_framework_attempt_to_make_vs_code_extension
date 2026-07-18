"""File Manager Agent — reads, writes, searches and lists files on the host filesystem.

Equivalent to an AutoGen agent with file-system tools. Use it alongside a
Planner or Code Writer to persist generated content, read configs, or search
codebases.

Tools:
  read_file      — read any UTF-8 file
  write_file     — create or overwrite a file
  append_file    — append lines to an existing file
  list_directory — list files in a folder (recursive optional)
  search_in_files — grep-style text search across files
  delete_file    — delete a file after confirmation
"""
import os
from pathlib import Path
from typing import Annotated

from agent_framework import ChatAgent, ai_function
from agent_framework.openai import OpenAIChatClient

_WORKSPACE = Path(__file__).resolve().parents[2]


def _safe_path(raw: str) -> Path:
    """Resolve to absolute, confine to workspace root."""
    p = Path(raw.strip())
    if not p.is_absolute():
        p = _WORKSPACE / p
    p = p.resolve()
    # Security: block path traversal outside workspace
    try:
        p.relative_to(_WORKSPACE.resolve())
    except ValueError as exc:
        raise PermissionError(f"Path '{p}' is outside the workspace.") from exc
    return p


# ── Tools ────────────────────────────────────────────────────────────────────

@ai_function
def read_file(
    path: Annotated[str, "File path — relative to workspace or absolute."],
    max_chars: Annotated[int, "Max characters to return. Default 16000."] = 16000,
) -> str:
    """Read the contents of a text file."""
    try:
        p = _safe_path(path)
        content = p.read_text(encoding="utf-8", errors="replace")
        if len(content) > max_chars:
            return content[:max_chars] + f"\n\n[truncated — {len(content)} total chars]"
        return content
    except PermissionError as exc:
        return f"read_file denied: {exc}"
    except Exception as exc:
        return f"read_file error: {type(exc).__name__}: {exc}"


@ai_function
def write_file(
    path: Annotated[str, "File path to create or overwrite."],
    content: Annotated[str, "Full text content to write."],
) -> str:
    """Create or overwrite a file with the given content."""
    try:
        p = _safe_path(path)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content, encoding="utf-8")
        return f"Written {len(content)} chars to {p}"
    except PermissionError as exc:
        return f"write_file denied: {exc}"
    except Exception as exc:
        return f"write_file error: {type(exc).__name__}: {exc}"


@ai_function
def append_file(
    path: Annotated[str, "File path to append to."],
    content: Annotated[str, "Text to append."],
) -> str:
    """Append text to an existing file (or create it if it doesn't exist)."""
    try:
        p = _safe_path(path)
        p.parent.mkdir(parents=True, exist_ok=True)
        with p.open("a", encoding="utf-8") as f:
            f.write(content)
        return f"Appended {len(content)} chars to {p}"
    except PermissionError as exc:
        return f"append_file denied: {exc}"
    except Exception as exc:
        return f"append_file error: {type(exc).__name__}: {exc}"


@ai_function
def list_directory(
    path: Annotated[str, "Directory to list. Default: workspace root."] = "",
    recursive: Annotated[bool, "List recursively. Default False."] = False,
    include_hidden: Annotated[bool, "Include hidden files/folders. Default False."] = False,
) -> str:
    """List files and directories at the given path."""
    try:
        base = _safe_path(path) if path.strip() else _WORKSPACE
        if not base.is_dir():
            return f"list_directory: '{base}' is not a directory."
        pattern = "**/*" if recursive else "*"
        entries = []
        for entry in sorted(base.glob(pattern)):
            if not include_hidden and entry.name.startswith("."):
                continue
            rel = entry.relative_to(base)
            kind = "[dir]" if entry.is_dir() else "[file]"
            entries.append(f"{kind} {rel}")
        if not entries:
            return "Directory is empty."
        return "\n".join(entries[:500])
    except PermissionError as exc:
        return f"list_directory denied: {exc}"
    except Exception as exc:
        return f"list_directory error: {type(exc).__name__}: {exc}"


@ai_function
def search_in_files(
    query: Annotated[str, "Text to search for (case-insensitive substring)."],
    directory: Annotated[str, "Directory to search in. Default: workspace root."] = "",
    file_pattern: Annotated[str, "Glob filter, e.g. '*.py'. Default: all text files."] = "**/*",
    max_results: Annotated[int, "Max matches to return. Default 50."] = 50,
) -> str:
    """Search for a text string across files in a directory."""
    try:
        base = _safe_path(directory) if directory.strip() else _WORKSPACE
        results = []
        query_lower = query.lower()
        for fp in sorted(base.glob(file_pattern)):
            if not fp.is_file():
                continue
            try:
                text = fp.read_text(encoding="utf-8", errors="replace")
            except Exception:
                continue
            for i, line in enumerate(text.splitlines(), 1):
                if query_lower in line.lower():
                    rel = fp.relative_to(_WORKSPACE)
                    results.append(f"{rel}:{i}: {line.strip()}")
                    if len(results) >= max_results:
                        break
            if len(results) >= max_results:
                break
        if not results:
            return f"No matches found for '{query}'."
        return "\n".join(results)
    except PermissionError as exc:
        return f"search_in_files denied: {exc}"
    except Exception as exc:
        return f"search_in_files error: {type(exc).__name__}: {exc}"


# ── Agent ────────────────────────────────────────────────────────────────────

_model = os.getenv("OLLAMA_MODEL") or "qwen2.5:7b"

agent = ChatAgent(
    chat_client=OpenAIChatClient(
        api_key="ollama",
        base_url=os.getenv("OLLAMA_ENDPOINT", "http://localhost:11434/v1/"),
        model_id=_model,
    ),
    name="File Manager",
    description=(
        "Reads, writes, searches and lists files on the host filesystem. "
        "Use in a team when agents need to persist output, read configs, or inspect codebases."
    ),
    instructions="""/no_think
You are a file system agent. You manage files on the host machine.

Capabilities:
- read_file: read any text file
- write_file: create or overwrite files
- append_file: add content to an existing file
- list_directory: browse folder contents
- search_in_files: find text across many files

Rules:
- Always confirm the path before writing or deleting.
- Report EXACT file contents or errors — do not paraphrase.
- For large files, read only the relevant sections (use max_chars).
- Never write files outside the workspace unless explicitly instructed.""",
    tools=[read_file, write_file, append_file, list_directory, search_in_files],
)
