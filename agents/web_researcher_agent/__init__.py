"""Web Researcher Agent — searches the web and fetches page content.

Equivalent to an AutoGen agent with web browsing capabilities. Use it in a
team alongside a Planner to research topics, find documentation, or gather
up-to-date information before writing code or reports.

Tools:
  web_search — search the web via DuckDuckGo (no API key needed)
  web_fetch  — fetch and extract text from any public URL
"""
import os
import urllib.parse
import urllib.request
from typing import Annotated

from agent_framework import ChatAgent, ai_function
from agent_framework.openai import OpenAIChatClient

_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0 Safari/537.36"
    )
}

# ── Tools ────────────────────────────────────────────────────────────────────

@ai_function
def web_search(
    query: Annotated[str, "Search query string."],
    max_results: Annotated[int, "Maximum number of results to return. Default 8."] = 8,
) -> str:
    """Search the web using DuckDuckGo and return titles, URLs, and snippets."""
    try:
        import json as _json
        encoded = urllib.parse.urlencode({"q": query, "format": "json", "no_html": "1", "no_redirect": "1"})
        url = f"https://api.duckduckgo.com/?{encoded}"
        req = urllib.request.Request(url, headers=_HEADERS)
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = _json.loads(resp.read().decode("utf-8", errors="replace"))

        results = []
        # Instant answer
        if data.get("AbstractText"):
            results.append(f"[Answer] {data['AbstractText']}\nSource: {data.get('AbstractURL', '')}")

        # Related topics
        for topic in data.get("RelatedTopics", [])[:max_results]:
            if isinstance(topic, dict) and topic.get("Text") and topic.get("FirstURL"):
                results.append(f"- {topic['Text']}\n  URL: {topic['FirstURL']}")

        if not results:
            return f"No results found for: '{query}'. Try a more specific query."
        return f"Search results for '{query}':\n\n" + "\n\n".join(results[:max_results])
    except Exception as exc:
        return f"web_search error: {type(exc).__name__}: {exc}"


@ai_function
def web_fetch(
    url: Annotated[str, "Public HTTP/HTTPS URL to fetch content from."],
    max_chars: Annotated[int, "Maximum characters to return. Default 12000."] = 12000,
) -> str:
    """Fetch the text content of a public web page."""
    try:
        if not url.startswith(("http://", "https://")):
            return "web_fetch: URL must start with http:// or https://"
        req = urllib.request.Request(url, headers=_HEADERS)
        with urllib.request.urlopen(req, timeout=20) as resp:
            raw = resp.read(1024 * 1024)  # max 1 MB
            content_type = resp.headers.get("Content-Type", "")

        text = raw.decode("utf-8", errors="replace")

        # Strip HTML tags with a simple approach
        if "html" in content_type.lower() or text.strip().startswith("<"):
            import re
            text = re.sub(r"<style[^>]*>.*?</style>", "", text, flags=re.DOTALL | re.IGNORECASE)
            text = re.sub(r"<script[^>]*>.*?</script>", "", text, flags=re.DOTALL | re.IGNORECASE)
            text = re.sub(r"<[^>]+>", " ", text)
            text = re.sub(r"[ \t]{2,}", " ", text)
            text = re.sub(r"\n{3,}", "\n\n", text)
            text = text.strip()

        if len(text) > max_chars:
            return text[:max_chars] + f"\n\n[Truncated — {len(text)} total chars]"
        return text or "(empty response)"
    except Exception as exc:
        return f"web_fetch error: {type(exc).__name__}: {exc}"


# ── Agent ────────────────────────────────────────────────────────────────────

_model = os.getenv("OLLAMA_MODEL") or "qwen2.5:7b"

agent = ChatAgent(
    chat_client=OpenAIChatClient(
        api_key="ollama",
        base_url=os.getenv("OLLAMA_ENDPOINT", "http://localhost:11434/v1/"),
        model_id=_model,
    ),
    name="Web Researcher",
    description=(
        "Searches the web and reads web pages. Use it when you need current information, "
        "documentation, or research before writing code or a report."
    ),
    instructions="""/no_think
You are a web research agent. Your job is to find accurate, current information.

Workflow:
1. Use web_search to find relevant URLs for the query.
2. Use web_fetch to read the most relevant page(s) in full.
3. Synthesise the information into a clear, structured summary.
4. Always cite your sources (URL + title).

Rules:
- Do NOT invent or hallucinate facts — only report what you actually retrieved.
- If search returns no results, try a rephrased query.
- For code documentation, prefer official docs over blog posts.
- Include relevant code examples if found on the page.
- Keep summaries concise but complete.""",
    tools=[web_search, web_fetch],
)
