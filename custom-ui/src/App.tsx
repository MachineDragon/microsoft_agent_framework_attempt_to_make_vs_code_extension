import { Suspense, lazy, useEffect, useRef, useState } from "react";
import { useAppStore } from "@/stores/appStore";
import { apiClient } from "@/services/api";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ChatInterface } from "@/components/ChatInterface";
import { ConversationSelector } from "@/components/ConversationSelector";
import { EventsPanel } from "@/components/EventsPanel";
import { ModeToggle } from "@/components/ModeToggle";
import { MessageSquare, Blocks, Wrench, Database, Table, Workflow, ChevronDown, Settings, Loader2, Eye, EyeOff, LayoutDashboard, BookOpen } from "lucide-react";
import { useWorkflowStore, ORCHESTRATION_OPTIONS, type WorkflowOrchestration } from "@/stores/workflowStore";
import type { AgentInfo } from "@/types";

const AgentsModal = lazy(() => import("@/components/AgentBuilderModal").then((module) => ({ default: module.AgentsModal })));
const AgentsPage = lazy(() => import("@/components/AgentBuilderPage").then((module) => ({ default: module.AgentsPage })));
const ToolsPage = lazy(() => import("@/components/ToolsPage").then((module) => ({ default: module.ToolsPage })));
const ModelsPage = lazy(() => import("@/components/ModelsPage").then((module) => ({ default: module.ModelsPage })));
const IDEPage = lazy(() => import("@/components/IDEPage").then((module) => ({ default: module.IDEPage })));
const DataPage = lazy(() => import("@/components/DataPage").then((module) => ({ default: module.DataPage })));
const NotesPage = lazy(() => import("@/components/NotesPage").then((module) => ({ default: module.NotesPage })));
const AgentDetailsDialog = lazy(() => import("@/components/AgentDetailsDialog").then((module) => ({ default: module.AgentDetailsDialog })));

const ORCHESTRATION_CHOICES: Array<{ id: WorkflowOrchestration; label: string; desc: string }> = [
  { id: 'group_chat', label: 'Group Chat', desc: 'Agents take turns in round-robin discussion' },
  { id: 'sequential', label: 'Sequential', desc: 'Agents work in pipeline, passing results forward' },
  { id: 'concurrent', label: 'Concurrent', desc: 'Agents work in parallel, results aggregated' },
  { id: 'handoff', label: 'Handoff', desc: 'Agents dynamically transfer control to each other' },
  { id: 'magentic', label: 'Magentic', desc: 'Manager coordinates specialized agents' },
];

const PENDING_AGENT_MODEL_EDIT_KEY = 'budai:pending-edit-agent-model';
const OLLAMA_KEYS_URL = 'https://ollama.com/settings/keys';

const isCloudModel = (modelName: string) => modelName.toLowerCase().includes(':cloud');

function PageLoader() {
  return (
    <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
      <Loader2 className="h-4 w-4 animate-spin" /> Loading
    </div>
  );
}

function App() {
  const {
    agents,
    selectedAgent,
    selectedAgents,
    orchestrationType,
    managerModelId,
    setManagerModelId,
    toggleAgentSelection,
    loadEntities,
    chatTargetMode,
    setChatTargetMode,
    selectedDirectModel,
    setSelectedDirectModel,
  } = useAppStore();
  const [isAgentBuilderOpen, setIsAgentBuilderOpen] = useState(false);
  const [showEventsPanel] = useState(true);
  const [isAgentDetailsOpen, setIsAgentDetailsOpen] = useState(false);
  const [currentPage, setCurrentPage] = useState<'chat' | 'agents' | 'tools' | 'models' | 'data' | 'data-dashboards' | 'data-builder' | 'ide' | 'notes'>('chat');
  const [agentToEditModel, setAgentToEditModel] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isAgentSelectorOpen, setIsAgentSelectorOpen] = useState(false);
  const [isOrchestrationSelectorOpen, setIsOrchestrationSelectorOpen] = useState(false);
  const [isChatTargetSelectorOpen, setIsChatTargetSelectorOpen] = useState(false);
  const [isWorkflowSelectorOpen, setIsWorkflowSelectorOpen] = useState(false);
  const [isManagerModelOpen, setIsManagerModelOpen] = useState(false);
  const { workflows: savedWorkflows } = useWorkflowStore();
  const [isDataNavOpen, setIsDataNavOpen] = useState(false);
  const [isModelSelectorOpen, setIsModelSelectorOpen] = useState(false);
  const [availableModels, setAvailableModels] = useState<Array<{ name: string; id: string; size: string; modified: string }>>([]);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [settingsLoading, setSettingsLoading] = useState(false);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [settingsSaved, setSettingsSaved] = useState(false);
  const [settingsNotice, setSettingsNotice] = useState<string | null>(null);
  const [ollamaApiKey, setOllamaApiKey] = useState("");
  const [ollamaApiKeyConfigured, setOllamaApiKeyConfigured] = useState(false);
  const [showOllamaApiKey, setShowOllamaApiKey] = useState(false);
  const dataNavCloseTimerRef = useRef<number | null>(null);

  const canChat = chatTargetMode === 'model'
    ? !!selectedDirectModel
    : chatTargetMode === 'agents'
      ? !!selectedAgent || selectedAgents.length > 0
      : selectedAgents.length >= 2;

  useEffect(() => {
    const initialize = async () => {
      try {
        const health = await apiClient.getHealth();
        console.log('Backend health:', health);
        await loadEntities();
        const models = await apiClient.getOllamaModels();
        setAvailableModels(models);
        const preferredModel = models.find((model) => !isCloudModel(model.name)) || models[0];
        if (preferredModel && (!selectedDirectModel || isCloudModel(selectedDirectModel))) {
          setSelectedDirectModel(preferredModel.name);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to initialize');
      } finally {
        setLoading(false);
      }
    };
    initialize();
  }, [loadEntities, selectedDirectModel, setSelectedDirectModel]);

  useEffect(() => {
    if (!isSettingsOpen) {
      return;
    }

    const loadSettings = async () => {
      setSettingsLoading(true);
      setSettingsError(null);
      setSettingsSaved(false);
      try {
        const settings = await apiClient.getCustomSettings();
        setOllamaApiKeyConfigured(settings.ollama_api_key_configured);
        setOllamaApiKey("");
      } catch (err) {
        setSettingsError(err instanceof Error ? err.message : "Failed to load settings");
      } finally {
        setSettingsLoading(false);
      }
    };

    loadSettings();
  }, [isSettingsOpen]);

  useEffect(() => () => {
    if (dataNavCloseTimerRef.current !== null) {
      window.clearTimeout(dataNavCloseTimerRef.current);
    }
  }, []);

  useEffect(() => {
    const handleOpenSettings = (event: Event) => {
      const reason = (event as CustomEvent<{ reason?: string }>).detail?.reason;
      setSettingsNotice(reason === 'ollama-web-search-key-required'
        ? 'Ollama hosted web search needs an Ollama API key. Generate a free key, paste it here, then save.'
        : null);
      setIsSettingsOpen(true);
    };

    window.addEventListener('budai:open-settings', handleOpenSettings);
    return () => window.removeEventListener('budai:open-settings', handleOpenSettings);
  }, []);

  useEffect(() => {
    const handleEditAgentModel = (event: Event) => {
      const agentId = (event as CustomEvent<{ agentId?: string }>).detail?.agentId;
      if (!agentId) return;
      window.sessionStorage.setItem(PENDING_AGENT_MODEL_EDIT_KEY, agentId);
      setAgentToEditModel(agentId);
      setCurrentPage('agents');
    };

    window.addEventListener('budai:edit-agent-model', handleEditAgentModel);
    return () => window.removeEventListener('budai:edit-agent-model', handleEditAgentModel);
  }, []);

  const openDataNav = () => {
    if (dataNavCloseTimerRef.current !== null) {
      window.clearTimeout(dataNavCloseTimerRef.current);
      dataNavCloseTimerRef.current = null;
    }
    setIsDataNavOpen(true);
  };

  const scheduleCloseDataNav = () => {
    if (dataNavCloseTimerRef.current !== null) {
      window.clearTimeout(dataNavCloseTimerRef.current);
    }
    dataNavCloseTimerRef.current = window.setTimeout(() => {
      setIsDataNavOpen(false);
      dataNavCloseTimerRef.current = null;
    }, 180);
  };

  const saveSettings = async () => {
    const apiKey = ollamaApiKey.trim();
    if (!apiKey) {
      setSettingsError("Enter an Ollama API key before saving.");
      setSettingsSaved(false);
      return;
    }

    setSettingsSaving(true);
    setSettingsError(null);
    setSettingsSaved(false);
    try {
      const settings = await apiClient.updateCustomSettings({ ollama_api_key: apiKey });
      setOllamaApiKeyConfigured(settings.ollama_api_key_configured);
      setOllamaApiKey("");
      setSettingsSaved(true);
    } catch (err) {
      setSettingsError(err instanceof Error ? err.message : "Failed to save settings");
    } finally {
      setSettingsSaving(false);
    }
  };

  const clearOllamaApiKey = async () => {
    setSettingsSaving(true);
    setSettingsError(null);
    setSettingsSaved(false);
    try {
      const settings = await apiClient.updateCustomSettings({ clear_ollama_api_key: true });
      setOllamaApiKeyConfigured(settings.ollama_api_key_configured);
      setOllamaApiKey("");
      setSettingsSaved(true);
    } catch (err) {
      setSettingsError(err instanceof Error ? err.message : "Failed to clear settings");
    } finally {
      setSettingsSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-4">
          <div className="h-12 w-12 rounded-2xl bg-primary/10 flex items-center justify-center">
            <Loader2 className="h-6 w-6 text-primary animate-spin" />
          </div>
          <p className="text-sm text-muted-foreground">Starting up…</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <div className="text-center space-y-4 max-w-sm">
          <div className="h-12 w-12 rounded-2xl bg-destructive/10 flex items-center justify-center mx-auto">
            <MessageSquare className="h-6 w-6 text-destructive" />
          </div>
          <h2 className="font-semibold">Connection failed</h2>
          <p className="text-sm text-muted-foreground">{error}</p>
          <button
            className="text-xs text-primary underline"
            onClick={() => window.location.reload()}
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen bg-background text-foreground flex-col">
      {/* Top Header */}
      <div className="relative z-50 border-b bg-card/80 backdrop-blur-sm">
        <div className="flex items-center justify-between px-4 py-2">
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2">
              <div className="h-7 w-7 rounded-lg bg-gradient-to-br from-primary to-primary/60 flex items-center justify-center shadow-sm">
                <MessageSquare className="h-4 w-4 text-primary-foreground" />
              </div>
              <h1 className="flex items-baseline text-sm font-semibold tracking-normal text-foreground">
                <span>Bud</span>
                <span className="ml-0.5 text-sm font-extrabold leading-none text-sky-500 tracking-[-0.16em]">
                  AI
                </span>
              </h1>
            </div>
            
            {/* Navigation */}
            <nav className="flex items-center gap-0.5 ml-2">
              <Button
                variant="ghost"
                size="sm"
                className={`h-8 px-3 text-xs gap-1.5 ${currentPage === 'chat' ? 'bg-accent text-accent-foreground' : ''}`}
                onClick={() => setCurrentPage('chat')}
              >
                <MessageSquare className="h-3.5 w-3.5" />
                Chat
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className={`h-8 px-3 text-xs gap-1.5 ${currentPage === 'tools' ? 'bg-accent text-accent-foreground' : ''}`}
                onClick={() => setCurrentPage('tools')}
              >
                <Wrench className="h-3.5 w-3.5" />
                Tools
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className={`h-8 px-3 text-xs gap-1.5 ${currentPage === 'agents' ? 'bg-accent text-accent-foreground' : ''}`}
                onClick={() => setCurrentPage('agents')}
              >
                <Blocks className="h-3.5 w-3.5" />
                Agents
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className={`h-8 px-3 text-xs gap-1.5 ${currentPage === 'models' ? 'bg-accent text-accent-foreground' : ''}`}
                onClick={() => setCurrentPage('models')}
              >
                <Database className="h-3.5 w-3.5" />
                Models
              </Button>
              <div
                className="relative"
                onMouseEnter={openDataNav}
                onMouseLeave={scheduleCloseDataNav}
              >
                <Button
                  variant="ghost"
                  size="sm"
                  className={`h-8 px-3 text-xs gap-1.5 ${currentPage === 'data' || currentPage === 'data-dashboards' || currentPage === 'data-builder' ? 'bg-accent text-accent-foreground' : ''}`}
                  onClick={() => {
                    setCurrentPage('data');
                    setIsDataNavOpen(!isDataNavOpen);
                  }}
                >
                  <Table className="h-3.5 w-3.5" />
                  Data
                  <ChevronDown className="h-3 w-3 opacity-60" />
                </Button>
                {isDataNavOpen && (
                  <>
                    <div className="absolute left-0 top-full z-50 w-52 rounded-lg border bg-card p-1.5 shadow-lg">
                      <button
                        className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs transition-colors ${currentPage === 'data' ? 'bg-accent' : 'hover:bg-accent/60'}`}
                        onClick={() => { setCurrentPage('data'); setIsDataNavOpen(false); }}
                      >
                        <MessageSquare className="h-3.5 w-3.5" />
                        Chat
                      </button>
                      <button
                        className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs transition-colors ${currentPage === 'data-dashboards' ? 'bg-accent' : 'hover:bg-accent/60'}`}
                        onClick={() => { setCurrentPage('data-dashboards'); setIsDataNavOpen(false); }}
                      >
                        <LayoutDashboard className="h-3.5 w-3.5" />
                        Dashboards
                      </button>
                      <button
                        className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs transition-colors ${currentPage === 'data-builder' ? 'bg-accent' : 'hover:bg-accent/60'}`}
                        onClick={() => { setCurrentPage('data-builder'); setIsDataNavOpen(false); }}
                      >
                        <Database className="h-3.5 w-3.5" />
                        AI Dashboard Builder
                      </button>
                    </div>
                  </>
                )}
              </div>
              <Button
                variant="ghost"
                size="sm"
                className={`h-8 px-3 text-xs gap-1.5 ${currentPage === 'ide' ? 'bg-accent text-accent-foreground' : ''}`}
                onClick={() => setCurrentPage('ide')}
              >
                <Blocks className="h-3.5 w-3.5" />
                IDE
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className={`h-8 px-3 text-xs gap-1.5 ${currentPage === 'notes' ? 'bg-accent text-accent-foreground' : ''}`}
                onClick={() => setCurrentPage('notes')}
              >
                <BookOpen className="h-3.5 w-3.5" />
                Notes
              </Button>
            </nav>
          </div>

          {/* Chat target and selector controls */}
          {currentPage === 'chat' && (
            <>
              <div className="relative">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setIsChatTargetSelectorOpen(!isChatTargetSelectorOpen)}
                  className="gap-2"
                >
                  <MessageSquare className="h-4 w-4" />
                  <span>{chatTargetMode === 'model' ? 'Target: Direct Model' : chatTargetMode === 'workflows' ? 'Target: Workflows' : 'Target: Agents'}</span>
                  <ChevronDown className="h-3.5 w-3.5 opacity-70" />
                </Button>
                {isChatTargetSelectorOpen && (
                  <>
                    <div
                      className="fixed inset-0 z-10"
                      onClick={() => setIsChatTargetSelectorOpen(false)}
                    />
                    <div className="absolute top-full mt-2 right-0 w-56 border rounded-lg p-2 bg-card shadow-lg z-20">
                      <button
                        className={`w-full text-left rounded px-2 py-2 text-sm transition-colors ${chatTargetMode === 'agents' ? 'bg-accent' : 'hover:bg-accent/60'}`}
                        onClick={() => { setChatTargetMode('agents'); setIsChatTargetSelectorOpen(false); }}
                      >
                        Agents
                      </button>
                      <button
                        className={`w-full text-left rounded px-2 py-2 text-sm transition-colors ${chatTargetMode === 'workflows' ? 'bg-accent' : 'hover:bg-accent/60'}`}
                        onClick={() => { setChatTargetMode('workflows'); setIsChatTargetSelectorOpen(false); }}
                      >
                        Workflows
                      </button>
                      <button
                        className={`w-full text-left rounded px-2 py-2 text-sm transition-colors ${chatTargetMode === 'model' ? 'bg-accent' : 'hover:bg-accent/60'}`}
                        onClick={() => { setChatTargetMode('model'); setIsChatTargetSelectorOpen(false); }}
                      >
                        Direct Model
                      </button>
                    </div>
                  </>
                )}
              </div>

              {(chatTargetMode as string) === 'workflows' && (
                <div className="relative">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setIsWorkflowSelectorOpen(!isWorkflowSelectorOpen)}
                    className="gap-2"
                  >
                    <Workflow className="h-4 w-4" />
                    <span>
                      {selectedAgents.length >= 2
                        ? `Workflow: ${selectedAgents.map(a => a.name).join(' → ').slice(0, 30)}${selectedAgents.map(a => a.name).join(' → ').length > 30 ? '…' : ''}`
                        : 'Workflow: Select'}
                    </span>
                    <ChevronDown className="h-3.5 w-3.5 opacity-70" />
                  </Button>
                  {isWorkflowSelectorOpen && (
                    <>
                      <div className="fixed inset-0 z-10" onClick={() => setIsWorkflowSelectorOpen(false)} />
                      <div className="absolute top-full mt-2 right-0 w-80 border rounded-lg p-3 bg-card shadow-lg z-20">
                        <div className="text-sm font-semibold mb-2">Choose Workflow</div>
                        {savedWorkflows.length === 0 ? (
                          <div className="text-sm text-muted-foreground py-2">
                            No workflows yet. Create one in the <strong>Agents</strong> page.
                          </div>
                        ) : (
                          <div className="flex flex-col gap-1 max-h-64 overflow-y-auto">
                            {savedWorkflows.map((wf) => {
                              const opt = ORCHESTRATION_OPTIONS.find(o => o.id === wf.orchestrationType);
                              const wfAgents = wf.agentIds.map(id => agents.find(a => a.id === id)).filter(Boolean) as typeof agents;
                              return (
                                <button
                                  key={wf.id}
                                  className="w-full text-left rounded px-2 py-2 text-sm hover:bg-accent/60 transition-colors"
                                  onClick={() => {
                                    // Pre-populate agents + orchestration type
                                    useAppStore.getState().setSelectedAgents(wfAgents);
                                    useAppStore.getState().setOrchestrationType(wf.orchestrationType);
                                    setChatTargetMode('workflows');
                                    setIsWorkflowSelectorOpen(false);
                                  }}
                                >
                                  <div className="font-medium">{wf.name}</div>
                                  <div className="text-xs text-muted-foreground mt-0.5">
                                    {opt?.icon} {opt?.label} · {wf.agentIds.length} agents
                                    {wf.description && ` · ${wf.description}`}
                                  </div>
                                </button>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    </>
                  )}
                </div>
              )}

              {chatTargetMode === 'model' && (
                <div className="relative">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setIsModelSelectorOpen(!isModelSelectorOpen)}
                    className="gap-2"
                  >
                    <Database className="h-4 w-4" />
                    <span>{selectedDirectModel ? `Model: ${selectedDirectModel}` : 'Model: Select'}</span>
                    <ChevronDown className="h-3.5 w-3.5 opacity-70" />
                  </Button>
                  {isModelSelectorOpen && (
                    <>
                      <div
                        className="fixed inset-0 z-10"
                        onClick={() => setIsModelSelectorOpen(false)}
                      />
                      <div className="absolute top-full mt-2 right-0 w-80 border rounded-lg p-3 bg-card shadow-lg z-20">
                        <div className="text-sm font-semibold mb-2">Choose Model</div>
                        {availableModels.length > 0 ? (
                          <div className="flex flex-col gap-1 max-h-64 overflow-y-auto">
                            {availableModels.map((model) => (
                              <button
                                key={model.id || model.name}
                                className={`w-full text-left rounded px-2 py-2 text-sm transition-colors ${selectedDirectModel === model.name ? 'bg-accent' : 'hover:bg-accent/60'}`}
                                onClick={() => {
                                  setSelectedDirectModel(model.name);
                                  setIsModelSelectorOpen(false);
                                }}
                              >
                                {model.name}
                              </button>
                            ))}
                          </div>
                        ) : (
                          <div className="text-sm text-muted-foreground">No models found</div>
                        )}
                      </div>
                    </>
                  )}
                </div>
              )}

              {chatTargetMode === 'agents' && (
                <>
                  <div className="relative">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setIsAgentSelectorOpen(!isAgentSelectorOpen)}
                      className="gap-2"
                    >
                      <MessageSquare className="h-4 w-4" />
                      <span>{selectedAgents.length > 0 ? `Agents: ${selectedAgents.length} selected` : 'Agents: Select'}</span>
                      <ChevronDown className="h-3.5 w-3.5 opacity-70" />
                    </Button>
                    {isAgentSelectorOpen && (
                      <>
                        <div
                          className="fixed inset-0 z-10"
                          onClick={() => setIsAgentSelectorOpen(false)}
                        />
                        <div className="absolute top-full mt-2 right-0 w-80 border rounded-lg p-3 bg-card shadow-lg z-20">
                          <div className="flex items-center justify-between mb-2">
                            <div className="text-sm font-semibold">Select Agents ({selectedAgents.length})</div>
                            {selectedAgents.length > 0 && (
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-6 text-xs"
                                onClick={() => useAppStore.getState().setSelectedAgents([])}
                              >
                                Clear All
                              </Button>
                            )}
                          </div>
                          {agents.length > 0 ? (
                            <div className="flex flex-col gap-2 max-h-64 overflow-y-auto">
                              {agents.map(agent => (
                                <label
                                  key={agent.id}
                                  className="flex items-center gap-2 p-2 rounded hover:bg-accent cursor-pointer transition-colors"
                                >
                                  <input
                                    type="checkbox"
                                    checked={selectedAgents.some(a => a.id === agent.id)}
                                    onChange={() => toggleAgentSelection(agent)}
                                    className="w-4 h-4"
                                  />
                                  <div className="flex-1">
                                    <div className="text-sm font-medium">{agent.name}</div>
                                    {agent.description && (
                                      <div className="text-xs text-muted-foreground truncate">
                                        {agent.description}
                                      </div>
                                    )}
                                  </div>
                                </label>
                              ))}
                            </div>
                          ) : (
                            <div className="text-sm text-muted-foreground">No agents found</div>
                          )}
                        </div>
                      </>
                    )}
                  </div>

                  {selectedAgents.length > 1 && (
                    <div className="relative">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setIsOrchestrationSelectorOpen(!isOrchestrationSelectorOpen)}
                        className="gap-2"
                      >
                        <Workflow className="h-4 w-4" />
                        <span>{orchestrationType === 'group_chat' ? 'Mode: Group Chat' :
                         orchestrationType === 'sequential' ? 'Mode: Sequential' :
                         orchestrationType === 'concurrent' ? 'Mode: Concurrent' :
                         orchestrationType === 'handoff' ? 'Mode: Handoff' :
                         'Mode: Magentic'}</span>
                        <ChevronDown className="h-3.5 w-3.5 opacity-70" />
                      </Button>
                      {isOrchestrationSelectorOpen && (
                        <>
                          <div
                            className="fixed inset-0 z-10"
                            onClick={() => setIsOrchestrationSelectorOpen(false)}
                          />
                          <div className="absolute top-full mt-2 right-0 w-72 border rounded-lg p-3 bg-card shadow-lg z-20">
                            <div className="text-sm font-semibold mb-3">Orchestration Type</div>
                            <div className="flex flex-col gap-2">
                              {ORCHESTRATION_CHOICES.map(type => (
                                <label
                                  key={type.id}
                                  className="flex items-start gap-2 p-2 rounded hover:bg-accent cursor-pointer transition-colors"
                                >
                                  <input
                                    type="radio"
                                    name="orchestration"
                                    checked={orchestrationType === type.id}
                                    onChange={() => {
                                      useAppStore.getState().setOrchestrationType(type.id);
                                      setIsOrchestrationSelectorOpen(false);
                                    }}
                                    className="mt-0.5 w-4 h-4"
                                  />
                                  <div className="flex-1">
                                    <div className="text-sm font-medium">{type.label}</div>
                                    <div className="text-xs text-muted-foreground">
                                      {type.desc}
                                    </div>
                                  </div>
                                </label>
                              ))}
                            </div>
                          </div>
                        </>
                      )}
                    </div>
                  )}

                  {/* Manager model picker — only for group_chat with 2+ agents */}
                  {selectedAgents.length > 1 && orchestrationType === 'group_chat' && (
                    <div className="relative">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setIsManagerModelOpen(!isManagerModelOpen)}
                        className="gap-2"
                      >
                        <Database className="h-4 w-4" />
                        <span>{managerModelId ? `Manager: ${managerModelId}` : 'Manager: Auto'}</span>
                        <ChevronDown className="h-3.5 w-3.5 opacity-70" />
                      </Button>
                      {isManagerModelOpen && (
                        <>
                          <div className="fixed inset-0 z-10" onClick={() => setIsManagerModelOpen(false)} />
                          <div className="absolute top-full mt-2 right-0 w-72 border rounded-lg p-3 bg-card shadow-lg z-20">
                            <div className="text-sm font-semibold mb-1">Manager LLM Model</div>
                            <div className="text-xs text-muted-foreground mb-3">The model that decides which agent speaks next.</div>
                            <div className="flex flex-col gap-1 max-h-60 overflow-y-auto">
                              <button
                                className={`w-full text-left rounded px-2 py-2 text-sm transition-colors ${!managerModelId ? 'bg-accent' : 'hover:bg-accent/60'}`}
                                onClick={() => { setManagerModelId(''); setIsManagerModelOpen(false); }}
                              >
                                <div className="font-medium">Auto</div>
                                <div className="text-xs text-muted-foreground">Borrow from first selected agent</div>
                              </button>
                              {availableModels.map((model) => (
                                <button
                                  key={model.id || model.name}
                                  className={`w-full text-left rounded px-2 py-2 text-sm transition-colors ${managerModelId === model.name ? 'bg-accent' : 'hover:bg-accent/60'}`}
                                  onClick={() => { setManagerModelId(model.name); setIsManagerModelOpen(false); }}
                                >
                                  {model.name}
                                </button>
                              ))}
                            </div>
                          </div>
                        </>
                      )}
                    </div>
                  )}
                </>
              )}
            </>
          )}

          <div className="flex items-center gap-1.5">
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => { setSettingsNotice(null); setIsSettingsOpen(true); }}
              aria-label="Open settings"
              title="Settings"
            >
              <Settings className="h-3.5 w-3.5" />
            </Button>
            <ModeToggle />
          </div>
        </div>

      </div>

      {/* Main Content Area */}
      <div className="flex-1 flex overflow-hidden">
        <Suspense fallback={<PageLoader />}>
          {currentPage === 'agents' ? (
            <AgentsPage editAgentId={agentToEditModel} onEditAgentHandled={() => setAgentToEditModel(null)} />
          ) : currentPage === 'tools' ? (
            <ToolsPage />
          ) : currentPage === 'models' ? (
            <ModelsPage />
          ) : currentPage === 'data' ? (
            <DataPage initialAssistantMode="chat" onOpenDashboards={() => setCurrentPage('data-builder')} />
          ) : currentPage === 'data-dashboards' ? (
            <DataPage initialAssistantMode="dashboards" onOpenDashboards={() => setCurrentPage('data-builder')} />
          ) : currentPage === 'data-builder' ? (
            <DataPage initialAssistantMode="builder" onOpenDashboards={() => setCurrentPage('data-builder')} />
          ) : currentPage === 'ide' ? (
            <div className="flex-1 flex flex-col">
              <IDEPage />
            </div>
          ) : currentPage === 'notes' ? (
            <div className="flex-1 flex flex-col overflow-hidden">
              <NotesPage />
            </div>
          ) : (
          <>
            <div className="flex-1 flex flex-col bg-gradient-to-br from-background via-background to-accent/5">
              {canChat ? (
                <>
                  {/* Show conversation selector only for single agent */}
                  {chatTargetMode === 'agents' && selectedAgent && selectedAgent.type === 'agent' && selectedAgents.length <= 1 && (
                    <ConversationSelector 
                      onToggleAgentDetails={() => setIsAgentDetailsOpen(true)}
                      onOpenSettings={() => setIsAgentBuilderOpen(true)}
                    />
                  )}
                  {/* Show multi-agent info bar when multiple agents selected */}
                  {(chatTargetMode === 'agents' || chatTargetMode === 'workflows') && selectedAgents.length > 1 && (
                    <div className="bg-accent/20 border-b px-4 py-2">
                      <div className="flex items-center gap-2">
                        <Workflow className="h-3.5 w-3.5 text-muted-foreground" />
                        <span className="text-xs text-muted-foreground">
                          {orchestrationType === 'group_chat' ? 'Group Chat' : 
                           orchestrationType === 'sequential' ? 'Sequential' :
                           orchestrationType === 'concurrent' ? 'Concurrent' :
                           orchestrationType === 'handoff' ? 'Handoff' :
                           'Magentic'}
                        </span>
                        <span className="text-xs text-foreground font-medium">{selectedAgents.map(a => a.name).join(' · ')}</span>
                      </div>
                    </div>
                  )}
                  <ChatInterface className="flex-1" />
                </>
              ) : (
                <div className="flex-1 flex items-center justify-center p-8">
                  <div className="text-center space-y-6 max-w-md">
                    <div className="h-16 w-16 rounded-2xl bg-primary/10 flex items-center justify-center mx-auto">
                      <MessageSquare className="h-8 w-8 text-primary/60" />
                    </div>
                    <div className="space-y-2">
                      <h2 className="text-xl font-semibold">
                      {chatTargetMode === 'model' ? 'Choose a model to start' : chatTargetMode === 'workflows' ? 'Choose a workflow to start' : 'Choose an agent to start'}
                    </h2>
                    <p className="text-sm text-muted-foreground">
                      {chatTargetMode === 'model'
                        ? 'Select a model from the toolbar above to chat directly.'
                        : chatTargetMode === 'workflows'
                          ? 'Select a saved workflow above, or create one on the Agents page.'
                          : 'Select one or more agents from the toolbar, then start chatting.'}
                      </p>
                    </div>
                    <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground">
                      {['🤖 Build & run code', '🔍 Search the web', '📊 Analyze data', '📝 Write & edit files'].map(hint => (
                        <div key={hint} className="rounded-lg border border-dashed border-border/60 px-3 py-2 text-left">{hint}</div>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Right Sidebar - Events Panel */}
            {showEventsPanel && chatTargetMode === 'agents' && selectedAgent && (
              <div className="w-96">
                <EventsPanel />
              </div>
            )}
          </>
          )}
        </Suspense>
      </div>

      {/* Agent Builder Modal */}
      <Suspense fallback={null}>
        <AgentsModal
          open={isAgentBuilderOpen}
          onOpenChange={setIsAgentBuilderOpen}
          agent={selectedAgent?.type === 'agent' ? selectedAgent : undefined}
        />
      </Suspense>

      {/* Agent Details Dialog */}
      {selectedAgent && selectedAgent.type === 'agent' && (
        <Suspense fallback={null}>
          <AgentDetailsDialog
            agent={selectedAgent as AgentInfo}
            open={isAgentDetailsOpen}
            onOpenChange={setIsAgentDetailsOpen}
          />
        </Suspense>
      )}

      <Dialog open={isSettingsOpen} onOpenChange={setIsSettingsOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Settings</DialogTitle>
            <DialogDescription>
              Configure the custom backend and API keys.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-5">
            {settingsNotice && (
              <div className="rounded-md border border-primary/30 bg-primary/10 px-3 py-2 text-xs text-primary">
                {settingsNotice}{' '}
                <a
                  href={OLLAMA_KEYS_URL}
                  target="_blank"
                  rel="noreferrer"
                  className="font-medium underline underline-offset-4"
                >
                  Generate a free Ollama key
                </a>
              </div>
            )}

            {/* Ollama API key */}
            <div className="rounded-lg border border-border/60 p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium">Ollama API Key</p>
                  <p className="text-xs text-muted-foreground mt-0.5">Used for web search via the custom backend.</p>
                  <a
                    href={OLLAMA_KEYS_URL}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-1 inline-flex text-xs font-medium text-primary underline-offset-4 hover:underline"
                  >
                    Generate an Ollama key
                  </a>
                </div>
                <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${ollamaApiKeyConfigured ? 'bg-green-500/15 text-green-600 dark:text-green-400' : 'bg-muted text-muted-foreground'}`}>
                  {ollamaApiKeyConfigured ? 'Active' : 'Not set'}
                </span>
              </div>
              <div className="flex gap-2">
                <Input
                  id="ollama-api-key"
                  type={showOllamaApiKey ? 'text' : 'password'}
                  value={ollamaApiKey}
                  onChange={(event) => { setOllamaApiKey(event.target.value); setSettingsSaved(false); }}
                  placeholder="sk-…"
                  disabled={settingsLoading || settingsSaving}
                  className="flex-1"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-9 w-9 shrink-0"
                  onClick={() => setShowOllamaApiKey((s) => !s)}
                  disabled={settingsLoading || settingsSaving || !ollamaApiKey}
                >
                  {showOllamaApiKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </Button>
              </div>
              {ollamaApiKeyConfigured && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="text-destructive hover:text-destructive h-7 px-2 text-xs"
                  onClick={clearOllamaApiKey}
                  disabled={settingsSaving}
                >
                  Clear key
                </Button>
              )}
            </div>

            {settingsError && (
              <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                {settingsError}
              </div>
            )}
            {settingsSaved && (
              <div className="rounded-md border border-green-500/30 bg-green-500/10 px-3 py-2 text-xs text-green-600 dark:text-green-400">
                Settings saved.
              </div>
            )}
          </div>

          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setIsSettingsOpen(false)}>Cancel</Button>
            <Button onClick={saveSettings} disabled={settingsSaving || settingsLoading || !ollamaApiKey.trim()}>
              {settingsSaving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

    </div>
  );
}

export default App;
