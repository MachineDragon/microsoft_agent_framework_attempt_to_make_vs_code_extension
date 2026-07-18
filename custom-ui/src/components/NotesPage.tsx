import { useState, useEffect, useRef, useMemo } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  FolderOpen, Folder, FileText, Plus, Trash2, Edit2, Search, Mic, MicOff,
  ChevronDown, ChevronRight, Sparkles, Send, Save, X, BookOpen, Loader2,
  FolderPlus, Check, ArrowLeft, AlignLeft, Bot,
  PanelLeftClose, PanelRightOpen, Globe2, Users,
} from 'lucide-react';
import { useNoteStore, type Note, type SavedAiNote } from '@/stores/noteStore';
import { useAppStore } from '@/stores/appStore';
import { apiClient } from '@/services/api';
import { getStoredString, setStoredString } from '@/services/extensionStorage';
import type { AgentInfo } from '@/types';

// ── Types ─────────────────────────────────────────────────────────────────────

type AiMessage = { role: 'user' | 'assistant'; content: string };

// ── AI quick-prompt presets ───────────────────────────────────────────────────

const AI_PROMPTS = [
  { label: 'Summarize', prompt: 'Summarize the raw notes into a clear, concise summary.' },
  { label: 'Bullet points', prompt: 'Convert the raw notes into organized bullet points.' },
  { label: 'Action items', prompt: 'Extract all action items and next steps from the raw notes.' },
  { label: 'Key takeaways', prompt: 'List the 3–5 most important takeaways from these notes.' },
  { label: 'Meeting minutes', prompt: 'Format the raw notes as professional meeting minutes.' },
  { label: 'Simplify', prompt: 'Rewrite the raw notes in plain, simple language.' },
];

// ── Speech recognition helper types ──────────────────────────────────────────

type SR = { continuous: boolean; interimResults: boolean; lang: string; onresult: any; onerror: any; onend: any; onstart?: any; start(): void; stop(): void };

// ── Utilities ─────────────────────────────────────────────────────────────────

function formatDate(ts: number) {
  const d = new Date(ts);
  const now = Date.now();
  const diff = now - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function isVsCodeEmbeddedBrowser() {
  const ua = navigator.userAgent.toLowerCase();
  return ua.includes(' electron/') && ua.includes(' code/');
}

function getSupportedAudioMimeType() {
  if (!('MediaRecorder' in window)) return '';
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/ogg',
  ];
  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) || '';
}

function getSavedAiNotes(note: Note | null): SavedAiNote[] {
  if (!note) return [];
  const saved = Array.isArray(note.aiNotes) ? note.aiNotes : [];
  if (saved.length > 0) return saved;
  if (!note.aiContent?.trim()) return [];
  return [{
    id: `${note.id}_legacy_ai_note`,
    title: 'Saved AI Note',
    content: note.aiContent,
    messages: [{ role: 'assistant', content: note.aiContent }],
    createdAt: note.updatedAt,
  }];
}

// ── Main component ────────────────────────────────────────────────────────────

export function NotesPage() {
  const store = useNoteStore();
  const agents = useAppStore((state) => state.agents);
  const loadEntities = useAppStore((state) => state.loadEntities);

  // Navigation
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [currentFolderId, setCurrentFolderId] = useState<string | null>(null);
  const [openFolderIds, setOpenFolderIds] = useState<Set<string>>(new Set());
  const [selectedNote, setSelectedNote] = useState<Note | null>(null);

  // Search
  const [searchQuery, setSearchQuery] = useState('');
  const [searchInName, setSearchInName] = useState(true);
  const [searchInDesc, setSearchInDesc] = useState(true);
  const [searchInBody, setSearchInBody] = useState(true);
  const [searchScope, setSearchScope] = useState<'folder' | 'all'>('all');

  // Inline creation / rename
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [creatingNote, setCreatingNote] = useState(false);
  const [newNoteName, setNewNoteName] = useState('');
  const [newNoteDesc, setNewNoteDesc] = useState('');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');

  // Note editor
  const [rawContent, setRawContent] = useState('');
  const [aiMessages, setAiMessages] = useState<AiMessage[]>([]);
  const [aiInput, setAiInput] = useState('');
  const [aiLoading, setAiLoading] = useState(false);
  const [aiStreaming, setAiStreaming] = useState('');
  const [aiThinking, setAiThinking] = useState('');
  const [aiThinkingExpanded, setAiThinkingExpanded] = useState(true);
  const [saved, setSaved] = useState(false);
  const [selectedAiNoteId, setSelectedAiNoteId] = useState('');
  const [isSavingAiNote, setIsSavingAiNote] = useState(false);
  const [aiNoteTitle, setAiNoteTitle] = useState('');
  const [aiTargetMode, setAiTargetMode] = useState<'model' | 'agent'>('model');
  const [selectedAgentId, setSelectedAgentId] = useState('');
  const [webSearchEnabled, setWebSearchEnabled] = useState(false);
  const [webSearchProvider, setWebSearchProvider] = useState<'ollama' | 'duckduckgo'>('duckduckgo');
  const [webSearchMode, setWebSearchMode] = useState<'search' | 'search_fetch' | 'deep'>('search_fetch');
  const [aiPromptHistoryIndex, setAiPromptHistoryIndex] = useState(-1);
  const aiPromptDraftRef = useRef('');

  // Speech
  const [isListening, setIsListening] = useState(false);
  const [speechStatus, setSpeechStatus] = useState('');
  const srRef = useRef<SR | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);

  // Models
  const [models, setModels] = useState<Array<{ name: string }>>([]);
  const [selectedModel, setSelectedModel] = useState('');

  const aiScrollRef = useRef<HTMLDivElement | null>(null);

  // ── Effects ──────────────────────────────────────────────────────────────────

  useEffect(() => {
    let cancelled = false;
    getStoredString('notes.model').then((storedModel) => {
      if (!cancelled && storedModel) setSelectedModel(storedModel);
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    apiClient.getOllamaModels().then((ms) => {
      setModels(ms);
      setSelectedModel((prev) => {
        if (prev && ms.some((m) => m.name === prev)) return prev;
        return ms[0]?.name || '';
      });
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (agents.length === 0) void loadEntities();
  }, [agents.length, loadEntities]);

  useEffect(() => {
    if (selectedAgentId && agents.some((agent) => agent.id === selectedAgentId)) return;
    setSelectedAgentId(agents[0]?.id || '');
  }, [agents, selectedAgentId]);

  useEffect(() => {
    if (selectedModel) void setStoredString('notes.model', selectedModel);
  }, [selectedModel]);

  useEffect(() => {
    if (!selectedNote) return;
    setRawContent(selectedNote.rawContent);
    const savedAiNotes = getSavedAiNotes(selectedNote);
    setSelectedAiNoteId(savedAiNotes.at(-1)?.id || '');
    setIsSavingAiNote(false);
    setAiNoteTitle('');
    setAiMessages([]);
    setAiInput('');
    setAiThinking('');
    setAiThinkingExpanded(true);
    setAiPromptHistoryIndex(-1);
    aiPromptDraftRef.current = '';
    setSaved(false);
  }, [selectedNote]);

  useEffect(() => {
    const el = aiScrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [aiMessages, aiStreaming]);

  // Auto-save raw content
  useEffect(() => {
    if (!selectedNote) return;
    const t = window.setTimeout(() => {
      store.updateNote(selectedNote.id, { rawContent });
    }, 800);
    return () => window.clearTimeout(t);
  }, [rawContent, selectedNote, store]);

  // ── Search ───────────────────────────────────────────────────────────────────

  const searchResults = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return null;
    const scope = searchScope === 'all'
      ? store.notes
      : store.notes.filter((n) => {
          if (currentFolderId === null) return n.folderId === null;
          const allIds = [currentFolderId, ...store.getAllDescendantFolderIds(currentFolderId)];
          return n.folderId !== null && allIds.includes(n.folderId);
        });
    return scope.filter((n) => {
      if (searchInName && n.name.toLowerCase().includes(q)) return true;
      if (searchInDesc && n.description.toLowerCase().includes(q)) return true;
      if (searchInBody && n.rawContent.toLowerCase().includes(q)) return true;
      return false;
    });
  }, [searchQuery, searchInName, searchInDesc, searchInBody, searchScope, store, currentFolderId]);

  // ── Folder helpers ────────────────────────────────────────────────────────────

  function toggleFolder(id: string) {
    setOpenFolderIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function handleCreateFolder() {
    const name = newFolderName.trim();
    if (!name) return;
    store.createFolder(name, currentFolderId);
    setOpenFolderIds((prev) => new Set([...prev, ...(currentFolderId ? [currentFolderId] : [])]));
    setNewFolderName('');
    setCreatingFolder(false);
  }

  function handleCreateNote() {
    const name = newNoteName.trim();
    if (!name) return;
    const n = store.createNote(name, newNoteDesc.trim(), currentFolderId);
    setNewNoteName('');
    setNewNoteDesc('');
    setCreatingNote(false);
    setSelectedNote(n);
  }

  function handleRename(id: string, isFolder: boolean) {
    const name = renameValue.trim();
    if (!name) { setRenamingId(null); return; }
    if (isFolder) store.renameFolder(id, name);
    else store.updateNote(id, { name });
    setRenamingId(null);
  }

  function startRename(id: string, current: string) {
    setRenamingId(id);
    setRenameValue(current);
  }

  // ── Speech ────────────────────────────────────────────────────────────────────

  const rawContentRef = useRef(rawContent);
  useEffect(() => { rawContentRef.current = rawContent; }, [rawContent]);
  const [interimText, setInterimText] = useState('');
  const speechBaseRef = useRef('');
  const committedSpeechRef = useRef('');
  const lastChunkRef = useRef('');
  const speechNoEventTimerRef = useRef<number | null>(null);
  const speechRestartTimerRef = useRef<number | null>(null);
  const speechSessionActiveRef = useRef(false);
  const speechCtorRef = useRef<any>(null);
  const speechReceivedResultRef = useRef(false);
  const speechImmediateEndCountRef = useRef(0);

  function clearSpeechTimers() {
    if (speechNoEventTimerRef.current) window.clearTimeout(speechNoEventTimerRef.current);
    if (speechRestartTimerRef.current) window.clearTimeout(speechRestartTimerRef.current);
    speechNoEventTimerRef.current = null;
    speechRestartTimerRef.current = null;
  }

  function appendTranscript(text: string) {
    const normalized = text.trim();
    if (!normalized) return;
    setRawContent((prev) => {
      const base = prev.trimEnd();
      return base ? `${base}\n${normalized}` : normalized;
    });
  }

  function stopBackendRecording() {
    const recorder = mediaRecorderRef.current;
    if (!recorder) return;
    setSpeechStatus('Stopping recording...');
    if (recorder.state !== 'inactive') recorder.stop();
  }

  async function startBackendRecording() {
    if (!navigator.mediaDevices?.getUserMedia || !('MediaRecorder' in window)) {
      setSpeechStatus('Audio recording is not supported in this browser. Use Chrome or Edge.');
      return;
    }

    try {
      setSpeechStatus('Requesting microphone permission...');
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = getSupportedAudioMimeType();
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      mediaStreamRef.current = stream;
      mediaRecorderRef.current = recorder;
      recordedChunksRef.current = [];

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) recordedChunksRef.current.push(event.data);
      };

      recorder.onerror = () => {
        mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
        mediaRecorderRef.current = null;
        mediaStreamRef.current = null;
        setIsListening(false);
        setSpeechStatus('Recording failed. Check microphone permission and try again.');
      };

      recorder.onstop = async () => {
        const chunks = [...recordedChunksRef.current];
        const type = recorder.mimeType || mimeType || 'audio/webm';
        mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
        mediaRecorderRef.current = null;
        mediaStreamRef.current = null;
        recordedChunksRef.current = [];
        setIsListening(false);

        if (chunks.length === 0) {
          setSpeechStatus('No audio was recorded. Try again and speak after the mic turns red.');
          return;
        }

        try {
          setSpeechStatus('Transcribing recording...');
          const result = await apiClient.transcribeSpeech(new Blob(chunks, { type }));
          if (result.text.trim()) {
            appendTranscript(result.text);
            setSpeechStatus(`Transcribed with ${result.engine} (${result.duration_seconds}s)`);
          } else {
            setSpeechStatus('Recording transcribed, but no speech was detected.');
          }
        } catch (err) {
          setSpeechStatus(`Transcription failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      };

      recorder.start(1000);
      setIsListening(true);
      setSpeechStatus('Recording for backend transcription... click the mic again to stop.');
    } catch (err) {
      setIsListening(false);
      setSpeechStatus(`Microphone recording failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  function toggleMic() {
    if (mediaRecorderRef.current) {
      stopBackendRecording();
      return;
    }

    if (isListening || speechSessionActiveRef.current) {
      // Stop: null the ref first so onend doesn't auto-restart
      speechSessionActiveRef.current = false;
      const r = srRef.current;
      srRef.current = null;
      r?.stop();
      clearSpeechTimers();
      setIsListening(false);
      setInterimText('');
      setSpeechStatus('Voice input stopped');
      return;
    }

    const SpeechRecognitionCtor =
      (window as any).SpeechRecognition ||
      (window as any).webkitSpeechRecognition;

    if (!SpeechRecognitionCtor) {
      void startBackendRecording();
      return;
    }

    if (isVsCodeEmbeddedBrowser()) {
      void startBackendRecording();
      return;
    }

    // Request mic permission explicitly first — gives a clear browser prompt
    speechSessionActiveRef.current = true;
    speechCtorRef.current = SpeechRecognitionCtor;
    speechImmediateEndCountRef.current = 0;
    setSpeechStatus('Requesting microphone permission...');
    navigator.mediaDevices?.getUserMedia?.({ audio: true })
      .then(() => startRecognition(SpeechRecognitionCtor))
      .catch((err) => {
        if (!speechSessionActiveRef.current) return;
        setSpeechStatus(`Microphone permission issue: ${err?.name || 'unknown'}. Trying speech recognition anyway...`);
        startRecognition(SpeechRecognitionCtor);
      });
  }

  function startRecognition(SpeechRecognitionCtor: any) {
    if (!speechSessionActiveRef.current) return;
    const rec = new SpeechRecognitionCtor();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = navigator.language || 'en-US';
    lastChunkRef.current = '';
    speechReceivedResultRef.current = false;
    committedSpeechRef.current = '';
    speechBaseRef.current = rawContentRef.current.trimEnd();

    const writeSpeech = (spokenText: string) => {
      const normalized = spokenText.trim();
      if (!normalized) return;
      const base = speechBaseRef.current;
      setRawContent(base ? `${base}\n${normalized}` : normalized);
    };

    const armNoEventTimer = () => {
      if (speechNoEventTimerRef.current) window.clearTimeout(speechNoEventTimerRef.current);
      speechNoEventTimerRef.current = window.setTimeout(() => {
        if (srRef.current === rec) {
          setSpeechStatus('Listening, but no speech events received yet. Check mic input/permission.');
        }
      }, 6000);
    };

    rec.onstart = () => {
      setIsListening(true);
      setSpeechStatus('Listening... speak now');
      armNoEventTimer();
    };

    rec.onresult = (event: any) => {
      if (!speechSessionActiveRef.current) return;
      speechReceivedResultRef.current = true;
      speechImmediateEndCountRef.current = 0;
      if (speechNoEventTimerRef.current) window.clearTimeout(speechNoEventTimerRef.current);
      let interim = '';
      let final = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const text: string = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          final += text;
        } else {
          interim += text;
        }
      }

      const finalChunk = final.trim();
      if (finalChunk && finalChunk !== lastChunkRef.current) {
        lastChunkRef.current = finalChunk;
        committedSpeechRef.current = committedSpeechRef.current
          ? `${committedSpeechRef.current} ${finalChunk}`.trim()
          : finalChunk;
      }

      const visibleTranscript = `${committedSpeechRef.current} ${interim}`.trim();
      if (interim) {
        setInterimText(interim.trim());
        setSpeechStatus(`Hearing: ${interim.trim()}`);
      } else if (finalChunk) {
        setInterimText('');
        setSpeechStatus(`Captured: ${finalChunk}`);
      }

      writeSpeech(visibleTranscript);
      armNoEventTimer();
    };

    rec.onerror = (e: any) => {
      if (speechNoEventTimerRef.current) window.clearTimeout(speechNoEventTimerRef.current);
      const error = e?.error ?? '';
      if (error === 'no-speech') {
        setSpeechStatus('No speech detected yet. Keep talking or try again closer to the mic.');
        return;
      }
      speechSessionActiveRef.current = false;
      srRef.current = null;
      setIsListening(false);
      setInterimText('');
      setSpeechStatus(`Speech recognition error: ${error || 'unknown'}`);
    };

    rec.onend = () => {
      if (speechNoEventTimerRef.current) window.clearTimeout(speechNoEventTimerRef.current);
      if (srRef.current !== rec) return;

      srRef.current = null;
      setIsListening(false);

      if (!speechSessionActiveRef.current) {
        setInterimText('');
        setSpeechStatus('Voice input stopped');
        return;
      }

      if (!speechReceivedResultRef.current) {
        speechImmediateEndCountRef.current += 1;
      }

      if (speechImmediateEndCountRef.current >= 3) {
        speechSessionActiveRef.current = false;
        setInterimText('');
        setSpeechStatus('Speech recognition is closing immediately. Check Windows/browser mic permission, then try Chrome or Edge if this VS Code browser keeps closing it.');
        return;
      }

      setSpeechStatus('Speech recognition paused; restarting...');
      speechRestartTimerRef.current = window.setTimeout(() => {
        if (!speechSessionActiveRef.current || !speechCtorRef.current) return;
        startRecognition(speechCtorRef.current);
      }, 350);
    };

    srRef.current = rec;
    try {
      rec.start();
    } catch (err) {
      srRef.current = null;
      speechSessionActiveRef.current = false;
      setIsListening(false);
      setSpeechStatus(`Failed to start microphone: ${err}`);
    }
  }

  // ── AI ────────────────────────────────────────────────────────────────────────

  function getSelectedAssistantAgent(): AgentInfo | null {
    return agents.find((agent) => agent.id === selectedAgentId) || null;
  }

  function buildNoteContextQuestion(userMessage: string) {
    return [
      `You are answering with the current note as context.`,
      `Note title: ${liveNote?.name || 'Untitled note'}`,
      liveNote?.description ? `Note description: ${liveNote.description}` : '',
      `Raw notes:\n${rawContent}`,
      `User request:\n${userMessage}`,
    ].filter(Boolean).join('\n\n');
  }

  async function buildAgentWebContext(userMessage: string) {
    if (!webSearchEnabled) return '';
    setAiStreaming('Searching the internet...');
    const maxResults = webSearchMode === 'deep' ? 8 : 5;
    const search = await apiClient.searchIDEWeb(userMessage, maxResults, [], [], webSearchProvider);
    const results = search.results || [];
    if (results.length === 0) return 'Internet search returned no results.';

    if (webSearchMode === 'search') {
      return [
        'Internet search results:',
        ...results.map((result, index) => `${index + 1}. ${result.title || 'Untitled'}\n${result.url || ''}\n${result.content || result.snippet || ''}`),
      ].join('\n\n');
    }

    const fetchCount = webSearchMode === 'deep' ? 4 : 2;
    const fetched: string[] = [];
    for (const result of results.slice(0, fetchCount)) {
      if (!result.url) continue;
      try {
        const page = await apiClient.fetchIDEWeb(result.url, userMessage);
        fetched.push(`Source: ${page.title || result.title || result.url}\nURL: ${page.final_url || result.url}\n${page.markdown.slice(0, 4000)}`);
      } catch {
        fetched.push(`Source: ${result.title || result.url}\nURL: ${result.url}\n${result.content || result.snippet || ''}`);
      }
    }

    return ['Internet context:', ...fetched].join('\n\n---\n\n');
  }

  async function runAgentAi(contextQuestion: string) {
    const agent = getSelectedAssistantAgent();
    if (!agent) throw new Error('Select an agent first.');

    const useCustomBackend = Boolean(agent.isUserCreated || agent.isDefault);
    const metadata: Record<string, any> = { entity_id: agent.id };

    if (useCustomBackend) {
      metadata.agent_configs = {
        [agent.id]: {
          name: agent.name,
          instructions: agent.instructions,
          model_id: agent.model_id,
          temperature: (agent as any).temperature || 0.7,
          max_tokens: (agent as any).max_tokens || 1000,
          tools: (agent as any).tools || [],
          chat_client_type: agent.chat_client_type || 'ollama',
        },
      };
    }

    const conversation = await apiClient.createConversation(metadata);
    const request = {
      input: contextQuestion,
      messages: [{ role: 'user' as const, content: contextQuestion }],
      conversation: conversation.id,
      metadata,
      stream: true,
    };

    let response = '';
    let thinking = '';
    for await (const event of apiClient.streamResponses(request, undefined, useCustomBackend)) {
      if (event.type === 'response.thinking.delta') {
        thinking += (event as any).delta || '';
        setAiThinking(thinking);
      } else if (event.type === 'response.output_text.delta') {
        response += (event as any).delta || '';
        setAiStreaming(response);
      } else if (event.type === 'response.function_call.complete') {
        const toolName = (event as any).data?.name || (event as any).function_call?.name || 'tool';
        const result = (event as any).data?.result || (event as any).function_call?.result;
        if (result) {
          response += `\n\n[${toolName}]\n${typeof result === 'string' ? result : JSON.stringify(result, null, 2)}`;
          setAiStreaming(response);
        }
      }
    }

    setAiMessages((prev) => [...prev, { role: 'assistant', content: response || `Agent ${agent.name || agent.id} completed without text output.` }]);
    setAiStreaming('');
  }

  async function runAi(userMessage: string) {
    if (!rawContent.trim()) return;
    if (aiTargetMode === 'model' && !selectedModel) return;
    if (aiTargetMode === 'agent' && !getSelectedAssistantAgent()) return;
    setAiLoading(true);
    setAiStreaming('');
    setAiThinking('');
    setAiThinkingExpanded(true);
    let contextQuestion = buildNoteContextQuestion(userMessage);
    const history: AiMessage[] = [...aiMessages, { role: 'user', content: userMessage }];
    setAiMessages(history);
    try {
      if (aiTargetMode === 'agent') {
        const webContext = await buildAgentWebContext(userMessage);
        if (webContext) {
          contextQuestion = `${contextQuestion}\n\n${webContext}`;
        }
        await runAgentAi(contextQuestion);
      } else {
        const systemPrompt = `You are a note assistant. The user's raw notes are below.\n\nRAW NOTES:\n${rawContent}\n\nAnswer questions or process the notes as instructed. Be concise and clear.`;
        const messages = [
          { role: 'system' as const, content: systemPrompt },
          ...history.map((m) => ({ role: m.role, content: m.content })),
        ];
        let response = '';
        for await (const chunk of apiClient.streamDirectModelChat(
          selectedModel,
          messages,
          undefined,
          [],
          webSearchEnabled,
          webSearchProvider,
          webSearchMode
        )) {
          if (chunk.type === 'thinking') {
            setAiThinking((prev) => prev + chunk.delta);
          } else if (chunk.type === 'content') {
            response += chunk.delta;
            setAiStreaming(response);
          }
        }
        setAiMessages((prev) => [...prev, { role: 'assistant', content: response }]);
        setAiStreaming('');
      }
    } catch (err) {
      setAiMessages((prev) => [...prev, { role: 'assistant', content: `Error: ${err instanceof Error ? err.message : String(err)}` }]);
      setAiStreaming('');
    } finally {
      setAiLoading(false);
    }
  }

  async function runQuickPrompt(prompt: string) {
    setAiInput(prompt);
    await runAi(prompt);
  }

  async function sendAiInput() {
    const q = aiInput.trim();
    if (!q) return;
    setAiInput('');
    setAiPromptHistoryIndex(-1);
    aiPromptDraftRef.current = '';
    await runAi(q);
  }

  function handleAiInputKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void sendAiInput();
      return;
    }

    const userPrompts = aiMessages
      .filter((message) => message.role === 'user' && message.content.trim())
      .map((message) => message.content)
      .reverse();

    if (e.key === 'ArrowUp') {
      if (userPrompts.length === 0) return;
      e.preventDefault();
      if (aiPromptHistoryIndex === -1) aiPromptDraftRef.current = aiInput;
      const nextIndex = Math.min(aiPromptHistoryIndex + 1, userPrompts.length - 1);
      setAiPromptHistoryIndex(nextIndex);
      setAiInput(userPrompts[nextIndex]);
      return;
    }

    if (e.key === 'ArrowDown' && aiPromptHistoryIndex !== -1) {
      e.preventDefault();
      const nextIndex = aiPromptHistoryIndex - 1;
      if (nextIndex < 0) {
        setAiPromptHistoryIndex(-1);
        setAiInput(aiPromptDraftRef.current);
      } else {
        setAiPromptHistoryIndex(nextIndex);
        setAiInput(userPrompts[nextIndex]);
      }
    }
  }

  function getCurrentAiResponse() {
    const lastAi = [...aiMessages].reverse().find((m) => m.role === 'assistant')?.content || '';
    return lastAi || aiStreaming;
  }

  function getSavableAiConversation(content: string): AiMessage[] {
    const conversation = [...aiMessages];
    const lastMessage = conversation.at(-1);
    if (aiStreaming) {
      conversation.push({ role: 'assistant', content: aiStreaming });
    } else if (content && lastMessage?.role !== 'assistant') {
      conversation.push({ role: 'assistant', content });
    }
    return conversation.filter((message) => message.content.trim());
  }

  function beginSaveAiToNote() {
    const content = getCurrentAiResponse();
    if (!content) return;
    setAiNoteTitle(`AI note ${getSavedAiNotes(liveNote).length + 1}`);
    setIsSavingAiNote(true);
  }

  function saveAiToNote() {
    if (!selectedNote) return;
    const content = getCurrentAiResponse();
    const title = aiNoteTitle.trim();
    if (!content || !title) return;
    const nextAiNote: SavedAiNote = {
      id: `ai_note_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      title,
      content,
      messages: getSavableAiConversation(content),
      createdAt: Date.now(),
    };
    const nextAiNotes = [...getSavedAiNotes(liveNote), nextAiNote];
    setSelectedAiNoteId(nextAiNote.id);
    setIsSavingAiNote(false);
    setAiNoteTitle('');
    store.updateNote(selectedNote.id, { aiContent: content, aiNotes: nextAiNotes });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  // ── Render helpers ────────────────────────────────────────────────────────────

  function renderFolderTree(parentId: string | null, depth = 0): React.ReactNode {
    const subfolders = store.getSubfolders(parentId);
    const notes = store.getNotesInFolder(parentId);
    if (!subfolders.length && !notes.length && parentId !== null) return null;

    return (
      <div style={{ paddingLeft: depth * 12 }}>
        {subfolders.map((f) => {
          const isOpen = openFolderIds.has(f.id);
          const isCurrent = currentFolderId === f.id;
          return (
            <div key={f.id}>
              <div
                className={`group flex items-center gap-1 px-1.5 py-1 rounded-md cursor-pointer select-none transition-colors ${isCurrent ? 'bg-primary/10 text-primary' : 'hover:bg-accent/50'}`}
                onClick={() => { toggleFolder(f.id); setCurrentFolderId(f.id); }}
              >
                <button className="shrink-0" onClick={(e) => { e.stopPropagation(); toggleFolder(f.id); }}>
                  {isOpen ? <ChevronDown className="h-3 w-3 text-muted-foreground" /> : <ChevronRight className="h-3 w-3 text-muted-foreground" />}
                </button>
                {isOpen ? <FolderOpen className="h-4 w-4 text-amber-400 shrink-0" /> : <Folder className="h-4 w-4 text-amber-400 shrink-0" />}
                {renamingId === f.id ? (
                  <input
                    autoFocus
                    className="flex-1 bg-transparent outline-none text-xs border-b border-primary"
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onBlur={() => handleRename(f.id, true)}
                    onKeyDown={(e) => { if (e.key === 'Enter') handleRename(f.id, true); if (e.key === 'Escape') setRenamingId(null); }}
                    onClick={(e) => e.stopPropagation()}
                  />
                ) : (
                  <span className="flex-1 text-xs truncate">{f.name}</span>
                )}
                <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 shrink-0">
                  <button className="p-0.5 rounded hover:bg-muted/60" onClick={(e) => { e.stopPropagation(); startRename(f.id, f.name); }} title="Rename"><Edit2 className="h-2.5 w-2.5" /></button>
                  <button className="p-0.5 rounded hover:bg-destructive/20 text-destructive" onClick={(e) => { e.stopPropagation(); if (confirm(`Delete "${f.name}" and all its contents?`)) store.deleteFolder(f.id); }} title="Delete"><Trash2 className="h-2.5 w-2.5" /></button>
                </div>
              </div>
              {isOpen && renderFolderTree(f.id, depth + 1)}
            </div>
          );
        })}
        {notes.map((n) => {
          const isSelected = selectedNote?.id === n.id;
          const noteAiNotes = getSavedAiNotes(n);
          return (
            <div key={n.id}>
              <div
                className={`group flex items-center gap-1.5 px-2 py-1 rounded-md cursor-pointer transition-colors ${isSelected && !selectedAiNoteId ? 'bg-primary/15 text-primary' : 'hover:bg-accent/40'}`}
                style={{ paddingLeft: depth * 12 + 8 + 16 }}
                onClick={() => { setSelectedNote(store.notes.find((x) => x.id === n.id) || n); setSelectedAiNoteId(''); }}
              >
                <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                {renamingId === n.id ? (
                  <input
                    autoFocus
                    className="flex-1 bg-transparent outline-none text-xs border-b border-primary"
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onBlur={() => handleRename(n.id, false)}
                    onKeyDown={(e) => { if (e.key === 'Enter') handleRename(n.id, false); if (e.key === 'Escape') setRenamingId(null); }}
                    onClick={(e) => e.stopPropagation()}
                  />
                ) : (
                  <span className="flex-1 text-xs truncate">{n.name}</span>
                )}
                {noteAiNotes.length > 0 && <span className="text-[10px] text-primary/70 shrink-0">{noteAiNotes.length}</span>}
                <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 shrink-0">
                  <button className="p-0.5 rounded hover:bg-muted/60" onClick={(e) => { e.stopPropagation(); startRename(n.id, n.name); }}><Edit2 className="h-2.5 w-2.5" /></button>
                  <button className="p-0.5 rounded hover:bg-destructive/20 text-destructive" onClick={(e) => { e.stopPropagation(); if (selectedNote?.id === n.id) setSelectedNote(null); store.deleteNote(n.id); }}><Trash2 className="h-2.5 w-2.5" /></button>
                </div>
              </div>
              {noteAiNotes.map((aiNote) => {
                const isAiSelected = selectedNote?.id === n.id && selectedAiNoteId === aiNote.id;
                return (
                  <div
                    key={aiNote.id}
                    className={`group flex items-center gap-1.5 px-2 py-0.5 rounded-md cursor-pointer transition-colors ${isAiSelected ? 'bg-primary/15 text-primary' : 'hover:bg-accent/40 text-muted-foreground'}`}
                    style={{ paddingLeft: depth * 12 + 8 + 34 }}
                    onClick={() => { setSelectedNote(store.notes.find((x) => x.id === n.id) || n); setSelectedAiNoteId(aiNote.id); }}
                    title={aiNote.title}
                  >
                    <Bot className="h-3 w-3 shrink-0 text-primary/70" />
                    <span className="flex-1 text-[11px] truncate">{aiNote.title}</span>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    );
  }

  const currentFolderPath = useMemo(() => {
    if (currentFolderId === null) return 'All Notes';
    const parts: string[] = [];
    let id: string | null = currentFolderId;
    while (id) {
      const f = store.folders.find((x) => x.id === id);
      if (!f) break;
      parts.unshift(f.name);
      id = f.parentId;
    }
    return parts.join(' / ');
  }, [currentFolderId, store.folders]);

  const liveNote = selectedNote ? (store.notes.find((n) => n.id === selectedNote.id) || selectedNote) : null;
  const savedAiNotes = getSavedAiNotes(liveNote);
  const selectedSavedAiNote = savedAiNotes.find((note) => note.id === selectedAiNoteId) || savedAiNotes.at(-1) || null;
  const hasAskedAi = aiMessages.some((message) => message.role === 'user');

  // ── RENDER ────────────────────────────────────────────────────────────────────

  return (
    <div className="flex w-full h-full overflow-hidden bg-background">

      {/* ═══ Left sidebar ══════════════════════════════════════════════════ */}
      {sidebarCollapsed ? (
        <button
          className="h-full w-9 shrink-0 flex flex-col items-center justify-start pt-3 gap-2 border-r border-border/50 bg-card hover:bg-accent/30 transition-colors"
          onClick={() => setSidebarCollapsed(false)}
          title="Open sidebar"
        >
          <PanelRightOpen className="h-4 w-4 text-muted-foreground" />
          <BookOpen className="h-3.5 w-3.5 text-primary/60" />
        </button>
      ) : (
      <div className="w-64 shrink-0 flex flex-col border-r border-border/50 bg-card overflow-hidden">

        {/* Header */}
        <div className="flex items-center gap-1.5 px-3 py-2.5 border-b border-border/50 shrink-0">
          <BookOpen className="h-4 w-4 text-primary shrink-0" />
          <span className="font-semibold text-sm flex-1">Notes</span>
          <button className="h-6 w-6 flex items-center justify-center rounded hover:bg-accent" onClick={() => setCreatingFolder(true)} title="New folder"><FolderPlus className="h-3.5 w-3.5" /></button>
          <button className="h-6 w-6 flex items-center justify-center rounded hover:bg-accent" onClick={() => setCreatingNote(true)} title="New note"><Plus className="h-3.5 w-3.5" /></button>
          <button className="h-6 w-6 flex items-center justify-center rounded hover:bg-accent" onClick={() => setSidebarCollapsed(true)} title="Collapse sidebar"><PanelLeftClose className="h-3.5 w-3.5" /></button>
        </div>

        {/* Search */}
        <div className="px-2 py-2 border-b border-border/50 space-y-1.5 shrink-0">
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search keywords in notes..."
              className="h-7 pl-7 text-xs"
            />
            {searchQuery && (
              <button className="absolute right-2 top-1/2 -translate-y-1/2" onClick={() => setSearchQuery('')}><X className="h-3 w-3 text-muted-foreground" /></button>
            )}
          </div>
          {searchQuery && (
            <div className="space-y-1">
              {/* Toggle filters */}
              <div className="flex flex-wrap gap-1">
                {[
                  { key: 'name', label: 'Name', val: searchInName, set: setSearchInName },
                  { key: 'desc', label: 'Description', val: searchInDesc, set: setSearchInDesc },
                  { key: 'body', label: 'Body', val: searchInBody, set: setSearchInBody },
                ].map(({ key, label, val, set }) => (
                  <button
                    key={key}
                    className={`text-[10px] px-1.5 py-0.5 rounded border transition-colors ${val ? 'bg-primary/15 border-primary/40 text-primary' : 'bg-muted/40 border-transparent text-muted-foreground'}`}
                    onClick={() => set(!val)}
                  >
                    {label}
                  </button>
                ))}
                <button
                  className={`text-[10px] px-1.5 py-0.5 rounded border transition-colors ${searchScope === 'folder' ? 'bg-primary/15 border-primary/40 text-primary' : 'bg-muted/40 border-transparent text-muted-foreground'}`}
                  onClick={() => setSearchScope(searchScope === 'all' ? 'folder' : 'all')}
                >
                  {searchScope === 'folder' ? 'This folder' : 'All folders'}
                </button>
              </div>
              {/* Results count */}
              <p className="text-[10px] text-muted-foreground px-0.5">
                {searchResults?.length ?? 0} result{searchResults?.length !== 1 ? 's' : ''}
              </p>
            </div>
          )}
        </div>

        {/* Tree / search results */}
        <div className="flex-1 min-h-0 overflow-y-auto p-1.5">
          {searchQuery && searchResults ? (
            // Search results mode
            <div className="space-y-0.5">
              {searchResults.length === 0 ? (
                <p className="text-xs text-muted-foreground text-center py-4">No results</p>
              ) : searchResults.map((n) => (
                <div
                  key={n.id}
                  className={`flex items-start gap-2 px-2 py-1.5 rounded-lg cursor-pointer hover:bg-accent/40 transition-colors ${selectedNote?.id === n.id ? 'bg-primary/10' : ''}`}
                  onClick={() => { setSelectedNote(n); setSearchQuery(''); }}
                >
                  <FileText className="h-3.5 w-3.5 text-muted-foreground shrink-0 mt-0.5" />
                  <div className="min-w-0">
                    <p className="text-xs font-medium truncate">{n.name}</p>
                    {n.description && <p className="text-[10px] text-muted-foreground truncate">{n.description}</p>}
                    <p className="text-[10px] text-muted-foreground/60">{formatDate(n.updatedAt)}</p>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            // Tree mode
            <div>
              {/* Root level shortcut */}
              <div
                className={`flex items-center gap-1.5 px-2 py-1 rounded-md cursor-pointer text-xs mb-0.5 transition-colors ${currentFolderId === null ? 'bg-primary/10 text-primary' : 'hover:bg-accent/40 text-muted-foreground'}`}
                onClick={() => setCurrentFolderId(null)}
              >
                <BookOpen className="h-3.5 w-3.5 shrink-0" />
                All Notes
              </div>
              {renderFolderTree(null)}
              {store.folders.length === 0 && store.notes.length === 0 && (
                <p className="text-[11px] text-muted-foreground text-center py-6 leading-relaxed">No notes yet.<br />Click + to create one.</p>
              )}
            </div>
          )}
        </div>

        {/* Create folder inline */}
        {creatingFolder && (
          <div className="px-2 py-2 border-t border-border/50 flex gap-1 shrink-0">
            <Input
              autoFocus
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleCreateFolder(); if (e.key === 'Escape') { setNewFolderName(''); setCreatingFolder(false); } }}
              placeholder="Folder name…"
              className="h-7 text-xs flex-1"
            />
            <Button size="sm" className="h-7 px-2" onClick={handleCreateFolder}>Add</Button>
            <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => { setNewFolderName(''); setCreatingFolder(false); }}><X className="h-3 w-3" /></Button>
          </div>
        )}
      </div>
      )}

      {/* ═══ Main area ═══════════════════════════════════════════════════════ */}
      <div className="flex-1 min-w-0 flex flex-col overflow-hidden">

        {!selectedNote && !creatingNote ? (
          // ── Note list view ──────────────────────────────────────────────────
          <div className="flex-1 overflow-y-auto p-6">
            <div className="max-w-3xl mx-auto">
              <div className="flex items-center justify-between mb-6">
                <div>
                  <h2 className="text-xl font-bold">{currentFolderPath}</h2>
                  <p className="text-sm text-muted-foreground mt-0.5">
                    {store.getNotesInFolder(currentFolderId).length} note{store.getNotesInFolder(currentFolderId).length !== 1 ? 's' : ''}
                    {store.getSubfolders(currentFolderId).length > 0 && ` · ${store.getSubfolders(currentFolderId).length} folder${store.getSubfolders(currentFolderId).length !== 1 ? 's' : ''}`}
                  </p>
                </div>
                <Button onClick={() => setCreatingNote(true)} className="gap-2">
                  <Plus className="h-4 w-4" /> New Note
                </Button>
              </div>

              {/* Subfolders */}
              {store.getSubfolders(currentFolderId).length > 0 && (
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3 mb-6">
                  {store.getSubfolders(currentFolderId).map((f) => (
                    <div
                      key={f.id}
                      className="flex items-center gap-2 rounded-xl border border-border/60 bg-card hover:border-primary/40 hover:shadow-sm px-3 py-2.5 cursor-pointer transition-all"
                      onClick={() => { setCurrentFolderId(f.id); setOpenFolderIds((p) => new Set([...p, f.id])); }}
                    >
                      <FolderOpen className="h-5 w-5 text-amber-400 shrink-0" />
                      <div className="min-w-0">
                        <p className="text-sm font-medium truncate">{f.name}</p>
                        <p className="text-[10px] text-muted-foreground">{store.getNotesInFolder(f.id).length} notes</p>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Notes grid */}
              {store.getNotesInFolder(currentFolderId).length === 0 ? (
                <div className="flex flex-col items-center justify-center py-24 text-center">
                  <FileText className="h-16 w-16 mx-auto opacity-20 mb-4" />
                  <p className="text-lg font-medium mb-1">No notes here</p>
                  <p className="text-sm text-muted-foreground mb-4">Click New Note to add your first note to this folder.</p>
                  <Button onClick={() => setCreatingNote(true)}>
                    <Plus className="h-4 w-4 mr-2" /> New Note
                  </Button>
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
                  {store.getNotesInFolder(currentFolderId).map((n) => (
                    <div
                      key={n.id}
                      className="group rounded-xl border border-border/60 bg-card hover:border-primary/40 hover:shadow-sm p-4 cursor-pointer transition-all"
                      onClick={() => setSelectedNote(n)}
                    >
                      <div className="flex items-start justify-between gap-2 mb-2">
                        <h3 className="font-semibold text-sm leading-tight">{n.name}</h3>
                        <button
                          className="opacity-0 group-hover:opacity-100 h-5 w-5 flex items-center justify-center rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive shrink-0"
                          onClick={(e) => { e.stopPropagation(); store.deleteNote(n.id); }}
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      </div>
                      {n.description && <p className="text-xs text-muted-foreground mb-2 line-clamp-2">{n.description}</p>}
                      {n.rawContent && <p className="text-xs text-muted-foreground/60 line-clamp-3 font-mono">{n.rawContent}</p>}
                      <div className="flex items-center justify-between mt-3 pt-2 border-t border-border/40">
                        <span className="text-[10px] text-muted-foreground">{formatDate(n.updatedAt)}</span>
                        {(n.aiContent || getSavedAiNotes(n).length > 0) && <span className="text-[10px] text-primary/70 flex items-center gap-0.5"><Bot className="h-2.5 w-2.5" /> AI note</span>}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

        ) : creatingNote ? (
          // ── Create note form ────────────────────────────────────────────────
          <div className="flex-1 overflow-y-auto p-8">
            <div className="max-w-xl mx-auto space-y-4">
              <div className="flex items-center gap-3 mb-2">
                <button className="text-muted-foreground hover:text-foreground" onClick={() => setCreatingNote(false)}><ArrowLeft className="h-5 w-5" /></button>
                <h2 className="text-xl font-bold">New Note</h2>
              </div>
              <div className="space-y-3 rounded-xl border border-border/60 p-5">
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Note name *</label>
                  <Input
                    autoFocus
                    placeholder="e.g. Meeting with product team"
                    value={newNoteName}
                    onChange={(e) => setNewNoteName(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter' && newNoteName.trim()) handleCreateNote(); }}
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Description</label>
                  <Input
                    placeholder="Brief context — what is this note about?"
                    value={newNoteDesc}
                    onChange={(e) => setNewNoteDesc(e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Save in folder</label>
                  <Select
                    value={currentFolderId || '__root__'}
                    onValueChange={(v) => setCurrentFolderId(v === '__root__' ? null : v)}
                  >
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__root__">Root (no folder)</SelectItem>
                      {store.folders.map((f) => <SelectItem key={f.id} value={f.id}>{f.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="flex gap-2 justify-end">
                <Button variant="outline" onClick={() => { setNewNoteName(''); setNewNoteDesc(''); setCreatingNote(false); }}>Cancel</Button>
                <Button onClick={handleCreateNote} disabled={!newNoteName.trim()}>
                  <Plus className="h-4 w-4 mr-1.5" /> Create Note
                </Button>
              </div>
            </div>
          </div>

        ) : liveNote ? (
          // ── Note editor (dual pane) ─────────────────────────────────────────
          <div className="flex-1 min-h-0 flex flex-col overflow-hidden">

            {/* Note header */}
            <div className="flex items-center gap-3 px-5 py-2.5 border-b border-border/50 shrink-0 bg-card/50">
              <button className="text-muted-foreground hover:text-foreground" onClick={() => setSelectedNote(null)}><ArrowLeft className="h-4 w-4" /></button>
              <div className="flex-1 min-w-0">
                <h2 className="font-semibold text-sm truncate">{liveNote.name}</h2>
                {liveNote.description && <p className="text-xs text-muted-foreground truncate">{liveNote.description}</p>}
              </div>
              <span className="text-[10px] text-muted-foreground shrink-0">{formatDate(liveNote.updatedAt)}</span>
            </div>

            {/* Dual pane */}
            <div className="flex-1 min-h-0 flex overflow-hidden">

              {/* ── Left pane: Raw notes ─────────────────────────────────── */}
              <div className="flex-1 min-w-0 flex flex-col border-r border-border/50 overflow-hidden">
                <div className="flex items-center gap-2 px-4 py-2 border-b border-border/30 shrink-0 bg-muted/10">
                  <AlignLeft className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Raw Notes</span>
                  <div className="flex-1" />
                  {speechStatus && (
                    <span className="max-w-[260px] truncate text-[11px] text-muted-foreground" title={speechStatus}>
                      {speechStatus}
                    </span>
                  )}
                  {isVsCodeEmbeddedBrowser() && (
                    <a
                      className="text-[11px] font-medium text-primary hover:underline"
                      href={window.location.href}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Open in Chrome/Edge
                    </a>
                  )}
                  <button
                    className={`h-7 w-7 flex items-center justify-center rounded-lg transition-colors ${isListening ? 'bg-red-500 text-white' : 'hover:bg-accent'}`}
                    onClick={toggleMic}
                    title={isListening ? 'Stop recording' : 'Start voice input'}
                  >
                    {isListening ? <MicOff className="h-3.5 w-3.5" /> : <Mic className="h-3.5 w-3.5" />}
                  </button>
                </div>

                <Textarea
                  className="flex-1 resize-none border-0 rounded-none bg-transparent focus-visible:ring-0 text-sm p-4 font-mono leading-relaxed"
                  placeholder={`Start typing or use the microphone to dictate...\n\nThis is your raw notes space — capture everything as-is.\nThe AI will help you process it on the right.`}
                  value={rawContent}
                  onChange={(e) => setRawContent(e.target.value)}
                />

                {/* Live interim speech preview */}
                {interimText && (
                  <div className="shrink-0 px-4 py-2 bg-amber-500/5 border-t border-amber-400/20">
                    <div className="flex items-center gap-1.5 mb-0.5">
                      <span className="inline-block h-2 w-2 rounded-full bg-red-500 animate-pulse" />
                      <span className="text-[10px] text-amber-600/80 dark:text-amber-400/70 font-medium uppercase tracking-wide">Listening…</span>
                    </div>
                    <p className="text-sm font-mono text-muted-foreground/70 italic">{interimText}</p>
                  </div>
                )}
              </div>

              {/* ── Right pane: AI ─────────────────────────────────────── */}
              <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
                {/* AI chat input at top */}
                <div className="shrink-0 border-b border-border/30 bg-muted/10">
                  <div className="flex items-center gap-1.5 px-3 py-2">
                    <Bot className="h-3.5 w-3.5 text-primary shrink-0" />
                    <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide flex-1">AI Assistant</span>
                    {(aiMessages.length > 0 || aiStreaming) && (
                      <button
                        className={`text-[11px] flex items-center gap-1 px-2 py-1 rounded-lg transition-colors ${saved ? 'bg-green-500/20 text-green-600' : 'bg-primary/15 text-primary hover:bg-primary/25'}`}
                        onClick={beginSaveAiToNote}
                        title="Save AI response as a note"
                      >
                        {saved ? <><Check className="h-3 w-3" /> Saved</> : <><Save className="h-3 w-3" /> Save AI response as a note</>}
                      </button>
                    )}
                  </div>
                  <div className="grid grid-cols-[112px_minmax(0,1fr)] gap-1.5 px-3 pb-2">
                    <Select value={aiTargetMode} onValueChange={(value) => setAiTargetMode(value as 'model' | 'agent')}>
                      <SelectTrigger className="h-8 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="model">Model</SelectItem>
                        <SelectItem value="agent">Agent</SelectItem>
                      </SelectContent>
                    </Select>

                    {aiTargetMode === 'agent' ? (
                      <Select value={selectedAgentId} onValueChange={setSelectedAgentId}>
                        <SelectTrigger className="h-8 text-xs">
                          <SelectValue placeholder="Select agent" />
                        </SelectTrigger>
                        <SelectContent>
                          {agents.map((agent) => (
                            <SelectItem key={agent.id} value={agent.id}>{agent.name || agent.id}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <Select value={selectedModel} onValueChange={setSelectedModel}>
                        <SelectTrigger className="h-8 text-xs">
                          <SelectValue placeholder="Select model" />
                        </SelectTrigger>
                        <SelectContent>{models.map((m) => <SelectItem key={m.name} value={m.name}>{m.name}</SelectItem>)}</SelectContent>
                      </Select>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5 px-3 pb-2">
                    <button
                      className={`h-7 px-2 rounded-lg border text-[11px] flex items-center gap-1 transition-colors ${webSearchEnabled ? 'bg-primary/15 border-primary/40 text-primary' : 'border-border/60 text-muted-foreground hover:bg-accent'}`}
                      onClick={() => setWebSearchEnabled((value) => !value)}
                      title="Use internet search with this note question"
                    >
                      <Globe2 className="h-3 w-3" /> Internet
                    </button>
                    {webSearchEnabled && (
                      <>
                        <Select value={webSearchProvider} onValueChange={(value) => setWebSearchProvider(value as 'ollama' | 'duckduckgo')}>
                          <SelectTrigger className="h-7 text-[11px] w-[116px]"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="duckduckgo">DuckDuckGo</SelectItem>
                            <SelectItem value="ollama">Ollama</SelectItem>
                          </SelectContent>
                        </Select>
                        <Select value={webSearchMode} onValueChange={(value) => setWebSearchMode(value as 'search' | 'search_fetch' | 'deep')}>
                          <SelectTrigger className="h-7 text-[11px] flex-1"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="search">Search</SelectItem>
                            <SelectItem value="search_fetch">Search + read</SelectItem>
                            <SelectItem value="deep">Deep research</SelectItem>
                          </SelectContent>
                        </Select>
                      </>
                    )}
                    {aiTargetMode === 'agent' && !webSearchEnabled && (
                      <span className="text-[11px] text-muted-foreground flex items-center gap-1 min-w-0">
                        <Users className="h-3 w-3 shrink-0" />
                        <span className="truncate">Agent receives raw notes as context</span>
                      </span>
                    )}
                  </div>
                  {!isSavingAiNote && !hasAskedAi && !aiStreaming && (
                    <div className="px-3 pb-2">
                      <p className="text-[10px] text-muted-foreground mb-1.5">Process with AI</p>
                      <div className="flex flex-wrap gap-1">
                        {AI_PROMPTS.map((p) => (
                          <button
                            key={p.label}
                            className="text-[11px] px-2 py-1 rounded-lg border border-border/60 hover:border-primary/50 hover:bg-primary/10 hover:text-primary transition-colors flex items-center gap-1"
                            onClick={() => runQuickPrompt(p.prompt)}
                            disabled={aiLoading || !rawContent.trim() || (aiTargetMode === 'model' ? !selectedModel : !selectedAgentId)}
                            title={p.prompt}
                          >
                            <Sparkles className="h-2.5 w-2.5" />
                            {p.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                  {isSavingAiNote && (
                    <div className="px-3 pb-2 space-y-1.5">
                      <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Save AI response as a note</p>
                      <div className="flex gap-1.5">
                        <Input
                          autoFocus
                          value={aiNoteTitle}
                          onChange={(e) => setAiNoteTitle(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') saveAiToNote();
                            if (e.key === 'Escape') { setIsSavingAiNote(false); setAiNoteTitle(''); }
                          }}
                          placeholder="AI note title..."
                          className="h-8 text-xs flex-1"
                        />
                        <Button size="sm" className="h-8 px-2 text-xs" onClick={saveAiToNote} disabled={!aiNoteTitle.trim()}>
                          Save
                        </Button>
                        <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => { setIsSavingAiNote(false); setAiNoteTitle(''); }}>
                          <X className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>
                  )}
                  {savedAiNotes.length > 1 && (
                    <div className="px-3 pb-2">
                      <Select value={selectedSavedAiNote?.id || ''} onValueChange={setSelectedAiNoteId}>
                        <SelectTrigger className="h-8 text-xs">
                          <SelectValue placeholder="Select saved AI note" />
                        </SelectTrigger>
                        <SelectContent>
                          {savedAiNotes.map((note) => (
                            <SelectItem key={note.id} value={note.id}>{note.title}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                  {!isSavingAiNote && (
                    <div className="flex gap-1.5 px-3 pb-2">
                      <Input
                        value={aiInput}
                        onChange={(e) => {
                          if (aiPromptHistoryIndex !== -1) {
                            setAiPromptHistoryIndex(-1);
                            aiPromptDraftRef.current = e.target.value;
                          }
                          setAiInput(e.target.value);
                        }}
                        onKeyDown={handleAiInputKeyDown}
                        placeholder="Ask AI about this note or generate a summary of this note..."
                        className="h-8 text-xs flex-1"
                        disabled={aiLoading || (aiTargetMode === 'model' ? !selectedModel : !selectedAgentId)}
                      />
                      <Button
                        size="icon"
                        className="h-8 w-8 shrink-0"
                        onClick={sendAiInput}
                        disabled={aiLoading || !aiInput.trim() || (aiTargetMode === 'model' ? !selectedModel : !selectedAgentId)}
                      >
                        {aiLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
                      </Button>
                    </div>
                  )}
                </div>

                {/* AI conversation + output */}
                <div ref={aiScrollRef} className="flex-1 min-h-0 overflow-y-auto p-4 space-y-3">
                  {aiMessages.length === 0 && !aiStreaming && !aiThinking && !selectedSavedAiNote ? (
                    <div className="flex flex-col items-center justify-center h-full text-center py-8">
                      <Sparkles className="h-10 w-10 opacity-20 mb-3" />
                      <p className="text-sm font-medium mb-1">AI Notes</p>
                      <p className="text-xs text-muted-foreground leading-relaxed max-w-xs">
                        Ask AI about this note, generate a summary of this note,<br />
                        extract action items, or turn raw notes into a saved AI note.
                      </p>
                    </div>
                  ) : (
                    <>
                      {aiThinking && (
                        <div className="rounded-xl border border-amber-400/25 bg-amber-500/5 p-3">
                          <button
                            className="w-full flex items-center gap-1.5 text-left"
                            onClick={() => setAiThinkingExpanded((value) => !value)}
                            title={aiThinkingExpanded ? 'Collapse thinking' : 'Expand thinking'}
                          >
                            {aiThinkingExpanded ? <ChevronDown className="h-3.5 w-3.5 text-amber-500" /> : <ChevronRight className="h-3.5 w-3.5 text-amber-500" />}
                            <Sparkles className="h-3.5 w-3.5 text-amber-500" />
                            <span className="text-[11px] font-semibold text-amber-600 dark:text-amber-400 uppercase tracking-wide flex-1">Thinking</span>
                            <span className="text-[10px] text-muted-foreground">{aiThinkingExpanded ? 'Hide' : 'Show'}</span>
                          </button>
                          {aiThinkingExpanded && (
                            <p className="mt-1.5 text-xs whitespace-pre-wrap leading-relaxed text-muted-foreground max-h-40 overflow-y-auto">
                              {aiThinking.replace(/<\/?think>/gi, '').trim()}
                            </p>
                          )}
                        </div>
                      )}

                      {/* Saved AI note (from previous sessions) */}
                      {selectedSavedAiNote && aiMessages.length === 0 && !aiStreaming && (
                        <div className="rounded-xl border border-primary/30 bg-primary/5 p-4">
                          <div className="flex items-center gap-1.5 mb-2">
                            <Bot className="h-3.5 w-3.5 text-primary" />
                            <span className="text-[11px] font-semibold text-primary uppercase tracking-wide">{selectedSavedAiNote.title}</span>
                          </div>
                          {selectedSavedAiNote.messages?.length ? (
                            <div className="space-y-2">
                              {selectedSavedAiNote.messages.map((msg, index) => (
                                <div key={index} className={msg.role === 'user' ? 'flex justify-end' : 'flex justify-start'}>
                                  <div className={`max-w-[92%] rounded-2xl px-3 py-2 text-xs whitespace-pre-wrap leading-relaxed ${msg.role === 'user' ? 'rounded-tr-sm bg-primary text-primary-foreground' : 'rounded-tl-sm border border-border/50 bg-card'}`}>
                                    {msg.content}
                                  </div>
                                </div>
                              ))}
                            </div>
                          ) : (
                            <p className="text-sm whitespace-pre-wrap leading-relaxed">{selectedSavedAiNote.content}</p>
                          )}
                        </div>
                      )}

                      {/* Chat history */}
                      {aiMessages.map((msg, i) => (
                        <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                          {msg.role === 'user' ? (
                            <div className="max-w-[85%] rounded-2xl rounded-tr-sm bg-primary text-primary-foreground px-3 py-2 text-xs">
                              {msg.content}
                            </div>
                          ) : (
                            <div className="max-w-[92%] rounded-2xl rounded-tl-sm border border-border/50 bg-card px-3 py-2 text-xs whitespace-pre-wrap leading-relaxed">
                              {msg.content}
                            </div>
                          )}
                        </div>
                      ))}

                      {/* Streaming */}
                      {aiStreaming && (
                        <div className="flex justify-start">
                          <div className="max-w-[92%] rounded-2xl rounded-tl-sm border border-border/50 bg-card px-3 py-2 text-xs whitespace-pre-wrap leading-relaxed">
                            {aiStreaming}
                          </div>
                        </div>
                      )}
                    </>
                  )}
                </div>
              </div>

            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
