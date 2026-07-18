import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { createExtensionJSONStorage } from '@/stores/extensionStorage';

export interface Tool {
  id: string;
  name: string;
  description: string;
  code: string;
  created_at: string;
  isDefault?: boolean; // Default tools cannot be deleted
}

// Default tools from Microsoft Agent Framework
const DEFAULT_TOOLS: Tool[] = [
  {
    id: 'code_interpreter',
    name: 'Ollama Code Interpreter',
    description: 'Local @ai_function adapter that lets an Ollama agent execute short Python scripts through the custom backend.',
    code: `from agent_framework import ai_function

  @ai_function
  def code_interpreter(code: str) -> str:
    """Execute a short Python script locally and return stdout, stderr, and the exit code."""
    # Generated agent folders include the full local executor implementation.
    ...
`,
    created_at: new Date().toISOString(),
    isDefault: true,
  },
  {
    id: 'web_search',
    name: 'HostedWebSearchTool',
    description: 'Official hosted provider tool marker for web search; local Ollama agents use the custom backend web-search route instead.',
    code: `from agent_framework import HostedWebSearchTool

tool = HostedWebSearchTool()

# With optional location context:
# tool = HostedWebSearchTool(
#     additional_properties={"user_location": {"city": "Seattle", "country": "US"}}
# )
`,
    created_at: new Date().toISOString(),
    isDefault: true,
  },
  {
    id: 'file_search',
    name: 'HostedFileSearchTool',
    description: 'Official hosted provider tool marker for provider-indexed files/vector stores; local Ollama needs a custom retrieval adapter.',
    code: `from agent_framework import HostedFileSearchTool

tool = HostedFileSearchTool()

# With vector-store inputs and max results:
# tool = HostedFileSearchTool(inputs=[{"vector_store_id": "vs_123"}], max_results=10)
`,
    created_at: new Date().toISOString(),
    isDefault: true,
  },
  {
    id: 'hosted_mcp',
    name: 'HostedMCPTool',
    description: 'Official hosted MCP definition managed by a capable AI service; local Ollama needs a local MCP adapter.',
    code: `from agent_framework import HostedMCPTool

tool = HostedMCPTool(
    name="my_mcp_tool",
    url="https://example.com/mcp",
)

# Optional: approval_mode, allowed_tools, headers, and description.
`,
    created_at: new Date().toISOString(),
    isDefault: true,
  },
];

interface ToolState {
  tools: Tool[];
  addTool: (tool: Tool) => void;
  deleteTool: (toolId: string) => void;
  updateTool: (toolId: string, updates: Partial<Tool>) => void;
  getTool: (toolId: string) => Tool | undefined;
  getDefaultTools: () => Tool[];
  getUserTools: () => Tool[];
}

export const useToolStore = create<ToolState>()(
  persist(
    (set, get) => ({
      tools: DEFAULT_TOOLS, // Initialize with default tools
      
      addTool: (tool) => {
        set((state) => ({
          tools: [...state.tools, tool],
        }));
      },
      
      deleteTool: (toolId) => {
        const tool = get().getTool(toolId);
        if (tool?.isDefault) {
          console.warn('Cannot delete default tools');
          return;
        }
        set((state) => ({
          tools: state.tools.filter(t => t.id !== toolId),
        }));
      },

      updateTool: (toolId, updates) => {
        const tool = get().getTool(toolId);
        if (tool?.isDefault) {
          console.warn('Cannot update default tools');
          return;
        }
        set((state) => ({
          tools: state.tools.map(t =>
            t.id === toolId ? { ...t, ...updates } : t
          ),
        }));
      },
      
      getTool: (toolId) => {
        return get().tools.find(t => t.id === toolId);
      },
      
      getDefaultTools: () => {
        return get().tools.filter(t => t.isDefault);
      },
      
      getUserTools: () => {
        return get().tools.filter(t => !t.isDefault);
      },
    }),
    {
      name: 'tool-storage',
      storage: createExtensionJSONStorage<ToolState>(),
      // Ensure default tools are always present
      merge: (persistedState: any, currentState) => ({
        ...currentState,
        tools: [
          ...DEFAULT_TOOLS,
          ...(persistedState?.tools?.filter((t: Tool) => !t.isDefault) || []),
        ],
      }),
    }
  )
);
