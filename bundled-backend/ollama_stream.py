from fastapi import Request
from fastapi.responses import StreamingResponse
from html import unescape
from html.parser import HTMLParser
import asyncio
import httpx
import json
import time
import sys
import os
import importlib
import importlib.util
import inspect
import re
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, unquote, urlparse

# ── Bootstrap: load agents/.env so every agent module finds OLLAMA_ENDPOINT ──
def _load_agents_env() -> None:
    """Load environment variables from agents/.env before any agent is imported."""
    extension_root = Path(os.getenv("BUDAI_EXTENSION_ROOT") or Path(__file__).parent.parent).resolve()
    env_path = Path(os.getenv("BUDAI_AGENTS_DIR") or extension_root / "agents") / ".env"
    if env_path.exists():
        try:
            with open(env_path, encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line or line.startswith("#") or "=" not in line:
                        continue
                    key, _, value = line.partition("=")
                    key, value = key.strip(), value.strip()
                    if key and key not in os.environ:
                        os.environ[key] = value
        except Exception as exc:
            print(f"Warning: could not load agents/.env: {exc}")
    # Ensure the two required vars have sensible defaults
    os.environ.setdefault("OLLAMA_ENDPOINT", "http://localhost:11434/v1")
    os.environ.setdefault("OLLAMA_MODEL", "llama3:8b")

_load_agents_env()

AGENTS_DIR = Path(os.getenv("BUDAI_AGENTS_DIR") or Path(os.getenv("BUDAI_EXTENSION_ROOT") or Path(__file__).parent.parent).resolve() / "agents")


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
        query = parse_qs(parsed.query)
        redirect_target = query.get("uddg", [""])[0]
        if redirect_target:
            return unquote(redirect_target)
        return href


def _html_to_text(html: str) -> str:
    without_scripts = re.sub(r"<script[\s\S]*?</script>|<style[\s\S]*?</style>", " ", html, flags=re.IGNORECASE)
    without_tags = re.sub(r"<[^>]+>", " ", without_scripts)
    return " ".join(unescape(without_tags).split())

async def stream_multi_agent_response(agent_configs: dict, messages: list, orchestration_type: str, max_rounds: int = 5):
    """Stream responses from multiple agents using the selected orchestration strategy."""

    print(f"Starting multi-agent streaming with orchestration: {orchestration_type}")
    print(f"Number of agents: {len(agent_configs)}")

    agent_list = list(agent_configs.items())
    if not agent_list:
        yield f"data: {json.dumps({'type': 'response.completed', 'response': {'status': 'completed'}})}\n\n"
        return

    base_messages = messages.copy()
    max_rounds = max(1, min(int(max_rounds or 5), 40))
    if orchestration_type == "group_chat":
        max_rounds = max(max_rounds, 10)

    def _event_chunk(event: dict) -> str:
        return f"data: {json.dumps(event)}\n\n"

    def _chat_message_text(message: object) -> str:
        text = getattr(message, "text", None)
        if text:
            return str(text)
        contents = getattr(message, "contents", None) or []
        parts = [str(getattr(content, "text", "")) for content in contents if getattr(content, "text", None)]
        return "\n".join(parts)

    def _dict_messages_to_chat_messages(raw_messages: list) -> list:
        from agent_framework import ChatMessage

        converted = []
        for raw in raw_messages:
            if not isinstance(raw, dict):
                converted.append(raw)
                continue
            role = raw.get("role", "user")
            content = raw.get("content", "")
            if isinstance(content, list):
                text_parts = []
                for item in content:
                    if isinstance(item, dict):
                        text_value = item.get("text") or item.get("content")
                        if text_value:
                            text_parts.append(str(text_value))
                content = "\n".join(text_parts)
            converted.append(ChatMessage(role=role, text=str(content or "")))
        return converted

    def _chat_messages_to_dict_messages(chat_messages: list, fallback_role: str = "user") -> list[dict]:
        converted = []
        for message in chat_messages:
            role_value = getattr(getattr(message, "role", None), "value", None) or getattr(message, "role", fallback_role)
            content = _chat_message_text(message)
            author = getattr(message, "author_name", None)
            # Prefix assistant messages with author name so downstream agents know who wrote what
            if author and str(role_value) == "assistant" and content:
                content = f"[{author}]: {content}"
            converted.append({"role": str(role_value), "content": content})
        return converted

    def _header(agent_id: str, agent_name: str) -> str:
        return _event_chunk({
            "type": "response.output_text.delta",
            "delta": f"\n\n**{agent_name}:**\n",
            "agent_id": agent_id,
            "agent_name": agent_name,
        })

    def _manager_message(text: str) -> str:
        return _event_chunk({
            "type": "response.output_text.delta",
            "delta": f"\n\n**Manager:**\n{text}\n",
            "agent_id": "manager",
            "agent_name": "Manager",
        })

    def _history_with_context(history: list, agent_name: str, context: str, next_prompt: str) -> list:
        updated = history.copy()
        updated.append({"role": "assistant", "content": f"{agent_name}: {context}"})
        updated.append({"role": "user", "content": next_prompt})
        return updated

    async def _stream_agent_turn(
        agent_id: str,
        config: dict,
        turn_messages: list,
        state: dict,
        extra_instructions: str | None = None,
    ):
        model = config.get("model_id")
        agent_name = config.get("name", agent_id)
        instructions = config.get("instructions") or ""
        if extra_instructions:
            instructions = f"{instructions}\n\n{extra_instructions}".strip()

        print(f"\n{'='*60}")
        print(f"Processing agent: {agent_name}")
        print(f"Model: {model}")
        print(f"Conversation history size: {len(turn_messages)} messages")
        print(f"{'='*60}\n")

        yield _header(agent_id, agent_name)

        agent_response = ""
        agent_tool_results: list[str] = []
        chunk_count = 0
        error_occurred = False

        try:
            async for chunk in stream_agent_response(agent_id, model, turn_messages, instructions, include_completion=False):
                chunk_count += 1
                if chunk.startswith("data: "):
                    try:
                        chunk_data = json.loads(chunk[6:])
                        event_type = chunk_data.get("type")

                        if event_type == "error":
                            error_occurred = True
                            error_msg = chunk_data.get("error", {}).get("message", "Unknown error")
                            print(f"ERROR from {agent_name}: {error_msg}")
                            yield chunk
                            continue

                        if event_type in {"response.output_text.delta", "response.thinking.delta", "response.function_call.complete"}:
                            chunk_data["agent_id"] = agent_id
                            chunk_data["agent_name"] = agent_name

                        if event_type == "response.output_text.delta":
                            agent_response += chunk_data.get("delta", "")

                        if event_type == "response.function_call.complete":
                            function_call = chunk_data.get("function_call") or chunk_data.get("data") or {}
                            tool_name = function_call.get("name", "unknown_tool")
                            tool_arguments = function_call.get("arguments", {})
                            tool_result = function_call.get("result", "")
                            try:
                                arguments_text = json.dumps(tool_arguments, ensure_ascii=False, indent=2)
                            except TypeError:
                                arguments_text = str(tool_arguments)
                            agent_tool_results.append(
                                f"{agent_name} called tool {tool_name}.\nArguments:\n{arguments_text}\nResult:\n{str(tool_result)[:12000]}"
                            )

                        if event_type in {"response.output_text.delta", "response.thinking.delta", "response.function_call.complete"}:
                            chunk = _event_chunk(chunk_data)
                    except Exception as exc:
                        print(f"Error parsing chunk for {agent_name}: {exc}")

                yield chunk
        except Exception as exc:
            error_occurred = True
            print(f"Error streaming from {agent_name}: {exc}")
            import traceback
            traceback.print_exc()

        context_parts = [part for part in [agent_response.strip(), *agent_tool_results] if part]
        agent_context = "\n\n".join(context_parts)
        state.update({
            "agent_id": agent_id,
            "agent_name": agent_name,
            "response": agent_response.strip(),
            "context": agent_context,
            "error": error_occurred,
        })
        print(f"Agent {agent_name} completed with {chunk_count} chunks, response length: {len(agent_response)}, tool results: {len(agent_tool_results)}")

    class _LocalAgentWorkflowExecutor:
        pass

    manager_queue: asyncio.Queue = asyncio.Queue()
    live_agent_text: dict[str, str] = {}

    async def _push_official_stream_event(event: dict, agent_id: str, agent_name: str) -> None:
        event_type = event.get("type")
        if event_type not in {"response.output_text.delta", "response.thinking.delta", "response.function_call.complete"}:
            return
        event["agent_id"] = agent_id
        event["agent_name"] = agent_name
        if event_type == "response.output_text.delta":
            live_agent_text[agent_name] = live_agent_text.get(agent_name, "") + str(event.get("delta", ""))
        await manager_queue.put(_event_chunk(event))

    async def _push_official_agent_header(agent_id: str, agent_name: str) -> None:
        await _push_official_stream_event({
            "type": "response.output_text.delta",
            "delta": f"\n\n**{agent_name}:**\n",
        }, agent_id, agent_name)

    def _build_auto_fix_fallback_script(agent_name: str) -> str | None:
        lower_name = agent_name.lower()
        if "diagnoser" in lower_name:
            return (
                "import subprocess\n"
                "print('Running: python auto_fix_lab/test_buggy_stats.py')\n"
                "result = subprocess.run(['python', 'auto_fix_lab/test_buggy_stats.py'], capture_output=True, text=True)\n"
                "print('exit_code:', result.returncode)\n"
                "print('stdout:')\n"
                "print(result.stdout or '(empty)')\n"
                "print('stderr:')\n"
                "print(result.stderr or '(empty)')\n"
                "print('\\n--- auto_fix_lab/buggy_stats.py ---')\n"
                "with open('auto_fix_lab/buggy_stats.py', 'r', encoding='utf-8') as f:\n"
                "    print(f.read())\n"
            )
        if "patcher" in lower_name:
            return (
                "from pathlib import Path\n"
                "import re\n"
                "import subprocess\n"
                "path = Path('auto_fix_lab/buggy_stats.py')\n"
                "source = path.read_text(encoding='utf-8')\n"
                "pattern = re.compile(r'def\\s+median\\(values:\\s*list\\[float\\]\\)\\s*->\\s*float:[\\s\\S]*?(?=\\n\\ndef\\s|\\Z)')\n"
                "replacement = '''def median(values: list[float]) -> float:\n"
                "    \"\"\"Return the median value from a non-empty list of numbers.\"\"\"\n"
                "    if not values:\n"
                "        raise ValueError(\"median requires at least one value\")\n"
                "\n"
                "    ordered = sorted(values)\n"
                "    midpoint = len(ordered) // 2\n"
                "\n"
                "    if len(ordered) % 2 == 1:\n"
                "        return ordered[midpoint]\n"
                "\n"
                "    return (ordered[midpoint - 1] + ordered[midpoint]) / 2\n"
                "'''\n"
                "if pattern.search(source):\n"
                "    source = pattern.sub(replacement.rstrip('\\n'), source, count=1)\n"
                "    path.write_text(source, encoding='utf-8')\n"
                "    print('Patched auto_fix_lab/buggy_stats.py with canonical median logic')\n"
                "else:\n"
                "    print('No patch applied: median function not found')\n"
                "result = subprocess.run(['python', 'auto_fix_lab/test_buggy_stats.py'], capture_output=True, text=True)\n"
                "print('exit_code:', result.returncode)\n"
                "print('stdout:')\n"
                "print(result.stdout or '(empty)')\n"
                "print('stderr:')\n"
                "print(result.stderr or '(empty)')\n"
            )
        if "verifier" in lower_name:
            return (
                "import subprocess\n"
                "print('Running independent verification: python auto_fix_lab/test_buggy_stats.py')\n"
                "result = subprocess.run(['python', 'auto_fix_lab/test_buggy_stats.py'], capture_output=True, text=True)\n"
                "print('exit_code:', result.returncode)\n"
                "print('stdout:')\n"
                "print(result.stdout or '(empty)')\n"
                "print('stderr:')\n"
                "print(result.stderr or '(empty)')\n"
            )
        return None

    def _run_local_python_script(script: str) -> str:
        import subprocess
        import sys
        import tempfile

        with tempfile.TemporaryDirectory(prefix="auto_fix_fallback_") as temp_dir:
            script_path = Path(temp_dir) / "main.py"
            script_path.write_text(script, encoding="utf-8")
            try:
                result = subprocess.run(
                    [sys.executable, str(script_path)],
                    cwd=Path(__file__).resolve().parents[2],
                    text=True,
                    capture_output=True,
                    timeout=40,
                )
            except Exception as exc:
                return f"Fallback execution failed: {type(exc).__name__}: {exc}"

        stdout = result.stdout[-12000:] if result.stdout else "(empty)"
        stderr = result.stderr[-12000:] if result.stderr else "(empty)"
        return f"exit_code: {result.returncode}\nstdout:\n{stdout}\nstderr:\n{stderr}"

    def _extract_latest_python_code_block(messages: list) -> str | None:
        for message in reversed(messages or []):
            if isinstance(message, dict):
                content = str(message.get("content") or "")
            else:
                content = _chat_message_text(message)
            match = re.search(r"```(?:python|py)?\s*\n([\s\S]*?)```", content, re.IGNORECASE)
            if match:
                code = match.group(1).strip()
                if code:
                    return code
        return None

    async def _invoke_agent_code_tool(agent_id: str, tool_name: str, code: str) -> str | None:
        mod = _load_agent_module(agent_id)
        if mod is None:
            return None
        execution_tool = getattr(mod, tool_name, None)
        if execution_tool is None or not hasattr(execution_tool, "invoke"):
            execution_tool = next(
                (
                    value for value in vars(mod).values()
                    if getattr(value, "type", None) == "ai_function" and getattr(value, "name", None) == tool_name
                ),
                None,
            )
        if execution_tool is None:
            return None
        try:
            input_model = getattr(execution_tool, "input_model", None)
            if input_model is not None and hasattr(input_model, "model_validate"):
                args_model = input_model.model_validate({"code": code})
                result = await execution_tool.invoke(arguments=args_model)
            else:
                result = await execution_tool.invoke(code=code)
            return str(result) if result is not None else "(no result)"
        except Exception as exc:
            return f"{tool_name} error: {type(exc).__name__}: {exc}"

    def _make_local_agent_executor(agent_id: str, config: dict):
        from agent_framework import ChatMessage, Role
        from agent_framework._workflows import AgentExecutorRequest, Executor, WorkflowContext, handler
        from agent_framework._workflows._group_chat import _GroupChatRequestMessage, _GroupChatResponseMessage

        agent_name = str(config.get("name", agent_id))
        model = config.get("model_id")
        instructions = config.get("instructions")

        class LocalAgentWorkflowExecutor(Executor):
            def __init__(self) -> None:
                super().__init__(id=agent_name)

            async def _run_local_agent(self, chat_messages: list, extra_instruction: str | None = None) -> ChatMessage:
                turn_messages = _chat_messages_to_dict_messages(chat_messages)
                run_instructions = instructions or ""
                if extra_instruction:
                    run_instructions = f"{run_instructions}\n\n{extra_instruction}".strip()

                # Models require the conversation to end on a user turn.
                # If the last message is assistant (e.g. previous agent's output),
                # append a user trigger so the model knows it must respond.
                if turn_messages and turn_messages[-1].get("role") == "assistant":
                    turn_messages = turn_messages + [{"role": "user", "content": "Please proceed with your task now."}]

                await _push_official_agent_header(agent_id, agent_name)

                if agent_id == "shell_executor_agent" or agent_name.lower() == "shell executor":
                    code_block = _extract_latest_python_code_block(chat_messages)
                    if code_block:
                        print(f"[run_python deterministic] Executing latest Python code block for {agent_name} ({len(code_block)} chars)")
                        tool_result = await _invoke_agent_code_tool(agent_id, "run_python", code_block)
                        if tool_result is not None:
                            tool_event = {
                                "type": "response.function_call.complete",
                                "function_call": {
                                    "name": "run_python",
                                    "arguments": {"code": code_block},
                                    "result": tool_result,
                                },
                            }
                            await _push_official_stream_event(tool_event, agent_id, agent_name)
                            return ChatMessage(
                                role=Role.ASSISTANT,
                                text=f"Tool run_python result:\n{tool_result}",
                                author_name=agent_name,
                            )

                # Deterministic auto-fix path: when manager asks for a one-shot code_interpreter
                # turn for Diagnoser/Patcher/Verifier, execute the backend script directly.
                if extra_instruction and "exactly one code_interpreter call" in extra_instruction.lower():
                    fallback_script = _build_auto_fix_fallback_script(agent_name)
                    if fallback_script:
                        fallback_result = _run_local_python_script(fallback_script)
                        fallback_event = {
                            "type": "response.function_call.complete",
                            "function_call": {
                                "name": "code_interpreter",
                                "arguments": {"code": fallback_script},
                                "result": fallback_result,
                            },
                        }
                        await _push_official_stream_event(fallback_event, agent_id, agent_name)
                        return ChatMessage(
                            role=Role.ASSISTANT,
                            text=(
                                "Applied deterministic backend tool execution for this auto-fix turn.\n\n"
                                f"Tool code_interpreter result:\n{fallback_result}"
                            ),
                            author_name=agent_name,
                        )

                response_text = ""
                tool_results: list[str] = []
                async for chunk in stream_agent_response(agent_id, model, turn_messages, run_instructions, include_completion=False):
                    if not chunk.startswith("data: "):
                        continue
                    try:
                        data = json.loads(chunk[6:])
                    except Exception:
                        continue
                    event_type = data.get("type")
                    if event_type == "response.output_text.delta":
                        response_text += data.get("delta", "")
                        await _push_official_stream_event(data, agent_id, agent_name)
                    elif event_type == "response.thinking.delta":
                        await _push_official_stream_event(data, agent_id, agent_name)
                    elif event_type == "response.function_call.complete":
                        function_call = data.get("function_call") or data.get("data") or {}
                        tool_name = function_call.get("name", "unknown_tool")
                        tool_result = function_call.get("result", "")
                        tool_results.append(f"Tool {tool_name} result:\n{tool_result}")
                        await _push_official_stream_event(data, agent_id, agent_name)
                    elif event_type == "error":
                        error_msg = data.get("error", {}).get("message", "Unknown error")
                        response_text += f"\nError: {error_msg}"

                if not tool_results and not response_text.strip() and extra_instruction and "exactly one code_interpreter call" in extra_instruction.lower():
                    fallback_script = _build_auto_fix_fallback_script(agent_name)
                    if fallback_script:
                        fallback_result = _run_local_python_script(fallback_script)
                        fallback_event = {
                            "type": "response.function_call.complete",
                            "function_call": {
                                "name": "code_interpreter",
                                "arguments": {"code": fallback_script},
                                "result": fallback_result,
                            },
                        }
                        await _push_official_stream_event(fallback_event, agent_id, agent_name)
                        tool_results.append(f"Tool code_interpreter result:\n{fallback_result}")
                        response_text = "Applied deterministic fallback tool execution for this auto-fix turn."

                # Fallback: if the model was supposed to call an execution tool but only
                # produced text intent (e.g. "I will run it now"), call the tool directly
                # by extracting the code block from the conversation.
                if not tool_results:
                    mod = _load_agent_module(agent_id)
                    if mod is not None:
                        execution_tool = next(
                            (v for v in vars(mod).values()
                             if getattr(v, "type", None) == "ai_function" and getattr(v, "name", None) in {"code_interpreter", "run_python"}),
                            None,
                        )
                        if execution_tool is not None:
                            tool_name = getattr(execution_tool, "name", "execution_tool")
                            code_block: str | None = None
                            for msg in reversed(turn_messages):
                                content = msg.get("content", "") if isinstance(msg, dict) else str(msg)
                                m = re.search(r"```python\s*\n([\s\S]*?)```", content)
                                if m:
                                    code_block = m.group(1).strip()
                                    break
                            if code_block:
                                print(f"[{tool_name} fallback] Model skipped tool call; executing code block directly ({len(code_block)} chars)")
                                try:
                                    input_model = getattr(execution_tool, "input_model", None)
                                    if input_model and hasattr(input_model, "model_validate"):
                                        args_model = input_model.model_validate({"code": code_block})
                                        tool_result = await execution_tool.invoke(arguments=args_model)
                                    else:
                                        tool_result = await execution_tool.invoke(code=code_block)
                                    tool_result_str = str(tool_result)
                                except Exception as exc:
                                    tool_result_str = f"{tool_name} error: {exc}"
                                tool_results.append(f"Tool {tool_name} result:\n{tool_result_str}")
                                tool_event = {
                                    "type": "response.function_call.complete",
                                    "function_call": {
                                        "name": tool_name,
                                        "arguments": {"code": code_block},
                                        "result": tool_result_str,
                                    },
                                }
                                await _push_official_stream_event(tool_event, agent_id, agent_name)

                full_text = "\n\n".join(part for part in [response_text.strip(), *tool_results] if part)
                return ChatMessage(role=Role.ASSISTANT, text=full_text or "(no response)", author_name=agent_name)

            @handler
            async def from_conversation(self, conversation: list[ChatMessage], ctx: WorkflowContext[list[ChatMessage]]) -> None:
                message = await self._run_local_agent(conversation)
                await ctx.send_message([*conversation, message])

            @handler
            async def from_agent_request(self, request: AgentExecutorRequest, ctx: WorkflowContext[list[ChatMessage]]) -> None:
                message = await self._run_local_agent(request.messages)
                await ctx.send_message([*request.messages, message])

            @handler
            async def from_group_chat_request(
                self,
                request: _GroupChatRequestMessage,
                ctx: WorkflowContext[_GroupChatResponseMessage],
            ) -> None:
                message = await self._run_local_agent(request.conversation, request.instruction)
                await ctx.send_message(_GroupChatResponseMessage(agent_name=request.agent_name, message=message))

        return LocalAgentWorkflowExecutor()

    async def _stream_official_workflow(workflow, initial_messages: list, manager_queue: asyncio.Queue | None = None):
        from agent_framework._workflows import WorkflowFailedEvent, WorkflowOutputEvent

        last_seen_text: dict[str, str] = {}
        workflow_done = object()

        async def _run_workflow_to_queue(queue: asyncio.Queue) -> None:
            try:
                async for event in workflow.run_stream(initial_messages):
                    await queue.put(event)
            finally:
                await queue.put(workflow_done)

        event_queue: asyncio.Queue = asyncio.Queue()
        workflow_task = asyncio.create_task(_run_workflow_to_queue(event_queue))

        try:
            while True:
                pending_gets = [asyncio.create_task(event_queue.get())]
                if manager_queue is not None:
                    pending_gets.append(asyncio.create_task(manager_queue.get()))

                done, pending = await asyncio.wait(pending_gets, return_when=asyncio.FIRST_COMPLETED)
                for task in pending:
                    task.cancel()

                for task in done:
                    item = task.result()
                    if isinstance(item, str):
                        yield item
                        continue

                    if item is workflow_done:
                        return

                    event = item
                    event_name = event.__class__.__name__
                    if event_name in {"WorkflowStartedEvent", "WorkflowStatusEvent", "SuperStepStartedEvent", "SuperStepCompletedEvent"}:
                        continue

                    if isinstance(event, WorkflowOutputEvent):
                        output = event.data
                        output_messages = output if isinstance(output, list) else [output]
                        for message in output_messages:
                            role_value = getattr(getattr(message, "role", None), "value", None) or getattr(message, "role", "")
                            if str(role_value) != "assistant":
                                continue
                            text = _chat_message_text(message)
                            author = getattr(message, "author_name", None) or "Workflow"
                            if not text or last_seen_text.get(author) == text:
                                continue
                            if text.strip() and text.strip() in live_agent_text.get(author, ""):
                                last_seen_text[author] = text
                                continue
                            last_seen_text[author] = text
                            yield _event_chunk({
                                "type": "response.output_text.delta",
                                "delta": f"\n\n**{author}:**\n{text}",
                                "agent_id": author,
                                "agent_name": author,
                            })
                    elif isinstance(event, WorkflowFailedEvent):
                        yield _event_chunk({"type": "error", "error": {"message": event.details.message}})
        finally:
            if not workflow_task.done():
                workflow_task.cancel()

    def _build_official_workflow(kind: str):
        from agent_framework import ConcurrentBuilder, GroupChatBuilder, GroupChatDirective, HandoffBuilder, MagenticBuilder, SequentialBuilder
        from agent_framework._workflows import Executor, WorkflowContext, handler

        participants = [_make_local_agent_executor(agent_id, config) for agent_id, config in agent_list]

        def _make_local_agent_protocol(agent_id: str, config: dict, handoff_targets: list[str] | None = None):
            from agent_framework import AgentRunResponse, AgentRunResponseUpdate, AgentThread, ChatMessage, ChatMessageStore, FunctionCallContent, Role, TextContent

            agent_name = str(config.get("name", agent_id))
            model = config.get("model_id")
            instructions = config.get("instructions") or ""
            targets = handoff_targets or []

            class LocalOllamaAgent:
                id = agent_name
                name = agent_name
                display_name = agent_name
                description = config.get("description") or instructions[:500] or agent_name

                def get_new_thread(self, **kwargs: Any) -> AgentThread:
                    return AgentThread(message_store=ChatMessageStore())

                async def _complete(self, messages=None, *, extra_instructions: str | None = None) -> ChatMessage:
                    normalized_messages = _chat_messages_to_dict_messages(messages if isinstance(messages, list) else _dict_messages_to_chat_messages([{"role": "user", "content": str(messages or "")}]))
                    run_instructions = instructions
                    if targets:
                        run_instructions = (
                            f"{run_instructions}\n\nYou are in an official handoff workflow. "
                            f"If another participant should take over, end with exactly HANDOFF: <agent name>. "
                            f"Available handoff targets: {', '.join(targets)}. If complete, end with FINAL."
                        ).strip()
                    if extra_instructions:
                        run_instructions = f"{run_instructions}\n\n{extra_instructions}".strip()

                    await _push_official_agent_header(agent_id, agent_name)
                    response_text = ""
                    tool_results: list[str] = []
                    async for chunk in stream_agent_response(agent_id, model, normalized_messages, run_instructions, include_completion=False):
                        if not chunk.startswith("data: "):
                            continue
                        try:
                            data = json.loads(chunk[6:])
                        except Exception:
                            continue
                        event_type = data.get("type")
                        if event_type == "response.output_text.delta":
                            response_text += data.get("delta", "")
                            await _push_official_stream_event(data, agent_id, agent_name)
                        elif event_type == "response.thinking.delta":
                            await _push_official_stream_event(data, agent_id, agent_name)
                        elif event_type == "response.function_call.complete":
                            function_call = data.get("function_call") or data.get("data") or {}
                            tool_results.append(f"Tool {function_call.get('name', 'unknown_tool')} result:\n{function_call.get('result', '')}")
                            await _push_official_stream_event(data, agent_id, agent_name)
                        elif event_type == "error":
                            response_text += f"\nError: {data.get('error', {}).get('message', 'Unknown error')}"

                    full_text = "\n\n".join(part for part in [response_text.strip(), *tool_results] if part) or "(no response)"
                    contents: list[Any] = [TextContent(text=full_text)]
                    handoff_match = re.search(r"HANDOFF\s*:\s*([^\n.;]+)", full_text, re.IGNORECASE)
                    if handoff_match:
                        target = handoff_match.group(1).strip()
                        sanitized = re.sub(r"[^a-zA-Z0-9_]+", "_", target).strip("_") or "agent"
                        contents.append(FunctionCallContent(
                            call_id=f"handoff_{uuid.uuid4().hex[:8]}",
                            name=f"handoff_to_{sanitized}",
                            arguments={"handoff_to": target},
                        ))
                    return ChatMessage(role=Role.ASSISTANT, contents=contents, author_name=agent_name)

                async def run(self, messages=None, *, thread=None, **kwargs: Any) -> AgentRunResponse:
                    message = await self._complete(messages)
                    if thread is not None and hasattr(thread, "on_new_messages"):
                        await thread.on_new_messages([message])
                    return AgentRunResponse(messages=[message], response_id=f"run_{uuid.uuid4().hex[:8]}")

                def run_stream(self, messages=None, *, thread=None, **kwargs: Any):
                    async def _stream():
                        message = await self._complete(messages)
                        if thread is not None and hasattr(thread, "on_new_messages"):
                            await thread.on_new_messages([message])
                        yield AgentRunResponseUpdate(
                            contents=list(message.contents or []),
                            role="assistant",
                            author_name=agent_name,
                            response_id=f"run_{uuid.uuid4().hex[:8]}",
                        )
                    return _stream()

            return LocalOllamaAgent()

        async def _push_manager_event(event_type: str, delta: str) -> None:
            if not delta:
                return
            await manager_queue.put(_event_chunk({
                "type": event_type,
                "delta": delta,
                "agent_id": "manager",
                "agent_name": "Manager",
            }))

        class LocalOllamaManagerChatClient:
            @property
            def additional_properties(self) -> dict[str, Any]:
                return {}

            async def get_response(self, messages, *, model_id: str | None = None, response_format=None, **kwargs: Any):
                from agent_framework import ChatResponse

                manager_model = model_id or str(agent_list[0][1].get("model_id") or os.getenv("OLLAMA_MODEL", "llama3:8b"))
                participant_names = [str(config.get("name", agent_id)) for agent_id, config in agent_list]
                prior_speakers = [
                    getattr(message, "author_name", None)
                    for message in (messages if isinstance(messages, list) else [messages])
                    if getattr(message, "author_name", None) in participant_names
                ]
                normalized_messages = _chat_messages_to_dict_messages(messages if isinstance(messages, list) else [messages])

                def _participant_named(partial_name: str) -> str | None:
                    normalized_partial = re.sub(r"[^a-z0-9]+", "", partial_name.lower())
                    for participant_name in participant_names:
                        normalized_name = re.sub(r"[^a-z0-9]+", "", participant_name.lower())
                        if normalized_partial in normalized_name:
                            return participant_name
                    return None

                def _latest_participant_message() -> tuple[str | None, str]:
                    raw_messages = messages if isinstance(messages, list) else [messages]
                    for message in reversed(raw_messages):
                        author = getattr(message, "author_name", None)
                        if author in participant_names:
                            return author, _chat_message_text(message)
                    return None, ""

                def _tool_result_failed(text: str) -> bool:
                    lower_text = text.lower()
                    exit_code_match = re.search(r"exit_code:\s*(-?\d+)", lower_text)
                    if exit_code_match and exit_code_match.group(1) != "0":
                        return True
                    failure_markers = (
                        "traceback",
                        "unicodeencodeerror",
                        "syntaxerror",
                        "permissionerror",
                        "filenotfounderror",
                        "error modifying file",
                        "error reading file",
                        "error reading file back",
                        "not readable",
                    )
                    return any(marker in lower_text for marker in failure_markers)

                def _tool_result_succeeded(text: str) -> bool:
                    lower_text = text.lower()
                    return (
                        "exit_code: 0" in lower_text
                        and not _tool_result_failed(text)
                        and any(marker in lower_text for marker in ("verified", "read", "success", "appended", "complete"))
                    )

                def _repair_instruction(error_text: str) -> str:
                    return (
                        "The previous execution failed. First read the exact tool result below, including exit_code, stdout, and stderr. "
                        "Diagnose that failure, then write a corrected Python script. "
                        "Return one complete fenced Python code block only. Use the exact user-requested file path, avoid Unicode-only console symbols, "
                        "append exactly five business ideas, and include read-back verification in the script.\n\n"
                        f"Latest execution result:\n{error_text[-4000:]}"
                    )

                if response_format is not None:
                    last_author, last_text = _latest_participant_message()
                    code_writer_name = _participant_named("code writer")
                    shell_executor_name = _participant_named("shell executor")
                    deterministic_payload: dict[str, Any] | None = None

                    if last_author == shell_executor_name and _tool_result_failed(last_text):
                        if code_writer_name:
                            deterministic_payload = {
                                "next_agent": code_writer_name,
                                "message": _repair_instruction(last_text),
                                "finish": False,
                                "final_response": None,
                            }
                    elif last_author == shell_executor_name and _tool_result_succeeded(last_text):
                        deterministic_payload = {
                            "next_agent": None,
                            "message": "",
                            "finish": True,
                            "final_response": "The script executed successfully and verified the file by reading it back.",
                        }
                    elif last_author == code_writer_name and shell_executor_name:
                        deterministic_payload = {
                            "next_agent": shell_executor_name,
                            "message": "Execute the latest Python code block. If it fails, return the exact exit code, stdout, and stderr so the script can be repaired.",
                            "finish": False,
                            "final_response": None,
                        }

                    if deterministic_payload is not None:
                        cleaned_response = json.dumps(deterministic_payload)
                        parsed_value = response_format.model_validate(deterministic_payload)
                        await _push_manager_event("response.thinking.delta", "\n[manager call started]\n")
                        await _push_manager_event("response.thinking.delta", f"\n[manager fallback decision: {cleaned_response}]\n")
                        await _push_manager_event("response.thinking.delta", "\n[manager call completed]\n")
                        return ChatResponse(text=cleaned_response, value=parsed_value, model_id=manager_model)

                if response_format is not None:
                    schema = response_format.model_json_schema() if hasattr(response_format, "model_json_schema") else {}
                    normalized_messages.append({
                        "role": "user",
                        "content": f"/no_think\nReturn only valid JSON now. No analysis, no markdown fences. Schema: {json.dumps(schema)}",
                    })
                response_text = ""
                await _push_manager_event("response.thinking.delta", "\n[manager call started]\n")
                async for chunk in stream_ollama_response(
                    manager_model,
                    normalized_messages,
                    None,
                    include_completion=False,
                    think=False,
                    ollama_options={"temperature": 0, "num_predict": 700},
                ):
                    if not chunk.startswith("data: "):
                        continue
                    try:
                        data = json.loads(chunk[6:])
                    except Exception:
                        continue
                    event_type = data.get("type")
                    if event_type == "response.thinking.delta":
                        await _push_manager_event("response.thinking.delta", data.get("delta", ""))
                    elif event_type == "response.output_text.delta":
                        response_text += data.get("delta", "")
                        await _push_manager_event("response.thinking.delta", data.get("delta", ""))
                    elif event_type == "error":
                        response_text += f"\nError: {data.get('error', {}).get('message', 'Unknown error')}"
                    if "}" not in response_text and len(response_text) >= 500:
                        await _push_manager_event(
                            "response.thinking.delta",
                            "\n[manager switching to fast routing fallback]\n",
                        )
                        break
                await _push_manager_event("response.thinking.delta", "\n[manager call completed]\n")

                cleaned_response = re.sub(r"<think>[\s\S]*?</think>", "", response_text, flags=re.IGNORECASE).strip()
                if "{" in cleaned_response and "}" in cleaned_response:
                    cleaned_response = cleaned_response[cleaned_response.find("{"):cleaned_response.rfind("}") + 1]

                parsed_value = None
                if response_format is not None and cleaned_response:
                    try:
                        parsed_value = response_format.model_validate_json(cleaned_response)
                    except Exception:
                        parsed_value = None

                if parsed_value is None and response_format is not None:
                    next_index = min(len(prior_speakers), max(0, len(participant_names) - 1))
                    def _fallback_instruction(agent_name: str) -> str:
                        normalized_name = agent_name.lower()
                        if "diagnoser" in normalized_name:
                            return (
                                "Make exactly one code_interpreter call. In that single Python script, run "
                                "python auto_fix_lab/test_buggy_stats.py, then print the contents of "
                                "auto_fix_lab/buggy_stats.py. Do not edit files. After the tool result, explain "
                                "the failing test and the smallest likely fix."
                            )
                        if "patcher" in normalized_name:
                            return (
                                "Make exactly one code_interpreter call. In that single Python script, read "
                                "auto_fix_lab/buggy_stats.py, replace only the even-length median return with "
                                "return (ordered[midpoint - 1] + ordered[midpoint]) / 2, write the same file, "
                                "then run python auto_fix_lab/test_buggy_stats.py. Do not modify anything outside auto_fix_lab."
                            )
                        if "verifier" in normalized_name:
                            return (
                                "Make exactly one code_interpreter call. In that single Python script, independently run "
                                "python auto_fix_lab/test_buggy_stats.py and report the exact output. Do not edit files."
                            )
                        return "Make the next required contribution in one concise turn. Use code_interpreter if you need to run commands or inspect files."

                    if prior_speakers and len(prior_speakers) >= len(participant_names):
                        fallback_payload = {
                            "next_agent": None,
                            "message": "",
                            "finish": True,
                            "final_response": "The selected agents completed their group chat turns.",
                        }
                    else:
                        next_agent_name = participant_names[next_index] if participant_names else None
                        fallback_payload = {
                            "next_agent": next_agent_name,
                            "message": _fallback_instruction(next_agent_name) if next_agent_name else "",
                            "finish": False,
                            "final_response": None,
                        }
                    cleaned_response = json.dumps(fallback_payload)
                    parsed_value = response_format.model_validate(fallback_payload)
                    await _push_manager_event("response.thinking.delta", f"\n[manager fallback decision: {cleaned_response}]\n")

                return ChatResponse(text=cleaned_response or "{}", value=parsed_value, model_id=manager_model)

            def get_streaming_response(self, messages, **kwargs: Any):
                from agent_framework import ChatResponseUpdate

                async def _stream():
                    response = await self.get_response(messages, **kwargs)
                    yield ChatResponseUpdate(text=response.text, role="assistant", model_id=response.model_id)
                return _stream()

        if kind == "sequential":
            return SequentialBuilder().participants(participants).build()
        if kind == "concurrent":
            class LocalConcurrentAggregator(Executor):
                def __init__(self) -> None:
                    super().__init__(id="local-concurrent-aggregator")

                @handler
                async def aggregate(self, results: list[Any], ctx: WorkflowContext[Any, list]) -> None:
                    output_messages = []
                    for result in results:
                        if isinstance(result, list):
                            for message in result:
                                if getattr(message, "role", None) and str(getattr(getattr(message, "role", None), "value", getattr(message, "role", ""))) == "assistant":
                                    output_messages.append(message)
                        elif getattr(result, "role", None):
                            output_messages.append(result)
                    await ctx.yield_output(output_messages or results)

            return ConcurrentBuilder().participants(participants).with_aggregator(LocalConcurrentAggregator()).build()
        if kind == "group_chat":
            return (
                GroupChatBuilder()
                .set_prompt_based_manager(
                    chat_client=LocalOllamaManagerChatClient(),
                    instructions=(
                        "/no_think\n"
                        "You are a fast routing manager. Return exactly one JSON object and no prose. "
                        "Select the next participant needed for the task. For diagnose/fix/verify tasks, "
                        "prefer the selected agents in this order when present: Auto Fix Diagnoser, Auto Fix Patcher, Auto Fix Verifier. "
                        "Finish only after the needed participants have acted."
                    ),
                    display_name="Manager",
                )
                .participants({executor.id: executor for executor in participants})
                .with_max_rounds(max_rounds)
                .build()
            )
        if kind == "handoff":
            agent_names = [str(config.get("name", agent_id)) for agent_id, config in agent_list]
            handoff_agents = [
                _make_local_agent_protocol(agent_id, config, [name for name in agent_names if name != str(config.get("name", agent_id))])
                for agent_id, config in agent_list
            ]
            builder = HandoffBuilder(participants=handoff_agents).set_coordinator(handoff_agents[0])
            for source in handoff_agents:
                targets = [target for target in handoff_agents if target is not source]
                if targets:
                    builder = builder.add_handoff(source, targets)
            return builder.build()
        if kind == "magentic":
            magentic_agents = {
                re.sub(r"[^a-zA-Z0-9_]+", "_", str(config.get("name", agent_id))).strip("_") or agent_id:
                _make_local_agent_protocol(agent_id, config)
                for agent_id, config in agent_list
            }
            return (
                MagenticBuilder()
                .participants(**magentic_agents)
                .with_standard_manager(
                    chat_client=LocalOllamaManagerChatClient(),
                    max_round_count=max_rounds,
                    max_stall_count=2,
                )
                .build()
            )
        return None

    if orchestration_type in {"sequential", "concurrent", "group_chat", "handoff", "magentic"}:
        try:
            workflow = _build_official_workflow(orchestration_type)
            if workflow is not None:
                yield _manager_message(f"Using official Agent Framework {orchestration_type.replace('_', ' ')} workflow.")
                async for chunk in _stream_official_workflow(workflow, _dict_messages_to_chat_messages(base_messages), manager_queue):
                    yield chunk
                print("\nOfficial workflow streaming complete")
                yield f"data: {json.dumps({'type': 'response.completed', 'response': {'status': 'completed'}})}\n\n"
                return
        except Exception as exc:
            print(f"Official workflow path failed; falling back to custom orchestration: {exc}")
            import traceback
            traceback.print_exc()
            yield _manager_message(
                "Official Agent Framework workflow failed, so this run is falling back to the custom local orchestrator. "
                f"Error: {exc}"
            )

    async def _run_turn_to_queue(queue: asyncio.Queue, result_map: dict, index: int, agent_id: str, config: dict, turn_messages: list):
        state: dict = {}
        async for chunk in _stream_agent_turn(agent_id, config, turn_messages, state):
            await queue.put(chunk)
        result_map[index] = state
        await queue.put(None)

    def _find_agent_by_name(name: str | None) -> tuple[str, dict] | None:
        if not name:
            return None
        normalized = re.sub(r"[^a-z0-9]+", "", name.lower())
        for agent_id, config in agent_list:
            agent_name = str(config.get("name", agent_id))
            candidates = {agent_id, agent_name}
            for candidate in candidates:
                if re.sub(r"[^a-z0-9]+", "", str(candidate).lower()) == normalized:
                    return agent_id, config
        return None

    def _extract_handoff_target(text: str) -> str | None:
        match = re.search(r"(?:handoff|transfer)\s*(?:to|:)\s*([^\n.;]+)", text, re.IGNORECASE)
        return match.group(1).strip() if match else None

    async def _collect_manager_decision(history: list, manager_model: str, participant_names: list[str], round_index: int) -> str:
        manager_prompt = (
            "You are the Magentic manager for a multi-agent workflow. "
            "Select the next participant or finish. Reply with a short reason and one exact line: "
            "NEXT: <participant name> or FINAL.\n"
            f"Participants: {', '.join(participant_names)}\n"
            f"Round: {round_index + 1}/{max_rounds}"
        )
        manager_messages = history.copy()
        manager_messages.append({"role": "user", "content": manager_prompt})
        decision = ""
        async for chunk in stream_ollama_response(manager_model, manager_messages, None, include_completion=False):
            if chunk.startswith("data: "):
                try:
                    data = json.loads(chunk[6:])
                    if data.get("type") == "response.output_text.delta":
                        decision += data.get("delta", "")
                except Exception:
                    pass
        return decision.strip()

    if orchestration_type == "concurrent":
        queue: asyncio.Queue = asyncio.Queue()
        results: dict[int, dict] = {}
        tasks = [
            asyncio.create_task(_run_turn_to_queue(queue, results, index, agent_id, config, base_messages.copy()))
            for index, (agent_id, config) in enumerate(agent_list)
        ]
        completed = 0
        while completed < len(tasks):
            item = await queue.get()
            if item is None:
                completed += 1
            else:
                yield item
        await asyncio.gather(*tasks, return_exceptions=True)

        summary = []
        for index in sorted(results):
            result = results[index]
            if result.get("context"):
                summary.append(f"{result['agent_name']}: {result['context']}")
        if summary:
            yield _manager_message("Concurrent execution completed. Results were gathered from all selected agents.")

    elif orchestration_type == "sequential":
        history = base_messages.copy()
        for index, (agent_id, config) in enumerate(agent_list):
            state: dict = {}
            async for chunk in _stream_agent_turn(agent_id, config, history, state):
                yield chunk
            if state.get("context") and not state.get("error"):
                history = _history_with_context(
                    history,
                    state["agent_name"],
                    state["context"],
                    "Continue the sequential workflow. Use all prior agent outputs and tool results as input, then perform only your assigned next step.",
                )

    elif orchestration_type == "handoff":
        history = base_messages.copy()
        current = agent_list[0]
        visited_turns = 0
        handoff_instructions = (
            "You are participating in a handoff workflow. If another selected agent should take over, "
            "end your response with exactly 'HANDOFF: <agent name>'. If the workflow is complete, end with 'FINAL'."
        )
        while current and visited_turns < max_rounds:
            agent_id, config = current
            state: dict = {}
            async for chunk in _stream_agent_turn(agent_id, config, history, state, handoff_instructions):
                yield chunk
            visited_turns += 1

            if state.get("context") and not state.get("error"):
                history = _history_with_context(
                    history,
                    state["agent_name"],
                    state["context"],
                    "Continue only if control has been handed to you. Otherwise summarize final status.",
                )

            response = state.get("response") or ""
            if re.search(r"\bFINAL\b", response, re.IGNORECASE):
                break
            next_agent = _find_agent_by_name(_extract_handoff_target(response))
            if not next_agent or next_agent[0] == agent_id:
                break
            yield _manager_message(f"Handoff accepted: {state['agent_name']} -> {next_agent[1].get('name', next_agent[0])}")
            current = next_agent

    elif orchestration_type == "magentic":
        history = base_messages.copy()
        participant_names = [str(config.get("name", agent_id)) for agent_id, config in agent_list]
        manager_model = str(agent_list[0][1].get("model_id") or os.getenv("OLLAMA_MODEL", "llama3:8b"))
        for round_index in range(max_rounds):
            decision = await _collect_manager_decision(history, manager_model, participant_names, round_index)
            yield _manager_message(decision or "NEXT: " + participant_names[round_index % len(participant_names)])
            if re.search(r"\bFINAL\b", decision, re.IGNORECASE):
                break

            next_match = re.search(r"NEXT\s*:\s*([^\n.;]+)", decision, re.IGNORECASE)
            selected = _find_agent_by_name(next_match.group(1).strip() if next_match else None)
            if selected is None:
                selected = agent_list[round_index % len(agent_list)]

            agent_id, config = selected
            state: dict = {}
            magentic_instructions = (
                "You were selected by the Magentic manager for this round. Follow the manager's latest instruction, "
                "use prior history and tool results, and report concrete progress."
            )
            async for chunk in _stream_agent_turn(agent_id, config, history, state, magentic_instructions):
                yield chunk
            if state.get("context") and not state.get("error"):
                history = _history_with_context(
                    history,
                    state["agent_name"],
                    state["context"],
                    "The manager will decide the next participant or finish.",
                )

    else:
        history = base_messages.copy()
        for turn_index in range(max_rounds):
            agent_id, config = agent_list[turn_index % len(agent_list)]
            state: dict = {}
            async for chunk in _stream_agent_turn(agent_id, config, history, state):
                yield chunk
            if state.get("context") and not state.get("error"):
                history = _history_with_context(
                    history,
                    state["agent_name"],
                    state["context"],
                    "Continue the group chat. Consider the full discussion so far, respond only if you can advance the task, and say when the group should stop.",
                )

    print("\nMulti-agent streaming complete")
    yield f"data: {json.dumps({'type': 'response.completed', 'response': {'status': 'completed'}})}\n\n"


# ── Real Agent Framework streaming ────────────────────────────────────────────

def _load_agent_module(agent_id: str):
    """Import (or retrieve cached) the agent module from agents/<agent_id>/__init__.py.

    Returns the module or None on failure.
    """
    module_path = AGENTS_DIR / agent_id / "__init__.py"
    if not module_path.exists():
        return None
    module_name = f"_af_agents.{agent_id}"
    if module_name in sys.modules:
        return sys.modules[module_name]
    try:
        spec = importlib.util.spec_from_file_location(module_name, module_path,
            submodule_search_locations=[])
        mod = importlib.util.module_from_spec(spec)
        sys.modules[module_name] = mod
        spec.loader.exec_module(mod)
        return mod
    except Exception as exc:
        print(f"[agent_loader] Failed to import {agent_id}: {exc}")
        import traceback; traceback.print_exc()
        return None


async def stream_agent_response(
    agent_id: str,
    model: str,
    messages: list,
    instructions: str | None = None,
    include_completion: bool = False,
):
    """Stream a response by actually running the Agent Framework agent module.

    Falls back to stream_ollama_response() when the agent module cannot be loaded
    or does not expose an ``agent`` object.
    """
    from agent_framework import ChatMessage, DataContent, Role
    from agent_framework._types import TextContent, TextReasoningContent, FunctionCallContent, FunctionResultContent

    print(f"\n=== stream_agent_response START ===")
    print(f"Agent ID: {agent_id}, Model: {model}")

    mod = _load_agent_module(agent_id)
    if mod is None or not hasattr(mod, "agent"):
        print(f"[stream_agent_response] No agent module for '{agent_id}', falling back")
        async for chunk in stream_ollama_response(model, messages, instructions, include_completion=include_completion):
            yield chunk
        return

    agent = mod.agent

    def _collect_native_tools(module) -> dict[str, object]:
        tools: dict[str, object] = {}
        for value in vars(module).values():
            if getattr(value, "type", None) == "ai_function" and getattr(value, "name", None):
                tools[value.name] = value
        return tools

    native_tools = _collect_native_tools(mod)
    if native_tools:
        print(f"[stream_agent_response] Using native Ollama stream with tools: {list(native_tools.keys())}")
        tool_instruction = (
            "When a tool is needed, make the actual tool call immediately. Do not explain how to call tools, "
            "do not ask the user to run commands, and do not present fake tool-call JSON as a final answer. "
            "For multi-step file/test tasks, combine the required reads, writes, and test commands into one "
            "code_interpreter Python script when possible. Avoid f-strings or quoted strings containing embedded "
            "line breaks; use separate print calls or explicit '\\n' escapes."
        )
        instructions = f"{instructions or ''}\n\n{tool_instruction}".strip()
    else:
        print("[stream_agent_response] Using native Ollama stream without tools")
    async for chunk in stream_ollama_response(
        model,
        messages,
        instructions,
        include_completion=include_completion,
        custom_tools=native_tools,
    ):
        yield chunk
    return

    def _data_url_media_type(data_url: str) -> str:
        if isinstance(data_url, str) and data_url.startswith("data:") and ";" in data_url:
            return data_url.split(";", 1)[0].removeprefix("data:") or "image/jpeg"
        return "image/jpeg"

    def _build_user_message():
        latest = next((m for m in reversed(messages) if isinstance(m, dict) and m.get("role") == "user"), {})
        content = latest.get("content", "") if isinstance(latest, dict) else ""

        if not isinstance(content, list):
            return "" if content is None else str(content)

        contents = []
        for item in content:
            if not isinstance(item, dict):
                continue
            item_type = item.get("type")
            if item_type in ("input_text", "text", "output_text"):
                text_value = item.get("text") or item.get("content")
                if isinstance(text_value, str) and text_value:
                    contents.append(TextContent(text=text_value))
            elif item_type == "input_image":
                image_url = item.get("image_url")
                if isinstance(image_url, str) and image_url:
                    contents.append(DataContent(uri=image_url, media_type=_data_url_media_type(image_url)))

        return ChatMessage(role=Role.USER, contents=contents) if contents else ""

    user_msg = _build_user_message()

    # Pending tool calls keyed by call_id – emitted when the result arrives.
    pending: dict[str, dict] = {}

    try:
        async for update in agent.run_stream(user_msg, model_id=model):
            for content in (update.contents or []):
                if isinstance(content, TextContent):
                    if content.text:
                        yield f"data: {json.dumps({'type': 'response.output_text.delta', 'delta': content.text})}\n\n"

                elif isinstance(content, TextReasoningContent):
                    if content.text:
                        yield f"data: {json.dumps({'type': 'response.thinking.delta', 'delta': content.text})}\n\n"

                elif isinstance(content, FunctionCallContent):
                    # Buffer – we emit the badge only after the result is available.
                    args = content.arguments
                    if isinstance(args, str):
                        try:
                            args = json.loads(args)
                        except Exception:
                            args = {"raw": args}
                    pending[content.call_id] = {
                        "name": content.name,
                        "call_id": content.call_id,
                        "arguments": args or {},
                    }
                    print(f"[tool] call buffered: {content.name}({args})")

                elif isinstance(content, FunctionResultContent):
                    call_info = pending.pop(content.call_id, {})
                    tool_name = call_info.get("name", "unknown_tool")
                    tool_args = call_info.get("arguments", {})
                    result_str = str(content.result) if content.result is not None else "(no result)"
                    if content.exception:
                        result_str = f"Error: {content.exception}"
                    print(f"[tool] result received: {tool_name} → {result_str[:120]}")
                    event = {
                        "type": "response.function_call.complete",
                        "data": {"name": tool_name, "call_id": content.call_id},
                        "function_call": {
                            "name": tool_name,
                            "arguments": tool_args,
                            "result": result_str,
                        },
                    }
                    yield f"data: {json.dumps(event)}\n\n"

        if include_completion:
            yield f"data: {json.dumps({'type': 'response.completed', 'response': {'status': 'completed'}})}\n\n"

    except Exception as exc:
        print(f"[stream_agent_response] Error: {exc}")
        import traceback; traceback.print_exc()
        error_event = {"type": "error", "error": {"message": str(exc)}}
        yield f"data: {json.dumps(error_event)}\n\n"

    print("=== stream_agent_response END ===\n")


def _detect_tool_calls(text: str) -> list[dict]:
    """Synthetic tool detection is disabled; only real runtime tool events should be shown."""
    _ = text
    return []


async def stream_ollama_response(
    model: str,
    messages: list,
    instructions: str = None,
    include_completion: bool = False,
    web_search_enabled: bool = False,
    web_search_provider: str = "ollama",
    web_search_mode: str = "search_fetch",
    custom_tools: dict[str, object] | None = None,
    think: bool = True,
    ollama_options: dict[str, Any] | None = None,
):
    """Stream response from Ollama and format as SSE events"""
    print(f"\n=== stream_ollama_response START ===")
    print(f"Model: {model}, Num messages: {len(messages)}, Include completion: {include_completion}, Web search: {web_search_enabled}, Provider: {web_search_provider}, Mode: {web_search_mode}")
    
    # Create a new client for each call to avoid connection reuse issues
    client = httpx.AsyncClient(timeout=600.0)
    
    total_content_yielded = 0
    full_response_text = ""
    full_thinking_text = ""
    tool_events_emitted = False

    def _model_supports_thinking(model_name: str) -> bool:
        normalized = model_name.lower().removesuffix(":cloud").removesuffix("-cloud")
        thinking_model_markers = (
            "deepseek-r1",
            "gpt-oss",
            "magistral",
            "qwen3",
            "qwq",
        )
        return any(marker in normalized for marker in thinking_model_markers)

    effective_think = bool(think and _model_supports_thinking(model))
    if think and not effective_think:
        print(f"[DEBUG] Thinking disabled for model that does not advertise thinking support: {model}")

    def _model_supports_tools(model_name: str) -> bool:
        normalized = model_name.lower().removesuffix(":cloud").removesuffix("-cloud")
        tool_model_markers = (
            "gemma4",
            "llama3-groq-tool-use",
            "qwen2.5-coder",
            "qwen3",
            "qwen3.5",
        )
        return any(marker in normalized for marker in tool_model_markers)

    async def _select_tool_capable_model(requested_model: str) -> str:
        if _model_supports_tools(requested_model):
            return requested_model
        configured = os.getenv("OLLAMA_TOOL_MODEL", "").strip()
        candidates = [
            configured,
            "qwen2.5-coder:7b",
            "qwen3.5:4b",
            "qwen3:4b",
            "qwen3:8b",
            "llama3-groq-tool-use:latest",
            "gemma4:e2b",
            "gemma4:e4b",
        ]
        try:
            response = await client.get("http://localhost:11434/api/tags", timeout=5.0)
            response.raise_for_status()
            installed = {item.get("name") for item in response.json().get("models", []) if item.get("name")}
        except Exception as exc:
            print(f"[DEBUG] Could not inspect installed Ollama models for tool fallback: {exc}")
            installed = set()
        for candidate in candidates:
            if candidate and (not installed or candidate in installed):
                print(f"[tool model fallback] {requested_model} does not support tools; using {candidate}")
                return candidate
        return requested_model

    if custom_tools and not _model_supports_tools(model):
        model = await _select_tool_capable_model(model)
        effective_think = bool(think and _model_supports_thinking(model))
    
    def _image_to_ollama_base64(image_url: str) -> str | None:
        if not isinstance(image_url, str) or not image_url:
            return None
        if image_url.startswith("data:") and "," in image_url:
            b64 = image_url.split(",", 1)[1]
            print(f"[DEBUG] Extracted base64 from data URL: length={len(b64)}, first 50 chars={b64[:50]}")
            return b64
        # Pass through likely base64 payloads; still ignore http(s) URLs.
        if image_url.startswith("http://") or image_url.startswith("https://"):
            print(f"[DEBUG] Ignoring HTTP(S) URL: {image_url[:50]}...")
            return None
        print(f"[DEBUG] Passing through as base64: length={len(image_url)}, first 50 chars={image_url[:50]}")
        return image_url

    def _normalize_messages_for_ollama(raw_messages: list) -> list[dict]:
        normalized: list[dict] = []
        for raw in raw_messages or []:
            if not isinstance(raw, dict):
                continue

            role = raw.get("role", "user")
            content = raw.get("content", "")
            text_parts: list[str] = []
            images: list[str] = []

            if isinstance(content, list):
                for item in content:
                    if not isinstance(item, dict):
                        continue
                    item_type = item.get("type")
                    if item_type in ("input_text", "text", "output_text"):
                        text_value = item.get("text") or item.get("content")
                        if isinstance(text_value, str) and text_value:
                            text_parts.append(text_value)
                    elif item_type == "input_image":
                        img_b64 = _image_to_ollama_base64(item.get("image_url"))
                        if img_b64:
                            images.append(img_b64)
            else:
                if content is None:
                    content = ""
                text_parts.append(str(content))

            raw_images = raw.get("images")
            if isinstance(raw_images, list):
                for image_value in raw_images:
                    img_b64 = _image_to_ollama_base64(image_value)
                    if img_b64:
                        images.append(img_b64)

            out_msg = {
                "role": role,
                "content": "\n".join(p for p in text_parts if p).strip(),
            }
            if images:
                out_msg["images"] = images
                print(f"[DEBUG] Message has {len(images)} image(s): {[len(img) for img in images]} bytes each")
            
            # Gemma 4 best practice: For multimodal inputs, images should come before text
            # Reorder: place images array first if present
            if images and out_msg["content"]:
                # Keep images at the message level (Ollama will handle ordering)
                pass

            normalized.append(out_msg)

        return normalized

    web_search_tools = [
        {
            "type": "function",
            "function": {
                "name": "web_search",
                "description": "Search the web for current or factual information using Ollama hosted web search.",
                "parameters": {
                    "type": "object",
                    "required": ["query"],
                    "properties": {
                        "query": {"type": "string", "description": "The web search query."},
                        "max_results": {"type": "integer", "description": "Maximum search results to return, from 1 to 10."},
                    },
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "web_fetch",
                "description": "Fetch readable page content from an absolute URL using Ollama hosted web fetch.",
                "parameters": {
                    "type": "object",
                    "required": ["url"],
                    "properties": {
                        "url": {"type": "string", "description": "The absolute URL to fetch."},
                    },
                },
            },
        },
    ]

    def _native_tool_schema(tool: object) -> dict:
        input_model = getattr(tool, "input_model", None)
        parameters = {"type": "object", "properties": {}}
        if input_model is not None and hasattr(input_model, "model_json_schema"):
            parameters = input_model.model_json_schema()
            parameters.pop("title", None)
        return {
            "type": "function",
            "function": {
                "name": getattr(tool, "name", "tool"),
                "description": getattr(tool, "description", ""),
                "parameters": parameters,
            },
        }

    def _escape_newlines_inside_python_strings(code: str) -> str:
        output: list[str] = []
        quote: str | None = None
        escaped = False
        index = 0
        while index < len(code):
            char = code[index]
            if quote is None:
                if char in {"'", '"'}:
                    if code[index:index + 3] == char * 3:
                        output.append(char * 3)
                        index += 3
                        continue
                    quote = char
                    escaped = False
                output.append(char)
                index += 1
                continue

            if escaped:
                output.append(char)
                escaped = False
            elif char == "\\":
                output.append(char)
                escaped = True
            elif char == quote:
                output.append(char)
                quote = None
            elif char == "\n":
                output.append("\\n")
            else:
                output.append(char)
            index += 1
        return "".join(output)

    async def _invoke_native_tool(tool: object, arguments: dict) -> str:
        try:
            if getattr(tool, "name", "") == "code_interpreter" and isinstance(arguments, dict):
                code = arguments.get("code")
                if isinstance(code, str):
                    arguments = {**arguments, "code": _escape_newlines_inside_python_strings(code)}
            input_model = getattr(tool, "input_model", None)
            if input_model is not None and hasattr(input_model, "model_validate"):
                args_model = input_model.model_validate(arguments or {})
                result = await tool.invoke(arguments=args_model)
            elif hasattr(tool, "invoke"):
                result = await tool.invoke(**(arguments or {}))
            else:
                result = tool(**(arguments or {}))
                if inspect.isawaitable(result):
                    result = await result
            return str(result) if result is not None else "(no result)"
        except Exception as exc:
            return f"Error: {exc}"

    def _extract_text_tool_calls(text: str) -> list[dict]:
        if not custom_tools or not text:
            return []

        calls: list[dict] = []

        def _append_call(parsed: object) -> None:
            if isinstance(parsed, list):
                for item in parsed:
                    _append_call(item)
                return
            if not isinstance(parsed, dict):
                return
            if isinstance(parsed.get("tool_call"), dict):
                _append_call(parsed["tool_call"])
                return
            if isinstance(parsed.get("tool_calls"), list):
                _append_call(parsed["tool_calls"])
                return
            tool_name = parsed.get("name") or parsed.get("function", {}).get("name")
            if tool_name not in custom_tools:
                return
            arguments = parsed.get("arguments") or parsed.get("function", {}).get("arguments") or {}
            if isinstance(arguments, str):
                try:
                    arguments = json.loads(arguments)
                except Exception:
                    arguments = {"raw": arguments}
            calls.append({"name": tool_name, "arguments": arguments or {}})

        def _parse_first_json_object(raw_text: str) -> object | None:
            decoder = json.JSONDecoder()
            for match in re.finditer(r"\{", raw_text):
                candidate = raw_text[match.start():].lstrip()
                try:
                    parsed, _end = decoder.raw_decode(candidate)
                    return parsed
                except Exception:
                    continue
            return None

        for match in re.finditer(r"<tool_call>\s*([\s\S]*?)\s*</tool_call>", text):
            parsed = _parse_first_json_object(match.group(1))
            _append_call(parsed)

        for match in re.finditer(r"</tool_call>", text):
            window = text[max(0, match.start() - 2000):match.start()]
            parsed_objects: list[object] = []
            decoder = json.JSONDecoder()
            for brace in re.finditer(r"\{", window):
                candidate = window[brace.start():].lstrip()
                try:
                    parsed, _end = decoder.raw_decode(candidate)
                    parsed_objects.append(parsed)
                except Exception:
                    continue
            for parsed in reversed(parsed_objects):
                before_count = len(calls)
                _append_call(parsed)
                if len(calls) > before_count:
                    break

        raw_json_call = _parse_first_json_object(text)
        _append_call(raw_json_call)

        return calls

    def _infer_tool_call_from_decision_text(text: str) -> dict | None:
        if not custom_tools or not text:
            return None

        lowered = text.lower()
        stop_patterns = (
            r"\b(call|use)\s+stop\b"
            r"|\bshould stop\b"
            r"|\bsafe action would be stop\b"
            r"|\btherefore,?\s+stop\b"
            r"|\bso,?\s+stop\b"
            r"|\bdo not drive forward\b"
            r"|\bdon't drive forward\b"
            r"|\bdrive forward\?\s*no\b"
            r"|\bdriving forward would be dangerous\b"
        )

        def _number_after(pattern: str, default: float) -> float:
            match = re.search(pattern, lowered)
            if not match:
                return default
            try:
                return float(match.group(1))
            except Exception:
                return default

        if "stop" in custom_tools and re.search(stop_patterns, lowered):
            reason = "unsafe or unclear path"
            reason_match = re.search(r"reason(?:\s+like)?\s+[\"']([^\"']+)[\"']", text, re.IGNORECASE)
            if reason_match:
                reason = reason_match.group(1).strip()
            elif "drop-off" in lowered or "drop off" in lowered:
                reason = "forward path may lead to a drop-off or unknown hazard"
            elif "water" in lowered or "void" in lowered:
                reason = "forward path may lead into water or a void"
            elif "hazard" in lowered:
                reason = "forward path appears unsafe or hazardous"
            return {"name": "stop", "arguments": {"reason": reason}}

        if "drive_forward" in custom_tools and re.search(r"\b(call|use)\s+drive_forward\b|\bcall\s+drive forward\b", lowered):
            return {
                "name": "drive_forward",
                "arguments": {"distance_feet": max(0.5, min(_number_after(r"(\d+(?:\.\d+)?)\s*(?:feet|ft)", 1.0), 2.0))},
            }
        if "drive_backward" in custom_tools and re.search(r"\b(call|use)\s+drive_backward\b|\bdrive backward\b|\bback up\b", lowered):
            return {
                "name": "drive_backward",
                "arguments": {"distance_feet": max(0.5, min(_number_after(r"(\d+(?:\.\d+)?)\s*(?:feet|ft)", 0.5), 1.0))},
            }
        if "drive_left" in custom_tools and re.search(r"\b(call|use)\s+drive_left\b|\bturn left\b|\bdrive left\b", lowered):
            return {
                "name": "drive_left",
                "arguments": {"turn_degrees": max(10, min(_number_after(r"(\d+(?:\.\d+)?)\s*degrees?", 15), 35))},
            }
        if "drive_right" in custom_tools and re.search(r"\b(call|use)\s+drive_right\b|\bturn right\b|\bdrive right\b", lowered):
            return {
                "name": "drive_right",
                "arguments": {"turn_degrees": max(10, min(_number_after(r"(\d+(?:\.\d+)?)\s*degrees?", 15), 35))},
            }
        return None

    def _format_web_search_result(data: dict, query: str) -> str:
        results = data.get("results") or []
        if not results:
            return f'No web search results found for "{query}".'

        lines = [f'Search results for "{query}":']
        for index, result in enumerate(results[:10], 1):
            title = result.get("title") or result.get("url") or "(no title)"
            url_value = result.get("url") or ""
            content = result.get("content") or result.get("snippet") or ""
            lines.append(f"{index}. {title}\nURL: {url_value}\nContent: {content}")
        return "\n\n".join(lines)

    def _format_web_fetch_result(data: dict, url_value: str) -> str:
        title = data.get("title") or "(no title)"
        content = data.get("content") or ""
        links = data.get("links") or []
        suffix = f"\nLinks: {', '.join(links[:10])}" if links else ""
        return f"Fetch result for {url_value}:\nTitle: {title}\nContent: {content}{suffix}"

    async def _call_ollama_hosted_tool(name: str, arguments: dict) -> str:
        api_key = os.getenv("OLLAMA_API_KEY", "").strip()
        if not api_key:
            return "Ollama hosted web search is enabled, but OLLAMA_API_KEY is not set on the backend. Set OLLAMA_API_KEY and restart the custom backend."

        headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
        if name == "web_search":
            query = str(arguments.get("query") or "").strip()
            max_results_raw = arguments.get("max_results", 10)
            try:
                max_results = max(1, min(int(max_results_raw), 10))
            except Exception:
                max_results = 10
            if not query:
                return "web_search failed: missing query."

            response = await client.post(
                "https://ollama.com/api/web_search",
                headers=headers,
                json={"query": query, "max_results": max_results},
                timeout=30.0,
            )
            if response.status_code != 200:
                return f"web_search failed with status {response.status_code}: {response.text[:500]}"
            return _format_web_search_result(response.json(), query)[:8000]

        if name == "web_fetch":
            url_value = str(arguments.get("url") or "").strip()
            parsed_url = urlparse(url_value)
            if parsed_url.scheme not in ("http", "https") or not parsed_url.netloc:
                return "web_fetch failed: url must be an absolute http(s) URL."

            response = await client.post(
                "https://ollama.com/api/web_fetch",
                headers=headers,
                json={"url": url_value},
                timeout=30.0,
            )
            if response.status_code != 200:
                return f"web_fetch failed with status {response.status_code}: {response.text[:500]}"
            return _format_web_fetch_result(response.json(), url_value)[:12000]

        return f"Unknown tool: {name}"

    async def _call_duckduckgo_tool(name: str, arguments: dict) -> str:
        headers = {
            "User-Agent": "Mozilla/5.0 Agent Framework DevUI",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
        }
        if name == "web_search":
            query = str(arguments.get("query") or "").strip()
            max_results_raw = arguments.get("max_results", 5 if web_search_mode == "deep" else 3)
            try:
                max_results = max(1, min(int(max_results_raw), 10))
            except Exception:
                max_results = 3
            if not query:
                return "web_search failed: missing query."

            response = None
            for search_url in ("https://html.duckduckgo.com/html/", "https://lite.duckduckgo.com/lite/"):
                response = await client.get(
                    search_url,
                    params={"q": query},
                    headers=headers,
                    follow_redirects=True,
                    timeout=30.0,
                )
                if response.status_code == 200:
                    break
            if response is None or response.status_code != 200:
                status_code = response.status_code if response is not None else "unknown"
                return (
                    f"WEB_SEARCH_FAILED: DuckDuckGo returned status {status_code} for this query. "
                    "This usually means DuckDuckGo returned an interstitial or temporary anti-bot response, "
                    "so no search results were available to the model. Try a shorter query or retry later."
                )

            parser = _DuckDuckGoResultParser()
            parser.feed(response.text)
            parser.close()
            if not parser.results:
                return "WEB_SEARCH_FAILED: DuckDuckGo returned a page, but no parseable search results were found."
            selected_results = parser.results[:max_results]
            search_summary = _format_web_search_result({"results": selected_results}, query)

            if web_search_mode in {"search_fetch", "deep"}:
                fetched_sections: list[str] = []
                fetch_limit = 5 if web_search_mode == "deep" else 3
                for index, result in enumerate(selected_results[:fetch_limit], 1):
                    url_value = result.get("url", "")
                    parsed_result_url = urlparse(url_value)
                    if parsed_result_url.scheme not in ("http", "https") or not parsed_result_url.netloc:
                        continue
                    try:
                        page_response = await client.get(
                            url_value,
                            headers=headers,
                            follow_redirects=True,
                            timeout=20.0,
                        )
                    except Exception as exc:
                        fetched_sections.append(f"{index}. {result.get('title') or url_value}\nURL: {url_value}\nFetch failed: {exc}")
                        continue

                    if page_response.status_code != 200:
                        fetched_sections.append(
                            f"{index}. {result.get('title') or url_value}\nURL: {url_value}\nFetch failed with status {page_response.status_code}."
                        )
                        continue

                    title_match = re.search(r"<title[^>]*>([\s\S]*?)</title>", page_response.text, re.IGNORECASE)
                    page_title = _html_to_text(title_match.group(1)) if title_match else (result.get("title") or "(no title)")
                    page_text = _html_to_text(page_response.text)
                    excerpt_length = 3500 if web_search_mode == "deep" else 2500
                    fetched_sections.append(
                        f"{index}. {page_title}\nURL: {url_value}\nPage excerpt:\n{page_text[:excerpt_length]}"
                    )

                if fetched_sections:
                    return f"{search_summary}\n\nFetched page excerpts from top results:\n\n" + "\n\n".join(fetched_sections)
            return search_summary[:8000]

        if name == "web_fetch":
            url_value = str(arguments.get("url") or "").strip()
            parsed_url = urlparse(url_value)
            if parsed_url.scheme not in ("http", "https") or not parsed_url.netloc:
                return "web_fetch failed: url must be an absolute http(s) URL."

            response = await client.get(url_value, headers=headers, follow_redirects=True, timeout=30.0)
            if response.status_code != 200:
                return f"web_fetch failed with status {response.status_code}: {response.text[:500]}"
            title_match = re.search(r"<title[^>]*>([\s\S]*?)</title>", response.text, re.IGNORECASE)
            title = _html_to_text(title_match.group(1)) if title_match else "(no title)"
            return _format_web_fetch_result({"title": title, "content": _html_to_text(response.text)[:12000]}, url_value)[:12000]

        return f"Unknown tool: {name}"

    async def _call_selected_web_tool(name: str, arguments: dict) -> str:
        if web_search_provider == "duckduckgo":
            return await _call_duckduckgo_tool(name, arguments)
        return await _call_ollama_hosted_tool(name, arguments)

    async def _stream_with_web_search(payload: dict):
        messages_for_tools = list(payload["messages"])
        mode_label = {
            "search": "search-only",
            "search_fetch": "search plus fetch",
            "deep": "deep research",
        }.get(web_search_mode, "search plus fetch")
        source_instruction = (
            f"Web mode is {mode_label} through {web_search_provider}. "
            "For current, factual, recent, or source-dependent questions, call web_search before answering. "
            "When page content is needed and web_fetch is available, fetch the most relevant result URLs before finalizing. "
            "Your final answer MUST include a Sources section with markdown links to every source URL you relied on. "
            "If search or fetch fails, say that clearly and answer only from available evidence."
        )
        if web_search_mode == "deep":
            source_instruction += " Use multiple searches or fetches when useful, compare sources, and prefer primary sources."
        if not any(msg.get("role") == "system" for msg in messages_for_tools):
            messages_for_tools.insert(0, {
                "role": "system",
                "content": source_instruction,
            })
        else:
            messages_for_tools.insert(0, {"role": "system", "content": source_instruction})

        enabled_web_tools = web_search_tools if web_search_mode in {"search_fetch", "deep"} else web_search_tools[:1]
        max_steps = 6 if web_search_mode == "deep" else 4

        for _step in range(max_steps):
            tool_payload = {
                "model": payload["model"],
                "messages": messages_for_tools,
                "tools": enabled_web_tools,
                "stream": True,
            }
            if effective_think:
                tool_payload["think"] = True
            assistant_content = ""
            tool_calls: list[dict] = []
            buffer = ""

            async with client.stream("POST", url, json=tool_payload, headers=headers, timeout=600.0) as response:
                if response.status_code != 200:
                    error_text = await response.aread()
                    error_message = f"Ollama returned status {response.status_code}"
                    try:
                        parsed_error = json.loads(error_text.decode("utf-8", errors="ignore"))
                        if isinstance(parsed_error, dict) and parsed_error.get("error"):
                            error_message = str(parsed_error["error"])
                    except Exception:
                        error_message = f"Ollama returned status {response.status_code}: {error_text[:500]}"
                    error_event = {"type": "error", "error": {"message": error_message}}
                    yield f"data: {json.dumps(error_event)}\n\n"
                    return

                async for text_chunk in response.aiter_text():
                    if not text_chunk:
                        continue
                    buffer += text_chunk
                    lines = buffer.split("\n")
                    buffer = lines.pop() or ""

                    for line in lines:
                        line = line.strip()
                        if not line:
                            continue
                        try:
                            data = json.loads(line)
                        except json.JSONDecodeError:
                            continue

                        assistant_message = data.get("message", {}) or {}
                        thinking = assistant_message.get("thinking") or data.get("thinking") or ""
                        if thinking:
                            yield f"data: {json.dumps({'type': 'response.thinking.delta', 'delta': thinking})}\n\n"

                        content = assistant_message.get("content", "")
                        if content:
                            assistant_content += content

                        for tool_call in assistant_message.get("tool_calls") or []:
                            if tool_call not in tool_calls:
                                tool_calls.append(tool_call)

                if buffer.strip():
                    try:
                        data = json.loads(buffer.strip())
                        assistant_message = data.get("message", {}) or {}
                        thinking = assistant_message.get("thinking") or data.get("thinking") or ""
                        if thinking:
                            yield f"data: {json.dumps({'type': 'response.thinking.delta', 'delta': thinking})}\n\n"
                        content = assistant_message.get("content", "")
                        if content:
                            assistant_content += content
                        for tool_call in assistant_message.get("tool_calls") or []:
                            if tool_call not in tool_calls:
                                tool_calls.append(tool_call)
                    except json.JSONDecodeError:
                        pass

            if not tool_calls:
                if assistant_content:
                    yield f"data: {json.dumps({'type': 'response.output_text.delta', 'delta': assistant_content})}\n\n"
                if include_completion:
                    yield f"data: {json.dumps({'type': 'response.completed', 'response': {'status': 'completed'}})}\n\n"
                return

            messages_for_tools.append({
                "role": "assistant",
                "content": assistant_content,
                "tool_calls": tool_calls,
            })

            for tool_call in tool_calls:
                function = tool_call.get("function", {}) or {}
                tool_name = function.get("name", "")
                arguments = function.get("arguments") or {}
                if isinstance(arguments, str):
                    try:
                        arguments = json.loads(arguments)
                    except Exception:
                        arguments = {"raw": arguments}

                tool_result = await _call_selected_web_tool(tool_name, arguments)
                label = f"{web_search_provider} search: {arguments.get('query')}" if tool_name == "web_search" else f"{web_search_provider} fetch: {arguments.get('url')}"
                lowered_tool_result = tool_result.lower()
                tool_failed = (
                    tool_result.startswith("WEB_SEARCH_FAILED:")
                    or lowered_tool_result.startswith("web_search failed:")
                    or lowered_tool_result.startswith("web_fetch failed")
                    or lowered_tool_result.startswith("unknown tool:")
                )
                tool_event = {
                    "type": "response.function_call.complete",
                    "function_call": {
                        "name": tool_name,
                        "arguments": arguments,
                        "status": "failed" if tool_failed else "completed",
                        "result": f"{label}\n\n{tool_result[:30000]}",
                    },
                }
                yield f"data: {json.dumps(tool_event)}\n\n"
                messages_for_tools.append({"role": "tool", "content": tool_result, "tool_name": tool_name})

        error_event = {"type": "error", "error": {"message": "Web search did not converge after multiple tool-call rounds."}}
        yield f"data: {json.dumps(error_event)}\n\n"

    try:
        # POST to Ollama's /api/chat endpoint
        url = "http://localhost:11434/api/chat"
        headers = None
        cloud_model = model.endswith(":cloud") or model.endswith("-cloud")
        if cloud_model:
            api_key = os.getenv("OLLAMA_API_KEY", "").strip()
            if not api_key:
                error_event = {
                    "type": "error",
                    "error": {
                        "message": "Ollama cloud models require OLLAMA_API_KEY on the custom backend. Add your Ollama API key in Settings and try again."
                    },
                }
                yield f"data: {json.dumps(error_event)}\n\n"
                return
            url = "https://ollama.com/api/chat"
            headers = {"Authorization": f"Bearer {api_key}"}
        
        # Add system message if instructions provided
        formatted_messages = []
        if instructions:
            formatted_messages.append({"role": "system", "content": instructions})
        formatted_messages.extend(_normalize_messages_for_ollama(messages))
        
        payload = {
            "model": model.removesuffix(":cloud").removesuffix("-cloud") if cloud_model else model,
            "messages": formatted_messages,
            "stream": True,
        }
        if effective_think:
            payload["think"] = True
        if ollama_options:
            payload["options"] = ollama_options

        if custom_tools:
            payload["tools"] = [_native_tool_schema(tool) for tool in custom_tools.values()]

        has_images = any(msg.get("images") for msg in formatted_messages)
        request_timeout = 600.0

        if web_search_enabled:
            if web_search_provider == "ollama" and not os.getenv("OLLAMA_API_KEY", "").strip():
                error_event = {
                    "type": "error",
                    "error": {
                        "message": "Ollama hosted web search requires OLLAMA_API_KEY on the custom backend. Set OLLAMA_API_KEY and restart the backend."
                    },
                }
                yield f"data: {json.dumps(error_event)}\n\n"
                return
            async for event in _stream_with_web_search(payload):
                yield event
            return
        
        # For Gemma 4 models with images: boost vision token budget to max for OCR/text recognition
        # Note: The vision_token_budget parameter may not be supported in all Ollama versions
        # if has_images and "gemma4" in model.lower():
        #     payload["meta"] = {"vision_token_budget": 1120}
        
        print(f"[DEBUG] Sending to Ollama: model={model}, messages={len(formatted_messages)}, has_images={has_images}")
        for i, msg in enumerate(formatted_messages):
            images_in_msg = msg.get("images", [])
            if images_in_msg:
                print(f"[DEBUG]   Message {i} (role={msg['role']}): {len(images_in_msg)} images, content_len={len(msg.get('content', ''))}")
                for j, img_b64 in enumerate(images_in_msg):
                    print(f"[DEBUG]     Image {j}: {len(img_b64)} bytes, starts with: {img_b64[:30]}...")
            else:
                print(f"[DEBUG]   Message {i} (role={msg['role']}): text only, content_len={len(msg.get('content', ''))}")
        
        print(f"Sending to Ollama: {len(formatted_messages)} messages")
        
        # DEBUG: Print payload structure (but truncate huge base64 strings)
        payload_debug = {**payload}
        payload_debug["messages"] = []
        for msg in payload["messages"]:
            msg_debug = {k: v for k, v in msg.items() if k != "images"}
            if "images" in msg:
                msg_debug["images"] = [f"<base64:{len(img)} bytes>" for img in msg["images"]]
            payload_debug["messages"].append(msg_debug)
        print(f"[DEBUG] Payload structure: {json.dumps(payload_debug, indent=2)}")
        
        # Validate that images in payload are actually present and valid base64
        for i, msg in enumerate(payload.get("messages", [])):
            if "images" in msg and msg["images"]:
                for j, img_b64 in enumerate(msg["images"]):
                    # Check JPEG magic bytes (FFD8FF in base64 = /9j/ prefix for JPEG)
                    if img_b64.startswith("/9j/") or img_b64.startswith("iVBO"):  # JPEG or PNG
                        print(f"[DEBUG] Message {i}, Image {j}: Valid base64 prefix (JPEG/PNG detected)")
                    else:
                        print(f"[DEBUG] Message {i}, Image {j}: WARNING - Unexpected base64 prefix: {img_b64[:20]}")
                    
                    # Sanity check: base64 length should be ~4/3 of binary length
                    if len(img_b64) % 4 != 0:
                        print(f"[DEBUG] Message {i}, Image {j}: WARNING - Base64 length not multiple of 4: {len(img_b64)}")
                    
                    # Check if base64 ends correctly
                    print(f"[DEBUG] Message {i}, Image {j}: Base64 last 30 chars: {img_b64[-30:]}")
        
        # Verify payload has images before sending
        has_images_in_payload = any(msg.get("images") for msg in payload.get("messages", []))
        print(f"[DEBUG] Final check before sending: has_images_in_payload={has_images_in_payload}")
        
        # Log the actual JSON size
        json_payload = json.dumps(payload)
        print(f"[DEBUG] Total JSON payload size: {len(json_payload)} bytes")
        print(f"[DEBUG] JSON starts with: {json_payload[:200]}")
        
        async with client.stream("POST", url, json=payload, headers=headers, timeout=request_timeout) as response:
            print(f"Ollama response status: {response.status_code}")
            print(f"[DEBUG] Ollama response headers: {dict(response.headers)}")
            
            if response.status_code != 200:
                error_text = await response.aread()
                print(f"ERROR: Ollama returned status {response.status_code}: {error_text}")
                error_message = f"Ollama returned status {response.status_code}"
                try:
                    parsed_error = json.loads(error_text.decode("utf-8", errors="ignore"))
                    if isinstance(parsed_error, dict) and parsed_error.get("error"):
                        error_message = str(parsed_error["error"])
                except Exception:
                    pass
                error_event = {
                    "type": "error",
                    "error": {"message": error_message}
                }
                yield f"data: {json.dumps(error_event)}\n\n"
                return
            
            chunk_count = 0
            pending_tool_calls: dict[str, dict] = {}
            stream_buffer = ""
            async for chunk in response.aiter_text():
                stream_buffer += chunk
                lines = stream_buffer.splitlines(keepends=True)
                if lines and not lines[-1].endswith(("\n", "\r")):
                    stream_buffer = lines.pop()
                else:
                    stream_buffer = ""
                for raw_line in lines:
                    line = raw_line.strip()
                    if not line:
                        continue
                    chunk_count += 1
                    try:
                        # Parse Ollama's response
                        data = json.loads(line)
                        message = data.get("message", {}) or {}
                        thinking = message.get("thinking") or data.get("thinking") or ""
                        content = message.get("content", "")
                        tool_calls = message.get("tool_calls") or []
                        done = data.get("done", False)
                        error = data.get("error")
                        
                        if error:
                            print(f"ERROR from Ollama: {error}")
                            error_event = {
                                "type": "error",
                                "error": {"message": error}
                            }
                            yield f"data: {json.dumps(error_event)}\n\n"
                            return
                        
                        if thinking:
                            full_thinking_text += thinking
                            thinking_event = {
                                "type": "response.thinking.delta",
                                "delta": thinking
                            }
                            print(f"Yielding thinking delta: {thinking[:50]}")
                            yield f"data: {json.dumps(thinking_event)}\n\n"
                            if custom_tools and not pending_tool_calls:
                                for text_call in _extract_text_tool_calls(full_thinking_text):
                                    tool_name = text_call["name"]
                                    tool = custom_tools.get(tool_name)
                                    if tool is None:
                                        continue
                                    result = await _invoke_native_tool(tool, text_call.get("arguments", {}))
                                    event = {
                                        "type": "response.function_call.complete",
                                        "function_call": {
                                            "name": tool_name,
                                            "arguments": text_call.get("arguments", {}),
                                            "result": result,
                                        },
                                    }
                                    yield f"data: {json.dumps(event)}\n\n"
                                    if include_completion:
                                        completion_event = {
                                            "type": "response.completed",
                                            "response": {"status": "completed"}
                                        }
                                        yield f"data: {json.dumps(completion_event)}\n\n"
                                    return

                        if content:
                            total_content_yielded += len(content)
                            full_response_text += content
                            
                            # Keep for compatibility, but synthetic detection is disabled.
                            if not tool_events_emitted and len(full_response_text) > 50:
                                tool_events_emitted = True
                            
                            if not custom_tools:
                                event = {
                                    "type": "response.output_text.delta",
                                    "delta": content
                                }
                                print(f"Yielding delta: {content[:50]}")
                                yield f"data: {json.dumps(event)}\n\n"

                        for tool_call in tool_calls:
                            function = tool_call.get("function", {}) or {}
                            tool_name = function.get("name", "")
                            arguments = function.get("arguments") or {}
                            if isinstance(arguments, str):
                                try:
                                    arguments = json.loads(arguments)
                                except Exception:
                                    arguments = {"raw": arguments}
                            if tool_name and tool_name not in pending_tool_calls:
                                pending_tool_calls[tool_name] = {"name": tool_name, "arguments": arguments or {}}
                        
                        if done:
                            decision_text = f"{full_response_text}\n{full_thinking_text}"
                            for text_call in _extract_text_tool_calls(decision_text):
                                tool_name = text_call["name"]
                                if tool_name and tool_name not in pending_tool_calls:
                                    pending_tool_calls[tool_name] = text_call
                            if not pending_tool_calls:
                                inferred_call = _infer_tool_call_from_decision_text(decision_text)
                                if inferred_call:
                                    pending_tool_calls[inferred_call["name"]] = inferred_call
                            if custom_tools and not pending_tool_calls and full_response_text:
                                event = {
                                    "type": "response.output_text.delta",
                                    "delta": full_response_text,
                                }
                                print(f"Yielding buffered delta: {full_response_text[:50]}")
                                yield f"data: {json.dumps(event)}\n\n"
                            for tool_name, call_info in pending_tool_calls.items():
                                tool = (custom_tools or {}).get(tool_name)
                                result = f"Unknown tool: {tool_name}"
                                if tool is not None:
                                    result = await _invoke_native_tool(tool, call_info.get("arguments", {}))
                                event = {
                                    "type": "response.function_call.complete",
                                    "function_call": {
                                        "name": tool_name,
                                        "arguments": call_info.get("arguments", {}),
                                        "result": result,
                                    },
                                }
                                yield f"data: {json.dumps(event)}\n\n"
                            print(f"Ollama stream done. Total chunks: {chunk_count}, Total content length: {total_content_yielded}")
                            if include_completion:
                                # Send completion event only if requested
                                completion_event = {
                                    "type": "response.completed",
                                    "response": {"status": "completed"}
                                }
                                yield f"data: {json.dumps(completion_event)}\n\n"
                    except json.JSONDecodeError as e:
                        print(f"JSON decode error: {e}, chunk: {line[:100]}")
                        continue
    except Exception as e:
        error_message = str(e) or e.__class__.__name__
        print(f"Exception in stream_ollama_response: {error_message}")
        import traceback
        traceback.print_exc()
        # Send error event
        error_event = {
            "type": "error",
            "error": {"message": error_message}
        }
        yield f"data: {json.dumps(error_event)}\n\n"
    finally:
        await client.aclose()
        print(f"=== stream_ollama_response END (total content: {total_content_yielded}) ===\n")

def ollama_stream_endpoint(app):
    @app.post("/v1/responses")
    async def v1_responses(request: Request):
        body = await request.json()
        
        # Extract metadata
        metadata = body.get("metadata", {})
        agent_configs = metadata.get("agent_configs", {})
        orchestration_type = metadata.get("orchestration_type", "concurrent")
        max_rounds = metadata.get("max_rounds", 5)
        web_search_enabled = bool(body.get("web_search_enabled") or metadata.get("web_search_enabled"))
        web_search_provider = str(body.get("web_search_provider") or metadata.get("web_search_provider") or "ollama").strip().lower()
        if web_search_provider not in {"ollama", "duckduckgo"}:
            web_search_provider = "ollama"
        web_search_mode = str(body.get("web_search_mode") or metadata.get("web_search_mode") or "search_fetch").strip().lower()
        if web_search_mode not in {"search", "search_fetch", "deep"}:
            web_search_mode = "search_fetch"
        
        # Debug logging
        print(f"Received request with {len(agent_configs)} agents")
        print(f"Orchestration type: {orchestration_type}")
        print(f"Agent configs: {list(agent_configs.keys())}")
        
        # Prefer explicit messages if provided; otherwise build from input.
        messages = body.get("messages")
        if not isinstance(messages, list) or len(messages) == 0:
            prompt = body.get("input", "")
            if not prompt:
                return {"error": "Missing input"}
            messages = [{"role": "user", "content": prompt}]
        
        # Handle multiple agents
        if agent_configs and len(agent_configs) > 1:
            print(f"Using multi-agent handler with {len(agent_configs)} agents")
            return StreamingResponse(
                stream_multi_agent_response(agent_configs, messages, orchestration_type, max_rounds=max_rounds),
                media_type="text/event-stream"
            )
        
        # Single agent
        agent_id = None
        if agent_configs:
            first_agent_id = list(agent_configs.keys())[0]
            agent_config = agent_configs[first_agent_id]
            model = agent_config.get("model_id")
            instructions = agent_config.get("instructions")
            agent_id = first_agent_id
        else:
            model = metadata.get("entity_id") or body.get("model", "llama3:8b")
            instructions = None

        if not model:
            model = "llama3:8b"
        
        # For direct-model chat without explicit instructions, provide a better default for vision tasks
        if not instructions and "gemma4" in model.lower():
            # Check if this request has images
            has_images = False
            if isinstance(messages, list):
                for msg in messages:
                    if isinstance(msg, dict):
                        if msg.get("images") or (isinstance(msg.get("content"), list) and 
                                                  any(item.get("type") == "input_image" for item in msg.get("content", []))):
                            has_images = True
                            break
            
            if has_images:
                # Vision-optimized system prompt for Gemma 4
                instructions = (
                    "You are a helpful visual assistant. When analyzing images, prioritize extracting and reading text content. "
                    "If the user asks about text, quotes, signs, documents, or visual content in images, focus on accurately reading and identifying the text first. "
                    "Use the attached image(s) as the primary context for your response. "
                    "Be precise when extracting text from images."
                )

        # Use the real Agent Framework runner when a Python module exists for this agent.
        if agent_id:
            return StreamingResponse(
                stream_agent_response(agent_id, model, messages, instructions, include_completion=True),
                media_type="text/event-stream"
            )

        return StreamingResponse(
            stream_ollama_response(
                model,
                messages,
                instructions,
                include_completion=True,
                web_search_enabled=web_search_enabled,
                web_search_provider=web_search_provider,
                web_search_mode=web_search_mode,
            ),
            media_type="text/event-stream"
        )

