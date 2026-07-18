
# Microsoft Agent Framework - Overview & Key Features

Microsoft Agent Framework is an open-source development kit for building AI agents and multi-agent workflows in .NET and Python. It unifies and extends ideas from Semantic Kernel and AutoGen, providing a robust foundation for building interactive, robust, and safe AI applications.

## Core Capabilities

- **AI Agents:**
	- Individual agents powered by LLMs to process user input, call tools and MCP servers, and generate responses.
	- Support for Azure OpenAI, OpenAI, Azure AI, and more.
	- Agents can be enhanced with threads (for state), context providers (for memory), and middleware.

- **Workflows:**
	- Graph-based orchestration connecting multiple agents and functions for complex, multi-step tasks.
	- Supports type-based routing, nesting, checkpointing, and human-in-the-loop request/response patterns.
	- Enables modular, composable, and scalable multi-agent solutions.

## Why Use Agent Framework?

- Combines the best of Semantic Kernel (enterprise features, state management, type safety, telemetry) and AutoGen (simple abstractions for single/multi-agent patterns).
- Introduces explicit workflow control, robust state management, and advanced orchestration for long-running and human-in-the-loop scenarios.
- Highly extensible and open to community contributions.

## When to Use

- **Best for:**
	- Applications needing autonomous decision-making, ad hoc planning, or conversation-based user interactions.
	- Scenarios where the task is dynamic, underspecified, or requires exploration (e.g., customer support, tutoring, code generation, research assistance).
- **Not ideal for:**
	- Highly structured, rule-based tasks with a fixed sequence (use a function instead).
	- Single agents managing very large toolsets (use workflows for multi-agent orchestration).

## Installation

- **Python:** `pip install agent-framework`
- **.NET:** `dotnet add package Microsoft.Agents.AI`


# Key Features
## Multi-Turn Conversations & Threading
- Built-in support for managing multi-turn conversations with AI agents.
- Maintains context across multiple interactions using AgentThread objects.
- Supports both in-memory and persistent (service-managed) conversation history.
- AgentThread can be serialized/deserialized for context persistence across sessions.
- Threading model is abstracted, providing a consistent interface regardless of backend (OpenAI, Foundry, etc.).

## Agent Memory
- Supports both short-term (chat history) and long-term memory.
- In-memory chat history for services that don't support persistent storage.
- In-service storage for services like Azure AI Foundry.
- Custom ChatMessageStore support for 3rd party or external storage.
- Memory reducers can be configured to manage context window size.
- Long-term memory via custom AIContextProvider components for extracting/injecting memories.

## Agent Middleware
- Powerful middleware system for cross-cutting concerns (logging, security, error handling, etc.).
- Three types: Agent Run Middleware, Function Calling Middleware, IChatClient Middleware.
- Middleware can inspect/modify input/output at various stages of agent execution.
- Middleware is chainable and can be registered per agent or per chat client.

## Agent Tools & Function Calling
- Agents can be equipped with tools (functions) for enhanced capabilities.
- Supports function calling and function calling middleware for advanced workflows.

## Retrieval Augmented Generation (RAG)
- Built-in support for RAG, allowing agents to retrieve and use external knowledge sources.

## Observability
- Integrated observability features for tracing, logging, and debugging agent runs.
- Supports event streaming and inspection of agent execution timelines.

## Background Responses
- Agents can provide background responses, enabling asynchronous workflows.

## Extensibility
- Highly extensible via custom memory, middleware, and storage components.
- Works with multiple backends (OpenAI, Azure, Foundry, etc.) with a unified API.

## .NET and Python Support
- Full API reference and support for both .NET and Python.

---

For more details, see the official documentation and API references.
