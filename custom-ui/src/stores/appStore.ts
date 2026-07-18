/**
 * Zustand store for custom UI state management
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { createExtensionJSONStorage } from "@/stores/extensionStorage";
import type {
  AgentInfo,
  WorkflowInfo,
  Conversation,
  PendingApproval,
  MetaResponse,
} from "@/types";
import type { ConversationItem } from "@/types/openai";
import type { ExtendedResponseStreamEvent } from "@/types/openai";
import { apiClient } from "@/services/api";

let activeResponseAbortController: AbortController | null = null;

const readFileAsDataUrl = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        resolve(reader.result);
      } else {
        reject(new Error('Failed to read file'));
      }
    };
    reader.onerror = () => reject(new Error(`Failed to read ${file.name}`));
    reader.readAsDataURL(file);
  });

const buildMultimodalUserMessage = async (text: string, files: File[]) => {
  const imageFiles = files.filter((file) => file.type.startsWith('image/'));
  if (imageFiles.length === 0) {
    return { role: 'user', content: text };
  }

  const imageParts = await Promise.all(
    imageFiles.map(async (file) => ({
      type: 'input_image',
      image_url: await readFileAsDataUrl(file),
    }))
  );

  return {
    role: 'user',
    content: [
      { type: 'input_text', text },
      ...imageParts,
    ],
  };
};

const stripToolCallMarkup = (content: string) =>
  content
    .replace(/<tool_call>\s*\{[\s\S]*?\}\s*<\/tool_call>/g, '')
    .replace(/\{\s*"name"\s*:\s*"[^"]+"[\s\S]*?\}\s*<\/tool_call>/g, '')
    .trimEnd();

const requestAgentModelSelection = (agent: AgentInfo) => {
  const agentName = agent.name || agent.id;
  return {
    id: `model-required-${agent.id}-${Date.now()}`,
    role: 'assistant',
    content: `Please select a model for ${agentName} before using this agent.`,
    action: {
      label: `Select model for ${agentName}`,
      event: 'budai:edit-agent-model',
      detail: { agentId: agent.id },
    },
  };
};

const agentsMissingModels = (agents: AgentInfo[]) => agents.filter((agent) => !agent.model_id?.trim());

const isFailedToolResult = (result: unknown) => {
  const text = typeof result === 'string' ? result : JSON.stringify(result ?? '');
  const lowerText = text.toLowerCase();
  const exitCodeMatch = lowerText.match(/exit_code:\s*(-?\d+)/);
  if (exitCodeMatch && exitCodeMatch[1] !== '0') {
    return true;
  }
  return [
    'traceback',
    'unicodeencodeerror',
    'syntaxerror',
    'permissionerror',
    'filenotfounderror',
    'error modifying file',
    'error reading file',
    'error reading file back',
    'not readable',
  ].some((marker) => lowerText.includes(marker));
};

// Separate persist store for user-created agents
interface UserAgentsStore {
  userAgents: AgentInfo[];
  addUserAgent: (agent: AgentInfo) => void;
  updateUserAgent: (agent: AgentInfo) => void;
  deleteUserAgent: (agentId: string) => void;
  getUserAgents: () => AgentInfo[];
}

const useUserAgentsStore = create<UserAgentsStore>()(
  persist(
    (set, get) => ({
      userAgents: [],
      addUserAgent: (agent) =>
        set((state) => ({
          userAgents: [...state.userAgents, { 
            ...agent, 
            isUserCreated: true,
            type: 'agent' as const,
            source: 'in_memory' as const,
            has_env: false,
          }],
        })),
      updateUserAgent: (agent) =>
        set((state) => ({
          userAgents: state.userAgents.map((a) =>
            a.id === agent.id ? { 
              ...agent, 
              isUserCreated: true,
              type: 'agent' as const,
              source: 'in_memory' as const,
              has_env: false,
            } : a
          ),
        })),
      deleteUserAgent: (agentId) =>
        set((state) => ({
          userAgents: state.userAgents.filter((a) => a.id !== agentId),
        })),
      getUserAgents: () => {
        // Migrate old agents without type field
        return get().userAgents.map(a => ({
          ...a,
          type: a.type || ('agent' as const),
          source: a.source || ('in_memory' as const),
          has_env: a.has_env ?? false,
          tools: a.tools || [],
        }));
      },
    }),
    {
      name: 'user-agents-storage',
      storage: createExtensionJSONStorage<UserAgentsStore>(),
    }
  )
);

interface AppStore {
  // Server meta
  serverMeta: MetaResponse | null;
  setServerMeta: (meta: MetaResponse) => void;

  // Entities
  agents: AgentInfo[];
  workflows: WorkflowInfo[];
  selectedEntity: AgentInfo | WorkflowInfo | null;
  defaultAgentModelIds: Record<string, string>;
  setAgents: (agents: AgentInfo[]) => void;
  setDefaultAgentModel: (agentId: string, modelId: string) => void;
  setWorkflows: (workflows: WorkflowInfo[]) => void;
  selectEntity: (entity: AgentInfo | WorkflowInfo | null) => void;
  
  // Multi-agent selection for group chat
  selectedAgents: AgentInfo[];
  selectedAgentIds: string[];
  setSelectedAgents: (agents: AgentInfo[]) => void;
  toggleAgentSelection: (agent: AgentInfo) => void;
  
  // Multi-agent orchestration type
  orchestrationType: 'concurrent' | 'sequential' | 'group_chat' | 'handoff' | 'magentic';
  setOrchestrationType: (type: 'concurrent' | 'sequential' | 'group_chat' | 'handoff' | 'magentic') => void;
  managerModelId: string;
  setManagerModelId: (id: string) => void;
  
  // User-created agents (stored in localStorage)
  addUserAgent: (agent: AgentInfo) => void;
  updateUserAgent: (agent: AgentInfo) => void;
  deleteUserAgent: (agentId: string) => void;
  getUserAgents: () => AgentInfo[];

  // Conversations
  currentConversation: Conversation | null;
  availableConversations: Conversation[];
  setCurrentConversation: (conversation: Conversation | null) => void;
  setAvailableConversations: (conversations: Conversation[]) => void;
  addConversation: (conversation: Conversation) => void;
  removeConversation: (conversationId: string) => void;

  // Chat messages (OpenAI conversation items)
  chatItems: ConversationItem[];
  setChatItems: (items: ConversationItem[]) => void;
  addChatItem: (item: ConversationItem) => void;
  clearChatItems: () => void;

  // Streaming state
  isStreaming: boolean;
  streamingResponseId: string | null;
  setIsStreaming: (streaming: boolean) => void;
  setStreamingResponseId: (id: string | null) => void;

  // Input state
  inputValue: string;
  setInputValue: (value: string) => void;

  // File attachments
  attachments: Array<{
    id: string;
    name: string;
    type: string;
    data: string;
  }>;
  addAttachment: (attachment: {
    id: string;
    name: string;
    type: string;
    data: string;
  }) => void;
  removeAttachment: (id: string) => void;
  clearAttachments: () => void;

  // Function approvals (Human-in-the-Loop)
  pendingApprovals: PendingApproval[];
  addPendingApproval: (approval: PendingApproval) => void;
  removePendingApproval: (requestId: string) => void;

  // Debug panel
  showDebugPanel: boolean;
  debugPanelWidth: number;
  debugEvents: ExtendedResponseStreamEvent[];
  setShowDebugPanel: (show: boolean) => void;
  setDebugPanelWidth: (width: number) => void;
  addDebugEvent: (event: ExtendedResponseStreamEvent) => void;
  clearDebugEvents: () => void;

  // Modals
  showAgentBuilder: boolean;
  showSettings: boolean;
  setShowAgentBuilder: (show: boolean) => void;
  setShowSettings: (show: boolean) => void;

  // Agent builder state
  editingAgent: AgentInfo | null;
  setEditingAgent: (agent: AgentInfo | null) => void;

  // UI preferences
  showToolCalls: boolean;
  setShowToolCalls: (show: boolean) => void;

  // Helper methods
  selectedAgent: AgentInfo | WorkflowInfo | null;
  chatTargetMode: 'agents' | 'model' | 'workflows';
  selectedDirectModel: string;
  setChatTargetMode: (mode: 'agents' | 'model' | 'workflows') => void;
  setSelectedDirectModel: (model: string) => void;
  chatMessages: Array<{
    id: string;
    role: string;
    content?: string;
    attachments?: Array<{
      name: string;
      type: string;
      url: string;
      isImage: boolean;
    }>;
    usage?: {
      prompt_tokens: number;
      completion_tokens: number;
      total_tokens: number;
    };
  }>;
  streamingState: {
    currentContent: string;
  };
  loadEntities: () => Promise<void>;
  selectAgent: (entity: AgentInfo | WorkflowInfo | null) => void;
  createConversation: () => Promise<void>;
  startNewChat: () => void;
  loadConversations: () => Promise<void>;
  switchConversation: (conversationId: string) => Promise<void>;
  deleteConversation: (conversationId: string) => Promise<void>;
  sendMessage: (text: string, files: File[]) => Promise<void>;
  sendMessageToMultipleAgents: (text: string, files: File[]) => Promise<void>;
  stopCurrentResponse: () => void;
}

export const useAppStore = create<AppStore>()(
  persist(
    (set, get) => ({
  // Server meta
  serverMeta: null,
  setServerMeta: (meta) => set({ serverMeta: meta }),

  // Entities
  agents: [],
  workflows: [],
  selectedEntity: null,
  defaultAgentModelIds: {},
  
  // Multi-agent selection
  selectedAgents: [],
  selectedAgentIds: [],
  setSelectedAgents: (agents) => set({ selectedAgents: agents, selectedAgentIds: agents.map(a => a.id) }),
  toggleAgentSelection: (agent) => {
    const state = get();
    const isSelected = state.selectedAgents.some(a => a.id === agent.id);
    const next = isSelected
      ? state.selectedAgents.filter(a => a.id !== agent.id)
      : [...state.selectedAgents, agent];
    set({ selectedAgents: next, selectedAgentIds: next.map(a => a.id) });
  },
  
  // Multi-agent orchestration type
  orchestrationType: 'group_chat',
  setOrchestrationType: (type) => set({ orchestrationType: type }),
  managerModelId: '',
  setManagerModelId: (id) => set({ managerModelId: id }),

  setAgents: (agents) => {
    // Agents in agents/ folder that should always appear as Default (undeleteable)
    const DEFAULT_AGENT_IDS = new Set([
      'shell_executor_agent',
      'planner_agent',
      'file_manager_agent',
      'web_researcher_agent',
      'devops_agent',
      'data_analyst_agent',
      'reviewer_agent',
      'code_writer_agent',
    ]);

    // Mark matching loaded agents as isDefault so they show in Default Agents section
    const defaultAgentModelIds = get().defaultAgentModelIds || {};
    const taggedAgents = agents.map(a => {
      if (!DEFAULT_AGENT_IDS.has(a.id)) return a;
      return {
        ...a,
        model_id: defaultAgentModelIds[a.id] || '',
        isDefault: true,
        isUserCreated: false,
      };
    });

    const nonDefaultLoadedAgents = taggedAgents.filter(a => !a.isDefault);
    const defaultLoadedAgents = taggedAgents.filter(a => a.isDefault);

    // Get user-created agents from localStorage with migration applied
    const userAgents = useUserAgentsStore.getState().getUserAgents();
    const merged = [...defaultLoadedAgents, ...userAgents, ...nonDefaultLoadedAgents];
    const dedupedById = Array.from(new Map(merged.map((agent) => [agent.id, agent])).values());
    // Re-resolve selected agents from persisted IDs using fresh data
    const persistedIds = get().selectedAgentIds;
    const resolvedSelected = persistedIds.length > 0
      ? persistedIds.map(id => dedupedById.find(a => a.id === id)).filter(Boolean) as AgentInfo[]
      : get().selectedAgents;
    set({ agents: dedupedById, selectedAgents: resolvedSelected });
  },

  setDefaultAgentModel: (agentId, modelId) => {
    const nextModelIds = { ...get().defaultAgentModelIds, [agentId]: modelId };
    set((state) => ({
      defaultAgentModelIds: nextModelIds,
      agents: state.agents.map((agent) =>
        agent.id === agentId && agent.isDefault
          ? { ...agent, model_id: modelId }
          : agent
      ),
      selectedAgents: state.selectedAgents.map((agent) =>
        agent.id === agentId && agent.isDefault
          ? { ...agent, model_id: modelId }
          : agent
      ),
    }));
  },
  
  // User agent management methods
  addUserAgent: (agent) => {
    useUserAgentsStore.getState().addUserAgent(agent);
    // Refresh the agents list
    const currentState = get();
    const backendAgents = currentState.agents.filter(a => !a.isDefault && !a.isUserCreated);
    currentState.setAgents(backendAgents);
  },
  updateUserAgent: (agent) => {
    useUserAgentsStore.getState().updateUserAgent(agent);
    // Refresh the agents list
    const currentState = get();
    const backendAgents = currentState.agents.filter(a => !a.isDefault && !a.isUserCreated);
    currentState.setAgents(backendAgents);
  },
  deleteUserAgent: (agentId) => {
    useUserAgentsStore.getState().deleteUserAgent(agentId);
    // Refresh the agents list
    const currentState = get();
    const backendAgents = currentState.agents.filter(a => !a.isDefault && !a.isUserCreated);
    currentState.setAgents(backendAgents);
    set((state) => ({
      selectedAgents: state.selectedAgents.filter((agent) => agent.id !== agentId),
      selectedAgent: state.selectedAgent?.id === agentId ? null : state.selectedAgent,
      selectedEntity: state.selectedEntity?.id === agentId ? null : state.selectedEntity,
    }));
  },
  getUserAgents: () => useUserAgentsStore.getState().userAgents,
  setWorkflows: (workflows) => set({ workflows }),
  selectEntity: (entity) => set({ selectedEntity: entity }),

  // Conversations
  currentConversation: null,
  availableConversations: [],
  setCurrentConversation: (conversation) => set({ currentConversation: conversation }),
  setAvailableConversations: (conversations) => set({ availableConversations: conversations }),
  addConversation: (conversation) =>
    set((state) => ({
      availableConversations: [conversation, ...state.availableConversations],
    })),
  removeConversation: (conversationId) =>
    set((state) => ({
      availableConversations: state.availableConversations.filter(
        (c) => c.id !== conversationId
      ),
      currentConversation:
        state.currentConversation?.id === conversationId
          ? null
          : state.currentConversation,
    })),

  // Chat messages
  chatItems: [],
  setChatItems: (items) => set({ chatItems: items }),
  addChatItem: (item) =>
    set((state) => ({ chatItems: [...state.chatItems, item] })),
  clearChatItems: () => set({ chatItems: [] }),

  // Streaming
  isStreaming: false,
  streamingResponseId: null,
  setIsStreaming: (streaming) => set({ isStreaming: streaming }),
  setStreamingResponseId: (id) => set({ streamingResponseId: id }),

  // Input
  inputValue: "",
  setInputValue: (value) => set({ inputValue: value }),

  // Attachments
  attachments: [],
  addAttachment: (attachment) =>
    set((state) => ({ attachments: [...state.attachments, attachment] })),
  removeAttachment: (id) =>
    set((state) => ({
      attachments: state.attachments.filter((a) => a.id !== id),
    })),
  clearAttachments: () => set({ attachments: [] }),

  // Function approvals
  pendingApprovals: [],
  addPendingApproval: (approval) =>
    set((state) => ({
      pendingApprovals: [...state.pendingApprovals, approval],
    })),
  removePendingApproval: (requestId) =>
    set((state) => ({
      pendingApprovals: state.pendingApprovals.filter(
        (a) => a.request_id !== requestId
      ),
    })),

  // Debug panel
  showDebugPanel: false,
  debugPanelWidth: 400,
  debugEvents: [],
  setShowDebugPanel: (show) => set({ showDebugPanel: show }),
  setDebugPanelWidth: (width) => set({ debugPanelWidth: width }),
  addDebugEvent: (event) =>
    set((state) => ({ debugEvents: [...state.debugEvents, event] })),
  clearDebugEvents: () => set({ debugEvents: [] }),

  // Modals
  showAgentBuilder: false,
  showSettings: false,
  setShowAgentBuilder: (show) => set({ showAgentBuilder: show }),
  setShowSettings: (show) => set({ showSettings: show }),

  // Agent builder
  editingAgent: null,
  setEditingAgent: (agent) => set({ editingAgent: agent }),

  // UI preferences
  showToolCalls: true,
  setShowToolCalls: (show) => set({ showToolCalls: show }),

  // Helper methods
  selectedAgent: null,
  chatTargetMode: 'agents',
  selectedDirectModel: '',
  setChatTargetMode: (mode) => set({ chatTargetMode: mode }),
  setSelectedDirectModel: (model) => set({ selectedDirectModel: model }),
  chatMessages: [],
  streamingState: { currentContent: '' },
  
  loadEntities: async () => {
    try {
      const { agents: loadedAgents, workflows: loadedWorkflows } = await apiClient.getEntities();
      // Use setAgents to merge with default agents
      get().setAgents(loadedAgents);
      set({ workflows: loadedWorkflows });
    } catch (error) {
      console.error('Failed to load entities:', error);
    }
  },

  selectAgent: (entity) => {
    set({ selectedEntity: entity, selectedAgent: entity });
  },

  loadConversations: async () => {
    const state = get();
    if (!state.selectedAgent || state.selectedAgent.type !== 'agent') return;
    
    try {
      const conversations = await apiClient.listConversations(state.selectedAgent.id);
      console.log('Loaded conversations:', conversations);
      const sortedConversations = [...conversations].sort((a, b) => b.created_at - a.created_at);
      const currentConversation = sortedConversations[0] || null;
      set({
        availableConversations: sortedConversations,
        currentConversation,
      });

      if (currentConversation) {
        const response: any = await apiClient.getConversationItems(currentConversation.id);
        const items = response.data || response;

        const messages: any[] = [];
        for (const item of items) {
          if (item.type === 'message') {
            let textContent = '';
            if (item.content && Array.isArray(item.content)) {
              for (const content of item.content) {
                if (content.type === 'output_text' || content.type === 'input_text' || content.type === 'text') {
                  textContent += content.text || content.content || '';
                }
              }
            }

            messages.push({
              id: item.id,
              role: item.role,
              content: textContent,
              usage: item.usage ? {
                prompt_tokens: item.usage.input_tokens || 0,
                completion_tokens: item.usage.output_tokens || 0,
                total_tokens: item.usage.total_tokens || 0,
              } : undefined,
            });
          }
        }

        set({ chatMessages: messages });
      } else {
        set({ chatMessages: [] });
      }
    } catch (error) {
      console.error('Failed to load conversations:', error);
    }
  },

  switchConversation: async (conversationId: string) => {
    const state = get();
    const conversation = state.availableConversations.find(c => c.id === conversationId);
    if (!conversation) return;
    
    try {
      // Set the conversation first (clears chat while loading)
      set({ currentConversation: conversation, chatMessages: [] });
      console.log('Switching to conversation:', conversationId);
      
      // Load conversation items from backend
      const response: any = await apiClient.getConversationItems(conversationId);
      console.log('Loaded conversation items:', response);
      
      const items = response.data || response;
      
      // Convert conversation items to chat messages
      const messages: any[] = [];
      for (const item of items) {
        if (item.type === 'message') {
          // Extract text content from the content array
          let textContent = '';
          if (item.content && Array.isArray(item.content)) {
            for (const content of item.content) {
              if (content.type === 'output_text' || content.type === 'input_text' || content.type === 'text') {
                textContent += content.text || content.content || '';
              }
            }
          }
          
          messages.push({
            id: item.id,
            role: item.role,
            content: textContent,
            usage: item.usage ? {
              prompt_tokens: item.usage.input_tokens || 0,
              completion_tokens: item.usage.output_tokens || 0,
              total_tokens: item.usage.total_tokens || 0,
            } : undefined,
          });
        }
      }
      
      console.log('Converted messages:', messages);
      set({ chatMessages: messages });
    } catch (error) {
      console.error('Failed to load conversation history:', error);
    }
  },

  deleteConversation: async (conversationId: string) => {
    const state = get();
    
    try {
      await apiClient.deleteConversation(conversationId);
      
      // Remove from list
      const updatedConversations = state.availableConversations.filter(c => c.id !== conversationId);
      set({ availableConversations: updatedConversations });
      
      // If deleted conversation was current, select another or clear
      if (state.currentConversation?.id === conversationId) {
        if (updatedConversations.length > 0) {
          set({ currentConversation: updatedConversations[0], chatMessages: [] });
        } else {
          set({ currentConversation: null, chatMessages: [] });
        }
      }
    } catch (error) {
      console.error('Failed to delete conversation:', error);
    }
  },

  createConversation: async () => {
    const state = get();

    const resolvedAgent =
      state.selectedAgent && state.selectedAgent.type === 'agent'
        ? (state.selectedAgent as AgentInfo)
        : state.selectedAgents.length === 1
          ? state.selectedAgents[0]
          : null;

    if (!resolvedAgent) {
      return;
    }
    
    try {
      const agent = resolvedAgent;
      
      // For user-created and default agents, pass full configuration in metadata
      const metadata: Record<string, any> = {
        agent_id: agent.id,
      };
      
      // Include full agent config for user-created or default agents
      if (agent.isUserCreated || agent.isDefault) {
        metadata.agent_config = {
          name: agent.name,
          instructions: agent.instructions,
          model_id: agent.model_id,
          temperature: (agent as any).temperature || 0.7,
          max_tokens: (agent as any).max_tokens || 1000,
          tools: (agent as any).tools || [],
          chat_client_type: agent.chat_client_type || 'ollama',
        };
      }
      
      const conversation = await apiClient.createConversation(metadata);
      // Add to list and set as current
      const newConversations = [conversation, ...state.availableConversations];
      set({ 
        currentConversation: conversation, 
        chatMessages: [],
        availableConversations: newConversations,
      });
    } catch (error) {
      console.error('Failed to create conversation:', error);
      alert(`Failed to create conversation: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  },

  startNewChat: () => {
    set({
      currentConversation: null,
      chatItems: [],
      chatMessages: [],
      streamingState: { currentContent: '' },
      debugEvents: [],
      pendingApprovals: [],
      isStreaming: false,
      streamingResponseId: null,
    });
  },

  sendMessage: async (text: string, files: File[]) => {
    const state = get();
    const resolvedAgent =
      state.selectedAgent && state.selectedAgent.type === 'agent'
        ? (state.selectedAgent as AgentInfo)
        : state.selectedAgents.length === 1
          ? state.selectedAgents[0]
          : null;

    if (!resolvedAgent) return;
    if (!state.currentConversation) return;

    const missingModelAgents = agentsMissingModels([resolvedAgent]);
    if (missingModelAgents.length > 0) {
      const warningMessage = requestAgentModelSelection(missingModelAgents[0]);
      set((state: any) => ({ chatMessages: [...state.chatMessages, warningMessage] }));
      return;
    }

    activeResponseAbortController = new AbortController();
    set({ isStreaming: true, streamingState: { currentContent: '' } });
    get().clearDebugEvents();

    try {
      // Add user message to UI
      const userMessage = {
        id: `msg-${Date.now()}`,
        role: 'user',
        content: text,
        attachments: files.map((file) => ({
          name: file.name,
          type: file.type,
          url: URL.createObjectURL(file),
          isImage: file.type.startsWith('image/'),
        })),
      };
      set((state) => ({ chatMessages: [...state.chatMessages, userMessage] }));

      // Stream response - use correct format for backend (OpenAI Responses API)
      const assistantMessageId = `msg-${Date.now()}-assistant`;
      let assistantContent = '';
      let assistantThinking = '';
      const allowPaint = () => new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      
      // Create placeholder assistant message immediately
      const assistantMessage: any = {
        id: assistantMessageId,
        role: 'assistant',
        agentName: resolvedAgent.name || resolvedAgent.id,
        content: '',
        streaming: true,
        analyzingImage: files.some((file) => file.type.startsWith('image/')),
      };
      set((state: any) => ({ chatMessages: [...state.chatMessages, assistantMessage] }));
      
      const useCustomBackend = resolvedAgent.isUserCreated || resolvedAgent.isDefault;
      const metadata: Record<string, any> = {
        entity_id: resolvedAgent.id, // DevUI backend routes by metadata.entity_id
      };

      // Custom backend expects an agent_configs map for configured agents.
      if (useCustomBackend) {
        metadata.agent_configs = {
          [resolvedAgent.id]: {
            name: resolvedAgent.name,
            instructions: resolvedAgent.instructions,
            model_id: resolvedAgent.model_id,
            temperature: (resolvedAgent as any).temperature || 0.7,
            max_tokens: (resolvedAgent as any).max_tokens || 1000,
            tools: (resolvedAgent as any).tools || [],
            chat_client_type: resolvedAgent.chat_client_type || 'ollama',
          },
        };
      }

      const userContentMessage = await buildMultimodalUserMessage(text, files);

      const request = {
        input: text,
        messages: [userContentMessage],
        conversation: state.currentConversation!.id,
        metadata,
        stream: true,
      };

      console.log('Sending request:', request);

      for await (const event of apiClient.streamResponses(request, undefined, useCustomBackend, activeResponseAbortController.signal)) {
        console.log('Received event:', event);
        
        if (event.type === 'response.thinking.delta') {
          assistantThinking += (event as any).delta || '';
          set((state: any) => ({
            chatMessages: state.chatMessages.map((msg: any) =>
              msg.id === assistantMessageId
                ? { ...msg, thinking: assistantThinking }
                : msg
            ),
          }));
          await allowPaint();
        }
        // Extract text deltas as they stream
        else if (event.type === 'response.output_text.delta') {
          assistantContent = stripToolCallMarkup(assistantContent + ((event as any).delta || ''));
          // Update the assistant message in place
          set((state: any) => ({
            chatMessages: state.chatMessages.map((msg: any) =>
              msg.id === assistantMessageId
                ? { ...msg, content: assistantContent, thinking: assistantThinking }
                : msg
            ),
          }));
          await allowPaint();
        }
        // Surface real tool calls as clickable chat rows
        else if (event.type === 'response.function_call.complete') {
          const toolName =
            (event as any).data?.name ||
            (event as any).function_call?.name ||
            'unknown_tool';
          const fc = (event as any).function_call || (event as any).data || {};
          const parts: string[] = [];
          if (fc.arguments) {
            parts.push(`Arguments:\n${typeof fc.arguments === 'string' ? fc.arguments : JSON.stringify(fc.arguments, null, 2)}`);
          }
          if (fc.result) {
            parts.push(`Result:\n${typeof fc.result === 'string' ? fc.result : JSON.stringify(fc.result, null, 2)}`);
          }
          const toolFailed = (fc as any).status === 'failed' || isFailedToolResult(fc.result);

          const toolMessage = {
            id: `tool-${Date.now()}-${Math.random()}`,
            role: 'assistant',
            type: 'tool_event',
            content: '',
            toolCall: {
              label: `Tool call ${toolFailed ? 'failed' : 'completed'}: ${toolName}`,
              detail: parts.length ? parts.join('\n\n') : 'No tool details returned.',
              failed: toolFailed,
            },
          };
          set((state: any) => ({ chatMessages: [...state.chatMessages, toolMessage] }));
        }
        // Handle completion
        else if (event.type === 'response.completed') {
          // Mark message as complete and add usage
          set((state: any) => ({
            chatMessages: state.chatMessages.map((msg: any) =>
              msg.id === assistantMessageId
                ? { ...msg, streaming: false, usage: (event as any).response?.usage }
                : msg
            ),
          }));
        }
        
        // Add debug event
        get().addDebugEvent(event);
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        return;
      }
      console.error('Failed to send message:', error);
      // Show error to user
      const errorMessage = {
        id: `msg-${Date.now()}-error`,
        role: 'assistant',
        content: `Error: ${error instanceof Error ? error.message : 'Failed to send message'}`,
      };
      set((state: any) => ({
        chatMessages: [...state.chatMessages, errorMessage],
      }));
    } finally {
      activeResponseAbortController = null;
      set({ isStreaming: false });
    }
  },

  // Multi-agent group chat - sends message to all selected agents
  sendMessageToMultipleAgents: async (text: string, files: File[]) => {
    const state = get();
    const { selectedAgents, orchestrationType } = state;
    
    if (!selectedAgents || selectedAgents.length === 0) {
      console.warn('No agents selected for multi-agent chat');
      return;
    }

    const missingModelAgents = agentsMissingModels(selectedAgents);
    if (missingModelAgents.length > 0) {
      const names = missingModelAgents.map((agent) => agent.name || agent.id).join(', ');
      const firstAgent = missingModelAgents[0];
      window.dispatchEvent(new CustomEvent('budai:edit-agent-model', { detail: { agentId: firstAgent.id } }));
      set((state: any) => ({
        chatMessages: [
          ...state.chatMessages,
          {
            id: `model-required-${firstAgent.id}-${Date.now()}`,
            role: 'assistant',
            content: `Please select a model for these agents before using them: ${names}.`,
            action: {
              label: `Select model for ${firstAgent.name || firstAgent.id}`,
              event: 'budai:edit-agent-model',
              detail: { agentId: firstAgent.id },
            },
          },
        ],
      }));
      return;
    }

    activeResponseAbortController = new AbortController();
    set({ isStreaming: true, streamingState: { currentContent: '' } });
    get().clearDebugEvents();

    try {
      const selectedAgentConfigs = selectedAgents as AgentInfo[];

      // Add user message once
      const userMessage = {
        id: `msg-${Date.now()}`,
        role: 'user',
        content: text,
        attachments: files.map((file) => ({
          name: file.name,
          type: file.type,
          url: URL.createObjectURL(file),
          isImage: file.type.startsWith('image/'),
        })),
      };
      set((state) => ({ chatMessages: [...state.chatMessages, userMessage] }));

      // Create a single conversation for multi-agent orchestration
      const agentIds = selectedAgents.map(a => a.id);
      const { managerModelId } = get();
      const metadata: Record<string, any> = {
        agent_ids: agentIds,
        orchestration_type: orchestrationType,
        // max_rounds omitted — the LLM manager decides when the task is done
        ...(managerModelId ? { manager_model_id: managerModelId } : {}),
      };
      
      // Add agent configs for user-created agents
      const agentConfigs: Record<string, any> = {};
      for (const agent of selectedAgentConfigs) {
        if (agent.isUserCreated || agent.isDefault) {
          agentConfigs[agent.id] = {
            name: agent.name,
            instructions: agent.instructions,
            model_id: agent.model_id,
            temperature: (agent as any).temperature || 0.7,
            max_tokens: (agent as any).max_tokens || 1000,
            tools: (agent as any).tools || [],
            chat_client_type: agent.chat_client_type || 'ollama',
          };
        }
      }
      if (Object.keys(agentConfigs).length > 0) {
        metadata.agent_configs = agentConfigs;
      }
      
      const conversation = await apiClient.createConversation(metadata);
      set((state) => ({
        currentConversation: conversation,
        availableConversations: [conversation!, ...state.availableConversations]
      }));

      // Stream orchestrated response - track messages per agent
      const agentMessages = new Map<string, { id: string; content: string; thinking: string }>();
      let currentAgentName = 'Assistant';
      let activeStreamingAgent: string | null = null;
      const setAgentStreaming = (agentName: string, streaming: boolean) => {
        const tracked = agentMessages.get(agentName);
        if (!tracked) return;
        set((state: any) => ({
          chatMessages: state.chatMessages.map((msg: any) =>
            msg.id === tracked.id
              ? { ...msg, streaming }
              : msg
          ),
        }));
      };

      const activateSpeaker = (agentName: string) => {
        if (!agentName) return;
        if (activeStreamingAgent && activeStreamingAgent !== agentName) {
          setAgentStreaming(activeStreamingAgent, false);
        }
        activeStreamingAgent = agentName;
        setAgentStreaming(agentName, true);
      };

      let managerRound = 0;
      let lastManagerRound = -1;

      // Classify manager deltas into: status lines (shown as content),
      // real thinking (shown in thinking panel), or skip.
      const classifyManagerDelta = (delta: string): { content: string; thinking: string; isMarker: boolean; isNewRound?: boolean; isFinish?: boolean } => {
        const text = String(delta || '');
        if (!text) return { content: '', thinking: '', isMarker: false };

        const classifyDecision = (decision: any) => {
          if (decision?.finish === true) {
            return { content: decision?.final_response || 'Workflow complete.', thinking: '', isMarker: true, isFinish: true };
          }
          if (decision?.next_agent) {
            return { content: `➜ ${decision.next_agent}`, thinking: '', isMarker: true };
          }
          return { content: '', thinking: '', isMarker: true };
        };

        const extractDecisionJson = (rawText: string) => {
          const decoderCandidates = rawText.match(/\{[\s\S]*\}/g) || [];
          for (const candidate of decoderCandidates) {
            try {
              const parsed = JSON.parse(candidate);
              if (parsed && (parsed.finish === true || parsed.next_agent !== undefined)) {
                return classifyDecision(parsed);
              }
            } catch { /* try next candidate */ }
          }
          return null;
        };

        // Structural markers → short status content line, no thinking
        if (text.includes('[manager call started]')) {
          managerRound++;
          return { content: `Deciding next speaker (round ${managerRound})...`, thinking: '', isMarker: true, isNewRound: true };
        }
        if (text.includes('[manager switching to fast routing fallback]')) {
          return { content: 'Using fast routing...', thinking: '', isMarker: true };
        }
        if (text.includes('[manager call completed]')) {
          return { content: '', thinking: '', isMarker: true };
        }

        const decisionMatch = text.match(/\[manager fallback decision:\s*(\{[\s\S]*\})\]/);
        if (decisionMatch) {
          try {
            return classifyDecision(JSON.parse(decisionMatch[1]));
          } catch { /* fall through */ }
          return { content: '', thinking: '', isMarker: true };
        }

        // Catch JSON objects the LLM may stream as raw structured-output tokens,
        // including the common case where it emits prose/thinking before the JSON.
        const embeddedDecision = extractDecisionJson(text);
        if (embeddedDecision) return embeddedDecision;

        // Catch bare JSON objects the LLM may stream as raw structured-output tokens
        const trimmed = text.trim();
        if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
          try {
            return classifyDecision(JSON.parse(trimmed));
          } catch { /* not valid JSON, fall through */ }
        }

        // Strip <think> tags but keep the content as real thinking
        const cleaned = text.replace(/<\/?think>/gi, '');
        if (!cleaned.trim()) return { content: '', thinking: '', isMarker: false };

        // This is real manager reasoning → show in thinking panel
        return { content: '', thinking: cleaned, isMarker: false };
      };
      const allowPaint = () => new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      
      const userContentMessage = await buildMultimodalUserMessage(text, files);

      const request = {
        input: text,
        messages: [userContentMessage],
        conversation: conversation!.id,
        metadata,
        stream: true,
      };

      console.log(`Sending multi-agent request (${orchestrationType}):`, request);

      // Group chat for user-created/default agents must use custom backend because those
      // agents are loaded from folders and are not discoverable as official DevUI entities.
      // For fully discovered backend entities, use official backend.
      const hasLocalFolderAgents = selectedAgents.some(a => a.isUserCreated || a.isDefault);
      const useCustomBackend = orchestrationType === 'group_chat'
        ? hasLocalFolderAgents
        : hasLocalFolderAgents;

      for await (const event of apiClient.streamResponses(request, undefined, useCustomBackend, activeResponseAbortController.signal)) {
        console.log('Received event:', event.type, event);
        
        if (event.type === 'response.output_item.added') {
          const item = (event as any).item;
          const agentName = (event as any).agent_name || 'Assistant';
          
          // Skip Manager - it's handled only via thinking.delta events with markers
          if (agentName === 'Manager') {
            continue;
          }
          
          if (item && item.content) {
            for (const contentPart of item.content) {
              if (contentPart.type === 'text') {
                // For non-streaming multi-agent responses, create separate messages
                
                if (!agentMessages.has(agentName)) {
                  const msgId = `msg-${Date.now()}-${agentName}-${Math.random()}`;
                  agentMessages.set(agentName, { id: msgId, content: '', thinking: '' });
                  
                  const newMessage: any = {
                    id: msgId,
                    role: 'assistant',
                    content: contentPart.text,
                    agentName: agentName,
                  };
                  set((state: any) => ({ chatMessages: [...state.chatMessages, newMessage] }));
                } else {
                  const agentMsg = agentMessages.get(agentName)!;
                  agentMsg.content += contentPart.text + '\n\n';
                  
                  set((state: any) => ({
                    chatMessages: state.chatMessages.map((msg: any) =>
                      msg.id === agentMsg.id
                        ? { ...msg, content: agentMsg.content }
                        : msg
                    ),
                  }));
                }
              }
            }
          }
        } else if (event.type === 'response.output_text.delta') {
          const delta = (event as any).delta;
          const eventAgentName = (event as any).agent_name;
          
          // Skip Manager text deltas - Manager is handled only via thinking.delta events with markers
          if (eventAgentName === 'Manager') {
            continue;
          }
          
          // Update current agent if provided in event
          if (eventAgentName) {
            currentAgentName = eventAgentName;
            activateSpeaker(currentAgentName);
          }
          
          // Check if this delta contains an agent header (e.g., "**AgentName:**")
          const agentHeaderMatch = delta.match(/\*\*([^*]+):\*\*/);
          if (agentHeaderMatch) {
            const headerAgentName = agentHeaderMatch[1].trim();
            currentAgentName = headerAgentName;
            console.log('Detected agent header:', currentAgentName);
            
            // Create a new message for this agent if not exists
            if (!agentMessages.has(currentAgentName)) {
              const msgId = `msg-${Date.now()}-${currentAgentName}-${Math.random()}`;
              agentMessages.set(currentAgentName, { id: msgId, content: '', thinking: '' });
              
              const newMessage: any = {
                id: msgId,
                role: 'assistant',
                content: '',
                streaming: true,
                agentName: currentAgentName,
              };
              console.log('Creating new message for agent:', currentAgentName, msgId);
              set((state: any) => ({ chatMessages: [...state.chatMessages, newMessage] }));
              activateSpeaker(currentAgentName);
            }
            continue; // Skip adding the header to content
          }
          
          // Determine which agent this delta belongs to
          // Create message for this agent if doesn't exist
          if (!agentMessages.has(currentAgentName)) {
            const msgId = `msg-${Date.now()}-${currentAgentName}-${Math.random()}`;
            agentMessages.set(currentAgentName, { id: msgId, content: '', thinking: '' });
            
            const newMessage: any = {
              id: msgId,
              role: 'assistant',
              content: '',
              streaming: true,
              agentName: currentAgentName,
            };
            console.log('Creating new message for agent (from delta):', currentAgentName, msgId);
            set((state: any) => ({ chatMessages: [...state.chatMessages, newMessage] }));
          }
          activateSpeaker(currentAgentName);
          
          // Append content to the appropriate agent's message
          const agentMsg = agentMessages.get(currentAgentName)!;
          agentMsg.content += delta;
          
          set((state: any) => ({
            chatMessages: state.chatMessages.map((msg: any) =>
              msg.id === agentMsg.id
                    ? { ...msg, content: agentMsg.content, thinking: agentMsg.thinking }
                : msg
            ),
          }));
                  await allowPaint();
        } else if (event.type === 'response.thinking.delta') {
          const eventAgentName = (event as any).agent_name;
          const deltaText = (event as any).delta || '';

          // For manager events, classify into content vs thinking
          if (eventAgentName === 'Manager') {
            const classified = classifyManagerDelta(deltaText);

            // Skip empty events
            if (!classified.content && !classified.thinking && !classified.isMarker) {
              get().addDebugEvent(event);
              continue;
            }

            currentAgentName = 'Manager';

            // Create a new Manager message for each new round
            const managerKey = `Manager-${managerRound}`;
            if (!agentMessages.has(managerKey)) {
              // Close previous manager message if it exists
              if (lastManagerRound !== -1) {
                const prevKey = `Manager-${lastManagerRound}`;
                if (agentMessages.has(prevKey)) {
                  const prevMsg = agentMessages.get(prevKey)!;
                  set((state: any) => ({
                    chatMessages: state.chatMessages.map((msg: any) =>
                      msg.id === prevMsg.id
                        ? { ...msg, streaming: false }
                        : msg
                    ),
                  }));
                }
              }

              const managerMsgId = `msg-${Date.now()}-Manager-round${managerRound}-${Math.random()}`;
              agentMessages.set(managerKey, { id: managerMsgId, content: '', thinking: '' });
              lastManagerRound = managerRound;

              const managerMessage: any = {
                id: managerMsgId,
                role: 'assistant',
                content: '',
                thinking: '',
                streaming: true,
                agentName: 'Manager',
              };
              set((state: any) => ({ chatMessages: [...state.chatMessages, managerMessage] }));
            }
            activateSpeaker('Manager');

            const agentMsg = agentMessages.get(managerKey)!;

            // Append content (status lines)
            if (classified.content) {
              agentMsg.content = classified.isFinish
                ? classified.content
                : agentMsg.content
                ? `${agentMsg.content}\n${classified.content}`
                : classified.content;
            }

            // Append thinking (each delta is a stream, each round starts fresh)
            if (classified.thinking) {
              agentMsg.thinking += classified.thinking;
            }

            set((state: any) => ({
              chatMessages: state.chatMessages.map((msg: any) =>
                msg.id === agentMsg.id
                  ? { ...msg, content: agentMsg.content, thinking: agentMsg.thinking, streaming: !classified.isFinish }
                  : msg
              ),
            }));
            await allowPaint();
            get().addDebugEvent(event);
            continue;
          }

          // Non-manager thinking delta handling
          if (eventAgentName) {
            currentAgentName = eventAgentName;
          }

          if (!agentMessages.has(currentAgentName)) {
            const msgId = `msg-${Date.now()}-${currentAgentName}-${Math.random()}`;
            agentMessages.set(currentAgentName, { id: msgId, content: '', thinking: '' });

            const newMessage: any = {
              id: msgId,
              role: 'assistant',
              content: '',
              thinking: '',
              streaming: true,
              agentName: currentAgentName,
            };
            set((state: any) => ({ chatMessages: [...state.chatMessages, newMessage] }));
          }
          activateSpeaker(currentAgentName);

          const agentMsg = agentMessages.get(currentAgentName)!;
          agentMsg.thinking += deltaText;

          set((state: any) => ({
            chatMessages: state.chatMessages.map((msg: any) =>
              msg.id === agentMsg.id
                ? { ...msg, thinking: agentMsg.thinking }
                : msg
            ),
          }));
          await allowPaint();
        } else if (event.type === 'response.completed') {
          console.log('Response completed, agent messages:', Array.from(agentMessages.keys()));
          // Mark all agent messages as no longer streaming
          set((state: any) => ({
            chatMessages: state.chatMessages.map((msg: any) => {
              const isAgentMessage = Array.from(agentMessages.values()).some(am => am.id === msg.id);
              return isAgentMessage
                ? { ...msg, streaming: false, usage: (event as any).response?.usage }
                : msg;
            }),
          }));
        } else if (event.type === 'response.function_call.complete') {
          const toolName =
            (event as any).data?.name ||
            (event as any).function_call?.name ||
            'unknown_tool';
          const toolAgentName = (event as any).agent_name || currentAgentName;
          activateSpeaker(toolAgentName);
          const fc = (event as any).function_call || (event as any).data || {};
          const parts: string[] = [];
          if (fc.arguments) {
            parts.push(`Arguments:\n${typeof fc.arguments === 'string' ? fc.arguments : JSON.stringify(fc.arguments, null, 2)}`);
          }
          if (fc.result) {
            parts.push(`Result:\n${typeof fc.result === 'string' ? fc.result : JSON.stringify(fc.result, null, 2)}`);
          }
          const toolFailed = (fc as any).status === 'failed' || isFailedToolResult(fc.result);

          // Ensure each speaker has visible text in the turn before/with a tool card.
          if (!agentMessages.has(toolAgentName)) {
            const msgId = `msg-${Date.now()}-${toolAgentName}-${Math.random()}`;
            agentMessages.set(toolAgentName, { id: msgId, content: '', thinking: '' });

            const newMessage: any = {
              id: msgId,
              role: 'assistant',
              content: '',
              streaming: true,
              agentName: toolAgentName,
            };
            set((state: any) => ({ chatMessages: [...state.chatMessages, newMessage] }));
          }

          const toolAgentMessage = agentMessages.get(toolAgentName)!;
          if (!toolAgentMessage.content.trim()) {
            toolAgentMessage.content = `Running tool: ${toolName}`;
            set((state: any) => ({
              chatMessages: state.chatMessages.map((msg: any) =>
                msg.id === toolAgentMessage.id
                  ? { ...msg, content: toolAgentMessage.content }
                  : msg
              ),
            }));
          }

          const toolMessage: any = {
            id: `tool-${Date.now()}-${Math.random()}`,
            role: 'assistant',
            type: 'tool_event',
            content: '',
            agentName: toolAgentName,
            toolCall: {
              label: `Tool call ${toolFailed ? 'failed' : 'completed'}: ${toolName}`,
              detail: parts.length ? parts.join('\n\n') : 'No tool details returned.',
              failed: toolFailed,
            },
          };
          set((state: any) => ({ chatMessages: [...state.chatMessages, toolMessage] }));
        }
        get().addDebugEvent(event);
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        return;
      }
      console.error('Failed to send message to multiple agents:', error);
      const errorMessage = {
        id: `msg-${Date.now()}-error`,
        role: 'assistant',
        content: `Error: ${error instanceof Error ? error.message : 'Failed to send message'}`,
      };
      set((state: any) => ({
        chatMessages: [...state.chatMessages, errorMessage],
      }));
    } finally {
      activeResponseAbortController = null;
      set({ isStreaming: false });
    }
  },

  stopCurrentResponse: () => {
    if (activeResponseAbortController) {
      activeResponseAbortController.abort();
      activeResponseAbortController = null;
    }
    set({ isStreaming: false });
  },
    }),
    {
      name: 'app-store-storage',
      storage: createExtensionJSONStorage<Pick<AppStore, 'chatTargetMode' | 'selectedDirectModel' | 'selectedAgentIds' | 'defaultAgentModelIds' | 'orchestrationType'>>(),
      partialize: (state) => ({
        chatTargetMode: state.chatTargetMode,
        selectedDirectModel: state.selectedDirectModel,
        selectedAgentIds: state.selectedAgentIds,
        defaultAgentModelIds: state.defaultAgentModelIds,
        orchestrationType: state.orchestrationType,
      }),
    }
  )
);
