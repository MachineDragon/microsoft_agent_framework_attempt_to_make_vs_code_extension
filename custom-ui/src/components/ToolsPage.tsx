import React, { useState, useRef, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Card } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { Loader2, Paperclip, Send, Code, Save, Trash2, Plus, ChevronDown, ChevronRight, Eye, Wand2, Mic, MicOff, Edit2, Download } from 'lucide-react';
import { apiClient } from '@/services/api';
import { useToolStore, type Tool } from '@/stores/toolStore';

interface Message {
  role: 'user' | 'assistant';
  content: string;
}

type ToolTypeOption = 'auto' | 'function' | 'hosted_code_interpreter' | 'hosted_file_search' | 'hosted_web_search' | 'hosted_mcp';

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

export const ToolsPage: React.FC = () => {
  const { tools, addTool, deleteTool, updateTool } = useToolStore();
  const [selectedModel, setSelectedModel] = useState<string>('');
  const [availableModels, setAvailableModels] = useState<Array<{ name: string; id: string; size: string; modified: string }>>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputValue, setInputValue] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingContent, setStreamingContent] = useState('');
  const [isSaveDialogOpen, setIsSaveDialogOpen] = useState(false);
  const [toolName, setToolName] = useState('');
  const [toolDescription, setToolDescription] = useState('');
  const [codeToSave, setCodeToSave] = useState('');
  const [showDefaultTools, setShowDefaultTools] = useState(true);
  const [showUserTools, setShowUserTools] = useState(true);
  const [viewingTool, setViewingTool] = useState<Tool | null>(null);
  const [editingToolId, setEditingToolId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [editCode, setEditCode] = useState('');
  const [isInstallingDependencies, setIsInstallingDependencies] = useState(false);
  const [dependencyMessage, setDependencyMessage] = useState('');
  const [isAICreateDialogOpen, setIsAICreateDialogOpen] = useState(false);
  const [aiPrompt, setAiPrompt] = useState('');
  const [aiToolType, setAiToolType] = useState<ToolTypeOption>('auto');
  const [aiModel, setAiModel] = useState('__auto__');
  const [isGeneratingTool, setIsGeneratingTool] = useState(false);
  const [speechSupported, setSpeechSupported] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const scrollViewportRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const dictationBaseRef = useRef('');

  const loadModels = React.useCallback(async () => {
    try {
      const models = await apiClient.getOllamaModels();
      console.log('Loaded models:', models);
      setAvailableModels(models);
      setSelectedModel((prev) => prev || models[0]?.name || '');
    } catch (error) {
      console.error('Failed to load models:', error);
      setAvailableModels([]);
    }
  }, []);

  useEffect(() => {
    void loadModels();
  }, [loadModels]);

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
    if (!isAICreateDialogOpen && isListening && recognitionRef.current) {
      try { recognitionRef.current.stop(); } catch { /* ignore */ }
      setIsListening(false);
    }
  }, [isAICreateDialogOpen, isListening]);

  useEffect(() => {
    if (scrollViewportRef.current) {
      scrollViewportRef.current.scrollTop = scrollViewportRef.current.scrollHeight;
    }
  }, [messages, streamingContent]);

  const handleSendMessage = async () => {
    if (!inputValue.trim() || !selectedModel || isStreaming) return;

    const userMessage: Message = { role: 'user', content: inputValue.trim() };
    setMessages(prev => [...prev, userMessage]);
    setInputValue('');
    setIsStreaming(true);
    setStreamingContent('');

    try {
      // Call backend which proxies to Ollama
      const response = await fetch('/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: selectedModel,
          messages: [...messages, userMessage].map(m => ({ role: m.role, content: m.content })),
          stream: true,
        }),
      });

      const reader = response.body?.getReader();
      const decoder = new TextDecoder();
      let accumulatedContent = '';

      if (!reader) {
        throw new Error('No response body');
      }

      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.trim()) {
            try {
              const parsed = JSON.parse(line);
              // Ollama returns { message: { role, content }, done }
              const content = parsed.message?.content;
              if (content) {
                accumulatedContent += content;
                setStreamingContent(accumulatedContent);
              }
              if (parsed.done) break;
            } catch (e) {
              console.error('Failed to parse streaming data:', e);
            }
          }
        }
      }

      setMessages(prev => [...prev, { role: 'assistant', content: accumulatedContent }]);
      setStreamingContent('');
    } catch (error) {
      console.error('Failed to send message:', error);
      setMessages(prev => [...prev, { role: 'assistant', content: 'Error: Failed to get response from model' }]);
    } finally {
      setIsStreaming(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  };

  const extractCodeFromMessage = (content: string): string => {
    const codeBlockMatch = content.match(/```[\w]*\n([\s\S]*?)```/);
    return codeBlockMatch ? codeBlockMatch[1].trim() : content;
  };

  const handleSaveCode = (content: string) => {
    const code = extractCodeFromMessage(content);
    setCodeToSave(code);
    setToolName('');
    setToolDescription('');
    setIsSaveDialogOpen(true);
  };

  const handleConfirmSave = () => {
    if (!toolName.trim() || !codeToSave.trim()) return;

    addTool({
      id: `tool_${Date.now()}`,
      name: toolName.trim(),
      description: toolDescription.trim(),
      code: codeToSave,
      created_at: new Date().toISOString(),
    });

    setIsSaveDialogOpen(false);
    setToolName('');
    setToolDescription('');
    setCodeToSave('');
  };

  const handleDeleteTool = (toolId: string) => {
    if (confirm('Are you sure you want to delete this tool?')) {
      deleteTool(toolId);
    }
  };

  const handleNewChat = () => {
    if (messages.length > 0 && confirm('Start a new conversation? Current chat will be cleared.')) {
      setMessages([]);
      setStreamingContent('');
    } else if (messages.length === 0) {
      setMessages([]);
      setStreamingContent('');
    }
  };

  const handleCreateToolWithAI = async () => {
    const prompt = aiPrompt.trim();
    if (!prompt) {
      alert('Please describe the tool you want to create.');
      return;
    }

    setIsGeneratingTool(true);
    try {
      const selectedModel = aiModel !== '__auto__' ? aiModel : undefined;
      const generated = await apiClient.generateToolWithAI({
        prompt,
        model: selectedModel,
        availableModels: availableModels.map((m) => m.name),
        toolType: aiToolType,
      });

      setToolName(generated.name || 'Generated Tool');
      setToolDescription(generated.description || 'AI-generated tool');
      setCodeToSave(generated.code || '');
      setIsAICreateDialogOpen(false);
      setIsSaveDialogOpen(true);
    } catch (error) {
      console.error('Failed to create tool with AI:', error);
      alert(`Failed to create tool with AI: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      setIsGeneratingTool(false);
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

  const handleEditTool = (tool: Tool) => {
    setEditingToolId(tool.id);
    setEditName(tool.name);
    setEditDescription(tool.description);
    setEditCode(tool.code);
  };

  const handleCancelEdit = () => {
    setEditingToolId(null);
    setEditName('');
    setEditDescription('');
    setEditCode('');
  };

  const extractDependencyCandidates = (code: string): string[] => {
    const aliasMap: Record<string, string> = {
      bs4: 'beautifulsoup4',
      cv2: 'opencv-python',
      PIL: 'pillow',
      yaml: 'pyyaml',
      sklearn: 'scikit-learn',
      Crypto: 'pycryptodome',
    };
    const ignored = new Set([
      'agent_framework',
      'typing',
      'typing_extensions',
      'collections',
      'datetime',
      'json',
      'os',
      'pathlib',
      're',
      'math',
      'statistics',
      'functools',
      'itertools',
      'operator',
      'asyncio',
      'subprocess',
      'threading',
      'logging',
      'http',
      'urllib',
      'dataclasses',
    ]);

    const deps = new Set<string>();
    const importRegex = /^\s*import\s+([^\n#]+)/gm;
    const fromRegex = /^\s*from\s+([a-zA-Z0-9_.]+)\s+import\s+/gm;

    for (const match of code.matchAll(importRegex)) {
      const groups = (match[1] || '').split(',');
      for (const group of groups) {
        const token = group.trim().split(/\s+as\s+/i)[0]?.trim();
        const topLevel = token?.split('.')[0];
        if (!topLevel || ignored.has(topLevel)) continue;
        deps.add(aliasMap[topLevel] || topLevel);
      }
    }

    for (const match of code.matchAll(fromRegex)) {
      const topLevel = (match[1] || '').split('.')[0]?.trim();
      if (!topLevel || ignored.has(topLevel)) continue;
      deps.add(aliasMap[topLevel] || topLevel);
    }

    return Array.from(deps).sort();
  };

  const codeDependencies = extractDependencyCandidates(codeToSave);
  const editDependencies = extractDependencyCandidates(editCode);

  const handleInstallDependencies = async (code: string) => {
    if (!code.trim()) return;
    setIsInstallingDependencies(true);
    setDependencyMessage('');
    try {
      const result = await apiClient.installToolDependencies(code);
      const parts: string[] = [];
      if (result.installed.length) parts.push(`Installed: ${result.installed.join(', ')}`);
      if (result.skipped.length) parts.push(`Already installed: ${result.skipped.join(', ')}`);
      if (!parts.length) parts.push(result.message || 'No third-party dependencies detected.');
      setDependencyMessage(parts.join(' | '));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown installation error';
      setDependencyMessage(`Install failed: ${message}`);
    } finally {
      setIsInstallingDependencies(false);
    }
  };

  const handleSaveEdit = () => {
    if (!editName.trim() || !editCode.trim() || !editingToolId) return;

    updateTool(editingToolId, {
      name: editName.trim(),
      description: editDescription.trim(),
      code: editCode,
    });

    setEditingToolId(null);
    setEditName('');
    setEditDescription('');
    setEditCode('');
    setDependencyMessage('');
    setViewingTool(null);
  };

  return (
    <div className="flex h-full w-full bg-background">
      {/* Left Sidebar - Saved Tools */}
      <div className="w-80 shrink-0 border-r bg-card/30 flex flex-col">
        <div className="p-4 border-b">
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-lg font-semibold">Saved Tools</h2>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  setAiPrompt('');
                  setAiToolType('auto');
                  setAiModel('__auto__');
                  setIsAICreateDialogOpen(true);
                }}
              >
                <Wand2 className="h-4 w-4 mr-1" />
                Create with AI
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setCodeToSave('');
                  setToolName('');
                  setToolDescription('');
                  setIsSaveDialogOpen(true);
                }}
              >
                <Plus className="h-4 w-4 mr-1" />
                New
              </Button>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">Code tools created from conversations</p>
        </div>

        <div className="flex-1 overflow-auto p-4 space-y-4">
          {/* Default Tools Section */}
          <div>
            <button
              onClick={() => setShowDefaultTools(!showDefaultTools)}
              className="flex items-center gap-2 w-full text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2 px-1 hover:text-foreground transition-colors"
            >
              {showDefaultTools ? (
                <ChevronDown className="h-3 w-3" />
              ) : (
                <ChevronRight className="h-3 w-3" />
              )}
              Default Tools
            </button>
            {showDefaultTools && (
              <div className="space-y-2">
                {tools.filter(t => t.isDefault).map((tool: Tool) => (
                  <Card key={tool.id} className="p-3 hover:shadow-md transition-shadow border-primary/30">
                    <div className="flex items-start justify-between mb-2">
                      <div className="flex items-center gap-2 flex-1">
                        <Badge variant="default" className="text-xs shrink-0">Default</Badge>
                        <h3 className="font-semibold text-sm truncate">{tool.name}</h3>
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 w-7 p-0 shrink-0"
                        onClick={() => setViewingTool(tool)}
                      >
                        <Eye className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                    <p className="text-xs text-muted-foreground line-clamp-2">{tool.description}</p>
                  </Card>
                ))}
              </div>
            )}
          </div>

          {/* User Tools Section */}
          <div>
            <button
              onClick={() => setShowUserTools(!showUserTools)}
              className="flex items-center gap-2 w-full text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2 px-1 hover:text-foreground transition-colors"
            >
              {showUserTools ? (
                <ChevronDown className="h-3 w-3" />
              ) : (
                <ChevronRight className="h-3 w-3" />
              )}
              Your Tools
            </button>
            {showUserTools && (
              <>
                {tools.filter(t => !t.isDefault).length === 0 ? (
                  <div className="text-center py-8 text-muted-foreground">
                    <Code className="h-12 w-12 mx-auto mb-3 opacity-50" />
                    <p className="text-sm">No custom tools yet</p>
                    <p className="text-xs mt-1">Chat with a model to generate code</p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {tools.filter(t => !t.isDefault).map((tool: Tool) => (
                      <Card key={tool.id} className="p-3 hover:shadow-md transition-shadow group">
                        <div className="flex items-start justify-between mb-2">
                          <h3 className="font-semibold text-sm truncate flex-1">{tool.name}</h3>
                          <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-6 w-6"
                              onClick={() => {
                                setViewingTool(tool);
                                handleEditTool(tool);
                              }}
                              title="Edit tool"
                            >
                              <Edit2 className="h-3 w-3 text-blue-500" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-6 w-6"
                              onClick={() => handleDeleteTool(tool.id)}
                              title="Delete tool"
                            >
                              <Trash2 className="h-3 w-3 text-destructive" />
                            </Button>
                          </div>
                        </div>
                        {tool.description && (
                          <p className="text-xs text-muted-foreground mb-2 line-clamp-2">{tool.description}</p>
                        )}
                        <div className="bg-muted/50 rounded p-2 mt-2">
                          <code className="text-xs font-mono line-clamp-3">{tool.code}</code>
                        </div>
                        <p className="text-xs text-muted-foreground mt-2">
                          {new Date(tool.created_at).toLocaleDateString()}
                        </p>
                      </Card>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>

      {/* Main Chat Area */}
      <div className="flex-1 flex flex-col bg-gradient-to-br from-background via-background to-accent/5 min-w-0">
        {/* Header */}
        <div className="border-b bg-card/50 backdrop-blur-sm p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-2">
                <Code className="h-5 w-5 text-primary" />
                <h2 className="text-lg font-semibold">Tool Builder</h2>
              </div>
              
              <Select value={selectedModel} onValueChange={setSelectedModel}>
                <SelectTrigger className="w-64">
                  <SelectValue placeholder="Select a model" />
                </SelectTrigger>
                <SelectContent>
                  {availableModels.map(model => (
                    <SelectItem key={model.name} value={model.name}>
                      {model.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <Button variant="outline" size="sm" onClick={handleNewChat}>
              <Plus className="h-4 w-4 mr-2" />
              New Chat
            </Button>
          </div>
        </div>

        {/* Messages */}
        <div 
          ref={scrollViewportRef}
          className="flex-1 min-h-0 overflow-auto px-6 py-4"
        >
          <div className="max-w-4xl mx-auto space-y-4">
            {messages.length === 0 && !streamingContent && (
              <div className="flex items-center justify-center h-full text-muted-foreground">
                <div className="text-center max-w-md">
                  <Code className="h-16 w-16 mx-auto mb-4 opacity-50" />
                  <h3 className="text-lg font-semibold mb-2">Build Custom Tools</h3>
                  <p className="text-sm mb-4">
                    Chat with an AI model to generate code for custom tools. 
                    Save the generated code to use in your agents.
                  </p>
                  <p className="text-xs">
                    Try asking: "Write a Python function to fetch weather data" or 
                    "Create a tool to search Wikipedia"
                  </p>
                </div>
              </div>
            )}

            {messages.map((message, index) => (
              <div
                key={index}
                className={`mb-6 flex ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}
              >
                <Card
                  className={`max-w-[80%] p-4 ${
                    message.role === 'user'
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-card'
                  }`}
                >
                <div className="flex items-start justify-between gap-2 mb-2">
                  <Badge variant={message.role === 'user' ? 'secondary' : 'outline'} className="text-xs">
                    {message.role === 'user' ? 'You' : selectedModel}
                  </Badge>
                  {message.role === 'assistant' && message.content.includes('```') && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 px-2"
                      onClick={() => handleSaveCode(message.content)}
                    >
                      <Save className="h-3 w-3 mr-1" />
                      Save
                    </Button>
                  )}
                </div>
                <div className="whitespace-pre-wrap break-words leading-relaxed">
                  {message.content.split(/(```[\w]*\n[\s\S]*?```)/g).map((part, i) => {
                    if (part.startsWith('```')) {
                      const match = part.match(/```([\w]*)\n([\s\S]*?)```/);
                      const language = match?.[1] || '';
                      const code = match?.[2] || '';
                      return (
                        <div key={i} className="my-2">
                          {language && (
                            <div className="text-xs text-muted-foreground mb-1">{language}</div>
                          )}
                          <pre className="bg-muted/50 p-3 rounded overflow-x-auto">
                            <code className="text-xs font-mono">{code}</code>
                          </pre>
                        </div>
                      );
                    }
                    return <span key={i}>{part}</span>;
                  })}
                </div>
              </Card>
            </div>
          ))}

          {isStreaming && (
            <div className="mb-4 flex justify-start">
              <Card className="max-w-[80%] p-4 bg-card">
                <Badge variant="outline" className="text-xs mb-2">
                  {selectedModel}
                </Badge>
                <div className="whitespace-pre-wrap break-words">
                  {streamingContent || (
                    <div className="flex items-center gap-2 text-muted-foreground italic">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      AI is thinking...
                    </div>
                  )}
                  {streamingContent && (
                    <span className="inline-block w-2 h-4 bg-primary animate-pulse ml-1" />
                  )}
                </div>
              </Card>
            </div>
          )}
        </div>
        </div>

        {/* Input Area */}
        <div className="shrink-0 border-t bg-card/50 backdrop-blur-sm p-4">
          <div className="max-w-4xl mx-auto w-full">
            <div className="flex items-center gap-2 bg-background rounded-lg border p-2">
              <Button variant="ghost" size="icon" className="shrink-0 h-10 w-10">
                <Paperclip className="h-5 w-5" />
              </Button>
              
              <Textarea
                ref={textareaRef}
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Ask the model to generate a tool..."
                className="flex-1 min-h-[40px] max-h-32 resize-none border-0 focus-visible:ring-0 focus-visible:ring-offset-0 bg-transparent py-[10px]"
                disabled={!selectedModel}
                rows={1}
              />
              
              <Button
                onClick={handleSendMessage}
                disabled={!inputValue.trim() || !selectedModel}
                size="icon"
                className="shrink-0 h-10 w-10"
              >
                {isStreaming ? (
                  <Loader2 className="h-5 w-5 animate-spin" />
                ) : (
                  <Send className="h-5 w-5" />
                )}
              </Button>
            </div>
          </div>
        </div>
      </div>

      {/* Save Tool Dialog */}
      <Dialog open={isSaveDialogOpen} onOpenChange={setIsSaveDialogOpen}>
        <DialogContent className="max-w-2xl max-h-[90vh] flex flex-col">
          <DialogHeader>
            <DialogTitle>Save Tool</DialogTitle>
          </DialogHeader>
          
          <div className="space-y-4 overflow-y-auto flex-1 pr-2">
            <div>
              <label className="text-sm font-medium mb-2 block">Tool Name *</label>
              <Input
                placeholder="e.g., weather_fetcher"
                value={toolName}
                onChange={(e) => setToolName(e.target.value)}
                className="w-full"
              />
            </div>
            
            <div>
              <label className="text-sm font-medium mb-2 block">Description</label>
              <Textarea
                placeholder="What does this tool do?"
                value={toolDescription}
                onChange={(e) => setToolDescription(e.target.value)}
                rows={3}
                className="w-full"
              />
            </div>
            
            <div>
              <label className="text-sm font-medium mb-2 block">Code</label>
              <Textarea
                value={codeToSave}
                onChange={(e) => {
                  setCodeToSave(e.target.value);
                  setDependencyMessage('');
                }}
                className="w-full font-mono text-xs min-h-[200px]"
                placeholder="Enter or edit the tool code..."
              />
            </div>

            {codeDependencies.length > 0 && (
              <div className="p-3 rounded-md border bg-muted/40 space-y-2">
                <div className="text-sm font-medium">Detected imports</div>
                <p className="text-xs text-muted-foreground">{codeDependencies.join(', ')}</p>
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  onClick={() => handleInstallDependencies(codeToSave)}
                  disabled={isInstallingDependencies}
                >
                  {isInstallingDependencies ? (
                    <>
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      Installing...
                    </>
                  ) : (
                    <>
                      <Download className="h-4 w-4 mr-2" />
                      Install Dependencies
                    </>
                  )}
                </Button>
              </div>
            )}

            {dependencyMessage && (
              <p className="text-xs text-muted-foreground">{dependencyMessage}</p>
            )}
          </div>

          <DialogFooter className="mt-4">
            <Button variant="outline" onClick={() => setIsSaveDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleConfirmSave} disabled={!toolName.trim() || !codeToSave.trim()}>
              <Save className="h-4 w-4 mr-2" />
              Save Tool
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Create Tool with AI Dialog */}
      <Dialog open={isAICreateDialogOpen} onOpenChange={setIsAICreateDialogOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Create Tool with AI</DialogTitle>
          </DialogHeader>

          <div className="space-y-4">
            <div>
              <div className="flex items-center justify-between gap-2 mb-2">
                <label className="text-sm font-medium">Describe the tool</label>
                {speechSupported && (
                  <Button
                    type="button"
                    variant={isListening ? 'destructive' : 'outline'}
                    size="sm"
                    onClick={toggleSpeechInput}
                    disabled={isGeneratingTool}
                    className={isListening ? 'ring-2 ring-red-400 ring-offset-1' : ''}
                    title={isListening ? 'Stop dictation' : 'Start speech-to-text'}
                  >
                    {isListening ? <MicOff className="h-4 w-4 mr-2" /> : <Mic className="h-4 w-4 mr-2" />}
                    {isListening ? 'Stop Dictation' : 'Dictate'}
                  </Button>
                )}
              </div>
              <Textarea
                value={aiPrompt}
                onChange={(e) => {
                  const value = e.target.value;
                  setAiPrompt(value);
                  dictationBaseRef.current = value;
                }}
                placeholder="Example: Create a hosted MCP tool for a public docs server that always requires approval for write operations."
                rows={6}
              />
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label className="text-sm font-medium mb-2 block">Tool Type</label>
                <Select value={aiToolType} onValueChange={(value) => setAiToolType(value as ToolTypeOption)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="auto">Auto</SelectItem>
                    <SelectItem value="function">Function (@ai_function)</SelectItem>
                    <SelectItem value="hosted_code_interpreter">Hosted Code Interpreter</SelectItem>
                    <SelectItem value="hosted_file_search">Hosted File Search</SelectItem>
                    <SelectItem value="hosted_web_search">Hosted Web Search</SelectItem>
                    <SelectItem value="hosted_mcp">Hosted MCP</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div>
                <label className="text-sm font-medium mb-2 block">Model</label>
                <Select value={aiModel} onValueChange={setAiModel}>
                  <SelectTrigger>
                    <SelectValue placeholder="Auto" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__auto__">Auto</SelectItem>
                    {availableModels.map((model) => (
                      <SelectItem key={model.name} value={model.name}>{model.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <p className="text-xs text-muted-foreground">
              AI generation is constrained to Microsoft Agent Framework tool constructor requirements and opens a review dialog before saving.
            </p>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setIsAICreateDialogOpen(false)} disabled={isGeneratingTool}>
              Cancel
            </Button>
            <Button onClick={handleCreateToolWithAI} disabled={isGeneratingTool || !aiPrompt.trim()}>
              {isGeneratingTool ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Generating...
                </>
              ) : (
                <>
                  <Wand2 className="h-4 w-4 mr-2" />
                  Generate Tool
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* View Tool Details Dialog */}
      <Dialog open={!!viewingTool} onOpenChange={(open) => !open && (setViewingTool(null), handleCancelEdit())}>
        <DialogContent className="max-w-3xl max-h-[90vh]">
          <DialogHeader>
            <div className="flex items-center gap-2 justify-between">
              <div className="flex items-center gap-2">
                {viewingTool?.isDefault && (
                  <Badge variant="default" className="text-xs">Default</Badge>
                )}
                <DialogTitle>
                  {editingToolId === viewingTool?.id ? 'Edit Tool' : viewingTool?.name}
                </DialogTitle>
              </div>
              {!viewingTool?.isDefault && editingToolId !== viewingTool?.id && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => viewingTool && handleEditTool(viewingTool)}
                >
                  <Edit2 className="h-4 w-4 mr-2" />
                  Edit
                </Button>
              )}
            </div>
          </DialogHeader>
          
          <div className="space-y-4 overflow-auto max-h-[calc(90vh-120px)]">
            {editingToolId === viewingTool?.id ? (
              <>
                <div>
                  <label className="text-sm font-medium mb-2 block">Tool Name</label>
                  <Input
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    className="w-full"
                  />
                </div>
                
                <div>
                  <label className="text-sm font-medium mb-2 block">Description</label>
                  <Textarea
                    value={editDescription}
                    onChange={(e) => setEditDescription(e.target.value)}
                    rows={3}
                    className="w-full"
                  />
                </div>

                <div>
                  <label className="text-sm font-medium mb-2 block">Code</label>
                  <Textarea
                    value={editCode}
                    onChange={(e) => {
                      setEditCode(e.target.value);
                      setDependencyMessage('');
                    }}
                    className="w-full font-mono text-xs min-h-[300px]"
                  />
                </div>

                {editDependencies.length > 0 && (
                  <div className="p-3 rounded-md border bg-muted/40 space-y-2">
                    <div className="text-sm font-medium">Detected imports</div>
                    <p className="text-xs text-muted-foreground">{editDependencies.join(', ')}</p>
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      onClick={() => handleInstallDependencies(editCode)}
                      disabled={isInstallingDependencies}
                    >
                      {isInstallingDependencies ? (
                        <>
                          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                          Installing...
                        </>
                      ) : (
                        <>
                          <Download className="h-4 w-4 mr-2" />
                          Install Dependencies
                        </>
                      )}
                    </Button>
                  </div>
                )}

                {dependencyMessage && (
                  <p className="text-xs text-muted-foreground">{dependencyMessage}</p>
                )}
              </>
            ) : (
              <>
                <div>
                  <label className="text-sm font-medium mb-2 block">Description</label>
                  <p className="text-sm text-muted-foreground p-3 bg-muted/50 rounded-md">
                    {viewingTool?.description}
                  </p>
                </div>
                
                {viewingTool?.code && (
                  <div>
                    <label className="text-sm font-medium mb-2 block">Code</label>
                    <pre className="p-4 bg-muted/50 rounded-md overflow-auto text-xs font-mono max-h-[400px] border">
                      <code>{viewingTool.code}</code>
                    </pre>
                  </div>
                )}

                <div className="text-xs text-muted-foreground pt-2 border-t">
                  <div className="flex items-center justify-between">
                    <span>Tool ID: {viewingTool?.id}</span>
                    {viewingTool?.created_at && (
                      <span>Created: {new Date(viewingTool.created_at).toLocaleDateString()}</span>
                    )}
                  </div>
                </div>
              </>
            )}
          </div>

          <DialogFooter>
            {editingToolId === viewingTool?.id ? (
              <>
                <Button variant="outline" onClick={handleCancelEdit}>
                  Cancel
                </Button>
                <Button onClick={handleSaveEdit} disabled={!editName.trim() || !editCode.trim()}>
                  <Save className="h-4 w-4 mr-2" />
                  Save Changes
                </Button>
              </>
            ) : (
              <Button variant="outline" onClick={() => setViewingTool(null)}>
                Close
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};
