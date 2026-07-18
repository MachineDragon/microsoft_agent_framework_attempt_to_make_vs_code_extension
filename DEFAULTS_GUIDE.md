# Default Tools Guide

## Overview

The Custom UI keeps a small set of non-deletable default tools that mirror the official hosted tool constructors exported by Microsoft Agent Framework. These are tool definitions you attach to your own agents; they are not prebuilt default agents.

## Default Tools

### Ollama Code Interpreter

- **UI ID**: `code_interpreter`
- **Framework primitive**: `@ai_function`
- **Purpose**: Lets an Ollama-backed agent execute short Python scripts locally through the Custom UI backend.
- **Important**: This is a local adapter for Ollama. The official hosted provider equivalent is `HostedCodeInterpreterTool`, but that marker only works with capable hosted clients.

```python
from agent_framework import ai_function

@ai_function
def code_interpreter(code: str) -> str:
    """Execute a short Python script locally and return stdout, stderr, and the exit code."""
    ...
```

### HostedWebSearchTool

- **UI ID**: `web_search`
- **Framework class**: `HostedWebSearchTool`
- **Purpose**: Lets a capable hosted AI service perform provider-managed web search.
- **Optional context**: Supports provider-specific additional properties, such as user location.
- **Ollama note**: The Custom UI already has a separate backend web-search route for direct Ollama chat; this hosted marker is for provider-managed clients.

```python
from agent_framework import HostedWebSearchTool

tool = HostedWebSearchTool(
    additional_properties={"user_location": {"city": "Seattle", "country": "US"}}
)
```

### HostedFileSearchTool

- **UI ID**: `file_search`
- **Framework class**: `HostedFileSearchTool`
- **Purpose**: Lets a capable hosted AI service search provider-indexed files or vector stores.
- **Optional inputs**: Supports hosted file and vector-store content references.
- **Ollama note**: A local Ollama agent needs a custom retrieval/vector-search adapter.

```python
from agent_framework import HostedFileSearchTool

tool = HostedFileSearchTool(inputs=[{"vector_store_id": "vs_123"}], max_results=10)
```

### HostedMCPTool

- **UI ID**: `hosted_mcp`
- **Framework class**: `HostedMCPTool`
- **Purpose**: Defines a hosted MCP server connection that is managed and executed by the AI service.
- **Required fields**: `name` and `url`.
- **Optional controls**: `approval_mode`, `allowed_tools`, `headers`, and `description`.
- **Ollama note**: A local Ollama agent needs a local MCP adapter/executor.

```python
from agent_framework import HostedMCPTool

tool = HostedMCPTool(
    name="my_mcp_tool",
    url="https://example.com/mcp",
)
```

## What Is Not A Default Tool

The current default tool list intentionally excludes local UI presets and unverified aliases. For example, there is no separate official `HostedVectorStoreTool` default in the Python Agent Framework source checked here. Vector stores are represented as inputs to `HostedFileSearchTool`.

## Technical Implementation

- Default tools live in `custom-ui/src/stores/toolStore.ts`.
- They are always re-injected during persisted store hydration.
- Default tools cannot be edited or deleted from the UI.
- User-created tools remain separate under `Your Tools`.
