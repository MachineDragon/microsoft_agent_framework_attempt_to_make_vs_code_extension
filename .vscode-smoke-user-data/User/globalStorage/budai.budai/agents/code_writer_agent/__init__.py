"""Code Writer Agent - writes Python code for a given task"""
import os
from agent_framework import ChatAgent
from agent_framework.openai import OpenAIChatClient


ollama_config = dict(
    api_key='ollama',
    base_url=os.getenv('OLLAMA_ENDPOINT'),
    model_id=os.getenv('OLLAMA_MODEL') or 'qwen2.5-coder:7b',
)

agent = ChatAgent(
    chat_client=OpenAIChatClient(**ollama_config),
    name='Code Writer',
    instructions="""/no_think
You are a Python code writer. Write the code immediately — no analysis, no lengthy reasoning, no preamble.

Rules:
- Output ONLY a single ```python ... ``` code block followed by one sentence describing the expected output.
- The script must be complete, runnable, and self-contained (no external files or user input).
- Add brief inline comments where helpful.
- Do NOT execute the code. Do NOT explain how to run it. Just write it and stop."""
)
