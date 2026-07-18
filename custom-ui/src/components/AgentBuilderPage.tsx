import React, { useState, useMemo, useEffect, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Plus, Search, Code, Settings, Trash2, ChevronDown, ChevronRight, Wand2, Loader2, Mic, MicOff, Wrench, AlertCircle, CheckCircle2, Calendar, Workflow } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import { AgentEditorDialog } from '@/components/AgentEditorDialog';
import { WorkflowBuilderDialog } from '@/components/WorkflowBuilderDialog';
import { useWorkflowStore, ORCHESTRATION_OPTIONS, type SavedWorkflow } from '@/stores/workflowStore';
import { apiClient } from '@/services/api';
import type { AgentInfo } from '@/types';
import { useToolStore } from '@/stores/toolStore';

type SortableEntity = {
  id: string;
  name?: string;
  description?: string;
  metadata?: Record<string, unknown>;
};

type OllamaModelInfo = {
  name: string;
  id: string;
  size: string;
  modified: string;
};

type GeneratedAgentSpec = {
  name: string;
  description: string;
  instructions: string;
  model: string;
  tools?: string[];
};

type SpeechRecognitionResultLike = {
  readonly isFinal: boolean;
  readonly 0: { transcript: string };
};

type SpeechRecognitionEventLike = {
  readonly resultIndex: number;
  readonly results: ArrayLike<SpeechRecognitionResultLike>;
};

type SpeechRecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: any) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
};

type SpeechRecognitionConstructorLike = new () => SpeechRecognitionLike;

declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionConstructorLike;
    webkitSpeechRecognition?: SpeechRecognitionConstructorLike;
  }
}

type AgentsPageProps = {
  editAgentId?: string | null;
  onEditAgentHandled?: () => void;
};

const PENDING_AGENT_MODEL_EDIT_KEY = 'budai:pending-edit-agent-model';

const normalizeAgentLookup = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '');

export const AgentsPage: React.FC<AgentsPageProps> = ({ editAgentId, onEditAgentHandled }) => {
  const { agents, loadEntities } = useAppStore();
  const { tools: savedTools } = useToolStore();
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState<'name' | 'date' | 'modified'>('name');
  const [isEditorOpen, setIsEditorOpen] = useState(false);
  const [editingAgent, setEditingAgent] = useState<AgentInfo | null>(null);
  const [showDefaultAgents, setShowDefaultAgents] = useState(true);
  const [showYourAgents, setShowYourAgents] = useState(true);
  const [showYourWorkflows, setShowYourWorkflows] = useState(true);
  const { workflows: savedWorkflows, deleteWorkflow } = useWorkflowStore();
  const [isWorkflowDialogOpen, setIsWorkflowDialogOpen] = useState(false);
  const [editingWorkflow, setEditingWorkflow] = useState<SavedWorkflow | null>(null);
  const [isAIDialogOpen, setIsAIDialogOpen] = useState(false);
  const [aiPrompt, setAiPrompt] = useState('');
  const [isGeneratingAgent, setIsGeneratingAgent] = useState(false);
  const [availableModels, setAvailableModels] = useState<OllamaModelInfo[]>([]);
  const [isLoadingModels, setIsLoadingModels] = useState(false);
  const [preferredModel, setPreferredModel] = useState('__auto__');
  const [isModelConfirmOpen, setIsModelConfirmOpen] = useState(false);
  const [pendingGeneratedAgent, setPendingGeneratedAgent] = useState<GeneratedAgentSpec | null>(null);
  const [confirmModel, setConfirmModel] = useState('');
  const [selectedTools, setSelectedTools] = useState<string[]>([]);
  const [selectedToolToAdd, setSelectedToolToAdd] = useState('__none__');
  const [speechSupported, setSpeechSupported] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const dictationBaseRef = useRef('');

  useEffect(() => {
    const SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognitionCtor) {
      setSpeechSupported(false);
      return;
    }

    setSpeechSupported(true);
    const recognition = new SpeechRecognitionCtor();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'en-US';

    recognition.onresult = (event: SpeechRecognitionEventLike) => {
      let finalTranscript = '';
      let interimTranscript = '';

      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        const transcript = result?.[0]?.transcript || '';
        if (result.isFinal) {
          finalTranscript += transcript;
        } else {
          interimTranscript += transcript;
        }
      }

      if (finalTranscript) {
        const nextBase = `${dictationBaseRef.current} ${finalTranscript}`.trim();
        dictationBaseRef.current = nextBase;
      }

      const combined = `${dictationBaseRef.current} ${interimTranscript}`.trim();
      if (combined) {
        setAiPrompt(combined);
      }
    };

    recognition.onerror = () => {
      setIsListening(false);
    };

    recognition.onend = () => {
      setIsListening(false);
    };

    recognitionRef.current = recognition;

    return () => {
      try { recognition.stop(); } catch { /* ignore */ }
      recognitionRef.current = null;
      setIsListening(false);
    };
  }, []);

  useEffect(() => {
    if (!isAIDialogOpen && isListening && recognitionRef.current) {
      try { recognitionRef.current.stop(); } catch { /* ignore */ }
      setIsListening(false);
    }
  }, [isAIDialogOpen, isListening]);

  useEffect(() => {
    if (!isAIDialogOpen) return;

    const loadLocalModels = async () => {
      setIsLoadingModels(true);
      try {
        const models = await apiClient.getOllamaModels();
        setAvailableModels(models);
      } catch {
        setAvailableModels([]);
      } finally {
        setIsLoadingModels(false);
      }
    };

    loadLocalModels();
  }, [isAIDialogOpen]);

  // Debug: Log agents to see what we have
  React.useEffect(() => {
    console.log('Total agents:', agents.length);
    console.log('Default agents:', agents.filter(a => a.isDefault).length);
    console.log('Agents:', agents);
  }, [agents]);

  // Filter and sort agents
  const sortEntities = React.useCallback(<T extends SortableEntity>(entities: T[]) => {
    return entities.sort((a, b) => {
      switch (sortBy) {
        case 'name':
          return (a.name || a.id).localeCompare(b.name || b.id);
        case 'date': {
          const aTime = a.metadata?.created_at as number || 0;
          const bTime = b.metadata?.created_at as number || 0;
          return bTime - aTime;
        }
        case 'modified': {
          const aModified = a.metadata?.modified_at as number || 0;
          const bModified = b.metadata?.modified_at as number || 0;
          return bModified - aModified;
        }
        default:
          return 0;
      }
    });
  }, [sortBy]);

  const filterEntities = React.useCallback(<T extends SortableEntity>(entities: T[]) => {
    return entities.filter(entity => 
      entity.name?.toLowerCase().includes(searchQuery.toLowerCase()) ||
      entity.description?.toLowerCase().includes(searchQuery.toLowerCase()) ||
      entity.id.toLowerCase().includes(searchQuery.toLowerCase())
    );
  }, [searchQuery]);

  const defaultAgents = useMemo(() => 
    sortEntities(filterEntities(agents.filter(a => a.isDefault))), 
    [agents, filterEntities, sortEntities]
  );

  const userAgents = useMemo(() => 
    sortEntities(filterEntities(agents.filter(a => !a.isDefault))), 
    [agents, filterEntities, sortEntities]
  );

  const handleCreateNew = () => {
    setEditingAgent(null);
    setIsEditorOpen(true);
  };

  const handleEditAgent = (agent: AgentInfo) => {
    setEditingAgent(agent);
    setIsEditorOpen(true);
  };

  useEffect(() => {
    const pendingAgentId = editAgentId || window.sessionStorage.getItem(PENDING_AGENT_MODEL_EDIT_KEY);
    if (!pendingAgentId) return;
    const normalizedPendingAgentId = normalizeAgentLookup(pendingAgentId);
    const agent = agents.find((candidate) =>
      candidate.id === pendingAgentId ||
      normalizeAgentLookup(candidate.id) === normalizedPendingAgentId ||
      normalizeAgentLookup(candidate.name || '') === normalizedPendingAgentId
    );
    if (!agent) return;
    setEditingAgent(agent);
    setIsEditorOpen(true);
    window.sessionStorage.removeItem(PENDING_AGENT_MODEL_EDIT_KEY);
    onEditAgentHandled?.();
  }, [agents, editAgentId, onEditAgentHandled]);

  const handleSaveAgent = async (agentData: any) => {
    try {
      const { addUserAgent, updateUserAgent, setDefaultAgentModel } = useAppStore.getState();

      const createUserAgentFromFolder = async (data: {
        name: string;
        description?: string;
        instructions: string;
        model_id?: string;
        tools?: string[];
      }) => {
        const userTools = useToolStore.getState().getUserTools();
        const toolCode = (data.tools || [])
          .map(id => userTools.find(t => t.id === id))
          .filter((t): t is NonNullable<typeof t> => !!t)
          .map(t => ({ id: t.id, name: t.name, code: t.code }));

        const result = await apiClient.createAgentAsFolder({
          name: data.name,
          description: data.description || '',
          instructions: data.instructions,
          model: data.model_id || 'llama3:8b',
          tools: data.tools || [],
          toolCode,
        });

        const newAgent = {
          ...data,
          id: result.id || data.name.toLowerCase().replace(/\s+/g, '_'),
          isUserCreated: true,
          type: 'agent' as const,
          source: 'in_memory' as const,
          has_env: false,
          tools: data.tools || [],
        };
        addUserAgent(newAgent);

      setActionSuccess('Agent created. Restart DevUI backend (port 8080) to load it.');
      setTimeout(() => setActionSuccess(null), 5000);
      };

      const updateUserAgentInFolder = async (agentId: string, data: {
        name: string;
        description?: string;
        instructions: string;
        model_id?: string;
        tools?: string[];
      }) => {
        const userTools = useToolStore.getState().getUserTools();
        const toolCode = (data.tools || [])
          .map(id => userTools.find(t => t.id === id))
          .filter((t): t is NonNullable<typeof t> => !!t)
          .map(t => ({ id: t.id, name: t.name, code: t.code }));

        await apiClient.updateAgentFolder(agentId, {
          name: data.name,
          description: data.description || '',
          instructions: data.instructions,
          model: data.model_id || 'llama3:8b',
          tools: data.tools || [],
          toolCode,
        });
      };
      
      // Default agents are stored locally, not sent to backend
      if (agentData.isDefault) {
        // For default agents, persist only the user's local model choice.
        setDefaultAgentModel(agentData.id, agentData.model_id);
        setIsEditorOpen(false);
        return;
      }

      // Check if this is a user-created agent by looking up in the current agents list
      const existingAgent = agentData.id ? agents.find(a => a.id === agentData.id) : null;
      const isUserCreated = existingAgent?.isUserCreated || !agentData.id;
      
      if (isUserCreated) {
        // User-created agents are now saved as persistent folders
        if (agentData.id) {
          // Persist updates to folder module, then update local store.
          await updateUserAgentInFolder(agentData.id, agentData);

          // Update existing user agent in local store - preserve required flags.
          updateUserAgent({ 
            ...agentData, 
            isUserCreated: true,
            type: 'agent' as const,
            source: 'in_memory' as const,
            has_env: false,
          });
          setIsEditorOpen(false);
        } else {
          // Create new user agent as a persistent folder
          try {
            await createUserAgentFromFolder(agentData);
            setIsEditorOpen(false);
          } catch (error) {
            setActionError(error instanceof Error ? error.message : 'Failed to create agent.');
          }
        }
      } else {
        // Backend agents use API
        if (agentData.id) {
          await apiClient.updateAgent(agentData.id, agentData);
        }
        await loadEntities();
        setIsEditorOpen(false);
      }
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Failed to save agent.');
      throw error;
    }
  };

  const handleCreateWithAI = async () => {
    const prompt = aiPrompt.trim();
    if (!prompt) return;

    setIsGeneratingAgent(true);
    try {
      const localModelNames = availableModels.map((m) => m.name);
      const userSelectedModel = preferredModel !== '__auto__' ? preferredModel : undefined;

      const generated = await apiClient.generateAgentWithAI({
        prompt,
        model: userSelectedModel,
        availableModels: localModelNames,
        userSelectedModel,
        availableTools: savedTools.map((tool) => tool.id),
        selectedTools,
      });

      const fallbackModel = localModelNames[0] || generated.model || 'llama3:8b';
      const normalizedModel = localModelNames.length > 0
        ? (localModelNames.includes(generated.model) ? generated.model : fallbackModel)
        : (generated.model || 'llama3:8b');

      if (!userSelectedModel && localModelNames.length > 0) {
        setPendingGeneratedAgent({ ...generated, model: normalizedModel, tools: selectedTools });
        setConfirmModel(normalizedModel);
        setIsModelConfirmOpen(true);
        return;
      }

      await createGeneratedAgent({ ...generated, model: normalizedModel, tools: selectedTools });
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Failed to create agent with AI.');
    } finally {
      setIsGeneratingAgent(false);
    }
  };

  const createGeneratedAgent = async (generated: GeneratedAgentSpec) => {
    const { addUserAgent } = useAppStore.getState();
    const userTools = useToolStore.getState().getUserTools();
    const toolCode = (generated.tools || [])
      .map(id => userTools.find(t => t.id === id))
      .filter((t): t is NonNullable<typeof t> => !!t)
      .map(t => ({ id: t.id, name: t.name, code: t.code }));

    const result = await apiClient.createAgentAsFolder({
      name: generated.name,
      description: generated.description || '',
      instructions: generated.instructions,
      model: generated.model || 'llama3:8b',
      tools: generated.tools || [],
      toolCode,
    });

    addUserAgent({
      id: result.id || generated.name.toLowerCase().replace(/\s+/g, '_'),
      name: generated.name,
      description: generated.description,
      instructions: generated.instructions,
      model_id: generated.model,
      tools: generated.tools || [],
      isUserCreated: true,
      type: 'agent',
      source: 'in_memory',
      has_env: false,
    });

      setIsAIDialogOpen(false);
      setIsModelConfirmOpen(false);
      setPendingGeneratedAgent(null);
      setConfirmModel('');
      setAiPrompt('');
      setPreferredModel('__auto__');
      setSelectedTools([]);
      setSelectedToolToAdd('__none__');
      setActionSuccess(`Agent "${generated.name}" created successfully.`);
      setTimeout(() => setActionSuccess(null), 5000);
  };

  const handleConfirmModelAndCreate = async () => {
    if (!pendingGeneratedAgent) return;

    const modelToUse = confirmModel || pendingGeneratedAgent.model || 'llama3:8b';
    setIsGeneratingAgent(true);
    try {
      await createGeneratedAgent({
        ...pendingGeneratedAgent,
        model: modelToUse,
      });
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Failed to create agent.');
    } finally {
      setIsGeneratingAgent(false);
    }
  };

  const toggleSpeechInput = () => {
    if (!speechSupported || !recognitionRef.current) return;

    if (isListening) {
      try {
        recognitionRef.current.stop();
      } catch {
        // ignore
      }
      setIsListening(false);
      return;
    }

    try {
      dictationBaseRef.current = aiPrompt;
      recognitionRef.current.start();
      setIsListening(true);
    } catch (error) {
      console.error('Failed to start speech recognition:', error);
      setIsListening(false);
    }
  };

  const handleAddSelectedTool = () => {
    if (selectedToolToAdd === '__none__') return;
    if (selectedTools.includes(selectedToolToAdd)) return;
    setSelectedTools((prev) => [...prev, selectedToolToAdd]);
    setSelectedToolToAdd('__none__');
  };

  const handleRemoveSelectedTool = (toolId: string) => {
    setSelectedTools((prev) => prev.filter((id) => id !== toolId));
  };

  const handleDeleteAgent = async (agentId: string, agent: AgentInfo) => {
    if (agent.isDefault) {
      setActionError('Default agents cannot be deleted. Use Edit to configure them.');
      return;
    }
    if (!confirm('Delete this agent? This cannot be undone.')) return;
    try {
      if (agent.isUserCreated) {
        await apiClient.deleteAgentFolder(agentId);
        const { deleteUserAgent } = useAppStore.getState();
        deleteUserAgent(agentId);
      } else {
        await apiClient.deleteAgent(agentId);
        await loadEntities();
      }
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Failed to delete agent.');
    }
  };

  return (
    <div className="flex flex-col h-full bg-background">
      {/* Header */}
      <div className="border-b bg-card/50 backdrop-blur-sm p-6">
        <div className="max-w-7xl mx-auto">
          <h1 className="text-3xl font-bold mb-2">Agents</h1>

          {/* Inline notifications */}
          {actionError && (
            <div className="flex items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive mb-4">
              <AlertCircle className="h-4 w-4 shrink-0" />
              {actionError}
              <button className="ml-auto opacity-60 hover:opacity-100" onClick={() => setActionError(null)}>×</button>
            </div>
          )}
          {actionSuccess && (
            <div className="flex items-center gap-2 rounded-lg border border-green-500/30 bg-green-500/10 px-3 py-2 text-sm text-green-600 dark:text-green-400 mb-4">
              <CheckCircle2 className="h-4 w-4 shrink-0" />
              {actionSuccess}
            </div>
          )}
          <p className="text-muted-foreground">Create and manage your AI agents</p>
        </div>
      </div>

      {/* Controls */}
      <div className="border-b bg-card/30 p-4">
        <div className="max-w-7xl mx-auto flex items-center gap-4">
          {/* Search */}
          <div className="flex-1 relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search agents..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9"
            />
          </div>

          {/* Sort */}
          <Select value={sortBy} onValueChange={(value: any) => setSortBy(value)}>
            <SelectTrigger className="w-[200px]">
              <SelectValue placeholder="Sort by..." />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="name">
                <div className="flex items-center gap-2">
                  <span>Alphabetical</span>
                </div>
              </SelectItem>
              <SelectItem value="date">
                <div className="flex items-center gap-2">
                  <Calendar className="h-4 w-4" />
                  <span>Date Created</span>
                </div>
              </SelectItem>
              <SelectItem value="modified">
                <div className="flex items-center gap-2">
                  <Calendar className="h-4 w-4" />
                  <span>Last Modified</span>
                </div>
              </SelectItem>
            </SelectContent>
          </Select>

          {/* Create New Button */}
          <Button variant="secondary" onClick={() => setIsAIDialogOpen(true)}>
            <Wand2 className="h-4 w-4 mr-2" />
            Create with AI
          </Button>

          <Button variant="outline" onClick={() => { setEditingWorkflow(null); setIsWorkflowDialogOpen(true); }}>
            <Workflow className="h-4 w-4 mr-2" />
            New Workflow
          </Button>

          <Button onClick={handleCreateNew} className="shadow-md">
            <Plus className="h-4 w-4 mr-2" />
            New Agent
          </Button>
        </div>
      </div>

      {/* Agent Grid */}
      <div className="flex-1 overflow-auto p-6">
        <div className="max-w-7xl mx-auto space-y-6">
          {/* Default Agents Section - Always show */}
          <div>
              <button
                onClick={() => setShowDefaultAgents(!showDefaultAgents)}
                className="flex items-center gap-2 text-lg font-semibold mb-4 hover:text-primary transition-colors"
              >
                {showDefaultAgents ? (
                  <ChevronDown className="h-5 w-5" />
                ) : (
                  <ChevronRight className="h-5 w-5" />
                )}
                Default Agents
                <Badge variant="secondary" className="ml-2">{defaultAgents.length}</Badge>
              </button>
              {showDefaultAgents && (
                <>
                  {defaultAgents.length === 0 ? (
                    <div className="text-center py-8 text-muted-foreground border-2 border-dashed rounded-lg">
                      <p className="text-sm">No default agents found</p>
                      <p className="text-xs mt-1">This shouldn't happen - default agents should always be present</p>
                    </div>
                  ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                      {defaultAgents.map(agent => (
                        <AgentCard
                          key={agent.id}
                          agent={agent}
                          onEdit={() => handleEditAgent(agent)}
                          onDelete={() => handleDeleteAgent(agent.id, agent)}
                        />
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>

          {/* Your Agents Section */}
          <div>
            <button
              onClick={() => setShowYourAgents(!showYourAgents)}
              className="flex items-center gap-2 text-lg font-semibold mb-4 hover:text-primary transition-colors"
            >
              {showYourAgents ? (
                <ChevronDown className="h-5 w-5" />
              ) : (
                <ChevronRight className="h-5 w-5" />
              )}
              Your Agents
              <Badge variant="secondary" className="ml-2">{userAgents.length}</Badge>
            </button>
            {showYourAgents && (
              <>
                {userAgents.length === 0 ? (
                  <div className="flex flex-col items-center justify-center h-48 text-center border-2 border-dashed rounded-lg">
                    <Code className="h-12 w-12 text-muted-foreground/50 mb-3" />
                    <h3 className="text-base font-semibold mb-2">
                      {searchQuery ? 'No custom agents found' : 'No custom agents yet'}
                    </h3>
                    <p className="text-sm text-muted-foreground mb-4">
                      {searchQuery 
                        ? 'Try adjusting your search query'
                        : 'Create your first custom agent to get started'
                      }
                    </p>
                    {!searchQuery && (
                      <Button onClick={handleCreateNew}>
                        <Plus className="h-4 w-4 mr-2" />
                        Create Agent
                      </Button>
                    )}
                  </div>
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                    {userAgents.map(agent => (
                      <AgentCard
                        key={agent.id}
                        agent={agent}
                        onEdit={() => handleEditAgent(agent)}
                        onDelete={() => handleDeleteAgent(agent.id, agent)}
                      />
                    ))}
                  </div>
                )}
              </>
            )}
          </div>

          {/* Your Workflows Section */}
          <div>
            <button
              onClick={() => setShowYourWorkflows(!showYourWorkflows)}
              className="flex items-center gap-2 text-lg font-semibold mb-4 hover:text-primary transition-colors"
            >
              {showYourWorkflows ? <ChevronDown className="h-5 w-5" /> : <ChevronRight className="h-5 w-5" />}
              Your Workflows
              <Badge variant="secondary" className="ml-2">{savedWorkflows.length}</Badge>
            </button>
            {showYourWorkflows && (
              <>
                {savedWorkflows.length === 0 ? (
                  <div className="flex flex-col items-center justify-center h-48 text-center border-2 border-dashed rounded-xl">
                    <Workflow className="h-10 w-10 text-muted-foreground/40 mb-3" />
                    <h3 className="text-base font-semibold mb-1">No workflows yet</h3>
                    <p className="text-sm text-muted-foreground mb-4 max-w-xs">
                      A workflow saves a named set of agents + orchestration type for one-click reuse in Chat.
                    </p>
                    <Button onClick={() => { setEditingWorkflow(null); setIsWorkflowDialogOpen(true); }}>
                      <Plus className="h-4 w-4 mr-2" /> Create Workflow
                    </Button>
                  </div>
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                    {savedWorkflows.map((wf) => {
                      const opt = ORCHESTRATION_OPTIONS.find((o) => o.id === wf.orchestrationType);
                      const participants = wf.agentIds.map((id) => agents.find((a) => a.id === id)).filter(Boolean) as AgentInfo[];
                      const allTools = Array.from(new Set(
                        participants.flatMap((a) =>
                          (a.tools ?? []).map((t) => (typeof t === 'string' ? t : (t as any)?.name ?? JSON.stringify(t)))
                        )
                      ));
                      return (
                        <div key={wf.id} className="group relative rounded-xl border border-border/60 bg-card hover:border-primary/40 hover:shadow-md transition-all flex flex-col overflow-hidden">
                          <div className="h-1 w-full bg-primary/50" />
                          <div className="p-4 flex flex-col gap-3 flex-1">
                            <div className="flex items-start justify-between gap-2">
                              <div className="min-w-0">
                                <div className="flex items-center gap-1.5 mb-0.5">
                                  <Workflow className="h-3.5 w-3.5 text-primary shrink-0" />
                                  <h3 className="font-semibold text-sm truncate">{wf.name}</h3>
                                </div>
                                {wf.description && <p className="text-xs text-muted-foreground line-clamp-2">{wf.description}</p>}
                              </div>
                              <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                                <button className="h-7 w-7 flex items-center justify-center rounded-lg hover:bg-accent" onClick={() => { setEditingWorkflow(wf); setIsWorkflowDialogOpen(true); }} title="Edit">
                                  <Settings className="h-3.5 w-3.5" />
                                </button>
                                <button className="h-7 w-7 flex items-center justify-center rounded-lg hover:bg-destructive/10 text-muted-foreground hover:text-destructive" onClick={() => { if (confirm(`Delete "${wf.name}"?`)) deleteWorkflow(wf.id); }} title="Delete">
                                  <Trash2 className="h-3.5 w-3.5" />
                                </button>
                              </div>
                            </div>

                            {/* Agents with their tools */}
                            <div className="flex-1 space-y-1.5">
                              {participants.length > 0 ? participants.map((agent, idx) => {
                                const tools = (agent.tools ?? []).map((t) =>
                                  typeof t === 'string' ? t : (t as any)?.name ?? '?'
                                );
                                return (
                                  <div key={agent.id} className="flex items-start gap-1.5">
                                    {wf.orchestrationType === 'sequential' && (
                                      <span className="text-[10px] text-muted-foreground/50 font-mono mt-0.5 shrink-0 w-4">{idx + 1}.</span>
                                    )}
                                    <div className="min-w-0">
                                      <span className="text-[11px] font-medium text-foreground/80">{agent.name || agent.id}</span>
                                      {tools.length > 0 && (
                                        <div className="flex flex-wrap gap-0.5 mt-0.5">
                                          {tools.map((t) => (
                                            <span key={t} className="inline-flex items-center gap-0.5 text-[9px] bg-primary/10 text-primary/70 rounded px-1 py-0.5 font-mono">
                                              <Wrench className="h-2 w-2" />{t}
                                            </span>
                                          ))}
                                        </div>
                                      )}
                                    </div>
                                  </div>
                                );
                              }) : (
                                // Agents not loaded yet — show IDs
                                <div className="flex flex-wrap gap-1">
                                  {wf.agentIds.map((id) => (
                                    <span key={id} className="text-[10px] bg-muted/60 rounded px-1.5 py-0.5 text-muted-foreground">{id}</span>
                                  ))}
                                </div>
                              )}
                            </div>

                            <div className="pt-1 border-t border-border/40 flex items-center justify-between gap-2">
                              <span className="text-[11px] text-muted-foreground">
                                {opt?.icon} {opt?.label} · {wf.agentIds.length} agent{wf.agentIds.length !== 1 ? 's' : ''} · {allTools.length} tool{allTools.length !== 1 ? 's' : ''}
                              </span>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </>
            )}
          </div>

        </div>
      </div>

      {/* Workflow Builder Dialog */}
      <WorkflowBuilderDialog
        open={isWorkflowDialogOpen}
        onOpenChange={setIsWorkflowDialogOpen}
        editing={editingWorkflow}
      />

      {/* Agent Editor Dialog */}
      <AgentEditorDialog
        open={isEditorOpen}
        onOpenChange={setIsEditorOpen}
        agent={editingAgent}
        onSave={handleSaveAgent}
      />

      <Dialog open={isAIDialogOpen} onOpenChange={setIsAIDialogOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Create Agent with AI</DialogTitle>
            <DialogDescription>
              Describe what kind of agent you want. AI will generate the name, description, instructions, and model.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor="ai-agent-prompt">What agent should be created?</Label>
              {speechSupported && (
                <Button
                  type="button"
                  variant={isListening ? 'destructive' : 'outline'}
                  size="sm"
                  onClick={toggleSpeechInput}
                  disabled={isGeneratingAgent}
                  className={isListening ? 'ring-2 ring-red-400 ring-offset-1' : ''}
                  title={isListening ? 'Stop dictation' : 'Start speech-to-text'}
                >
                  {isListening ? <MicOff className="h-4 w-4 mr-2" /> : <Mic className="h-4 w-4 mr-2" />}
                  {isListening ? 'Stop Dictation' : 'Dictate'}
                </Button>
              )}
            </div>
            <Textarea
              id="ai-agent-prompt"
              placeholder="Example: Create an agent that reviews pull requests for security issues and explains risks in simple terms."
              value={aiPrompt}
              onChange={(e) => {
                const value = e.target.value;
                setAiPrompt(value);
                dictationBaseRef.current = value;
              }}
              rows={7}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="preferred-model">Preferred Model (optional)</Label>
            <Select value={preferredModel} onValueChange={setPreferredModel} disabled={isGeneratingAgent || isLoadingModels}>
              <SelectTrigger id="preferred-model">
                <SelectValue placeholder={isLoadingModels ? 'Loading local models...' : 'Auto-select from local models'} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__auto__">Auto-select and ask me to confirm</SelectItem>
                {availableModels.map((model) => (
                  <SelectItem key={model.name} value={model.name}>{model.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Detected local models: {availableModels.length > 0 ? availableModels.map((m) => m.name).join(', ') : 'none detected'}
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="preferred-tool">Tools (optional)</Label>
            <div className="flex items-center gap-2">
              <Select
                value={selectedToolToAdd}
                onValueChange={(value) => {
                  setSelectedToolToAdd(value);
                  if (value !== '__none__' && !selectedTools.includes(value)) {
                    setSelectedTools((prev) => [...prev, value]);
                    setSelectedToolToAdd('__none__');
                  }
                }}
                disabled={isGeneratingAgent}
              >
                <SelectTrigger id="preferred-tool" className="flex-1">
                  <SelectValue placeholder="Pick a tool to add" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">Select a tool...</SelectItem>
                  {savedTools.map((tool) => (
                    <SelectItem key={tool.id} value={tool.id}>{tool.name} ({tool.id})</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button type="button" variant="outline" onClick={handleAddSelectedTool} disabled={isGeneratingAgent || selectedToolToAdd === '__none__'}>
                Add Tool
              </Button>
            </div>
            <div className="flex flex-wrap gap-2 min-h-[28px]">
              {selectedTools.map((toolId) => (
                <Badge key={toolId} variant="secondary" className="flex items-center gap-2">
                  {toolId}
                  <button
                    type="button"
                    onClick={() => handleRemoveSelectedTool(toolId)}
                    className="text-xs leading-none"
                    aria-label={`Remove ${toolId}`}
                  >
                    x
                  </button>
                </Badge>
              ))}
              {selectedTools.length === 0 && (
                <p className="text-xs text-muted-foreground">No tools selected. AI will generate general instructions.</p>
              )}
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setIsAIDialogOpen(false)} disabled={isGeneratingAgent}>
              Cancel
            </Button>
            <Button onClick={handleCreateWithAI} disabled={isGeneratingAgent || !aiPrompt.trim()}>
              {isGeneratingAgent ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Creating...
                </>
              ) : (
                <>
                  <Wand2 className="h-4 w-4 mr-2" />
                  Create Agent
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={isModelConfirmOpen} onOpenChange={setIsModelConfirmOpen}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>Confirm Model</DialogTitle>
            <DialogDescription>
              Choose which local Ollama model this generated agent should use.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div>
              <p className="text-sm font-medium">Generated Agent</p>
              <p className="text-sm text-muted-foreground">{pendingGeneratedAgent?.name || 'Untitled Agent'}</p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="confirm-model">Model</Label>
              <Select value={confirmModel} onValueChange={setConfirmModel}>
                <SelectTrigger id="confirm-model">
                  <SelectValue placeholder="Select model" />
                </SelectTrigger>
                <SelectContent>
                  {availableModels.map((model) => (
                    <SelectItem key={model.name} value={model.name}>{model.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setIsModelConfirmOpen(false);
                setPendingGeneratedAgent(null);
              }}
              disabled={isGeneratingAgent}
            >
              Cancel
            </Button>
            <Button onClick={handleConfirmModelAndCreate} disabled={isGeneratingAgent || !confirmModel}>
              {isGeneratingAgent ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Creating...
                </>
              ) : (
                'Use This Model'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

interface AgentCardProps {
  agent: AgentInfo;
  onEdit: () => void;
  onDelete: () => void;
}

const AgentCard: React.FC<AgentCardProps> = ({ agent, onEdit, onDelete }) => {
  const toolCount = agent.tools?.length ?? 0;
  const isDefault = agent.isDefault;
  const isWorkflow = agent.type === 'workflow';

  return (
    <div className={`group relative rounded-xl border transition-all hover:shadow-md hover:border-primary/40 bg-card flex flex-col overflow-hidden ${
      isDefault ? 'border-primary/30' : 'border-border/60'
    }`}>
      {/* Top accent bar */}
      <div className={`h-1 w-full ${isDefault ? 'bg-primary/60' : isWorkflow ? 'bg-purple-500/60' : 'bg-border/40'}`} />

      <div className="p-4 flex flex-col gap-3 flex-1">
        {/* Name row */}
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 flex-wrap mb-0.5">
              {isDefault && <Badge variant="default" className="text-[10px] h-4 px-1.5 shrink-0">Default</Badge>}
              {isWorkflow && <Badge variant="outline" className="text-[10px] h-4 px-1.5 shrink-0 text-purple-500 border-purple-400/50">Workflow</Badge>}
              <h3 className="font-semibold text-sm truncate">{agent.name || agent.id}</h3>
            </div>
            {agent.model_id && (
              <p className="text-[11px] text-muted-foreground font-mono truncate">{agent.model_id}</p>
            )}
          </div>

          {/* Actions — shown on hover */}
          <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
            <button
              className="h-7 w-7 flex items-center justify-center rounded-lg hover:bg-accent transition-colors"
              onClick={onEdit}
              title={isDefault ? 'Configure' : 'Edit'}
            >
              <Settings className="h-3.5 w-3.5" />
            </button>
            {!isDefault && !isWorkflow && (
              <button
                className="h-7 w-7 flex items-center justify-center rounded-lg hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
                onClick={onDelete}
                title="Delete"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>

        {/* Description */}
        {agent.description ? (
          <p className="text-xs text-muted-foreground line-clamp-2 leading-relaxed flex-1">
            {agent.description}
          </p>
        ) : (
          <p className="text-xs text-muted-foreground/50 italic flex-1">No description</p>
        )}

        {/* Footer chips */}
        <div className="flex items-center gap-1.5 flex-wrap pt-1 border-t border-border/40">
          {toolCount > 0 && (
            <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground bg-muted/60 rounded-md px-1.5 py-0.5">
              <Wrench className="h-2.5 w-2.5" />
              {toolCount} tool{toolCount !== 1 ? 's' : ''}
            </span>
          )}
          {agent.source && agent.source !== 'directory' && (
            <span className="text-[10px] text-muted-foreground bg-muted/60 rounded-md px-1.5 py-0.5">
              {agent.source}
            </span>
          )}
          {agent.isUserCreated && (
            <span className="text-[10px] text-primary/70 bg-primary/10 rounded-md px-1.5 py-0.5">
              custom
            </span>
          )}
        </div>
      </div>
    </div>
  );
};
