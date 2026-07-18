
from fastapi import FastAPI, File, HTTPException, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from starlette.concurrency import run_in_threadpool
from pydantic import BaseModel
import asyncio
import subprocess
import os
import json
import ast
import re
import shutil
import sys
import threading
import time
import uuid
import tempfile
from html import unescape
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import parse_qs, unquote, urljoin, urlparse
import httpx
from ollama_stream import ollama_stream_endpoint

app = FastAPI()


def _discover_extension_root() -> Path:
    configured_root = os.getenv("BUDAI_EXTENSION_ROOT")
    if configured_root:
        return Path(configured_root).resolve()

    current_file = Path(__file__).resolve()
    for candidate in [current_file.parent, *current_file.parents]:
        if (candidate / "agents").is_dir() and (candidate / "package.json").is_file():
            return candidate
    return current_file.parent.parent


# Define the agents directory
EXTENSION_ROOT = _discover_extension_root()
WORKSPACE_ROOT = Path(os.getenv("BUDAI_WORKSPACE_ROOT") or EXTENSION_ROOT).resolve()
AGENTS_DIR = Path(os.getenv("BUDAI_AGENTS_DIR") or EXTENSION_ROOT / "agents").resolve()
SETTINGS_FILE = Path(os.getenv("BUDAI_SETTINGS_FILE") or Path(__file__).with_name("settings.local"))
USER_DATA_DIR = Path(os.getenv("BUDAI_USER_DATA_DIR") or SETTINGS_FILE.parent / "user-data").resolve()
IDE_ROOT_FILE = USER_DATA_DIR / "ide_root.local"
MODEL_PULL_JOBS: dict[str, dict] = {}
MODEL_PULL_JOBS_LOCK = threading.Lock()
IDE_ROOT = WORKSPACE_ROOT
IDE_EXCLUDED_DIRS = {
    ".git",
    ".venv",
    ".venv-1",
    "node_modules",
    "dist",
    "build",
    "__pycache__",
    ".pytest_cache",
    ".mypy_cache",
    ".ruff_cache",
}
IDE_TEXT_SUFFIXES = {
    ".css", ".csv", ".env", ".html", ".js", ".json", ".jsx", ".md", ".mjs", ".py",
    ".sh", ".toml", ".ts", ".tsx", ".txt", ".yaml", ".yml",
}
WEB_CACHE_TTL_SECONDS = 15 * 60
WEB_CACHE_MAX_BYTES = 50 * 1024 * 1024
WEB_FETCH_MAX_BYTES = 10 * 1024 * 1024
WEB_FETCH_MAX_MARKDOWN_CHARS = 100_000
WEB_FETCH_MAX_REDIRECTS = 10
WEB_FETCH_CACHE: dict[str, dict] = {}
WEB_FETCH_CACHE_LOCK = threading.Lock()
WEB_FETCH_CACHE_BYTES = 0
SPEECH_MAX_UPLOAD_BYTES = 25 * 1024 * 1024
SPEECH_MODEL_LOCK = threading.Lock()
SPEECH_MODEL_CACHE: dict[str, object] = {}


def _load_local_settings() -> None:
    if os.getenv("BUDAI_DISABLE_SETTINGS_FILE") == "1":
        return
    if not SETTINGS_FILE.exists():
        return
    try:
        settings = json.loads(SETTINGS_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return
    api_key = str(settings.get("ollama_api_key") or "").strip()
    if api_key and not os.getenv("OLLAMA_API_KEY", "").strip():
        os.environ["OLLAMA_API_KEY"] = api_key


def _save_local_settings() -> None:
    if os.getenv("BUDAI_DISABLE_SETTINGS_FILE") == "1":
        if SETTINGS_FILE.exists():
            SETTINGS_FILE.unlink()
        return
    api_key = os.getenv("OLLAMA_API_KEY", "").strip()
    if api_key:
        SETTINGS_FILE.write_text(json.dumps({"ollama_api_key": api_key}, indent=2), encoding="utf-8")
    elif SETTINGS_FILE.exists():
        SETTINGS_FILE.unlink()


def _resolve_user_storage_file(name: str) -> Path:
    if not re.fullmatch(r"[A-Za-z0-9_.:-]{1,120}", name):
        raise HTTPException(status_code=400, detail="Invalid storage name")
    USER_DATA_DIR.mkdir(parents=True, exist_ok=True)
    return USER_DATA_DIR / f"{name}.json"


def _load_ide_root() -> Path:
    if not IDE_ROOT_FILE.exists():
        return WORKSPACE_ROOT
    try:
        saved_path = IDE_ROOT_FILE.read_text(encoding="utf-8").strip()
    except OSError:
        return WORKSPACE_ROOT
    if not saved_path:
        return WORKSPACE_ROOT
    candidate = Path(saved_path).expanduser()
    try:
        resolved = candidate.resolve()
    except OSError:
        return WORKSPACE_ROOT
    if resolved.exists() and resolved.is_dir():
        return resolved
    return WORKSPACE_ROOT


def _save_ide_root(path: Path) -> None:
    IDE_ROOT_FILE.write_text(str(path.resolve()), encoding="utf-8")


def _set_model_pull_job(job_key: str, **updates) -> None:
    with MODEL_PULL_JOBS_LOCK:
        current = MODEL_PULL_JOBS.setdefault(job_key, {})
        current.update(updates)


def _run_model_pull_job(job_id: str, model_name: str) -> None:
    _set_model_pull_job(job_id, status="starting", completed=0, total=None, percent=None, done=False, error=None)
    try:
        with httpx.Client(timeout=None) as client:
            with client.stream(
                "POST",
                "http://localhost:11434/api/pull",
                json={"name": model_name, "stream": True},
            ) as response:
                if response.status_code != 200:
                    _set_model_pull_job(
                        job_id,
                        status="failed",
                        done=True,
                        error=f"Ollama returned status {response.status_code}: {response.read().decode('utf-8', errors='ignore')[:500]}",
                    )
                    return
                for line in response.iter_lines():
                    if not line:
                        continue
                    try:
                        payload = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if payload.get("error"):
                        _set_model_pull_job(job_id, status="failed", done=True, error=str(payload["error"]))
                        return
                    completed = payload.get("completed")
                    total = payload.get("total")
                    percent = None
                    if isinstance(completed, int) and isinstance(total, int) and total > 0:
                        percent = round((completed / total) * 100, 1)
                    status = str(payload.get("status") or "downloading")
                    _set_model_pull_job(job_id, status=status, completed=completed, total=total, percent=percent)
        _set_model_pull_job(job_id, status="success", percent=100, done=True, error=None)
    except Exception as exc:
        _set_model_pull_job(job_id, status="failed", done=True, error=f"{type(exc).__name__}: {exc}")


_load_local_settings()
IDE_ROOT = _load_ide_root()

class AgentCreate(BaseModel):
    name: str
    description: str = ""
    instructions: str
    model: str
    tools: list[str] = []
    tool_code: list[dict] = []  # [{id, name, code}] for user-generated tools


class AgentGenerateRequest(BaseModel):
    prompt: str
    model: str | None = None
    available_models: list[str] = []
    user_selected_model: str | None = None
    available_tools: list[str] = []
    selected_tools: list[str] = []


class ToolGenerateRequest(BaseModel):
    prompt: str
    model: str | None = None
    available_models: list[str] = []
    tool_type: str | None = None


class InstallDependenciesRequest(BaseModel):
    code: str


class AppSettingsUpdateRequest(BaseModel):
    ollama_api_key: str | None = None
    clear_ollama_api_key: bool = False


class UserStorageUpdateRequest(BaseModel):
    value: str


class OllamaModelRequest(BaseModel):
    name: str

class IDEFileWriteRequest(BaseModel):
    path: str
    content: str


class IDEFolderRequest(BaseModel):
    path: str


class IDESearchRequest(BaseModel):
    query: str
    max_results: int = 50


class IDEWebSearchRequest(BaseModel):
    query: str
    max_results: int = 5
    provider: str = "auto"
    allowed_domains: list[str] = []
    blocked_domains: list[str] = []


class IDEWebFetchRequest(BaseModel):
    url: str
    prompt: str = "Extract the most relevant information from this page."


class IDECommandRequest(BaseModel):
    command: str
    timeout_seconds: int = 30
    cwd: str | None = None
    stdin: str | list[str] | None = None
    
class IDETerminalInputRequest(BaseModel):
    input: str


class AgentFolderUpdateRequest(BaseModel):
    name: str
    description: str = ""
    instructions: str
    model: str
    tools: list[str] = []
    tool_code: list[dict] = []


def _extract_json_object(raw_text: str) -> dict:
    import re
    text = raw_text.strip()
    if text.startswith("```"):
        text = text.replace("```json", "").replace("```", "").strip()
    start = text.find("{")
    end = text.rfind("}")
    if start == -1 or end == -1 or end <= start:
        raise ValueError("No JSON object found in model output")
    json_text = text[start:end + 1]
    try:
        return json.loads(json_text)
    except json.JSONDecodeError:
        pass
    try:
        parsed = ast.literal_eval(json_text)
        if isinstance(parsed, dict):
            return parsed
    except Exception:
        pass
    try:
        normalized = (json_text.replace("\u201c", '"').replace("\u201d", '"')
                      .replace("\u2018", "'").replace("\u2019", "'"))
        return json.loads(normalized)
    except json.JSONDecodeError:
        pass
    result = {}
    for key in ("name", "description", "tool_type", "code"):
        tq = re.search(rf'''["\']?{key}["\']?\s*:\s*"""(.*?)"""''', json_text, re.DOTALL)
        if tq:
            result[key] = tq.group(1).strip()
            continue
        sq = re.search(rf'''["\']?{key}["\']?\s*:\s*"((?:[^"\\]|\\.)*)"''', json_text)
        if sq:
            result[key] = sq.group(1).replace("\\n", "\n").replace('\\"', '"')
    if result:
        return result
    raise ValueError("No parseable JSON or dict found in model output")


def _resolve_workspace_file(path: str) -> Path:
    root = IDE_ROOT.resolve()
    normalized = path.replace("\\", "/").lstrip("/").strip()
    if not normalized:
        raise HTTPException(status_code=400, detail="File path is required")
    resolved = (root / normalized).resolve()
    if resolved != root and root not in resolved.parents:
        raise HTTPException(status_code=400, detail="File path must stay inside the opened folder")
    return resolved


def _resolve_ide_folder(path: str) -> Path:
    raw_path = path.strip().strip('"')
    if not raw_path:
        raise HTTPException(status_code=400, detail="Folder path is required")
    candidate = Path(raw_path).expanduser()
    if not candidate.is_absolute():
        candidate = WORKSPACE_ROOT / candidate
    resolved = candidate.resolve()
    if not resolved.exists() or not resolved.is_dir():
        raise HTTPException(status_code=404, detail=f"Folder not found: {path}")
    return resolved


def _resolve_terminal_cwd(cwd: str | None) -> Path:
    if not cwd:
        return IDE_ROOT.resolve()
    candidate = Path(cwd.strip().strip('"'))
    if not candidate.is_absolute():
        candidate = IDE_ROOT / candidate
    resolved = candidate.resolve()
    if not resolved.exists() or not resolved.is_dir():
        raise HTTPException(status_code=400, detail=f"Working directory not found: {cwd}")
    return resolved


def _pick_folder_dialog(initial_dir: str) -> str:
    import tkinter as tk
    from tkinter import filedialog

    root = tk.Tk()
    root.withdraw()
    root.attributes("-topmost", True)
    root.update()
    try:
        return filedialog.askdirectory(title="Open folder", initialdir=initial_dir)
    finally:
        root.destroy()


def _pick_csv_files_dialog(initial_dir: str) -> list[str]:
    import tkinter as tk
    from tkinter import filedialog

    root = tk.Tk()
    root.withdraw()
    root.attributes("-topmost", True)
    root.update()
    try:
        selected = filedialog.askopenfilenames(
            title="Open CSV file",
            initialdir=initial_dir,
            filetypes=[("CSV files", "*.csv"), ("All files", "*.*")],
        )
        return list(selected)
    finally:
        root.destroy()
    
TERMINAL_SESSIONS: dict[str, dict] = {}
TERMINAL_SESSIONS_LOCK = threading.Lock()
    
def _append_terminal_output(session_id: str, text: str) -> None:
    if not text:
        return
    with TERMINAL_SESSIONS_LOCK:
        session = TERMINAL_SESSIONS.get(session_id)
        if session:
            session["output"].append(text)
    
def _read_terminal_pipe(session_id: str, pipe) -> None:
    try:
        while True:
            chunk = pipe.read(1)
            if not chunk:
                break
            _append_terminal_output(session_id, chunk)
    except Exception as exc:
        _append_terminal_output(session_id, f"\n[terminal read error: {exc}]\n")
    
def _drain_terminal_output(session_id: str) -> str:
    with TERMINAL_SESSIONS_LOCK:
        session = TERMINAL_SESSIONS.get(session_id)
        if not session:
            raise HTTPException(status_code=404, detail="Terminal session not found")
        output = "".join(session["output"])
        session["output"].clear()
        return output
    
def _get_terminal_session(session_id: str) -> dict:
    with TERMINAL_SESSIONS_LOCK:
        session = TERMINAL_SESSIONS.get(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Terminal session not found")
    return session


def _normalize_pty_input(data: str) -> str:
    return data.replace("\r\n", "\n").replace("\r", "\n")


def _build_ide_tree(directory: Path, depth: int = 0, max_depth: int = 4, counter: list[int] | None = None) -> list[dict]:
    if counter is None:
        counter = [0]
    if depth > max_depth or counter[0] > 600:
        return []

    entries: list[dict] = []
    try:
        children = sorted(directory.iterdir(), key=lambda p: (p.is_file(), p.name.lower()))
    except OSError:
        return entries

    for child in children:
        if counter[0] > 600:
            break
        if child.name in IDE_EXCLUDED_DIRS or child.name.startswith("."):
            continue
        if child.is_dir():
            counter[0] += 1
            entries.append({
                "type": "folder",
                "name": child.name,
                "children": _build_ide_tree(child, depth + 1, max_depth, counter),
            })
            continue
        if child.is_file() and child.suffix.lower() in IDE_TEXT_SUFFIXES:
            counter[0] += 1
            entries.append({"type": "file", "name": child.name})
    return entries


def _iter_ide_text_files(root: Path):
    for current_root, dirnames, filenames in os.walk(root):
        dirnames[:] = [name for name in dirnames if name not in IDE_EXCLUDED_DIRS and not name.startswith(".")]
        current_path = Path(current_root)
        for filename in filenames:
            file_path = current_path / filename
            if file_path.suffix.lower() in IDE_TEXT_SUFFIXES:
                yield file_path


def _extract_third_party_modules(code: str) -> list[str]:
    package_aliases = {
        "bs4": "beautifulsoup4",
        "cv2": "opencv-python",
        "PIL": "pillow",
        "yaml": "pyyaml",
        "sklearn": "scikit-learn",
        "Crypto": "pycryptodome",
    }
    ignore_modules = {
        "agent_framework",
        "typing",
        "typing_extensions",
        "collections",
        "datetime",
        "json",
        "os",
        "pathlib",
        "re",
        "math",
        "statistics",
        "functools",
        "itertools",
        "operator",
        "asyncio",
        "subprocess",
        "threading",
        "logging",
        "http",
        "urllib",
        "dataclasses",
    }

    try:
        parsed = ast.parse(code)
    except SyntaxError:
        return []

    imports: set[str] = set()
    stdlib_modules = set(getattr(sys, "stdlib_module_names", set()))

    for node in ast.walk(parsed):
        module_name = None
        if isinstance(node, ast.Import):
            for alias in node.names:
                top_level = alias.name.split(".")[0]
                imports.add(top_level)
            continue
        if isinstance(node, ast.ImportFrom) and node.module:
            module_name = node.module.split(".")[0]
        if module_name:
            imports.add(module_name)

    third_party: set[str] = set()
    for module in imports:
        if not module or module in ignore_modules:
            continue
        if module in stdlib_modules:
            continue
        pip_name = package_aliases.get(module, module)
        third_party.add(pip_name)

    return sorted(third_party)


class _DuckDuckGoResultParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.results: list[dict[str, str]] = []
        self._current: dict[str, str] | None = None
        self._title_parts: list[str] = []
        self._snippet_parts: list[str] = []
        self._capture_title = False
        self._capture_snippet = False

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attr_map = {key: value or "" for key, value in attrs}
        classes = set(attr_map.get("class", "").split())
        if tag == "a" and "result__a" in classes:
            self._finish_current()
            self._current = {"url": self._normalize_url(attr_map.get("href", ""))}
            self._title_parts = []
            self._snippet_parts = []
            self._capture_title = True
            return
        if self._current is not None and "result__snippet" in classes:
            self._capture_snippet = True

    def handle_data(self, data: str) -> None:
        if self._capture_title:
            self._title_parts.append(data)
        elif self._capture_snippet:
            self._snippet_parts.append(data)

    def handle_endtag(self, tag: str) -> None:
        if tag == "a" and self._capture_title:
            self._capture_title = False
        if tag in {"a", "div"} and self._capture_snippet:
            self._capture_snippet = False

    def close(self) -> None:
        super().close()
        self._finish_current()

    def _finish_current(self) -> None:
        if not self._current:
            return
        title = " ".join("".join(self._title_parts).split())
        url_value = self._current.get("url", "")
        if title and url_value:
            snippet = " ".join("".join(self._snippet_parts).split())
            if not any(result.get("url") == url_value for result in self.results):
                self.results.append({"title": title, "url": url_value, "content": snippet})
        self._current = None
        self._title_parts = []
        self._snippet_parts = []

    @staticmethod
    def _normalize_url(href: str) -> str:
        if href.startswith("//"):
            href = f"https:{href}"
        parsed = urlparse(href)
        redirect_target = parse_qs(parsed.query).get("uddg", [""])[0]
        return unquote(redirect_target) if redirect_target else href


class _MarkdownHTMLParser(HTMLParser):
    def __init__(self, base_url: str) -> None:
        super().__init__(convert_charrefs=True)
        self.base_url = base_url
        self.parts: list[str] = []
        self._skip_depth = 0
        self._link_stack: list[str] = []
        self._pre_depth = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attr_map = {key.lower(): value or "" for key, value in attrs}
        if tag in {"script", "style", "noscript", "svg"}:
            self._skip_depth += 1
            return
        if self._skip_depth:
            return
        if tag in {"h1", "h2", "h3", "h4", "h5", "h6"}:
            level = int(tag[1])
            self.parts.append(f"\n\n{'#' * level} ")
        elif tag in {"p", "div", "section", "article", "header", "footer", "main"}:
            self.parts.append("\n\n")
        elif tag in {"br", "tr"}:
            self.parts.append("\n")
        elif tag in {"li"}:
            self.parts.append("\n- ")
        elif tag in {"pre", "code"}:
            if tag == "pre":
                self._pre_depth += 1
                self.parts.append("\n\n```\n")
            elif not self._pre_depth:
                self.parts.append("`")
        elif tag == "a":
            href = attr_map.get("href", "").strip()
            self._link_stack.append(urljoin(self.base_url, href) if href else "")

    def handle_endtag(self, tag: str) -> None:
        if tag in {"script", "style", "noscript", "svg"} and self._skip_depth:
            self._skip_depth -= 1
            return
        if self._skip_depth:
            return
        if tag == "a" and self._link_stack:
            href = self._link_stack.pop()
            if href:
                self.parts.append(f"]({href})")
        elif tag == "code" and not self._pre_depth:
            self.parts.append("`")
        elif tag == "pre" and self._pre_depth:
            self._pre_depth -= 1
            self.parts.append("\n```\n")
        elif tag in {"p", "div", "section", "article", "h1", "h2", "h3", "h4", "h5", "h6"}:
            self.parts.append("\n")

    def handle_data(self, data: str) -> None:
        if self._skip_depth:
            return
        text = data if self._pre_depth else " ".join(data.split())
        if not text:
            return
        if self._link_stack:
            self.parts.append("[")
        self.parts.append(text)

    def markdown(self) -> str:
        text = "".join(self.parts)
        text = re.sub(r"[ \t]+\n", "\n", text)
        text = re.sub(r"\n{3,}", "\n\n", text)
        return text.strip()


def _domain_allowed(url_value: str, allowed_domains: list[str], blocked_domains: list[str]) -> bool:
    hostname = urlparse(url_value).hostname or ""
    allowed = [domain.lower().lstrip(".") for domain in allowed_domains if domain.strip()]
    blocked = [domain.lower().lstrip(".") for domain in blocked_domains if domain.strip()]
    normalized = hostname.lower().lstrip(".")
    if any(normalized == domain or normalized.endswith(f".{domain}") for domain in blocked):
        return False
    if allowed and not any(normalized == domain or normalized.endswith(f".{domain}") for domain in allowed):
        return False
    return True


def _strip_www(hostname: str) -> str:
    return hostname.lower().removeprefix("www.")


def _is_permitted_redirect(original_url: str, redirect_url: str) -> bool:
    original = urlparse(original_url)
    redirected = urlparse(redirect_url)
    if redirected.scheme != original.scheme or redirected.port != original.port:
        return False
    if redirected.username or redirected.password:
        return False
    return _strip_www(original.hostname or "") == _strip_www(redirected.hostname or "")


def _get_web_cache(url_value: str) -> dict | None:
    now = time.time()
    with WEB_FETCH_CACHE_LOCK:
        entry = WEB_FETCH_CACHE.get(url_value)
        if not entry:
            return None
        if now - entry["created_at"] > WEB_CACHE_TTL_SECONDS:
            global WEB_FETCH_CACHE_BYTES
            WEB_FETCH_CACHE_BYTES = max(0, WEB_FETCH_CACHE_BYTES - int(entry.get("size", 0)))
            WEB_FETCH_CACHE.pop(url_value, None)
            return None
        entry["last_accessed"] = now
        return dict(entry["data"], cached=True)


def _set_web_cache(url_value: str, data: dict) -> None:
    global WEB_FETCH_CACHE_BYTES
    size = max(1, len(str(data.get("markdown") or data.get("content") or "").encode("utf-8")))
    now = time.time()
    with WEB_FETCH_CACHE_LOCK:
        old = WEB_FETCH_CACHE.pop(url_value, None)
        if old:
            WEB_FETCH_CACHE_BYTES = max(0, WEB_FETCH_CACHE_BYTES - int(old.get("size", 0)))
        WEB_FETCH_CACHE[url_value] = {"created_at": now, "last_accessed": now, "size": size, "data": data}
        WEB_FETCH_CACHE_BYTES += size
        while WEB_FETCH_CACHE_BYTES > WEB_CACHE_MAX_BYTES and WEB_FETCH_CACHE:
            oldest_key = min(WEB_FETCH_CACHE, key=lambda key: WEB_FETCH_CACHE[key]["last_accessed"])
            oldest = WEB_FETCH_CACHE.pop(oldest_key)
            WEB_FETCH_CACHE_BYTES = max(0, WEB_FETCH_CACHE_BYTES - int(oldest.get("size", 0)))


async def _search_ollama_hosted(request: IDEWebSearchRequest) -> dict:
    api_key = os.getenv("OLLAMA_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError("OLLAMA_API_KEY is not set")
    async with httpx.AsyncClient(timeout=30.0) as client:
        response = await client.post(
            "https://ollama.com/api/web_search",
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            json={"query": request.query, "max_results": max(1, min(request.max_results, 10))},
        )
    if response.status_code != 200:
        raise RuntimeError(f"Ollama hosted search returned {response.status_code}: {response.text[:300]}")
    results = [result for result in response.json().get("results", []) if _domain_allowed(result.get("url", ""), request.allowed_domains, request.blocked_domains)]
    return {"provider": "ollama", "query": request.query, "results": results[: max(1, min(request.max_results, 10))]}


async def _search_duckduckgo(request: IDEWebSearchRequest) -> dict:
    headers = {
        "User-Agent": "Mozilla/5.0 Agent Framework DevUI",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
    }
    async with httpx.AsyncClient(timeout=30.0, follow_redirects=True) as client:
        response = None
        for search_url in ("https://html.duckduckgo.com/html/", "https://lite.duckduckgo.com/lite/"):
            response = await client.get(search_url, params={"q": request.query}, headers=headers)
            if response.status_code == 200:
                break
    if response is None or response.status_code != 200:
        raise RuntimeError(f"DuckDuckGo returned status {response.status_code if response else 'unknown'}")
    parser = _DuckDuckGoResultParser()
    parser.feed(response.text)
    parser.close()
    results = [result for result in parser.results if _domain_allowed(result.get("url", ""), request.allowed_domains, request.blocked_domains)]
    return {"provider": "duckduckgo", "query": request.query, "results": results[: max(1, min(request.max_results, 10))]}


async def _fetch_url_markdown(url_value: str) -> dict:
    cached = _get_web_cache(url_value)
    if cached:
        return cached

    parsed = urlparse(url_value)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc or parsed.username or parsed.password:
        raise HTTPException(status_code=400, detail="web_fetch requires a valid public http(s) URL without credentials")
    if parsed.scheme == "http":
        parsed = parsed._replace(scheme="https")
        url_value = parsed.geturl()

    headers = {"User-Agent": "Mozilla/5.0 Agent Framework DevUI", "Accept": "text/markdown,text/html,text/plain,*/*"}
    current_url = url_value
    async with httpx.AsyncClient(timeout=60.0, follow_redirects=False) as client:
        for _redirect in range(WEB_FETCH_MAX_REDIRECTS + 1):
            response = await client.get(current_url, headers=headers)
            if response.status_code in {301, 302, 307, 308}:
                location = response.headers.get("location")
                if not location:
                    raise HTTPException(status_code=502, detail="Redirect response missing Location header")
                redirect_url = urljoin(current_url, location)
                if not _is_permitted_redirect(current_url, redirect_url):
                    return {
                        "url": url_value,
                        "redirected": True,
                        "redirect_url": redirect_url,
                        "status_code": response.status_code,
                        "markdown": f"REDIRECT DETECTED\n\nOriginal URL: {current_url}\nRedirect URL: {redirect_url}\n\nFetch the redirected URL explicitly if you trust it.",
                        "cached": False,
                    }
                current_url = redirect_url
                continue
            break
        else:
            raise HTTPException(status_code=508, detail="Too many redirects")

    content = response.content[:WEB_FETCH_MAX_BYTES + 1]
    if len(content) > WEB_FETCH_MAX_BYTES:
        raise HTTPException(status_code=413, detail="Fetched content exceeds 10 MB limit")
    content_type = response.headers.get("content-type", "")
    text = content.decode(response.encoding or "utf-8", errors="replace")
    title = ""
    title_match = re.search(r"<title[^>]*>([\s\S]*?)</title>", text, re.IGNORECASE)
    if title_match:
        title = " ".join(unescape(re.sub(r"<[^>]+>", " ", title_match.group(1))).split())
    if "html" in content_type.lower() or re.search(r"<html|<body|<p[\s>]", text, re.IGNORECASE):
        parser = _MarkdownHTMLParser(current_url)
        parser.feed(text)
        markdown = parser.markdown()
    else:
        markdown = text.strip()
    if len(markdown) > WEB_FETCH_MAX_MARKDOWN_CHARS:
        markdown = markdown[:WEB_FETCH_MAX_MARKDOWN_CHARS] + "\n\n[Content truncated due to length.]"
    data = {
        "url": url_value,
        "final_url": current_url,
        "title": title,
        "status_code": response.status_code,
        "content_type": content_type,
        "bytes": len(content),
        "markdown": markdown,
        "cached": False,
    }
    _set_web_cache(url_value, data)
    return data


def _transcribe_audio_file(audio_path: Path, language: str | None = None) -> dict:
    model_name = os.getenv("SPEECH_TO_TEXT_MODEL", "base")
    device = os.getenv("SPEECH_TO_TEXT_DEVICE", "cpu")
    compute_type = os.getenv("SPEECH_TO_TEXT_COMPUTE_TYPE", "int8")

    try:
        from faster_whisper import WhisperModel
    except ImportError:
        WhisperModel = None

    if WhisperModel is not None:
        cache_key = f"faster-whisper:{model_name}:{device}:{compute_type}"
        with SPEECH_MODEL_LOCK:
            model = SPEECH_MODEL_CACHE.get(cache_key)
            if model is None:
                model = WhisperModel(model_name, device=device, compute_type=compute_type)
                SPEECH_MODEL_CACHE[cache_key] = model
        segments, info = model.transcribe(str(audio_path), language=language or None, vad_filter=True)
        text = " ".join(segment.text.strip() for segment in segments).strip()
        return {
            "text": text,
            "engine": "faster-whisper",
            "model": model_name,
            "language": getattr(info, "language", None),
            "duration": getattr(info, "duration", None),
        }

    try:
        import whisper
    except ImportError:
        whisper = None

    if whisper is not None:
        cache_key = f"openai-whisper:{model_name}"
        with SPEECH_MODEL_LOCK:
            model = SPEECH_MODEL_CACHE.get(cache_key)
            if model is None:
                model = whisper.load_model(model_name)
                SPEECH_MODEL_CACHE[cache_key] = model
        result = model.transcribe(str(audio_path), language=language or None)
        return {
            "text": str(result.get("text") or "").strip(),
            "engine": "openai-whisper",
            "model": model_name,
            "language": result.get("language"),
            "duration": None,
        }

    raise HTTPException(
        status_code=503,
        detail=(
            "Speech transcription is not installed. Install faster-whisper and python-multipart "
            "in the custom backend environment, then restart the Custom Backend."
        ),
    )


@app.get("/health")
async def health():
    return {"status": "healthy", "entities_count": 2, "framework": "agent_framework"}
ollama_stream_endpoint(app)


@app.get("/api/settings")
async def get_app_settings():
    api_key = os.getenv("OLLAMA_API_KEY", "").strip()
    return {"ollama_api_key_configured": bool(api_key)}


@app.put("/api/settings")
async def update_app_settings(settings: AppSettingsUpdateRequest):
    if settings.clear_ollama_api_key:
        os.environ.pop("OLLAMA_API_KEY", None)
        _save_local_settings()
    elif settings.ollama_api_key is not None:
        api_key = settings.ollama_api_key.strip()
        if api_key:
            os.environ["OLLAMA_API_KEY"] = api_key
            _save_local_settings()

    api_key = os.getenv("OLLAMA_API_KEY", "").strip()
    return {"ollama_api_key_configured": bool(api_key)}


@app.get("/api/storage/{name}")
async def get_user_storage_item(name: str):
    storage_file = _resolve_user_storage_file(name)
    if not storage_file.exists():
        return {"value": None}
    try:
        return {"value": storage_file.read_text(encoding="utf-8")}
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"Failed to read storage: {exc}") from exc


@app.put("/api/storage/{name}")
async def set_user_storage_item(name: str, request: UserStorageUpdateRequest):
    storage_file = _resolve_user_storage_file(name)
    try:
        storage_file.write_text(request.value, encoding="utf-8")
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"Failed to write storage: {exc}") from exc
    return {"ok": True}


@app.delete("/api/storage/{name}")
async def delete_user_storage_item(name: str):
    storage_file = _resolve_user_storage_file(name)
    try:
        if storage_file.exists():
            storage_file.unlink()
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"Failed to delete storage: {exc}") from exc
    return {"ok": True}


@app.get("/api/ide/files")
async def list_ide_files():
    return {"root": str(IDE_ROOT), "files": _build_ide_tree(IDE_ROOT)}


@app.put("/api/ide/folder")
async def open_ide_folder(request: IDEFolderRequest):
    global IDE_ROOT
    IDE_ROOT = _resolve_ide_folder(request.path)
    _save_ide_root(IDE_ROOT)
    return {"root": str(IDE_ROOT), "files": _build_ide_tree(IDE_ROOT)}


@app.post("/api/ide/folder/pick")
async def pick_ide_folder():
    global IDE_ROOT
    try:
        selected = await run_in_threadpool(_pick_folder_dialog, str(IDE_ROOT))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to open folder picker: {exc}")

    if not selected:
        return {"cancelled": True, "root": str(IDE_ROOT), "files": _build_ide_tree(IDE_ROOT)}

    IDE_ROOT = _resolve_ide_folder(selected)
    _save_ide_root(IDE_ROOT)
    return {"cancelled": False, "root": str(IDE_ROOT), "files": _build_ide_tree(IDE_ROOT)}


@app.get("/api/ide/file")
async def read_ide_file(path: str):
    file_path = _resolve_workspace_file(path)
    if not file_path.exists() or not file_path.is_file():
        raise HTTPException(status_code=404, detail=f"File not found: {path}")
    if file_path.suffix.lower() not in IDE_TEXT_SUFFIXES:
        raise HTTPException(status_code=400, detail=f"Unsupported text file type: {file_path.suffix}")
    try:
        return {"path": f"/{file_path.relative_to(IDE_ROOT).as_posix()}", "content": file_path.read_text(encoding="utf-8")}
    except UnicodeDecodeError:
        raise HTTPException(status_code=400, detail="File is not valid UTF-8 text")
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"Failed to read file: {exc}")


@app.put("/api/ide/file")
async def write_ide_file(request: IDEFileWriteRequest):
    file_path = _resolve_workspace_file(request.path)
    if file_path.suffix.lower() not in IDE_TEXT_SUFFIXES:
        raise HTTPException(status_code=400, detail=f"Unsupported text file type: {file_path.suffix}")
    try:
        file_path.parent.mkdir(parents=True, exist_ok=True)
        file_path.write_text(request.content, encoding="utf-8")
        return {"success": True, "path": f"/{file_path.relative_to(IDE_ROOT).as_posix()}"}
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"Failed to write file: {exc}")


@app.post("/api/ide/search")
async def search_ide_files(request: IDESearchRequest):
    query = request.query.strip()
    if not query:
        raise HTTPException(status_code=400, detail="Search query is required")
    max_results = max(1, min(request.max_results, 200))
    lowered_query = query.lower()
    matches: list[dict] = []

    for file_path in _iter_ide_text_files(IDE_ROOT):
        if len(matches) >= max_results:
            break
        try:
            with file_path.open("r", encoding="utf-8") as file:
                for line_number, line in enumerate(file, 1):
                    if lowered_query in line.lower():
                        matches.append({
                            "path": f"/{file_path.relative_to(IDE_ROOT).as_posix()}",
                            "line": line_number,
                            "text": line.rstrip("\n")[:500],
                        })
                        if len(matches) >= max_results:
                            break
        except (OSError, UnicodeDecodeError):
            continue

    return {"query": query, "matches": matches}


@app.post("/api/ide/web/search")
async def ide_web_search(request: IDEWebSearchRequest):
    request.query = request.query.strip()
    if not request.query:
        raise HTTPException(status_code=400, detail="web_search requires query")
    request.max_results = max(1, min(request.max_results, 10))
    start = time.perf_counter()
    errors: list[str] = []

    if request.provider in {"auto", "ollama"}:
        try:
            data = await _search_ollama_hosted(request)
            data["duration_seconds"] = round(time.perf_counter() - start, 3)
            data["fallback_errors"] = errors
            return data
        except Exception as exc:
            errors.append(f"ollama: {exc}")
            if request.provider == "ollama":
                raise HTTPException(status_code=502, detail=str(exc))

    try:
        data = await _search_duckduckgo(request)
        data["duration_seconds"] = round(time.perf_counter() - start, 3)
        data["fallback_errors"] = errors
        return data
    except Exception as exc:
        errors.append(f"duckduckgo: {exc}")
        raise HTTPException(status_code=502, detail="; ".join(errors))


@app.post("/api/ide/web/fetch")
async def ide_web_fetch(request: IDEWebFetchRequest):
    url_value = request.url.strip()
    if not url_value:
        raise HTTPException(status_code=400, detail="web_fetch requires url")
    start = time.perf_counter()
    data = await _fetch_url_markdown(url_value)
    data["prompt"] = request.prompt.strip() or "Extract the most relevant information from this page."
    data["duration_seconds"] = round(time.perf_counter() - start, 3)
    return data

@app.post("/api/speech/transcribe")
async def transcribe_speech(file: UploadFile = File(...), language: str | None = None):
    content_type = (file.content_type or "").lower()
    if not (content_type.startswith("audio/") or content_type in {"application/octet-stream", "video/webm"}):
        raise HTTPException(status_code=400, detail=f"Unsupported audio content type: {file.content_type or 'unknown'}")

    suffix = Path(file.filename or "recording.webm").suffix or ".webm"
    total_bytes = 0
    start = time.perf_counter()
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
            tmp_path = Path(tmp.name)
            while True:
                chunk = await file.read(1024 * 1024)
                if not chunk:
                    break
                total_bytes += len(chunk)
                if total_bytes > SPEECH_MAX_UPLOAD_BYTES:
                    raise HTTPException(status_code=413, detail="Audio recording is too large. Keep dictation clips under 25 MB.")
                tmp.write(chunk)

        result = await run_in_threadpool(_transcribe_audio_file, tmp_path, language)
        result["bytes"] = total_bytes
        result["duration_seconds"] = round(time.perf_counter() - start, 3)
        return result
    finally:
        try:
            if "tmp_path" in locals():
                tmp_path.unlink(missing_ok=True)
        except OSError:
            pass


@app.get("/api/ide/csv-files")
async def list_ide_csv_files():
    root = IDE_ROOT.resolve()
    files: list[str] = []
    for path in root.rglob("*.csv"):
        if any(part in IDE_EXCLUDED_DIRS for part in path.relative_to(root).parts[:-1]):
            continue
        try:
            files.append(path.relative_to(root).as_posix())
        except ValueError:
            continue
    return {"root": str(root), "files": sorted(files)}


@app.get("/api/ide/csv-file")
async def read_ide_csv_file(path: str):
    resolved = _resolve_workspace_file(path)
    if resolved.suffix.lower() != ".csv":
        raise HTTPException(status_code=400, detail="Only CSV files can be opened here")
    try:
        content = resolved.read_text(encoding="utf-8-sig")
    except UnicodeDecodeError:
        content = resolved.read_text(encoding="latin-1")
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"Failed to read CSV file: {exc}")
    return {"path": resolved.relative_to(IDE_ROOT.resolve()).as_posix(), "content": content}


@app.post("/api/data/csv/pick")
async def pick_data_csv_files():
    selected_paths = await run_in_threadpool(_pick_csv_files_dialog, str(IDE_ROOT.resolve()))
    if not selected_paths:
        return {"cancelled": True, "files": []}

    files = []
    for raw_path in selected_paths:
        path = Path(raw_path).resolve()
        if not path.exists() or not path.is_file() or path.suffix.lower() != ".csv":
            continue
        try:
            content = path.read_text(encoding="utf-8-sig")
        except UnicodeDecodeError:
            content = path.read_text(encoding="latin-1")
        except OSError as exc:
            raise HTTPException(status_code=500, detail=f"Failed to read CSV file {path}: {exc}")
        files.append({
            "path": str(path),
            "filename": path.name,
            "content": content,
            "last_modified": time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(path.stat().st_mtime)),
        })

    return {"cancelled": False, "files": files}


@app.post("/api/ide/command")
async def run_ide_command(request: IDECommandRequest):
    command = request.command.strip()
    if not command:
        raise HTTPException(status_code=400, detail="Command is required")
    timeout_seconds = max(1, min(request.timeout_seconds, 120))
    cwd = _resolve_terminal_cwd(request.cwd)
    stdin_value = request.stdin
    input_text = None
    if isinstance(stdin_value, list):
        input_text = "\n".join(str(line) for line in stdin_value) + ("\n" if stdin_value else "")
    elif isinstance(stdin_value, str):
        input_text = stdin_value if stdin_value.endswith(("\n", "\r")) else f"{stdin_value}\n"
    try:
        completed = await run_in_threadpool(
            subprocess.run,
            command,
            cwd=str(cwd),
            shell=True,
            input=input_text,
            capture_output=True,
            text=True,
            timeout=timeout_seconds,
        )
        output = ((completed.stdout or "") + (completed.stderr or ""))[:12000]
        return {"exit_code": completed.returncode, "output": output, "cwd": str(cwd)}
    except subprocess.TimeoutExpired as exc:
        output = ((exc.stdout or "") + (exc.stderr or ""))[:12000]
        raise HTTPException(status_code=408, detail={"message": f"Command timed out after {timeout_seconds}s", "output": output})
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to run command: {exc}")


@app.post("/api/ide/terminal/start")
async def start_ide_terminal(request: IDECommandRequest):
    command = request.command.strip()
    if not command:
        raise HTTPException(status_code=400, detail="Command is required")
    cwd = _resolve_terminal_cwd(request.cwd)
    env = os.environ.copy()
    env.setdefault("PYTHONUNBUFFERED", "1")
    session_id = uuid.uuid4().hex
    try:
        process = subprocess.Popen(
            command,
            cwd=str(cwd),
            shell=True,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=0,
            env=env,
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to start terminal command: {exc}")

    with TERMINAL_SESSIONS_LOCK:
        TERMINAL_SESSIONS[session_id] = {"process": process, "output": [], "cwd": str(cwd)}

    for pipe in (process.stdout, process.stderr):
        if pipe:
            thread = threading.Thread(target=_read_terminal_pipe, args=(session_id, pipe), daemon=True)
            thread.start()

    return {
        "session_id": session_id,
        "output": _drain_terminal_output(session_id),
        "running": process.poll() is None,
        "exit_code": process.poll(),
        "cwd": str(cwd),
    }


@app.get("/api/ide/terminal/{session_id}")
async def read_ide_terminal(session_id: str):
    session = _get_terminal_session(session_id)
    process: subprocess.Popen = session["process"]
    exit_code = process.poll()
    output = _drain_terminal_output(session_id)
    return {
        "session_id": session_id,
        "output": output,
        "running": exit_code is None,
        "exit_code": exit_code,
        "cwd": session["cwd"],
    }


@app.post("/api/ide/terminal/{session_id}/input")
async def write_ide_terminal(session_id: str, request: IDETerminalInputRequest):
    session = _get_terminal_session(session_id)
    process: subprocess.Popen = session["process"]
    if process.poll() is not None or not process.stdin:
        raise HTTPException(status_code=400, detail="Terminal session is not running")
    try:
        process.stdin.write(request.input)
        process.stdin.flush()
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to write terminal input: {exc}")
    return {"success": True}


@app.delete("/api/ide/terminal/{session_id}")
async def stop_ide_terminal(session_id: str):
    session = _get_terminal_session(session_id)
    process: subprocess.Popen = session["process"]
    if process.poll() is None:
        process.terminate()
    output = _drain_terminal_output(session_id)
    with TERMINAL_SESSIONS_LOCK:
        TERMINAL_SESSIONS.pop(session_id, None)
    return {"success": True, "output": output}


@app.websocket("/api/ide/terminal/pty")
async def ide_terminal_pty(websocket: WebSocket):
    await websocket.accept()
    cwd = _resolve_terminal_cwd(websocket.query_params.get("cwd"))
    command = websocket.query_params.get("command") or os.environ.get("COMSPEC") or "cmd.exe"
    popen_command = [command, "/Q"] if os.name == "nt" and not websocket.query_params.get("command") else command
    loop = asyncio.get_running_loop()
    output_queue: asyncio.Queue[str | None] = asyncio.Queue()

    try:
        process = subprocess.Popen(
            popen_command,
            cwd=str(cwd),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=0,
        )
    except Exception as exc:
        await websocket.send_text(f"Failed to start terminal shell: {exc}\r\n")
        await websocket.close(code=1011)
        return

    def read_terminal_output() -> None:
        try:
            while process.poll() is None and process.stdout:
                chunk = process.stdout.read(1)
                if not chunk:
                    break
                if chunk:
                    loop.call_soon_threadsafe(output_queue.put_nowait, chunk)
        except Exception as exc:
            loop.call_soon_threadsafe(output_queue.put_nowait, f"\r\n[terminal read error: {exc}]\r\n")
        finally:
            loop.call_soon_threadsafe(output_queue.put_nowait, None)

    threading.Thread(target=read_terminal_output, daemon=True).start()

    async def send_output() -> None:
        while True:
            chunk = await output_queue.get()
            if chunk is None:
                break
            await websocket.send_text(chunk)

    async def receive_input() -> None:
        while process.poll() is None:
            raw_message = await websocket.receive_text()
            try:
                message = json.loads(raw_message)
            except json.JSONDecodeError:
                if process.stdin:
                    process.stdin.write(_normalize_pty_input(raw_message))
                    process.stdin.flush()
                continue
            message_type = message.get("type")
            if message_type == "input":
                if process.stdin:
                    process.stdin.write(_normalize_pty_input(str(message.get("data") or "")))
                    process.stdin.flush()
            elif message_type == "resize":
                pass

    sender = asyncio.create_task(send_output())
    receiver = asyncio.create_task(receive_input())
    done, pending = await asyncio.wait({sender, receiver}, return_when=asyncio.FIRST_COMPLETED)
    for task in pending:
        task.cancel()
    try:
        if process.poll() is None:
            process.terminate()
    except Exception:
        pass
    for task in done:
        try:
            task.result()
        except (WebSocketDisconnect, asyncio.CancelledError, OSError, ConnectionError):
            pass

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/v1/entities")
async def get_entities():
    return {"entities": [], "message": "Stub endpoint."}


def _string_from_ast(node: ast.AST | None) -> str:
    if node is None:
        return ""
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    if isinstance(node, ast.JoinedStr):
        parts = [part.value for part in node.values if isinstance(part, ast.Constant) and isinstance(part.value, str)]
        return "".join(parts)
    if isinstance(node, ast.BoolOp):
        for value in node.values:
            text = _string_from_ast(value)
            if text:
                return text
    if isinstance(node, ast.Call):
        call_name = getattr(node.func, "attr", "") or getattr(node.func, "id", "")
        if call_name == "getenv":
            if len(node.args) > 1:
                return _string_from_ast(node.args[1])
            return ""
        for arg in node.args:
            text = _string_from_ast(arg)
            if text:
                return text
    return ""


def _agent_info_from_folder(agent_path: Path) -> dict | None:
    init_path = agent_path / "__init__.py"
    if not init_path.exists():
        return None

    try:
        source = init_path.read_text(encoding="utf-8")
        tree = ast.parse(source)
    except (OSError, SyntaxError, UnicodeDecodeError):
        return None

    info = {
        "id": agent_path.name,
        "name": agent_path.name.replace("_", " ").title(),
        "description": "Agent folder loaded from the local agents directory.",
        "type": "agent",
        "source": "in_memory",
        "tools": [],
        "has_env": False,
        "module_path": str(init_path),
        "instructions": "",
        "model_id": "",
        "chat_client_type": "ollama",
        "isUserCreated": True,
        "metadata": {"folder_agent": True},
    }

    docstring = ast.get_docstring(tree)
    if docstring:
        info["name"] = docstring.strip()

    for node in ast.walk(tree):
        if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == "ollama_config" for target in node.targets):
            if isinstance(node.value, ast.Call):
                for keyword in node.value.keywords:
                    if keyword.arg == "model_id":
                        info["metadata"]["detected_model_id"] = _string_from_ast(keyword.value)
        if not isinstance(node, ast.Call):
            continue
        call_name = getattr(node.func, "id", "") or getattr(node.func, "attr", "")
        if call_name != "ChatAgent":
            continue
        for keyword in node.keywords:
            if keyword.arg == "name":
                info["name"] = _string_from_ast(keyword.value) or info["name"]
            elif keyword.arg == "description":
                info["description"] = _string_from_ast(keyword.value) or info["description"]
            elif keyword.arg == "instructions":
                info["instructions"] = _string_from_ast(keyword.value)
            elif keyword.arg == "tools" and isinstance(keyword.value, ast.List):
                tools = []
                for element in keyword.value.elts:
                    tool_name = getattr(element, "id", "") or getattr(element, "attr", "")
                    if tool_name:
                        tools.append(tool_name)
                info["tools"] = tools
    return info


@app.get("/api/agents/folders")
async def list_agent_folders():
    agents: list[dict] = []
    if AGENTS_DIR.exists():
        for agent_path in sorted(AGENTS_DIR.iterdir(), key=lambda path: path.name.lower()):
            if not agent_path.is_dir() or agent_path.name.startswith("__"):
                continue
            agent_info = _agent_info_from_folder(agent_path)
            if agent_info:
                agents.append(agent_info)
    return {"agents": agents}


def _build_agent_init_content(
    folder_name: str,
    agent_name: str,
    instructions: str,
    model: str,
    selected_tools: list[str],
    tool_code: list[dict],
) -> str:
    import textwrap, re as _re

    hosted_tool_map = {
        "file_search":      "HostedFileSearchTool()",
        "hosted_mcp":       'HostedMCPTool(name="my_mcp_tool", url="https://example.com/mcp")',
        "mcp_tool":         'HostedMCPTool(name="my_mcp_tool", url="https://example.com/mcp")',
        "web_search":       "HostedWebSearchTool()",
        "vector_store":     "HostedFileSearchTool()",
    }
    local_tool_blocks = {
        "code_interpreter": '''# Tool: Local Code Interpreter for Ollama
@ai_function
def code_interpreter(code: str) -> str:
    """Execute Python code or a simple Python command locally and return stdout, stderr, and the exit code."""
    import shlex
    import subprocess
    import sys
    import tempfile
    from pathlib import Path

    if not code or not code.strip():
        return "code_interpreter failed: missing Python code."
    if len(code) > 12000:
        return "code_interpreter failed: code is too long; keep scripts under 12000 characters."

    stripped_code = code.strip()
    workspace_root = Path(__file__).resolve().parents[2]
    try:
        command_parts = shlex.split(stripped_code)
    except ValueError:
        command_parts = []

    if "\n" not in stripped_code and len(command_parts) >= 2 and command_parts[0].lower() in {"python", "python3", "py"}:
        try:
            result = subprocess.run(
                [sys.executable, *command_parts[1:]],
                cwd=workspace_root,
                text=True,
                capture_output=True,
                timeout=20,
            )
        except subprocess.TimeoutExpired:
            return "code_interpreter failed: execution timed out after 20 seconds."
        except Exception as exc:
            return f"code_interpreter failed: {type(exc).__name__}: {exc}"
    else:
        with tempfile.TemporaryDirectory(prefix="ollama_code_interpreter_") as temp_dir:
            script_path = Path(temp_dir) / "main.py"
            script_path.write_text(code, encoding="utf-8")
            try:
                result = subprocess.run(
                    [sys.executable, str(script_path)],
                    cwd=workspace_root,
                    text=True,
                    capture_output=True,
                    timeout=20,
                )
            except subprocess.TimeoutExpired:
                return "code_interpreter failed: execution timed out after 20 seconds."
            except Exception as exc:
                return f"code_interpreter failed: {type(exc).__name__}: {exc}"

    stdout = result.stdout[-12000:] if result.stdout else ""
    stderr = result.stderr[-12000:] if result.stderr else ""
    return f"exit_code: {result.returncode}\\nstdout:\\n{stdout or '(empty)'}\\nstderr:\\n{stderr or '(empty)'}"
''',
    }
    selected_tools = [t.strip() for t in (selected_tools or []) if t and t.strip()]
    user_tool_map = {tc["id"]: tc for tc in (tool_code or []) if tc.get("id") and tc.get("code")}
    tool_instances = [hosted_tool_map[t] for t in selected_tools if t in hosted_tool_map]
    local_tool_function_names = [t for t in selected_tools if t in local_tool_blocks]
    local_tool_sections = [local_tool_blocks[t] for t in selected_tools if t in local_tool_blocks]
    unknown_tools = [t for t in selected_tools if t not in hosted_tool_map and t not in local_tool_blocks and t not in user_tool_map]

    tool_imports = []
    if any("HostedCodeInterpreterTool" in t for t in tool_instances): tool_imports.append("HostedCodeInterpreterTool")
    if any("HostedFileSearchTool" in t for t in tool_instances): tool_imports.append("HostedFileSearchTool")
    if any("HostedMCPTool" in t for t in tool_instances): tool_imports.append("HostedMCPTool")
    if any("HostedWebSearchTool" in t for t in tool_instances): tool_imports.append("HostedWebSearchTool")

    extra_imports = ["ai_function"] + tool_imports
    import_line = f"from agent_framework import ChatAgent, {', '.join(extra_imports)}"

    user_tool_function_names = []
    user_tool_blocks = []
    for tool_id in selected_tools:
        if tool_id not in user_tool_map:
            continue
        tc = user_tool_map[tool_id]
        raw_code = tc.get("code", "").strip()
        safe_name = _re.sub(r"[^a-z0-9_]", "_", (tc.get("name") or tool_id).lower().replace(" ", "_"))
        safe_name = _re.sub(r"_+", "_", safe_name).strip("_") or "custom_tool"
        if "def " in raw_code:
            m = _re.search(r"def\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(", raw_code)
            if m: safe_name = m.group(1)
            prefix = "" if "@ai_function" in raw_code else "@ai_function\n"
            block = f"# Tool: {tc.get('name', tool_id)}\n{prefix}{raw_code}"
        else:
            indented = textwrap.indent(raw_code, "    ")
            desc = tc.get("description") or tc.get("name") or tool_id
            block = f"# Tool: {tc.get('name', tool_id)}\n@ai_function\ndef {safe_name}():\n    \"\"\"{desc}\"\"\"\n{indented}"
        user_tool_blocks.append(block)
        user_tool_function_names.append(safe_name)

    all_tool_refs = tool_instances + local_tool_function_names + user_tool_function_names
    tools_arg = f",\n    tools=[{', '.join(all_tool_refs)}]" if all_tool_refs else ""
    unknown_comment = (f"\n# NOTE: Unresolved tools: {', '.join(unknown_tools)}\n" if unknown_tools else "")
    local_tools_section = ("\n\n" + "\n\n".join(local_tool_sections)) if local_tool_sections else ""
    user_tools_section = ("\n\n" + "\n\n".join(user_tool_blocks)) if user_tool_blocks else ""
    all_generated_tools_section = f"{local_tools_section}{user_tools_section}"

    file_lines = [
        f'"""{agent_name}"""',
        "import os",
        import_line,
        "from agent_framework.openai import OpenAIChatClient",
    ]
    if unknown_comment: file_lines.append(unknown_comment)
    if all_generated_tools_section: file_lines.append(all_generated_tools_section)
    file_lines += [
        "",
        "ollama_config = dict(",
        "    api_key='ollama',",
        "    base_url=os.getenv('OLLAMA_ENDPOINT'),",
        f"    model_id=os.getenv('OLLAMA_MODEL') or {repr(model)},",
        ")",
        "",
        f"{folder_name} = ChatAgent(",
        "    chat_client=OpenAIChatClient(**ollama_config),",
        f"    name={repr(agent_name)},",
        f"    instructions={repr(instructions)}{tools_arg}",
        ")",
        "",
        f"agent = {folder_name}",
        "",
    ]
    return "\n".join(file_lines)


@app.post("/api/agents/create-folder")
async def create_agent_folder(agent: AgentCreate):
    try:
        folder_name = agent.name.lower().replace(" ", "_").replace("-", "_")
        folder_name = "".join(c for c in folder_name if c.isalnum() or c == "_")
        agent_path = AGENTS_DIR / folder_name
        if agent_path.exists():
            raise HTTPException(status_code=400, detail=f"Agent folder '{folder_name}' already exists")
        agent_path.mkdir(parents=True, exist_ok=True)
        generated_init = _build_agent_init_content(
            folder_name=folder_name,
            agent_name=agent.name,
            instructions=agent.instructions,
            model=agent.model,
            selected_tools=agent.tools or [],
            tool_code=agent.tool_code or [],
        )

        # Fail fast if AI-generated tool code would produce invalid Python.
        try:
            compile(generated_init, str(agent_path / "__init__.py"), "exec")
        except SyntaxError as exc:
            line = exc.lineno or "unknown"
            raise HTTPException(
                status_code=400,
                detail=(
                    "Generated tool code is invalid Python and could not be wired into the agent. "
                    f"Syntax error at line {line}: {exc.msg}. "
                    "Please edit the tool code or regenerate it."
                ),
            )

        (agent_path / "__init__.py").write_text(generated_init, encoding="utf-8")

        return {
            "success": True,
            "id": folder_name,
            "message": f"Agent '{agent.name}' created successfully!\n\nIMPORTANT: Restart the DevUI backend (port 8080) for it to appear.",
            "path": str(agent_path),
            "needsRestart": True,
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to create agent: {str(e)}")


@app.put("/api/agents/{agent_id}/update-folder")
async def update_agent_folder(agent_id: str, agent: AgentFolderUpdateRequest):
    try:
        folder_name = agent_id.lower().replace(" ", "_").replace("-", "_")
        folder_name = "".join(c for c in folder_name if c.isalnum() or c == "_")
        if not folder_name:
            raise HTTPException(status_code=400, detail="Invalid agent id")

        agents_root = AGENTS_DIR.resolve()
        agent_path = (AGENTS_DIR / folder_name).resolve()
        if agents_root not in agent_path.parents:
            raise HTTPException(status_code=400, detail="Invalid agent path")
        if not agent_path.exists() or not agent_path.is_dir():
            raise HTTPException(status_code=404, detail=f"Agent folder '{folder_name}' not found")

        generated_init = _build_agent_init_content(
            folder_name=folder_name,
            agent_name=agent.name,
            instructions=agent.instructions,
            model=agent.model,
            selected_tools=agent.tools or [],
            tool_code=agent.tool_code or [],
        )

        try:
            compile(generated_init, str(agent_path / "__init__.py"), "exec")
        except SyntaxError as exc:
            line = exc.lineno or "unknown"
            raise HTTPException(
                status_code=400,
                detail=(
                    "Updated tool code is invalid Python and could not be wired into the agent. "
                    f"Syntax error at line {line}: {exc.msg}. "
                    "Please edit the tool code or regenerate it."
                ),
            )

        (agent_path / "__init__.py").write_text(generated_init, encoding="utf-8")
        return {
            "success": True,
            "id": folder_name,
            "message": f"Agent '{agent.name}' updated successfully!",
            "path": str(agent_path),
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to update agent: {str(e)}")


@app.delete("/api/agents/{agent_id}/delete-folder")
async def delete_agent_folder(agent_id: str):
    try:
        folder_name = agent_id.lower().replace(" ", "_").replace("-", "_")
        folder_name = "".join(c for c in folder_name if c.isalnum() or c == "_")
        if not folder_name:
            raise HTTPException(status_code=400, detail="Invalid agent id")
        agents_root = AGENTS_DIR.resolve()
        agent_path  = (AGENTS_DIR / folder_name).resolve()
        if agents_root not in agent_path.parents:
            raise HTTPException(status_code=400, detail="Invalid agent path")
        if not agent_path.exists():
            return {"success": True, "id": folder_name, "message": f"Agent folder '{folder_name}' was already deleted"}
        if not agent_path.is_dir():
            raise HTTPException(status_code=400, detail=f"Path '{folder_name}' is not a folder")
        shutil.rmtree(agent_path)
        return {"success": True, "id": folder_name, "message": f"Agent folder '{folder_name}' deleted successfully"}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to delete agent folder: {str(e)}")


@app.post("/api/agents/generate")
async def generate_agent_spec(request: AgentGenerateRequest):
    prompt = (request.prompt or "").strip()
    if not prompt:
        raise HTTPException(status_code=400, detail="Prompt is required")
    available_models = [m.strip() for m in request.available_models if m and m.strip()]
    available_tools  = [t.strip() for t in request.available_tools if t and t.strip()]
    selected_tools   = [t.strip() for t in request.selected_tools if t and t.strip()]
    if selected_tools and available_tools:
        invalid = [t for t in selected_tools if t not in available_tools]
        if invalid:
            raise HTTPException(status_code=400, detail=f"Selected tools are not available: {', '.join(invalid)}")
    default_model = request.model or os.getenv("OLLAMA_MODEL") or "llama3:8b"
    if request.user_selected_model:
        sel = request.user_selected_model.strip()
        if available_models and sel not in available_models:
            raise HTTPException(status_code=400, detail=f"Selected model '{sel}' is not in local available models")
        model = sel
    else:
        model = default_model
    if available_models and model not in available_models:
        model = available_models[0]

    sys_p = ("You design AI agent configurations. Return ONLY valid JSON with exactly these keys: "
             "name, description, instructions, model. name should be short and title-cased; "
             "description one sentence; instructions a clear multi-sentence system prompt; "
             "model must be one of the available local models if a list is provided.")
    user_p = (f"Create an agent spec for:\n\n{prompt}\n\n"
              f"Available local models: {', '.join(available_models) if available_models else '(not provided)'}\n"
              f"Available tools: {', '.join(available_tools) if available_tools else '(not provided)'}\n"
              f"Selected tools: {', '.join(selected_tools) if selected_tools else '(none)'}\n"
              f"Default model: {model}")
    payload = {"model": model, "stream": False,
               "messages": [{"role": "system", "content": sys_p}, {"role": "user", "content": user_p}],
               "options": {"temperature": 0.3}}
    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            resp = await client.post("http://localhost:11434/api/chat", json=payload)
        if resp.status_code != 200:
            raise HTTPException(status_code=502, detail=f"Ollama generation failed with status {resp.status_code}")
        data = resp.json()
        raw_content = data.get("message", {}).get("content", "")
        if not raw_content:
            raise HTTPException(status_code=502, detail="Ollama returned empty content")
        parsed = _extract_json_object(raw_content)
        gen_name  = (parsed.get("name")         or "Custom Agent").strip()
        gen_desc  = (parsed.get("description")  or "AI-generated custom agent").strip()
        gen_instr = (parsed.get("instructions") or "You are a helpful assistant.").strip()
        gen_model = (parsed.get("model")        or model).strip()
        if available_models and gen_model not in available_models:
            gen_model = request.user_selected_model or model
            if gen_model not in available_models:
                gen_model = available_models[0]
        if not gen_instr:
            gen_instr = "You are a helpful assistant."
        return {"name": gen_name, "description": gen_desc, "instructions": gen_instr, "model": gen_model}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to generate agent spec: {str(e)}")


@app.post("/api/tools/install-dependencies")
async def install_tool_dependencies(request: InstallDependenciesRequest):
    code = (request.code or "").strip()
    if not code:
        raise HTTPException(status_code=400, detail="Tool code is required")

    packages = _extract_third_party_modules(code)
    if not packages:
        return {
            "detected": [],
            "installed": [],
            "skipped": [],
            "message": "No third-party dependencies detected.",
        }

    already_installed: list[str] = []
    to_install: list[str] = []
    for pkg in packages:
        check = subprocess.run(
            [sys.executable, "-m", "pip", "show", pkg],
            capture_output=True,
            text=True,
            timeout=15,
        )
        if check.returncode == 0:
            already_installed.append(pkg)
        else:
            to_install.append(pkg)

    installed: list[str] = []
    if to_install:
        install_cmd = [sys.executable, "-m", "pip", "install", *to_install]
        result = subprocess.run(install_cmd, capture_output=True, text=True, timeout=180)
        if result.returncode != 0:
            raise HTTPException(
                status_code=500,
                detail=(
                    "Dependency installation failed. "
                    + (result.stderr.strip() or result.stdout.strip() or "Unknown pip error")
                ),
            )
        installed = to_install

    return {
        "detected": packages,
        "installed": installed,
        "skipped": already_installed,
        "message": "Dependencies installed successfully." if installed else "Dependencies already installed.",
    }


@app.post("/api/tools/generate")
async def generate_tool_spec(request: ToolGenerateRequest):
    prompt = (request.prompt or "").strip()
    if not prompt:
        raise HTTPException(status_code=400, detail="Prompt is required")
    available_models = [m.strip() for m in request.available_models if m and m.strip()]
    model = request.model or os.getenv("OLLAMA_MODEL") or "llama3:8b"
    if available_models and model not in available_models:
        model = available_models[0]
    requested_tool_type = (request.tool_type or "auto").strip().lower()
    allowed_types = ["auto", "function", "hosted_code_interpreter", "hosted_file_search", "hosted_web_search", "hosted_mcp"]
    if requested_tool_type not in allowed_types:
        raise HTTPException(status_code=400, detail=f"Invalid tool_type '{requested_tool_type}'")

    sys_p = ("You are an expert in Microsoft Agent Framework Python tools. "
             "Return ONLY valid JSON with exactly these keys: name, description, tool_type, code. "
             "tool_type must be one of: function, hosted_code_interpreter, hosted_file_search, hosted_web_search, hosted_mcp. "
             "Function tool: typed Python function using @ai_function from agent_framework with docstring and Annotated args.")
    user_p = (f"Generate a tool for:\n\n{prompt}\n\nRequested tool type: {requested_tool_type}\n"
              f"Available models: {', '.join(available_models) if available_models else '(not provided)'}")
    payload = {"model": model, "stream": False,
               "messages": [{"role": "system", "content": sys_p}, {"role": "user", "content": user_p}],
               "options": {"temperature": 0.2}}

    def _extract_code_from_raw(text: str) -> str:
        fence_start = text.find("```")
        if fence_start != -1:
            fence_end = text.find("```", fence_start + 3)
            if fence_end != -1:
                block = text[fence_start + 3:fence_end].strip()
                lines = block.splitlines()
                if lines and lines[0].strip().replace("-", "").isalpha() and len(lines) > 1:
                    return "\n".join(lines[1:]).strip()
                return block
        return text.strip()

    def _looks_like_json(text: str) -> bool:
        t = text.strip()
        return t.startswith("{") and t.endswith("}")

    def _parse_generated_tool(raw_content: str) -> tuple[str, str, str]:
        try:
            parsed = _extract_json_object(raw_content)
            gen_name = (parsed.get("name") or "Custom Tool").strip()
            gen_desc = (parsed.get("description") or "AI-generated tool").strip()
            gen_type = (parsed.get("tool_type") or "function").strip().lower()
            gen_code = (parsed.get("code") or "").strip()
            if _looks_like_json(gen_code):
                try:
                    inner = _extract_json_object(gen_code)
                    if inner.get("code"):
                        gen_code = (inner.get("code") or "").strip()
                        gen_name = (inner.get("name") or gen_name).strip()
                        gen_desc = (inner.get("description") or gen_desc).strip()
                        gen_type = (inner.get("tool_type") or gen_type).strip().lower()
                    else:
                        gen_code = _extract_code_from_raw(raw_content)
                except Exception:
                    gen_code = _extract_code_from_raw(raw_content)
        except Exception:
            gen_name = "Custom Tool"
            gen_desc = "AI-generated tool"
            gen_type = requested_tool_type if requested_tool_type != "auto" else "function"
            gen_code = _extract_code_from_raw(raw_content)
        return gen_name, gen_desc, gen_type, gen_code

    def _validate_generated_code(code: str) -> tuple[bool, str]:
        if not code.strip():
            return False, "Generated code was empty"
        if "def " not in code:
            return False, "Generated code must include at least one function definition"
        try:
            compile(code, "<generated_tool>", "exec")
        except SyntaxError as exc:
            return False, f"Syntax error at line {exc.lineno}: {exc.msg}"
        return True, ""

    try:
        repair_notes: list[str] = []
        for attempt in range(3):
            if attempt > 0:
                feedback = "\n".join(f"- {n}" for n in repair_notes[-2:])
                payload["messages"][1]["content"] = (
                    user_p
                    + "\n\nYour previous output had issues. Return corrected JSON only. "
                    + "Ensure code is complete, includes imports, and compiles.\n"
                    + f"Issues:\n{feedback}"
                )

            async with httpx.AsyncClient(timeout=60.0) as client:
                resp = await client.post("http://localhost:11434/api/chat", json=payload)
            if resp.status_code != 200:
                raise HTTPException(status_code=502, detail=f"Ollama generation failed with status {resp.status_code}")

            data = resp.json()
            raw_content = data.get("message", {}).get("content", "")
            if not raw_content:
                repair_notes.append("Ollama returned empty content")
                continue

            gen_name, gen_desc, gen_type, gen_code = _parse_generated_tool(raw_content)
            if gen_type not in allowed_types[1:]:
                gen_type = "function"

            ok, reason = _validate_generated_code(gen_code)
            if ok:
                return {
                    "name": gen_name,
                    "description": gen_desc,
                    "tool_type": gen_type,
                    "code": gen_code,
                    "model": model,
                }
            repair_notes.append(reason)

        raise HTTPException(
            status_code=502,
            detail=(
                "Failed to generate valid tool code after retries. "
                + " ; ".join(repair_notes[-3:])
            ),
        )
    except HTTPException:
        raise
    except Exception as e:
        import traceback; traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Failed to generate tool spec: {type(e).__name__}: {str(e)}")


@app.get("/v1/models/ollama")
async def list_ollama_models():
    try:
        result = subprocess.run(["ollama", "list"], capture_output=True, text=True, timeout=10)
        if result.returncode != 0:
            return {"models": [], "error": "Ollama not available"}
        models = []
        lines = result.stdout.strip().split("\n")
        if len(lines) > 1:
            header = lines[0]
            id_start = header.find("ID")
            size_start = header.find("SIZE")
            modified_start = header.find("MODIFIED")
            for line in lines[1:]:
                if id_start >= 0 and size_start >= 0 and modified_start >= 0 and len(line) >= modified_start:
                    name = line[:id_start].strip()
                    model_id = line[id_start:size_start].strip()
                    size = line[size_start:modified_start].strip()
                    modified = line[modified_start:].strip()
                else:
                    parts = line.split()
                    if len(parts) < 4:
                        continue
                    name = parts[0]
                    model_id = parts[1]
                    size = " ".join(parts[2:4]) if len(parts) > 4 and parts[3].isalpha() else parts[2]
                    modified = " ".join(parts[4:] if len(parts) > 4 and parts[3].isalpha() else parts[3:])
                if name and model_id:
                    model = {"name": name, "id": model_id, "size": size, "modified": modified}
                    show_result = subprocess.run(["ollama", "show", name], capture_output=True, text=True, timeout=10)
                    if show_result.returncode == 0:
                        section = None
                        capabilities = []
                        details = {}
                        for raw_line in show_result.stdout.splitlines():
                            text = raw_line.strip()
                            if not text:
                                continue
                            if text in {"Model", "Capabilities", "Parameters", "License", "System", "Template"}:
                                section = text
                                continue
                            if section == "Capabilities":
                                capabilities.append(text)
                            elif section == "Model":
                                detail_parts = re.split(r"\s{2,}", text, maxsplit=1)
                                if len(detail_parts) == 2:
                                    details[detail_parts[0].replace(" ", "_")] = detail_parts[1]
                        model.update({
                            "capabilities": capabilities,
                            "architecture": details.get("architecture"),
                            "parameters": details.get("parameters"),
                            "context_length": details.get("context_length"),
                            "embedding_length": details.get("embedding_length"),
                            "quantization": details.get("quantization"),
                        })
                    models.append(model)
        return {"models": models}
    except Exception as e:
        return {"models": [], "error": str(e)}


@app.post("/v1/models/ollama/pull")
async def pull_ollama_model(request: OllamaModelRequest):
    model_name = request.name.strip()
    if not model_name:
        raise HTTPException(status_code=400, detail="Model name is required")
    job_id = str(uuid.uuid4())
    _set_model_pull_job(job_id, job_id=job_id, name=model_name, status="queued", completed=0, total=None, percent=None, done=False, error=None)
    thread = threading.Thread(target=_run_model_pull_job, args=(job_id, model_name), daemon=True)
    thread.start()
    return {"success": True, "job_id": job_id, "name": model_name, "message": f"Started downloading model '{model_name}'."}


@app.get("/v1/models/ollama/pull/{job_id}")
async def get_ollama_model_pull_job(job_id: str):
    with MODEL_PULL_JOBS_LOCK:
        job = MODEL_PULL_JOBS.get(job_id)
        if not job:
            raise HTTPException(status_code=404, detail="Download job not found")
        return dict(job)


@app.delete("/v1/models/ollama")
async def delete_ollama_model(request: OllamaModelRequest):
    model_name = request.name.strip()
    if not model_name:
        raise HTTPException(status_code=400, detail="Model name is required")
    result = subprocess.run(["ollama", "rm", model_name], capture_output=True, text=True, timeout=60)
    if result.returncode != 0:
        raise HTTPException(status_code=502, detail=(result.stderr or result.stdout or "Failed to delete model").strip())
    return {"success": True, "message": f"Model '{model_name}' deleted."}
