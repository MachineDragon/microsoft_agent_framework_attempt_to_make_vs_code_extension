/**
 * API client for custom UI
 * Handles all backend communication including SSE streaming
 */

import type {
  AgentInfo,
  WorkflowInfo,
  Conversation,
  HealthResponse,
  MetaResponse,
} from "@/types";
import type { AgentFrameworkRequest } from "@/types/agent-framework";
import type { ExtendedResponseStreamEvent } from "@/types/openai";
import { isVscodeBridgeAvailable, requestVscode } from "@/services/vscodeBridge";

type BudAIRuntimeConfig = {
  customBackendBaseUrl?: string;
  devuiBackendBaseUrl?: string;
  ollamaEndpoint?: string;
};

declare global {
  interface Window {
    __BUDAI_CONFIG__?: BudAIRuntimeConfig;
  }
}

const DEFAULT_DEVUI_BASE_URL = "http://localhost:8080";
const DEFAULT_CUSTOM_BACKEND_BASE_URL = "http://localhost:8081";

function getBudAIRuntimeConfig(): BudAIRuntimeConfig {
  return typeof window !== "undefined" ? window.__BUDAI_CONFIG__ ?? {} : {};
}

const DEFAULT_API_BASE_URL = getBudAIRuntimeConfig().devuiBackendBaseUrl || DEFAULT_DEVUI_BASE_URL;

class ApiClient {
  private baseUrl: string = DEFAULT_API_BASE_URL;
  private authToken: string | null = null;

  constructor() {}

  setBaseUrl(url: string) {
    this.baseUrl = url;
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  private getCustomBackendBaseUrl(): string {
    return getBudAIRuntimeConfig().customBackendBaseUrl || DEFAULT_CUSTOM_BACKEND_BASE_URL;
  }

  private customBackendUrl(endpoint: string): string {
    return `${this.getCustomBackendBaseUrl()}${endpoint}`;
  }

  private devuiBackendUrl(endpoint: string): string {
    return `${this.baseUrl}${endpoint}`;
  }

  setAuthToken(token: string | null): void {
    this.authToken = token;
  }

  clearAuthToken(): void {
    this.setAuthToken(null);
  }

  private async request<T>(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(options.headers as Record<string, string>),
    };

    if (this.authToken) {
      headers["Authorization"] = `Bearer ${this.authToken}`;
    }

    const response = await fetch(url, {
      ...options,
      headers,
    });

    if (!response.ok) {
      if (response.status === 401) {
        this.clearAuthToken();
      }
      const error = await response.json().catch(() => ({
        error: { message: response.statusText },
      }));
      throw new Error(error.error?.message || response.statusText);
    }

    return response.json();
  }

  async getHealth(): Promise<HealthResponse> {
    return this.request<HealthResponse>("/health");
  }

  async getMeta(): Promise<MetaResponse> {
    return this.request<MetaResponse>("/meta");
  }

  async getEntities(): Promise<{ agents: AgentInfo[]; workflows: WorkflowInfo[] }> {
    const response = await this.request<{ entities: Array<AgentInfo | WorkflowInfo> }>("/v1/entities");
    let agents = response.entities.filter((e) => e.type === "agent") as AgentInfo[];
    const workflows = response.entities.filter((e) => e.type === "workflow") as WorkflowInfo[];

    if (agents.length === 0) {
      const folderResponse = await fetch(this.customBackendUrl("/api/agents/folders"));
      if (folderResponse.ok) {
        const folderData = await folderResponse.json() as { agents?: AgentInfo[] };
        agents = folderData.agents || [];
      }
    }

    return { agents, workflows };
  }

  async getEntityInfo(entityId: string): Promise<AgentInfo | WorkflowInfo> {
    return this.request<AgentInfo | WorkflowInfo>(`/v1/entities/${entityId}/info`);
  }

  async reloadEntity(entityId: string): Promise<{ success: boolean; message: string }> {
    return this.request(`/v1/entities/${entityId}/reload`, { method: "POST" });
  }

  async getOllamaModels(): Promise<Array<{
    name: string;
    id: string;
    size: string;
    modified: string;
    capabilities?: string[];
    architecture?: string;
    parameters?: string;
    context_length?: string;
    embedding_length?: string;
    quantization?: string;
  }>> {
    try {
      const endpoints = [this.customBackendUrl("/v1/models/ollama"), this.devuiBackendUrl("/v1/models/ollama")];
      for (const endpoint of endpoints) {
        try {
          const response = await fetch(endpoint);
          if (!response.ok) {
            continue;
          }
          const data = await response.json();
          console.log('Ollama models response:', data);
          if (data.error) {
            console.error('Ollama error:', data.error);
            continue;
          }
          return data.models || [];
        } catch {
          // Try next endpoint
        }
      }
      return [];
    } catch (error) {
      console.error('Failed to fetch Ollama models:', error);
      return [];
    }
  }

  async pullOllamaModel(name: string): Promise<{ success: boolean; job_id: string; name: string; message: string }> {
    const response = await fetch(this.customBackendUrl("/v1/models/ollama/pull"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({ detail: response.statusText }));
      throw new Error(error.detail || response.statusText);
    }
    return response.json();
  }

  async getOllamaModelPullJob(jobId: string): Promise<{
    job_id: string;
    name: string;
    status: string;
    completed?: number | null;
    total?: number | null;
    percent?: number | null;
    done: boolean;
    error?: string | null;
  }> {
    const response = await fetch(this.customBackendUrl(`/v1/models/ollama/pull/${encodeURIComponent(jobId)}`));
    if (!response.ok) {
      const error = await response.json().catch(() => ({ detail: response.statusText }));
      throw new Error(error.detail || response.statusText);
    }
    return response.json();
  }

  async deleteOllamaModel(name: string): Promise<{ success: boolean; message: string }> {
    const response = await fetch(this.customBackendUrl("/v1/models/ollama"), {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({ detail: response.statusText }));
      throw new Error(error.detail || response.statusText);
    }
    return response.json();
  }

  async getCustomSettings(): Promise<{ ollama_api_key_configured: boolean }> {
    if (isVscodeBridgeAvailable()) {
      return requestVscode<{ ollama_api_key_configured: boolean }>("settings.get");
    }

    const response = await fetch(this.customBackendUrl("/api/settings"));
    if (!response.ok) {
      const error = await response.json().catch(() => ({ detail: response.statusText }));
      throw new Error(error.detail || response.statusText);
    }
    return response.json();
  }

  async updateCustomSettings(settings: { ollama_api_key?: string; clear_ollama_api_key?: boolean }): Promise<{ ollama_api_key_configured: boolean }> {
    if (isVscodeBridgeAvailable()) {
      return requestVscode<{ ollama_api_key_configured: boolean }>("settings.update", settings);
    }

    const response = await fetch(this.customBackendUrl("/api/settings"), {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(settings),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({ detail: response.statusText }));
      throw new Error(error.detail || response.statusText);
    }
    return response.json();
  }

  async getUserStorageItem(name: string): Promise<string | null> {
    const response = await fetch(this.customBackendUrl(`/api/storage/${encodeURIComponent(name)}`));
    if (!response.ok) {
      return null;
    }
    const data = await response.json();
    return typeof data.value === "string" ? data.value : null;
  }

  async setUserStorageItem(name: string, value: string): Promise<void> {
    const response = await fetch(this.customBackendUrl(`/api/storage/${encodeURIComponent(name)}`), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value }),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({ detail: response.statusText }));
      throw new Error(error.detail || response.statusText);
    }
  }

  async removeUserStorageItem(name: string): Promise<void> {
    const response = await fetch(this.customBackendUrl(`/api/storage/${encodeURIComponent(name)}`), { method: "DELETE" });
    if (!response.ok) {
      const error = await response.json().catch(() => ({ detail: response.statusText }));
      throw new Error(error.detail || response.statusText);
    }
  }

  async listIDEFiles(): Promise<{ root: string; files: Array<{ type: "file" | "folder"; name: string; children?: any[] }> }> {
    const response = await fetch(this.customBackendUrl("/api/ide/files"));
    if (!response.ok) {
      const error = await response.json().catch(() => ({ detail: response.statusText }));
      throw new Error(error.detail || response.statusText);
    }
    return response.json();
  }

  async openIDEFolder(path: string): Promise<{ root: string; files: Array<{ type: "file" | "folder"; name: string; children?: any[] }> }> {
    const response = await fetch(this.customBackendUrl("/api/ide/folder"), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({ detail: response.statusText }));
      throw new Error(error.detail || response.statusText);
    }
    return response.json();
  }

  async pickIDEFolder(): Promise<{ cancelled?: boolean; root: string; files: Array<{ type: "file" | "folder"; name: string; children?: any[] }> }> {
    const response = await fetch(this.customBackendUrl("/api/ide/folder/pick"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({ detail: response.statusText }));
      throw new Error(error.detail || response.statusText);
    }
    return response.json();
  }

  async readIDEFile(path: string): Promise<{ path: string; content: string }> {
    const response = await fetch(this.customBackendUrl(`/api/ide/file?path=${encodeURIComponent(path)}`));
    if (!response.ok) {
      const error = await response.json().catch(() => ({ detail: response.statusText }));
      throw new Error(error.detail || response.statusText);
    }
    return response.json();
  }

  async writeIDEFile(path: string, content: string): Promise<{ success: boolean; path: string }> {
    const response = await fetch(this.customBackendUrl("/api/ide/file"), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, content }),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({ detail: response.statusText }));
      throw new Error(error.detail || response.statusText);
    }
    return response.json();
  }

  async searchIDEFiles(query: string, maxResults = 50): Promise<{ query: string; matches: Array<{ path: string; line: number; text: string }> }> {
    const response = await fetch(this.customBackendUrl("/api/ide/search"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, max_results: maxResults }),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({ detail: response.statusText }));
      throw new Error(error.detail || response.statusText);
    }
    return response.json();
  }

  async listIDECSVFiles(): Promise<{ root: string; files: string[] }> {
    const response = await fetch(this.customBackendUrl("/api/ide/csv-files"));
    if (!response.ok) {
      const error = await response.json().catch(() => ({ detail: response.statusText }));
      throw new Error(typeof error.detail === "string" ? error.detail : JSON.stringify(error.detail || response.statusText));
    }
    return response.json();
  }

  async readIDECSVFile(path: string): Promise<{ path: string; content: string }> {
    const response = await fetch(this.customBackendUrl(`/api/ide/csv-file?path=${encodeURIComponent(path)}`));
    if (!response.ok) {
      const error = await response.json().catch(() => ({ detail: response.statusText }));
      throw new Error(typeof error.detail === "string" ? error.detail : JSON.stringify(error.detail || response.statusText));
    }
    return response.json();
  }

  async pickDataCSVFiles(): Promise<{ cancelled?: boolean; files: Array<{ path: string; filename: string; content: string; last_modified: string }> }> {
    const response = await fetch(this.customBackendUrl("/api/data/csv/pick"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({ detail: response.statusText }));
      throw new Error(typeof error.detail === "string" ? error.detail : JSON.stringify(error.detail || response.statusText));
    }
    return response.json();
  }

  async searchIDEWeb(
    query: string,
    maxResults = 5,
    allowedDomains: string[] = [],
    blockedDomains: string[] = [],
    provider: "auto" | "ollama" | "duckduckgo" = "auto"
  ): Promise<{
    provider: string;
    query: string;
    results: Array<{ title?: string; url?: string; content?: string; snippet?: string }>;
    duration_seconds: number;
    fallback_errors?: string[];
  }> {
    const response = await fetch(this.customBackendUrl("/api/ide/web/search"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, max_results: maxResults, provider, allowed_domains: allowedDomains, blocked_domains: blockedDomains }),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({ detail: response.statusText }));
      throw new Error(typeof error.detail === "string" ? error.detail : JSON.stringify(error.detail || response.statusText));
    }
    return response.json();
  }

  async fetchIDEWeb(url: string, prompt: string): Promise<{
    url: string;
    final_url?: string;
    title?: string;
    status_code?: number;
    content_type?: string;
    bytes?: number;
    markdown: string;
    cached: boolean;
    redirected?: boolean;
    redirect_url?: string;
    duration_seconds: number;
    prompt: string;
  }> {
    const response = await fetch(this.customBackendUrl("/api/ide/web/fetch"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, prompt }),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({ detail: response.statusText }));
      throw new Error(typeof error.detail === "string" ? error.detail : JSON.stringify(error.detail || response.statusText));
    }
    return response.json();
  }

  async transcribeSpeech(blob: Blob, language?: string): Promise<{
    text: string;
    engine: string;
    model: string;
    language?: string | null;
    duration?: number | null;
    duration_seconds: number;
    bytes: number;
  }> {
    const form = new FormData();
    const extension = blob.type.includes("ogg") ? "ogg" : "webm";
    form.append("file", blob, `notes-recording.${extension}`);

    const params = language ? `?language=${encodeURIComponent(language)}` : "";
  const response = await fetch(this.customBackendUrl(`/api/speech/transcribe${params}`), {
      method: "POST",
      body: form,
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({ detail: response.statusText }));
      throw new Error(typeof error.detail === "string" ? error.detail : JSON.stringify(error.detail || response.statusText));
    }
    return response.json();
  }

  async runIDECommand(command: string, timeoutSeconds = 30, cwd?: string, stdin?: string[] | string): Promise<{ exit_code: number; output: string; cwd: string }> {
    const response = await fetch(this.customBackendUrl("/api/ide/command"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command, timeout_seconds: timeoutSeconds, cwd, stdin }),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({ detail: response.statusText }));
      throw new Error(typeof error.detail === "string" ? error.detail : JSON.stringify(error.detail || response.statusText));
    }
    return response.json();
  }

  async startIDETerminal(command: string, cwd?: string): Promise<{ session_id: string; output: string; running: boolean; exit_code: number | null; cwd: string }> {
    const response = await fetch(this.customBackendUrl("/api/ide/terminal/start"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command, cwd }),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({ detail: response.statusText }));
      throw new Error(typeof error.detail === "string" ? error.detail : JSON.stringify(error.detail || response.statusText));
    }
    return response.json();
  }

  async readIDETerminal(sessionId: string): Promise<{ session_id: string; output: string; running: boolean; exit_code: number | null; cwd: string }> {
    const response = await fetch(this.customBackendUrl(`/api/ide/terminal/${sessionId}`));
    if (!response.ok) {
      const error = await response.json().catch(() => ({ detail: response.statusText }));
      throw new Error(typeof error.detail === "string" ? error.detail : JSON.stringify(error.detail || response.statusText));
    }
    return response.json();
  }

  async writeIDETerminal(sessionId: string, input: string): Promise<{ success: boolean }> {
    const response = await fetch(this.customBackendUrl(`/api/ide/terminal/${sessionId}/input`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input }),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({ detail: response.statusText }));
      throw new Error(typeof error.detail === "string" ? error.detail : JSON.stringify(error.detail || response.statusText));
    }
    return response.json();
  }

  async stopIDETerminal(sessionId: string): Promise<{ success: boolean; output: string }> {
    const response = await fetch(this.customBackendUrl(`/api/ide/terminal/${sessionId}`), { method: "DELETE" });
    if (!response.ok) {
      const error = await response.json().catch(() => ({ detail: response.statusText }));
      throw new Error(typeof error.detail === "string" ? error.detail : JSON.stringify(error.detail || response.statusText));
    }
    return response.json();
  }

  async *streamDirectModelChat(
    model: string,
    messages: Array<{ role: "user" | "assistant" | "system"; content: string }>,
    signal?: AbortSignal,
    imageDataUrls: string[] = [],
    webSearchEnabled = false,
    webSearchProvider?: "ollama" | "duckduckgo",
    webSearchMode?: "search" | "search_fetch" | "deep"
  ): AsyncGenerator<
    | { type: "content" | "thinking"; delta: string }
    | { type: "tool_event"; event: ExtendedResponseStreamEvent }
  > {
    const latestUserMessage = [...messages]
      .reverse()
      .find((m) => m.role === "user" && typeof m.content === "string" && m.content.trim().length > 0);

    const outboundMessages: Array<{
      role: "user" | "assistant" | "system";
      content: string;
      images?: string[];
    }> = messages.map((m) => ({ role: m.role, content: m.content }));

    if (imageDataUrls.length > 0) {
      const lastUserIndex = [...outboundMessages]
        .map((m, i) => ({ m, i }))
        .reverse()
        .find(({ m }) => m.role === "user")?.i;

      if (typeof lastUserIndex === "number") {
        const current = outboundMessages[lastUserIndex];
        const text = typeof current.content === "string" ? current.content : "";
        
        // Gemma 4 best practice: Images work best when the question is clear before/with the image
        // Restructure to guide the model to read the image content first
        const groundedText = [
          text, // User's question comes first to frame what to look for
          "Analyze only the attached image(s) in this current message. Do not rely on earlier image descriptions or prior guesses. If the current image is unclear, say what visible details you can actually identify.",
        ]
          .filter(Boolean)
          .join("\n\n");
          
        outboundMessages[lastUserIndex] = {
          ...current,
          content: groundedText,
          images: imageDataUrls,
        };
        console.log(`[DEBUG API] Added ${imageDataUrls.length} images to user message, content_len=${groundedText.length}`);
      }
    }

    const response = await fetch(this.customBackendUrl("/v1/responses"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        input: latestUserMessage?.content || "",
        model,
        messages: outboundMessages,
        stream: true,
        web_search_enabled: webSearchEnabled,
        web_search_provider: webSearchProvider,
        web_search_mode: webSearchMode,
      }),
      signal,
    });

    console.log(`[DEBUG API] Fetch response status: ${response.status}, ok: ${response.ok}`);

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[DEBUG API] HTTP error response:`, errorText);
      throw new Error(`HTTP error! status: ${response.status}, body: ${errorText}`);
    }

    const reader = response.body?.getReader();
    const decoder = new TextDecoder();

    if (!reader) {
      throw new Error("No response body");
    }

    let buffer = "";
    let lineCount = 0;
    let chunkYieldCount = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        console.log(`[DEBUG API] Stream done, total lines processed: ${lineCount}, chunks yielded: ${chunkYieldCount}`);
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        lineCount++;
        const trimmed = line.trim();
        if (!trimmed) {
          console.log(`[DEBUG API] Line ${lineCount}: (empty)`);
          continue;
        }

        if (trimmed === "data: [DONE]") {
          console.log(`[DEBUG API] Line ${lineCount}: Received [DONE] marker`);
          return;
        }

        // Handle both "data: " prefix (from errors/SSE) and raw JSON (from Ollama)
        const payload = trimmed.startsWith("data: ") ? trimmed.slice(6) : trimmed;
        console.log(`[DEBUG API] Line ${lineCount}: raw payload =`, payload.substring(0, 150));

        let parsed: any;
        try {
          parsed = JSON.parse(payload);
          console.log(`[DEBUG API] Line ${lineCount}: parsed keys =`, Object.keys(parsed));
        } catch (e) {
          console.log(`[DEBUG API] Line ${lineCount}: JSON parse error:`, (e as Error).message);
          // Ignore malformed stream lines and continue reading.
          continue;
        }

        // Check for error response and propagate to caller/UI.
        if (parsed?.type === "error") {
          const errorMsg = parsed?.error?.message || "Unknown error";
          console.error(`[DEBUG API] Line ${lineCount}: ERROR from backend: ${errorMsg}`);
          throw new Error(errorMsg);
        }

        if (parsed?.type === "response.function_call.complete") {
          chunkYieldCount++;
          console.log(`[DEBUG API] Tool event ${chunkYieldCount}:`, parsed?.function_call?.name || parsed?.data?.name || "tool");
          yield { type: "tool_event", event: parsed as ExtendedResponseStreamEvent };
        }

        const thinking = parsed?.type === "response.thinking.delta"
          ? parsed?.delta
          : parsed?.message?.thinking ?? parsed?.thinking;
        if (typeof thinking === "string" && thinking.length > 0) {
          chunkYieldCount++;
          console.log(`[DEBUG API] Thinking chunk ${chunkYieldCount}: yielding`, thinking.substring(0, 50));
          yield { type: "thinking", delta: thinking };
        }

        // Support both wrapper SSE format and raw Ollama format.
        const content = parsed?.type === "response.output_text.delta"
          ? parsed?.delta
          : parsed?.message?.content;
        if (typeof content === "string" && content.length > 0) {
          chunkYieldCount++;
          console.log(`[DEBUG API] Chunk ${chunkYieldCount}: yielding`, content.substring(0, 50));
          yield { type: "content", delta: content };
        }

        if (parsed?.type === "response.completed" || parsed?.done === true) {
          console.log(`[DEBUG API] Line ${lineCount}: Received completion marker`);
          return;
        }
      }
    }
  }

  async updateEntity(
    entityId: string,
    updates: {
      instructions?: string;
      model_id?: string;
      temperature?: number;
      max_tokens?: number;
    }
  ): Promise<{ success: boolean; message: string }> {
    return this.request(`/v1/entities/${entityId}/update`, {
      method: "POST",
      body: JSON.stringify(updates),
    });
  }

  async createAgent(agentData: {
    name: string;
    description?: string;
    instructions: string;
    model_id?: string;
    temperature?: number;
    max_tokens?: number;
    tools?: string[];
  }): Promise<AgentInfo> {
    return this.request("/v1/agents", {
      method: "POST",
      body: JSON.stringify(agentData),
    });
  }

  async createAgentAsFolder(agentData: {
    name: string;
    description: string;
    instructions: string;
    model: string;
    tools?: string[];
    toolCode?: Array<{ id: string; name: string; code: string }>;
  }): Promise<{ success: boolean; id: string; message: string; path: string }> {
    const response = await fetch(this.customBackendUrl("/api/agents/create-folder"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ...agentData, tool_code: agentData.toolCode ?? [] }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ message: response.statusText }));
      throw new Error(
        error.detail ||
        error.message ||
        (Array.isArray(error) && error[0]?.msg) ||
        `HTTP error! status: ${response.status}`
      );
    }

    return response.json();
  }

  async updateAgentFolder(agentId: string, agentData: {
    name: string;
    description: string;
    instructions: string;
    model: string;
    tools?: string[];
    toolCode?: Array<{ id: string; name: string; code: string }>;
  }): Promise<{ success: boolean; id: string; message: string; path: string }> {
    const response = await fetch(this.customBackendUrl(`/api/agents/${encodeURIComponent(agentId)}/update-folder`), {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ...agentData, tool_code: agentData.toolCode ?? [] }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ message: response.statusText }));
      throw new Error(
        error.detail ||
        error.message ||
        (Array.isArray(error) && error[0]?.msg) ||
        `HTTP error! status: ${response.status}`
      );
    }

    return response.json();
  }

  async generateAgentWithAI(request: {
    prompt: string;
    model?: string;
    availableModels?: string[];
    userSelectedModel?: string;
    availableTools?: string[];
    selectedTools?: string[];
  }): Promise<{ name: string; description: string; instructions: string; model: string }> {
    const response = await fetch(this.customBackendUrl("/api/agents/generate"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        prompt: request.prompt,
        model: request.model,
        available_models: request.availableModels || [],
        user_selected_model: request.userSelectedModel,
        available_tools: request.availableTools || [],
        selected_tools: request.selectedTools || [],
      }),
    });

    if (!response.ok) {
      if (response.status === 404) {
        throw new Error("AI generation endpoint not found on port 8081. Restart the Custom Backend so it loads the latest routes.");
      }
      const error = await response.json().catch(() => ({ message: response.statusText }));
      throw new Error(error.detail || error.message || `HTTP error! status: ${response.status}`);
    }

    return response.json();
  }

  async generateToolWithAI(request: {
    prompt: string;
    model?: string;
    availableModels?: string[];
    toolType?: 'auto' | 'function' | 'hosted_code_interpreter' | 'hosted_file_search' | 'hosted_web_search' | 'hosted_mcp';
  }): Promise<{ name: string; description: string; tool_type: string; code: string; model: string }> {
    const response = await fetch(this.customBackendUrl("/api/tools/generate"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        prompt: request.prompt,
        model: request.model,
        available_models: request.availableModels || [],
        tool_type: request.toolType || 'auto',
      }),
    });

    if (!response.ok) {
      if (response.status === 404) {
        throw new Error("AI tool generation endpoint not found on port 8081. Restart the Custom Backend so it loads the latest routes.");
      }
      const error = await response.json().catch(() => ({ message: response.statusText }));
      throw new Error(error.detail || error.message || `HTTP error! status: ${response.status}`);
    }

    return response.json();
  }

  async installToolDependencies(code: string): Promise<{ detected: string[]; installed: string[]; skipped: string[]; message: string }> {
    const response = await fetch(this.customBackendUrl("/api/tools/install-dependencies"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ code }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ message: response.statusText }));
      throw new Error(error.detail || error.message || `HTTP error! status: ${response.status}`);
    }

    return response.json();
  }

  async updateAgent(agentId: string, agentData: {
    name?: string;
    description?: string;
    instructions?: string;
    model_id?: string;
    temperature?: number;
    max_tokens?: number;
    tools?: string[];
  }): Promise<AgentInfo> {
    return this.request(`/v1/agents/${agentId}`, {
      method: "PUT",
      body: JSON.stringify(agentData),
    });
  }

  async deleteAgent(agentId: string): Promise<void> {
    await this.request(`/v1/agents/${agentId}`, {
      method: "DELETE",
    });
  }

  async deleteAgentFolder(agentId: string): Promise<void> {
    const response = await fetch(this.customBackendUrl(`/api/agents/${encodeURIComponent(agentId)}/delete-folder`), {
      method: "DELETE",
      headers: {
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ message: response.statusText }));
      throw new Error(error.detail || error.message || `HTTP error! status: ${response.status}`);
    }
  }

  async createConversation(metadata?: Record<string, any>): Promise<Conversation> {
    return this.request("/v1/conversations", {
      method: "POST",
      body: JSON.stringify({ metadata: metadata || {} }),
    });
  }

  async listConversations(agentId?: string): Promise<Conversation[]> {
    const params = agentId ? `?agent_id=${agentId}` : "";
    const response: { data: Conversation[]; has_more: boolean } = await this.request(`/v1/conversations${params}`);
    return response.data;
  }

  async getConversation(conversationId: string): Promise<Conversation> {
    return this.request(`/v1/conversations/${conversationId}`);
  }

  async deleteConversation(conversationId: string): Promise<void> {
    await this.request(`/v1/conversations/${conversationId}`, { method: "DELETE" });
  }

  async getConversationItems(conversationId: string) {
    return this.request(`/v1/conversations/${conversationId}/items`);
  }

  async updateConversation(conversationId: string, metadata: Record<string, string>): Promise<Conversation> {
    return this.request(`/v1/conversations/${conversationId}`, {
      method: "POST",
      body: JSON.stringify({ metadata }),
    });
  }

  async createConversationItems(conversationId: string, items: any[]): Promise<any> {
    return this.request(`/v1/conversations/${conversationId}/items`, {
      method: "POST",
      body: JSON.stringify({ items }),
    });
  }

  async getConversationItem(conversationId: string, itemId: string): Promise<any> {
    return this.request(`/v1/conversations/${conversationId}/items/${itemId}`);
  }

  async deleteConversationItem(conversationId: string, itemId: string): Promise<void> {
    await this.request(`/v1/conversations/${conversationId}/items/${itemId}`, {
      method: "DELETE",
    });
  }

  // Deployment endpoints
  async createDeployment(config: {
    entity_id: string;
    resource_group: string;
    app_name: string;
    region?: string;
    ui_mode?: string;
    ui_enabled?: boolean;
    stream?: boolean;
  }): Promise<any> {
    return this.request("/v1/deployments", {
      method: "POST",
      body: JSON.stringify(config),
    });
  }

  async listDeployments(entityId?: string): Promise<any[]> {
    const params = entityId ? `?entity_id=${entityId}` : "";
    return this.request(`/v1/deployments${params}`);
  }

  async getDeployment(deploymentId: string): Promise<any> {
    return this.request(`/v1/deployments/${deploymentId}`);
  }

  async deleteDeployment(deploymentId: string): Promise<void> {
    await this.request(`/v1/deployments/${deploymentId}`, {
      method: "DELETE",
    });
  }

  async deployEntity(entityId: string, config: {
    resource_group: string;
    app_name: string;
    region?: string;
    ui_mode?: string;
    ui_enabled?: boolean;
    stream?: boolean;
  }): Promise<any> {
    return this.request(`/v1/entities/${entityId}/deploy`, {
      method: "POST",
      body: JSON.stringify({ entity_id: entityId, ...config }),
    });
  }

  async *streamResponses(
    request: AgentFrameworkRequest,
    onEvent?: (event: ExtendedResponseStreamEvent) => void,
    useCustomBackend: boolean = false,
    signal?: AbortSignal
  ): AsyncGenerator<ExtendedResponseStreamEvent> {
    // Use custom backend (8081) for user-created agents, DevUI backend (8080) for others
    const backendUrl = useCustomBackend ? this.getCustomBackendBaseUrl() : this.baseUrl;
    const url = `${backendUrl}/v1/responses`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    };

    if (this.authToken && !useCustomBackend) {
      headers["Authorization"] = `Bearer ${this.authToken}`;
    }

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ ...request, stream: true }),
      signal,
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const reader = response.body?.getReader();
    const decoder = new TextDecoder();

    if (!reader) {
      throw new Error("No response body");
    }

    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (line.startsWith("data: ")) {
          const data = line.slice(6);
          if (data === "[DONE]") {
            return;
          }
          try {
            const event = JSON.parse(data) as ExtendedResponseStreamEvent;
            if (onEvent) onEvent(event);
            yield event;
          } catch (e) {
            console.error("Failed to parse event:", data, e);
          }
        }
      }
    }
  }
}

export const apiClient = new ApiClient();
