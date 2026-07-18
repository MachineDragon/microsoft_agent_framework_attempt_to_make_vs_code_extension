import React, { useRef, useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Card } from '@/components/ui/card';
import { Loader2, Paperclip, Send, FileText, Image as ImageIcon, MessageSquare, MessageSquarePlus, Mic, MicOff, Square, ChevronUp, ChevronDown, X, Wrench, Globe2, Search, Radio } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useAppStore } from '@/stores/appStore';
import { apiClient } from '@/services/api';
import { getStoredJSON, getStoredString, setStoredJSON, setStoredString } from '@/services/extensionStorage';

type WebSearchProvider = 'ollama' | 'duckduckgo';
type WebSearchMode = 'off' | 'search' | 'search_fetch' | 'deep';

const requestOllamaApiKey = () => {
  window.dispatchEvent(new CustomEvent('budai:open-settings', {
    detail: { reason: 'ollama-web-search-key-required' },
  }));
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

type TtsQueueItem = {
  messageId: string;
  text: string;
};

const VOICE_SILENCE_MS = 2500;

function isVsCodeWebview() {
  const userAgent = navigator.userAgent.toLowerCase();
  return userAgent.includes(' electron/') && userAgent.includes(' code/');
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

interface ChatInterfaceProps {
  className?: string;
}

export const ChatInterface: React.FC<ChatInterfaceProps> = ({ className }) => {
  const {
    chatMessages,
    isStreaming,
    streamingState,
    sendMessage,
    sendMessageToMultipleAgents,
    stopCurrentResponse,
    selectedAgents,
    selectedAgent,
    chatTargetMode,
    selectedDirectModel,
    currentConversation,
    createConversation,
    startNewChat,
    debugEvents,
  } = useAppStore();

  const [inputText, setInputText] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [promptHistory, setPromptHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const [voiceModeEnabled, setVoiceModeEnabled] = useState(false);
  const [webSearchProvider, setWebSearchProvider] = useState<WebSearchProvider | null>(null);
  const [webSearchMode, setWebSearchMode] = useState<WebSearchMode>('off');
  const [isListening, setIsListening] = useState(false); // used by mic button UI indicator
  const [isTtsSpeaking, setIsTtsSpeaking] = useState(false);
  const [queuedMessages, setQueuedMessages] = useState<Array<{ text: string; files: File[] }>>([]);
  const [speechSupported, setSpeechSupported] = useState(false);
  const [speechStatus, setSpeechStatus] = useState('');
  const [availableVoices, setAvailableVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [selectedVoice, setSelectedVoice] = useState<SpeechSynthesisVoice | null>(null);
  const [savedTtsVoiceUri, setSavedTtsVoiceUri] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrollViewportRef = useRef<HTMLDivElement>(null);
  const shouldStickToBottomRef = useRef(true);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const inputTextRef = useRef('');
  const filesRef = useRef<File[]>([]);
  const voiceTranscriptBufferRef = useRef('');
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const useBackendSpeechRef = useRef(false);
  const silenceTimerRef = useRef<number | null>(null);
  const inputDebounceTimerRef = useRef<number | null>(null);
  const voiceModeEnabledRef = useRef(false);
  const isStreamingRef = useRef(false);
  const ttsQueueRef = useRef<TtsQueueItem[]>([]);
  const ttsSpeakingRef = useRef(false);
  const ttsKeepAliveRef = useRef<number | null>(null);
  const selectedVoiceRef = useRef<SpeechSynthesisVoice | null>(null);
  const currentTtsChunkRef = useRef<TtsQueueItem | null>(null);
  const ttsVoiceSwitchPendingRef = useRef(false);
  const streamingSpokenOffsetsRef = useRef<Record<string, number>>({});
  const suppressedTtsMessageIdsRef = useRef<Set<string>>(new Set());
  const directModelAbortControllerRef = useRef<AbortController | null>(null);
  const speakTextRef = useRef<(messageId: string, text: string) => void>(() => {});
  const sendCurrentInputRef = useRef<() => Promise<boolean>>(async () => false);
  const handleSendFromVoiceRef = useRef<() => Promise<void>>(async () => {});
  const chatPrefsLoadedRef = useRef(false);

  // Keep refs in sync with state so recognition handlers are never stale
  useEffect(() => { voiceModeEnabledRef.current = voiceModeEnabled; }, [voiceModeEnabled]);
  useEffect(() => { isStreamingRef.current = isStreaming; }, [isStreaming]);
  useEffect(() => { selectedVoiceRef.current = selectedVoice; }, [selectedVoice]);

  useEffect(() => {
    let cancelled = false;
    const loadChatPreferences = async () => {
      const [savedPromptHistory, savedProvider, savedMode] = await Promise.all([
        getStoredJSON<string[]>('chat-prompt-history', []),
        getStoredString('direct-model-web-search'),
        getStoredString('direct-model-web-search-mode'),
      ]);
      if (cancelled) return;
      setPromptHistory(Array.isArray(savedPromptHistory) ? savedPromptHistory : []);
      setWebSearchProvider(savedProvider === 'duckduckgo' ? 'duckduckgo' : null);
      setWebSearchMode(
        savedProvider === 'duckduckgo' && (savedMode === 'search' || savedMode === 'search_fetch' || savedMode === 'deep')
          ? savedMode
          : 'off'
      );
      chatPrefsLoadedRef.current = true;
    };
    void loadChatPreferences();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    getStoredString('tts-voice-uri').then((voiceUri) => {
      if (!cancelled) setSavedTtsVoiceUri(voiceUri);
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!chatPrefsLoadedRef.current) return;
    if (webSearchProvider) {
      void setStoredString('direct-model-web-search', webSearchProvider);
    } else {
      void setStoredString('direct-model-web-search', 'false');
    }
  }, [webSearchProvider]);

  useEffect(() => {
    if (!chatPrefsLoadedRef.current) return;
    void setStoredString('direct-model-web-search-mode', webSearchMode);
    if (webSearchMode !== 'off' && !webSearchProvider) {
      setWebSearchProvider('duckduckgo');
    }
  }, [webSearchMode, webSearchProvider]);

  const enableOllamaHostedWebSearch = async () => {
    try {
      const settings = await apiClient.getCustomSettings();
      if (!settings.ollama_api_key_configured) {
        setWebSearchProvider(null);
        setWebSearchMode('off');
        requestOllamaApiKey();
        return;
      }
      setWebSearchProvider('ollama');
      if (webSearchMode === 'off') setWebSearchMode('search_fetch');
    } catch {
      setWebSearchProvider(null);
      setWebSearchMode('off');
      requestOllamaApiKey();
    }
  };

  const clearTtsKeepAlive = () => {
    if (ttsKeepAliveRef.current) {
      window.clearInterval(ttsKeepAliveRef.current);
      ttsKeepAliveRef.current = null;
    }
  };

  const stopTTS = () => {
    window.speechSynthesis.cancel();
    ttsSpeakingRef.current = false;
    setIsTtsSpeaking(false);
    ttsQueueRef.current = [];
    currentTtsChunkRef.current = null;
    ttsVoiceSwitchPendingRef.current = false;
    clearTtsKeepAlive();
  };

  const stopSpeakingCurrentReply = () => {
    if (currentTtsChunkRef.current?.messageId) {
      suppressedTtsMessageIdsRef.current.add(currentTtsChunkRef.current.messageId);
    }
    stopTTS();

    // If voice mode is still on, resume listening immediately after stop.
    if (voiceModeEnabledRef.current && !isStreamingRef.current && recognitionRef.current) {
      window.setTimeout(() => {
        if (!voiceModeEnabledRef.current || isStreamingRef.current || ttsSpeakingRef.current) return;
        try {
          recognitionRef.current?.start();
          setIsListening(true);
        } catch {
          // Ignore occasional start race errors.
        }
      }, 250);
    }
  };

  const speakNext = () => {
    if (ttsQueueRef.current.length === 0) {
      ttsSpeakingRef.current = false;
      setIsTtsSpeaking(false);
      currentTtsChunkRef.current = null;
      clearTtsKeepAlive();

      // Resume mic after TTS finishes so user can immediately speak again.
      if (voiceModeEnabledRef.current && !isStreamingRef.current && recognitionRef.current) {
        window.setTimeout(() => {
          if (!voiceModeEnabledRef.current || isStreamingRef.current || ttsSpeakingRef.current) return;
          try {
            recognitionRef.current?.start();
            setIsListening(true);
          } catch {
            // Ignore occasional start race errors.
          }
        }, 250);
      }
      return;
    }

    const nextItem = ttsQueueRef.current.shift()!;
    currentTtsChunkRef.current = nextItem;
    const utterance = new SpeechSynthesisUtterance(nextItem.text);
    utterance.rate = 1;
    utterance.pitch = 1;
    const voice = selectedVoiceRef.current;
    if (voice) utterance.voice = voice;

    utterance.onstart = () => {
      ttsSpeakingRef.current = true;
      setIsTtsSpeaking(true);
      // Keep-alive: Chrome/Edge cancel TTS after ~15s - pause/resume every 10s prevents it
      if (!ttsKeepAliveRef.current) {
        ttsKeepAliveRef.current = window.setInterval(() => {
          if (window.speechSynthesis.speaking) {
            window.speechSynthesis.pause();
            window.speechSynthesis.resume();
          }
        }, 10000);
      }
      // Stop recognition while speaking to avoid feedback
      if (recognitionRef.current) {
        try { recognitionRef.current.stop(); } catch { /* ignore */ }
        setIsListening(false);
      }
    };

    utterance.onend = () => {
      if (ttsVoiceSwitchPendingRef.current) {
        ttsVoiceSwitchPendingRef.current = false;
        ttsSpeakingRef.current = false;
        setIsTtsSpeaking(false);
        clearTtsKeepAlive();
        speakNext();
        return;
      }

      currentTtsChunkRef.current = null;
      speakNext();
    };

    utterance.onerror = () => {
      if (ttsVoiceSwitchPendingRef.current) {
        ttsVoiceSwitchPendingRef.current = false;
        ttsSpeakingRef.current = false;
        setIsTtsSpeaking(false);
        clearTtsKeepAlive();
        speakNext();
        return;
      }

      currentTtsChunkRef.current = null;
      ttsSpeakingRef.current = false;
      setIsTtsSpeaking(false);
      speakNext(); // Try next sentence even on error
    };

    window.speechSynthesis.speak(utterance);
  };

  const speakText = (messageId: string, text: string) => {
    if (suppressedTtsMessageIdsRef.current.has(messageId)) return;
    // Split into sentences to avoid long-text glitches
    const sentences = text.match(/[^.!?\n]+[.!?\n]*/g) ?? [text];
    ttsQueueRef.current.push(
      ...sentences
        .map((s) => s.trim())
        .filter(Boolean)
        .map((sentence) => ({ messageId, text: sentence }))
    );
    if (!ttsSpeakingRef.current) {
      speakNext();
    }
  };
  speakTextRef.current = speakText;
  const spokenMessageIdsRef = useRef<Set<string>>(new Set());
  const pendingAutoSendRef = useRef(false);
  const lastRecognitionChunkRef = useRef('');
  const historyDraftRef = useRef('');

  const rememberPrompt = (text: string) => {
    const prompt = text.trim();
    if (!prompt) return;

    setPromptHistory((prev) => {
      if (prev[prev.length - 1] === prompt) return prev;
      const next = [...prev, prompt].slice(-100);
      void setStoredJSON('chat-prompt-history', next);
      return next;
    });
    setHistoryIndex(null);
    historyDraftRef.current = '';
  };

  const extractSpeakablePrefix = (text: string) => {
    const matches = text.match(/[^.!?\n]+[.!?\n]+/g);
    if (!matches || matches.length === 0) {
      return '';
    }
    return matches.join('').trim();
  };

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

  const optimizeImageForVision = async (file: File): Promise<string> => {
    const dataUrl = await readFileAsDataUrl(file);

    // Keep small images untouched to avoid unnecessary re-encoding loss.
    if (file.size < 700_000) {
      return dataUrl;
    }

    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const maxDimension = 1600;
        const scale = Math.min(1, maxDimension / Math.max(img.width, img.height));
        const targetWidth = Math.max(1, Math.round(img.width * scale));
        const targetHeight = Math.max(1, Math.round(img.height * scale));

        const canvas = document.createElement('canvas');
        canvas.width = targetWidth;
        canvas.height = targetHeight;

        const ctx = canvas.getContext('2d');
        if (!ctx) {
          resolve(dataUrl);
          return;
        }

        ctx.drawImage(img, 0, 0, targetWidth, targetHeight);
        const optimized = canvas.toDataURL('image/jpeg', 0.88);
        resolve(optimized || dataUrl);
      };

      img.onerror = () => resolve(dataUrl);
      img.src = dataUrl;
    });
  };

  const buildAttachmentPreviews = (inputFiles: File[]) =>
    inputFiles.map((file) => ({
      name: file.name,
      type: file.type,
      url: URL.createObjectURL(file),
      isImage: file.type.startsWith('image/'),
    }));

  const getWebModeLabel = () => {
    if (webSearchMode === 'off') return 'Web off';
    if (webSearchMode === 'search') return 'Search';
    if (webSearchMode === 'deep') return 'Deep research';
    return 'Search + fetch';
  };

  const extractWebSources = (detail: string) => {
    const sources: Array<{ title: string; url: string; snippet?: string }> = [];
    const seen = new Set<string>();
    const blocks = detail.split(/\n\n+/);
    for (const block of blocks) {
      const urlMatch = block.match(/URL:\s*(https?:\/\/\S+)/i) || block.match(/Fetch result for\s+(https?:\/\/\S+)/i);
      if (!urlMatch) continue;
      const url = urlMatch[1].replace(/[),.]+$/, '');
      if (seen.has(url)) continue;
      seen.add(url);
      const titleMatch = block.match(/^\s*\d+\.\s*([^\n]+)/) || block.match(/Title:\s*([^\n]+)/i);
      const snippetMatch = block.match(/(?:Content|Page excerpt|Result):\s*([\s\S]{1,240})/i);
      sources.push({
        title: titleMatch?.[1]?.trim() || new URL(url).hostname,
        url,
        snippet: snippetMatch?.[1]?.replace(/\s+/g, ' ').trim(),
      });
    }
    return sources.slice(0, 6);
  };

  const updateStickToBottom = () => {
    const viewport = scrollViewportRef.current;
    if (!viewport) return;
    const distanceFromBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
    shouldStickToBottomRef.current = distanceFromBottom < 96;
  };

  // Auto-scroll only when the user is already near the bottom.
  useEffect(() => {
    const viewport = scrollViewportRef.current;
    if (!viewport || !shouldStickToBottomRef.current) return;
    viewport.scrollTop = viewport.scrollHeight;
  }, [chatMessages, streamingState.currentContent]);

  // Load available voices — retry until Edge's online neural voices appear
  useEffect(() => {
    let settled = false;
    let pollInterval: number | null = null;

    const loadVoices = () => {
      const voices = window.speechSynthesis.getVoices();
      if (voices.length === 0) return;

      const hasNatural = voices.some(
        (v) => v.name.toLowerCase().includes('natural') || v.name.toLowerCase().includes('online')
      );

      // Keep polling until natural voices appear (or we've already settled)
      if (!hasNatural && !settled) return;

      settled = true;

      // Sort priority: 1) en-US Natural/Online, 2) en-US other, 3) other Natural/Online, 4) rest
      const sorted = [...voices].sort((a, b) => {
        const aEnUS = a.lang === 'en-US';
        const bEnUS = b.lang === 'en-US';
        const aIsNatural = a.name.toLowerCase().includes('natural') || a.name.toLowerCase().includes('online');
        const bIsNatural = b.name.toLowerCase().includes('natural') || b.name.toLowerCase().includes('online');

        const score = (enUS: boolean, natural: boolean) =>
          (enUS ? 2 : 0) + (natural ? 1 : 0);

        return score(bEnUS, bIsNatural) - score(aEnUS, aIsNatural);
      });

      setAvailableVoices(sorted);

      // Restore saved voice, else pick best en-US natural voice.
      setSelectedVoice((prev) => {
        const savedUri = savedTtsVoiceUri;
        if (savedUri) {
          const saved = sorted.find((v) => v.voiceURI === savedUri);
          if (saved) return saved;
        }
        if (prev) return prev;
        // Prefer en-US Natural first, then any en-US, then any Natural
        const enUsNatural = sorted.find(
          (v) => v.lang === 'en-US' && (v.name.toLowerCase().includes('natural') || v.name.toLowerCase().includes('online'))
        );
        return enUsNatural ?? sorted[0];
      });

      // Stop polling once settled
      if (pollInterval) {
        window.clearInterval(pollInterval);
        pollInterval = null;
      }
    };

    window.speechSynthesis.onvoiceschanged = loadVoices;
    loadVoices();

    // Poll every 250ms for up to 5s in case Edge loads neural voices slowly
    pollInterval = window.setInterval(loadVoices, 250);
    const stopPoll = window.setTimeout(() => {
      if (!settled) {
        settled = true;
        loadVoices(); // Final attempt with whatever is available
      }
      if (pollInterval) {
        window.clearInterval(pollInterval);
        pollInterval = null;
      }
    }, 5000);

    return () => {
      if (pollInterval) window.clearInterval(pollInterval);
      window.clearTimeout(stopPoll);
    };
  }, [savedTtsVoiceUri]);

  // Reliability path: if voice mode is on and input text changes, auto-send after silence window.
  useEffect(() => {
    if (!voiceModeEnabled || isStreaming) return;

    const candidateText = (inputTextRef.current || voiceTranscriptBufferRef.current).trim();
    if (!candidateText) return;

    if (inputDebounceTimerRef.current) {
      window.clearTimeout(inputDebounceTimerRef.current);
    }

    inputDebounceTimerRef.current = window.setTimeout(() => {
      void handleSendFromVoiceRef.current();
    }, VOICE_SILENCE_MS);

    return () => {
      if (inputDebounceTimerRef.current) {
        window.clearTimeout(inputDebounceTimerRef.current);
      }
    };
  }, [inputText, voiceModeEnabled, isStreaming]);

  useEffect(() => {
    inputTextRef.current = inputText;
  }, [inputText]);

  useEffect(() => {
    filesRef.current = files;
  }, [files]);

  useEffect(() => {
    const SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;
    const backendSpeechSupported = typeof navigator.mediaDevices?.getUserMedia === 'function' && 'MediaRecorder' in window;
    useBackendSpeechRef.current = isVsCodeWebview() || !SpeechRecognitionCtor;

    if (useBackendSpeechRef.current) {
      setSpeechSupported(backendSpeechSupported);
      return;
    }

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
      // Ignore results when voice mode is off
      if (!voiceModeEnabledRef.current) return;

      // Only append finalized results to avoid interim overlap duplicates.
      let transcriptChunk = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        if (event.results[i].isFinal) {
          transcriptChunk += event.results[i][0].transcript;
        }
      }

      const normalized = transcriptChunk.trim();
      if (!normalized) return;
      if (normalized === lastRecognitionChunkRef.current) return;
      lastRecognitionChunkRef.current = normalized;

      pendingAutoSendRef.current = true;

      setInputText((prev) => {
        const prevTrimmed = prev.trim();

        // If this chunk already exists at the end, skip appending.
        if (prevTrimmed.endsWith(normalized)) {
          return prev;
        }

        // If this chunk contains the current text (replacement-style finalization), replace.
        if (prevTrimmed && normalized.startsWith(prevTrimmed)) {
          return normalized;
        }

        if (!prevTrimmed) return normalized;
        const needsSpace = prev.endsWith(' ') ? '' : ' ';
        return `${prev}${needsSpace}${normalized}`;
      });

      voiceTranscriptBufferRef.current = inputTextRef.current.trim()
        ? `${inputTextRef.current.trim()} ${normalized}`.trim()
        : normalized;

      if (silenceTimerRef.current) window.clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = window.setTimeout(() => {
        void handleSendFromVoice();
      }, VOICE_SILENCE_MS);
    };

    recognition.onerror = (e: unknown) => {
      const err = (e as Record<string, string>) ?? {};
      setIsListening(false);
      // 'no-speech' and 'aborted' are normal — restart if still in voice mode
      if (!voiceModeEnabledRef.current) return;
      if (err?.error === 'no-speech' || err?.error === 'aborted') {
        window.setTimeout(() => {
          if (!voiceModeEnabledRef.current || isStreamingRef.current || ttsSpeakingRef.current) return;
          try { recognition.start(); setIsListening(true); } catch { /* ignore */ }
        }, 300);
      }
    };

    recognition.onend = () => {
      setIsListening(false);
      if (!voiceModeEnabledRef.current) return;

      // If text is waiting, send it
      if (pendingAutoSendRef.current && !isStreamingRef.current) {
        void handleSendFromVoiceRef.current();
        return;
      }

      // Restart listening after a short delay to avoid tight loops
      if (!isStreamingRef.current && !ttsSpeakingRef.current) {
        window.setTimeout(() => {
          if (!voiceModeEnabledRef.current || isStreamingRef.current || ttsSpeakingRef.current) return;
          try {
            lastRecognitionChunkRef.current = '';
            recognition.start();
            setIsListening(true);
          } catch { /* ignore */ }
        }, 300);
      }
    };

    recognitionRef.current = recognition;

    return () => {
      if (silenceTimerRef.current) window.clearTimeout(silenceTimerRef.current);
      if (inputDebounceTimerRef.current) window.clearTimeout(inputDebounceTimerRef.current);
      try { recognition.stop(); } catch { /* ignore */ }
      recognitionRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Created ONCE on mount — uses refs to avoid stale closures

  const sendCurrentInput = async () => {
    const currentInput = inputText || inputTextRef.current;
    const currentFiles = files.length > 0 ? files : filesRef.current;

    if (!currentInput.trim() && currentFiles.length === 0) return false;

    rememberPrompt(currentInput);

    if (chatTargetMode === 'model') {
      if (!selectedDirectModel) return false;

      const previousMessages = useAppStore
        .getState()
        .chatMessages
        .filter((m: any) => m.role === 'user' || m.role === 'assistant')
        .filter((m: any) => typeof m.content === 'string' && m.content.trim().length > 0)
        .map((m: any) => ({ role: m.role, content: m.content }));

      const userMessage = {
        id: `msg-${Date.now()}`,
        role: 'user',
        content: currentInput,
        attachments: buildAttachmentPreviews(currentFiles),
      };
      const assistantMessageId = `msg-${Date.now()}-assistant`;

      // Detect images from actual data URL content instead of relying only on file.type.
      const fileDataReads = await Promise.allSettled(currentFiles.map((file) => optimizeImageForVision(file)));
      const fileDataUrls = fileDataReads.map((result) =>
        result.status === 'fulfilled' && /^data:image\//i.test(result.value) ? result.value : null
      );
      const imageDataUrls = fileDataUrls.filter((value): value is string => typeof value === 'string');

      console.log(`[DEBUG Frontend] Read ${currentFiles.length} selected files, got ${imageDataUrls.length} valid image data URLs`);
      imageDataUrls.forEach((url, i) => {
        const mimeType = url.split(',')[0].split(':')[1].split(';')[0];
        console.log(`[DEBUG Frontend] Image ${i}: mime=${mimeType}, totalLen=${url.length}, base64Len=${url.split(',')[1]?.length || 0}, first100=${url.substring(0, 100)}`);
      });

      if (currentFiles.length > 0 && imageDataUrls.length === 0) {
        console.warn('[DEBUG Frontend] Files were attached, but none could be converted to data:image URLs for model input.');
      }

      // Update attachment URLs to use data URLs (persists after files are cleared)
      userMessage.attachments = userMessage.attachments.map((att: any, i: number) => ({
        ...att,
        url: att.isImage && fileDataUrls[i] ? fileDataUrls[i] : att.url,
      }));

      useAppStore.setState((state: any) => ({
        chatMessages: [
          ...state.chatMessages,
          userMessage,
          {
            id: assistantMessageId,
            role: 'assistant',
            content: '',
            streaming: true,
            name: selectedDirectModel,
          },
        ],
      }));

      // Clear composer immediately so Enter behaves like normal chat.
      setInputText('');
      setFiles([]);
      inputTextRef.current = '';
      filesRef.current = [];
      if (fileInputRef.current) fileInputRef.current.value = '';
      voiceTranscriptBufferRef.current = '';

      directModelAbortControllerRef.current?.abort();
      directModelAbortControllerRef.current = new AbortController();
      useAppStore.getState().clearDebugEvents();
      useAppStore.setState({ isStreaming: true });

      try {
        console.log('[DEBUG] Starting API call to streamDirectModelChat');
        console.log('[DEBUG] Model:', selectedDirectModel);
        console.log('[DEBUG] Previous messages:', previousMessages.length);
        console.log('[DEBUG] Image data URLs:', imageDataUrls.length);
        
        let assistantContent = '';
        let assistantThinking = '';
        let chunkCount = 0;
        const allowPaint = () => new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
        const requestMessages = imageDataUrls.length > 0
          ? [{ role: 'user' as const, content: currentInput }]
          : [...previousMessages, { role: 'user' as const, content: currentInput }];

        for await (const chunk of apiClient.streamDirectModelChat(
          selectedDirectModel,
          requestMessages,
          directModelAbortControllerRef.current.signal,
          imageDataUrls,
          webSearchMode !== 'off' && webSearchProvider !== null,
          webSearchProvider ?? undefined,
          webSearchMode === 'off' ? undefined : webSearchMode,
        )) {
          chunkCount++;
          if (chunk.type === 'tool_event') {
            const event = chunk.event as any;
            useAppStore.getState().addDebugEvent(event);
            const toolName =
              event.data?.name ||
              event.function_call?.name ||
              event.name ||
              'unknown_tool';
            const fc = event.function_call || event.data || {};
            const parts: string[] = [];
            if (fc.arguments) {
              parts.push(`Arguments:\n${typeof fc.arguments === 'string' ? fc.arguments : JSON.stringify(fc.arguments, null, 2)}`);
            }
            if (fc.result) {
              parts.push(`Result:\n${typeof fc.result === 'string' ? fc.result : JSON.stringify(fc.result, null, 2)}`);
            }
            const resultText = typeof fc.result === 'string' ? fc.result : JSON.stringify(fc.result ?? '');
            const toolFailed = fc.status === 'failed' || /^WEB_SEARCH_FAILED:/i.test(resultText.trim());
            const isWebTool = toolName === 'web_search' || toolName === 'web_fetch';
            const detail = parts.length ? parts.join('\n\n') : 'No tool details returned.';

            const toolMessage = {
              id: `tool-${Date.now()}-${Math.random()}`,
              role: 'assistant',
              type: 'tool_event',
              content: '',
              toolCall: {
                label: `Tool call ${toolFailed ? 'failed' : 'completed'}: ${toolName}`,
                detail,
                sources: isWebTool ? extractWebSources(detail) : [],
                isWebTool,
              },
            };
            useAppStore.setState((state: any) => ({ chatMessages: [...state.chatMessages, toolMessage] }));
            await allowPaint();
            continue;
          }
          if (chunk.type === 'thinking') {
            assistantThinking += chunk.delta;
          } else {
            assistantContent += chunk.delta;
          }
          if (chunkCount <= 3) console.log(`[DEBUG] Chunk ${chunkCount}:`, chunk.delta.substring(0, 50));
          useAppStore.setState((state: any) => ({
            chatMessages: state.chatMessages.map((msg: any) =>
              msg.id === assistantMessageId
                ? { ...msg, content: assistantContent, thinking: assistantThinking }
                : msg
            ),
          }));
          await allowPaint();
        }
        console.log('[DEBUG] Streaming complete, total chunks:', chunkCount);

        useAppStore.setState((state: any) => ({
          chatMessages: state.chatMessages.map((msg: any) =>
            msg.id === assistantMessageId
              ? { ...msg, streaming: false }
              : msg
          ),
        }));
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          useAppStore.setState((state: any) => ({
            chatMessages: state.chatMessages.map((msg: any) =>
              msg.id === assistantMessageId
                ? { ...msg, streaming: false, content: msg.content || '' }
                : msg
            ),
          }));
          return true;
        }
        console.error('[DEBUG] API Error:', error);
        const errorMsg = error instanceof Error ? error.message : String(error);
        console.error('[DEBUG] Error details:', errorMsg);
        useAppStore.setState((state: any) => ({
          chatMessages: [
            ...state.chatMessages,
            {
              id: `msg-${Date.now()}-error`,
              role: 'assistant',
              content: `Error: ${errorMsg}`,
              name: selectedDirectModel || 'Model',
            },
          ],
        }));
      } finally {
        directModelAbortControllerRef.current = null;
        useAppStore.setState({ isStreaming: false });
      }
      return true;
    }

    if (selectedAgents && selectedAgents.length > 1) {
      sendMessageToMultipleAgents(currentInput, currentFiles);
      setInputText('');
      setFiles([]);
      inputTextRef.current = '';
      filesRef.current = [];
      if (fileInputRef.current) fileInputRef.current.value = '';
      voiceTranscriptBufferRef.current = '';
      return true;
    }

    if (!currentConversation) {
      await createConversation();
    }

    sendMessage(currentInput, currentFiles);
    setInputText('');
    setFiles([]);
    inputTextRef.current = '';
    filesRef.current = [];
    if (fileInputRef.current) fileInputRef.current.value = '';
    voiceTranscriptBufferRef.current = '';
    return true;
  };
  sendCurrentInputRef.current = sendCurrentInput;

  const handleSend = async () => {
    if (isStreaming) {
      const queuedText = inputTextRef.current.trim();
      const queuedFiles = [...filesRef.current];
      if (!queuedText && queuedFiles.length === 0) return;

      setQueuedMessages((prev) => [...prev, { text: queuedText, files: queuedFiles }]);
      setInputText('');
      setFiles([]);
      inputTextRef.current = '';
      filesRef.current = [];
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }

    await sendCurrentInput();
  };

  const handleStopResponse = () => {
    // Stop speech immediately.
    stopSpeakingCurrentReply();
    directModelAbortControllerRef.current?.abort();
    directModelAbortControllerRef.current = null;
    // Stop backend generation/stream.
    stopCurrentResponse();
  };

  const handleNewChat = () => {
    stopSpeakingCurrentReply();
    directModelAbortControllerRef.current?.abort();
    directModelAbortControllerRef.current = null;
    stopCurrentResponse();
    setQueuedMessages([]);
    setInputText('');
    setFiles([]);
    inputTextRef.current = '';
    filesRef.current = [];
    voiceTranscriptBufferRef.current = '';
    pendingAutoSendRef.current = false;
    lastRecognitionChunkRef.current = '';
    if (fileInputRef.current) fileInputRef.current.value = '';
    startNewChat();
  };

  const removeQueuedMessageAt = (index: number) => {
    setQueuedMessages((prev) => prev.filter((_, i) => i !== index));
  };

  const moveQueuedMessageUp = (index: number) => {
    if (index <= 0) return;
    setQueuedMessages((prev) => {
      const next = [...prev];
      const temp = next[index - 1];
      next[index - 1] = next[index];
      next[index] = temp;
      return next;
    });
  };

  const moveQueuedMessageDown = (index: number) => {
    setQueuedMessages((prev) => {
      if (index >= prev.length - 1) return prev;
      const next = [...prev];
      const temp = next[index + 1];
      next[index + 1] = next[index];
      next[index] = temp;
      return next;
    });
  };

  const handleSendFromVoice = async () => {
    if (!voiceModeEnabledRef.current || isStreamingRef.current) return;

    // Use buffered transcript as source of truth for auto-send timing.
    if (!inputTextRef.current.trim() && voiceTranscriptBufferRef.current.trim()) {
      const buffered = voiceTranscriptBufferRef.current.trim();
      inputTextRef.current = buffered;
      setInputText(buffered);
    }

    const sent = await sendCurrentInput();
    if (!sent) return;

    pendingAutoSendRef.current = false;
    lastRecognitionChunkRef.current = '';
    // Recognition will auto-restart via onend after it naturally stops
  };
  handleSendFromVoiceRef.current = handleSendFromVoice;

  const appendVoiceTranscript = (transcript: string) => {
    const normalized = transcript.trim();
    if (!normalized) return;

    pendingAutoSendRef.current = true;
    setInputText((prev) => {
      const prevTrimmed = prev.trim();
      if (!prevTrimmed) return normalized;
      if (prevTrimmed.endsWith(normalized)) return prev;
      return `${prev}${prev.endsWith(' ') ? '' : ' '}${normalized}`;
    });
    voiceTranscriptBufferRef.current = inputTextRef.current.trim()
      ? `${inputTextRef.current.trim()} ${normalized}`.trim()
      : normalized;
    inputTextRef.current = voiceTranscriptBufferRef.current;
  };

  const stopBackendRecording = () => {
    const recorder = mediaRecorderRef.current;
    if (!recorder) return;
    setSpeechStatus('Stopping recording...');
    if (recorder.state !== 'inactive') recorder.stop();
  };

  const startBackendRecording = async () => {
    if (!navigator.mediaDevices?.getUserMedia || !('MediaRecorder' in window)) {
      setSpeechStatus('Microphone recording is not available in this VS Code webview.');
      setSpeechSupported(false);
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
        mediaStreamRef.current = null;
        mediaRecorderRef.current = null;
        recordedChunksRef.current = [];
        setVoiceModeEnabled(false);
        setIsListening(false);
        setSpeechStatus('Recording failed. Check microphone permission and try again.');
      };

      recorder.onstop = async () => {
        const chunks = [...recordedChunksRef.current];
        const type = recorder.mimeType || mimeType || 'audio/webm';
        mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
        mediaStreamRef.current = null;
        mediaRecorderRef.current = null;
        recordedChunksRef.current = [];
        setIsListening(false);

        if (chunks.length === 0) {
          setVoiceModeEnabled(false);
          setSpeechStatus('No audio was recorded. Try again and speak after the mic turns red.');
          return;
        }

        try {
          setSpeechStatus('Transcribing with Faster Whisper...');
          const result = await apiClient.transcribeSpeech(new Blob(chunks, { type }));
          if (!voiceModeEnabledRef.current) return;
          if (result.text.trim()) {
            appendVoiceTranscript(result.text);
            setSpeechStatus(`Transcribed with ${result.engine}. Sending...`);
            await handleSendFromVoiceRef.current();
          } else {
            setSpeechStatus('No speech was detected. Try again closer to the mic.');
          }
        } catch (error) {
          setSpeechStatus(`Transcription failed: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
          setVoiceModeEnabled(false);
        }
      };

      recorder.start(1000);
      setVoiceModeEnabled(true);
      setIsListening(true);
      setSpeechStatus('Recording for Faster Whisper... click the mic again to stop.');
    } catch (error) {
      setVoiceModeEnabled(false);
      setIsListening(false);
      setSpeechStatus(`Microphone permission issue: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
      return;
    }

    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') {
      setHistoryIndex(null);
      return;
    }

    if (promptHistory.length === 0) {
      return;
    }

    const target = e.currentTarget as HTMLTextAreaElement;
    const value = target.value;
    const selectionStart = target.selectionStart ?? value.length;
    const selectionEnd = target.selectionEnd ?? value.length;

    const beforeCursor = value.slice(0, selectionStart);
    const afterCursor = value.slice(selectionEnd);
    const isAtFirstLine = !beforeCursor.includes('\n');
    const isAtLastLine = !afterCursor.includes('\n');

    if (e.key === 'ArrowUp' && !isAtFirstLine) {
      return;
    }

    if (e.key === 'ArrowDown' && !isAtLastLine) {
      return;
    }

    e.preventDefault();

    if (historyIndex === null) {
      historyDraftRef.current = value;
    }

    if (e.key === 'ArrowUp') {
      const nextIndex = historyIndex === null
        ? promptHistory.length - 1
        : Math.max(0, historyIndex - 1);
      const nextValue = promptHistory[nextIndex] ?? '';
      setHistoryIndex(nextIndex);
      setInputText(nextValue);
      inputTextRef.current = nextValue;
      window.setTimeout(() => {
        textareaRef.current?.setSelectionRange(nextValue.length, nextValue.length);
      }, 0);
      return;
    }

    const nextIndex = historyIndex === null ? null : historyIndex + 1;
    if (nextIndex === null || nextIndex >= promptHistory.length) {
      const draft = historyDraftRef.current;
      setHistoryIndex(null);
      setInputText(draft);
      inputTextRef.current = draft;
      window.setTimeout(() => {
        textareaRef.current?.setSelectionRange(draft.length, draft.length);
      }, 0);
      return;
    }

    const nextValue = promptHistory[nextIndex] ?? '';
    setHistoryIndex(nextIndex);
    setInputText(nextValue);
    inputTextRef.current = nextValue;
    window.setTimeout(() => {
      textareaRef.current?.setSelectionRange(nextValue.length, nextValue.length);
    }, 0);
  };

  const toggleSpeechInput = () => {
    if (!speechSupported) return;

    if (useBackendSpeechRef.current) {
      if (voiceModeEnabled || mediaRecorderRef.current) {
        stopBackendRecording();
        return;
      }
      void startBackendRecording();
      return;
    }

    if (!recognitionRef.current) return;

    if (voiceModeEnabled) {
      setVoiceModeEnabled(false);
      if (silenceTimerRef.current) {
        window.clearTimeout(silenceTimerRef.current);
      }
      if (inputDebounceTimerRef.current) {
        window.clearTimeout(inputDebounceTimerRef.current);
      }
      pendingAutoSendRef.current = false;
      voiceTranscriptBufferRef.current = '';
      lastRecognitionChunkRef.current = '';
      stopTTS();
      recognitionRef.current.stop();
      stopBackendRecording();
      setIsListening(false);
      return;
    }

    try {
      // Mark current assistant messages as already spoken, so voice mode reads only new responses.
      const existingAssistantIds = chatMessages
        .filter((m: any) => m.role !== 'user' && m.id)
        .map((m: any) => String(m.id));
      spokenMessageIdsRef.current = new Set(existingAssistantIds);

      setVoiceModeEnabled(true);
      setSpeechStatus('Listening...');
      recognitionRef.current.start();
      setIsListening(true);
    } catch (error) {
      console.error('Failed to start speech recognition:', error);
      setVoiceModeEnabled(false);
      setIsListening(false);
      setSpeechStatus(`Failed to start speech recognition: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  useEffect(() => {
    if (!voiceModeEnabled || isStreaming) return;

    const unspoken = chatMessages.filter((message: any) => {
      const id = String(message.id || '');
      return (
        message.role !== 'user' &&
        id &&
        !message.streaming &&
        typeof message.content === 'string' &&
        message.content.trim().length > 0 &&
        !spokenMessageIdsRef.current.has(id)
      );
    });

    for (const message of unspoken) {
      const id = String(message.id);
      spokenMessageIdsRef.current.add(id);
      const alreadySpokenLength = streamingSpokenOffsetsRef.current[id] ?? 0;
      const fullText = String(message.content);
      const remainingText = fullText.slice(alreadySpokenLength).trim();
      if (remainingText) {
        speakTextRef.current(id, remainingText);
      }
      streamingSpokenOffsetsRef.current[id] = fullText.length;
    }
  }, [chatMessages, voiceModeEnabled, isStreaming]);

  // Send next queued message once streaming completes.
  useEffect(() => {
    if (isStreaming) return;
    if (queuedMessages.length === 0) return;

    const [next, ...rest] = queuedMessages;
    setQueuedMessages(rest);

    // Push queued input into refs/state then send through the normal flow.
    inputTextRef.current = next.text;
    filesRef.current = next.files;
    setInputText(next.text);
    setFiles(next.files);

    window.setTimeout(() => {
      void sendCurrentInputRef.current();
    }, 0);
  }, [isStreaming, queuedMessages]);

  useEffect(() => {
    if (!voiceModeEnabled) return;

    for (const message of chatMessages as any[]) {
      if (message.role === 'user' || !message.streaming || typeof message.content !== 'string' || !message.id) {
        continue;
      }

      const id = String(message.id);
      if (suppressedTtsMessageIdsRef.current.has(id)) {
        continue;
      }

      const content = String(message.content);
      const spokenOffset = streamingSpokenOffsetsRef.current[id] ?? 0;
      const unsaid = content.slice(spokenOffset);
      const speakable = extractSpeakablePrefix(unsaid);

      if (!speakable) {
        continue;
      }

      speakTextRef.current(id, speakable);
      streamingSpokenOffsetsRef.current[id] = spokenOffset + speakable.length;
    }
  }, [chatMessages, voiceModeEnabled]);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      const nextFiles = Array.from(e.target.files);
      console.log(`[DEBUG] handleFileSelect: Selected ${nextFiles.length} files`, nextFiles.map(f => ({ name: f.name, size: f.size, type: f.type })));
      filesRef.current = nextFiles;
      setFiles(nextFiles);
      console.log(`[DEBUG] handleFileSelect: files state updated, files.length=${nextFiles.length}`);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer.files) {
      const nextFiles = Array.from(e.dataTransfer.files);
      filesRef.current = nextFiles;
      setFiles(nextFiles);
    }
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    const fileItems = Array.from(items).filter(item => item.kind === 'file');
    if (fileItems.length > 0) {
      const pastedFiles = fileItems.map(item => item.getAsFile()).filter(Boolean) as File[];
      const nextFiles = [...filesRef.current, ...pastedFiles];
      filesRef.current = nextFiles;
      setFiles(nextFiles);
    }
  };

  const removeFile = (index: number) => {
    const nextFiles = filesRef.current.filter((_, i) => i !== index);
    filesRef.current = nextFiles;
    setFiles(nextFiles);
  };

  const renderFilePreview = (file: File, index: number) => {
    const isImage = file.type.startsWith('image/');
    console.log(`[DEBUG] renderFilePreview: Rendering file ${index}: ${file.name} (${file.type}, size=${file.size})`);
    return (
      <div key={index} className="relative inline-block mr-2 mb-2">
        <Card className="p-2 pr-8">
          <div className="flex items-center gap-2">
            {isImage ? <ImageIcon className="h-4 w-4" /> : <FileText className="h-4 w-4" />}
            <span className="text-sm truncate max-w-[150px]">{file.name}</span>
          </div>
        </Card>
        <Button
          variant="ghost"
          size="sm"
          className="absolute -top-2 -right-2 h-6 w-6 p-0 rounded-full"
          onClick={() => removeFile(index)}
        >
          ×
        </Button>
      </div>
    );
  };

  const renderMessage = (message: any, index: number) => {
    const isUser = message.role === 'user';
    const isToolEvent = message?.type === 'tool_event' && message?.toolCall;
    const thinkingText = typeof message.thinking === 'string' ? message.thinking.trim() : '';
    const singleSelectedAgentName = selectedAgent && selectedAgent.type === 'agent' ? selectedAgent.name : undefined;
    const senderName = isUser
      ? 'Me'
      : message.name ||
        message.agentName ||
        (chatTargetMode === 'model' ? selectedDirectModel : undefined) ||
        (selectedAgents.length === 1 ? selectedAgents[0]?.name : undefined) ||
        singleSelectedAgentName ||
        'Assistant';
      const isManagerMessage = senderName === 'Manager';

    if (isToolEvent) {
      const isWebTool = Boolean(message.toolCall.isWebTool);
      const toolFailed = Boolean(message.toolCall.failed);
      const sources = Array.isArray(message.toolCall.sources) ? message.toolCall.sources : [];
      const toneClasses = toolFailed
        ? 'border-destructive/40 bg-destructive/10 text-destructive dark:border-destructive/50 dark:bg-destructive/15 dark:text-red-200'
        : isWebTool
          ? 'border-blue-300/50 bg-blue-50/60 text-blue-950 dark:border-blue-900/50 dark:bg-blue-950/25 dark:text-blue-100'
          : 'border-amber-300/40 bg-amber-50/50 text-amber-900 dark:border-amber-900/40 dark:bg-amber-900/20 dark:text-amber-100';
      const hoverClasses = toolFailed
        ? 'hover:bg-destructive/15 dark:hover:bg-destructive/20'
        : isWebTool
          ? 'hover:bg-blue-100/60 dark:hover:bg-blue-900/40'
          : 'hover:bg-amber-100/50 dark:hover:bg-amber-900/40';
      const badgeClasses = toolFailed
        ? 'bg-destructive text-destructive-foreground'
        : isWebTool
          ? 'bg-blue-500 text-white dark:bg-blue-300 dark:text-blue-950'
          : 'bg-amber-400 text-amber-950 dark:bg-amber-300 dark:text-amber-950';
      const borderClasses = toolFailed
        ? 'border-destructive/30 dark:border-destructive/40'
        : isWebTool
          ? 'border-blue-300/30 dark:border-blue-900/30'
          : 'border-amber-300/30 dark:border-amber-900/30';
      return (
        <div key={message.id || index} className="mb-4 flex justify-start">
          <div className={`max-w-[90%] rounded-xl border text-sm overflow-hidden ${toneClasses}`}>
            <details open={toolFailed || undefined}>
              <summary className={`list-none cursor-pointer px-3 py-2 transition-colors ${hoverClasses}`}>
                <div className="flex items-center gap-2">
                  {isWebTool ? <Globe2 className="h-3.5 w-3.5 shrink-0" /> : <Wrench className="h-3.5 w-3.5 shrink-0" />}
                  <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide shadow-sm ${badgeClasses}`}>
                    {toolFailed ? 'Tool Failed' : isWebTool ? 'Web Source' : 'Tool'}
                  </span>
                  <span className="flex-1">{message.toolCall.label}</span>
                  <span className="text-xs opacity-60">{toolFailed ? 'failure output shown' : 'click to view'}</span>
                </div>
              </summary>
              {sources.length > 0 && (
                <div className="grid gap-2 border-t border-blue-300/30 px-3 py-2 dark:border-blue-900/30 sm:grid-cols-2">
                  {sources.map((source: any) => (
                    <a key={source.url} href={source.url} target="_blank" rel="noreferrer" className="min-w-0 rounded-lg border bg-background/70 p-2 transition-colors hover:bg-background">
                      <div className="truncate text-xs font-semibold">{source.title}</div>
                      <div className="truncate text-[11px] opacity-70">{source.url}</div>
                      {source.snippet && <div className="mt-1 line-clamp-2 text-[11px] opacity-80">{source.snippet}</div>}
                    </a>
                  ))}
                </div>
              )}
              <div className={`${borderClasses} border-t px-3 py-2`}>
                <pre className="whitespace-pre-wrap break-words text-xs font-mono opacity-90 max-h-64 overflow-auto">{message.toolCall.detail}</pre>
              </div>
            </details>
          </div>
        </div>
      );
    }

    return (
      <div
        key={message.id || index}
        className={`mb-6 flex ${isUser ? 'justify-end' : 'justify-start'}`}
      >
        <div className={`max-w-[80%] ${isUser ? 'bg-primary text-primary-foreground shadow-lg shadow-primary/20' : 'bg-accent/50 backdrop-blur-sm border border-accent'} rounded-2xl p-4`}>
          <div className={`flex items-center mb-2 ${isUser ? 'justify-end' : ''}`}>
            <span className="text-sm font-semibold">{senderName}</span>
          </div>
          {thinkingText.length > 0 && (
            // Manager always shows thinking directly (no expand needed)
            isManagerMessage ? (
              <div className="mb-3 rounded-lg border bg-background/50 px-3 py-2 text-sm whitespace-pre-wrap break-words text-muted-foreground">
                {message.thinking}
              </div>
            ) : message.streaming ? (
              <div className="mb-3 rounded-lg border bg-background/50">
                <div className="flex items-center gap-2 px-3 py-2 text-xs font-medium text-muted-foreground">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  <span>Thinking...</span>
                </div>
                <div className="border-t px-3 py-2 text-sm whitespace-pre-wrap break-words text-muted-foreground">
                  {message.thinking}
                </div>
              </div>
            ) : (
              <details className="mb-3 rounded-lg border bg-background/50">
                <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-muted-foreground hover:text-foreground">
                  Thinking
                </summary>
                <div className="border-t px-3 py-2 text-sm whitespace-pre-wrap break-words text-muted-foreground">
                  {message.thinking}
                </div>
              </details>
            )
          )}
          {/* Message content */}
          {message.content && (
            <div className="whitespace-pre-wrap break-words leading-relaxed">
              {message.content}
            </div>
          )}

          {message.action && (
            <button
              type="button"
              className="mt-3 rounded-md border border-primary/30 bg-primary/10 px-3 py-1.5 text-xs font-medium text-primary transition-colors hover:bg-primary/15"
              onClick={() => window.dispatchEvent(new CustomEvent(message.action.event, { detail: message.action.detail }))}
            >
              {message.action.label}
            </button>
          )}

          {Array.isArray(message.attachments) && message.attachments.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2">
                {message.attachments.map((attachment: any, attachmentIndex: number) => (
                <a
                  key={`${message.id || index}-att-${attachmentIndex}`}
                  href={attachment.url}
                  target="_blank"
                  rel="noreferrer"
                  className="block"
                  title={attachment.name}
                >
                  {attachment.isImage ? (
                    <img
                      src={attachment.url}
                      alt={attachment.name}
                      className="h-24 w-24 object-cover rounded-md border"
                    />
                  ) : (
                    <div className="flex items-center gap-2 rounded-md border px-2 py-1 text-xs bg-background/60">
                      <FileText className="h-3.5 w-3.5" />
                      <span className="max-w-[150px] truncate">{attachment.name}</span>
                    </div>
                  )}
                </a>
              ))}
            </div>
          )}
          
          {/* Streaming indicator - skip for Manager as it shows status lines */}
          {message.streaming && !thinkingText && !isManagerMessage && (
            <div className="flex items-center gap-2 mt-3 text-xs text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" />
              <span>{message.analyzingImage ? 'Analyzing image...' : `${senderName} is starting...`}</span>
            </div>
          )}

          {/* Usage tokens */}
          {message.usage && message.usage.prompt_tokens !== undefined && message.usage.completion_tokens !== undefined && (
            <div className="mt-3 pt-3 border-t border-current/10 text-xs opacity-60 flex flex-wrap gap-3">
              <span className="font-medium">Total: {message.usage.prompt_tokens + message.usage.completion_tokens}</span>
              <span>•</span>
              <span>Prompt: {message.usage.prompt_tokens}</span>
              <span>•</span>
              <span>Completion: {message.usage.completion_tokens}</span>
            </div>
          )}
        </div>
      </div>
    );
  };

  const [expandedToolIds, setExpandedToolIds] = useState<Set<string>>(new Set());

  const toggleToolExpand = (id: string) => {
    setExpandedToolIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toolActivity = useMemo(() => {
    const items: Array<{ id: string; label: string; detail?: string }> = [];

    for (const event of debugEvents as any[]) {
      if (!event || !event.type) continue;

      if (event.type === 'response.output_item.added' && event.item?.type === 'function_call') {
        const args = event.item?.arguments;
        items.push({
          id: `${event.type}-${event.item?.id || event.item?.call_id || items.length}`,
          label: `Tool call started: ${event.item?.name || 'unknown_tool'}`,
          detail: args ? `Arguments:\n${typeof args === 'string' ? args : JSON.stringify(args, null, 2)}` : undefined,
        });
        continue;
      }

      if (event.type === 'response.output_item.done' && event.item?.type === 'function_call') {
        const args = event.item?.arguments;
        const output = event.item?.output;
        const parts: string[] = [];
        if (args) parts.push(`Arguments:\n${typeof args === 'string' ? args : JSON.stringify(args, null, 2)}`);
        if (output) parts.push(`Result:\n${typeof output === 'string' ? output : JSON.stringify(output, null, 2)}`);
        items.push({
          id: `${event.type}-${event.item?.id || event.item?.call_id || items.length}`,
          label: `Tool call completed: ${event.item?.name || 'unknown_tool'}`,
          detail: parts.length ? parts.join('\n\n') : undefined,
        });
        continue;
      }

      if (event.type === 'response.function_call.complete') {
        const toolName =
          event.data?.name ||
          event.function_call?.name ||
          event.name ||
          'unknown_tool';
        const fc = event.function_call || event.data || {};
        const parts: string[] = [];
        if (fc.arguments) parts.push(`Arguments:\n${typeof fc.arguments === 'string' ? fc.arguments : JSON.stringify(fc.arguments, null, 2)}`);
        if (fc.result) parts.push(`Result:\n${typeof fc.result === 'string' ? fc.result : JSON.stringify(fc.result, null, 2)}`);
        items.push({
          id: `${event.type}-${event.data?.call_id || items.length}`,
          label: `Tool call completed: ${toolName}`,
          detail: parts.length ? parts.join('\n\n') : undefined,
        });
        continue;
      }

      if (event.type === 'response.function_result.complete') {
        const output = event.output || event.result;
        items.push({
          id: `${event.type}-${event.call_id || items.length}`,
          label: `Tool result received (${event.status || 'completed'})`,
          detail: output ? `Result:\n${typeof output === 'string' ? output : JSON.stringify(output, null, 2)}` : undefined,
        });
        continue;
      }

      if (event.type === 'response.function_approval.requested') {
        items.push({
          id: `${event.type}-${event.request_id || items.length}`,
          label: `Tool approval requested: ${event.function_call?.name || 'tool'}`,
          detail: event.function_call ? JSON.stringify(event.function_call, null, 2) : undefined,
        });
        continue;
      }

      if (event.type === 'response.function_approval.responded') {
        items.push({
          id: `${event.type}-${event.request_id || items.length}`,
          label: `Tool approval ${event.approved ? 'approved' : 'rejected'}`,
        });
        continue;
      }
    }

    return items.slice(-8);
  }, [debugEvents]);

  return (
    <div className={`flex flex-col overflow-hidden ${className}`}>
      {/* Messages area */}
      <div className="flex-1 min-h-0 overflow-auto px-6 py-4" ref={scrollViewportRef} onScroll={updateStickToBottom}>
        <div className="max-w-4xl mx-auto" ref={scrollRef}>
          {chatMessages.length === 0 && (
            <div className="flex flex-col items-center justify-center min-h-[60%] text-center py-12 px-6">
              <div className="h-14 w-14 rounded-2xl bg-primary/10 flex items-center justify-center mb-5">
                <MessageSquare className="h-7 w-7 text-primary" />
              </div>
              <h3 className="text-xl font-semibold mb-2">
                {selectedAgent?.name ? `Chat with ${selectedAgent.name}` : "Start a conversation"}
              </h3>
              <p className="text-sm text-muted-foreground max-w-sm mb-8">
                {selectedAgent?.description || "Send a message to begin. Shift+Enter for a new line."}
              </p>
              <div className="grid grid-cols-2 gap-2 w-full max-w-lg">
                {[
                  "Explain what this codebase does",
                  "Write unit tests for this project",
                  "Find and fix any bugs you can see",
                  "Summarize the recent changes",
                ].map((prompt) => (
                  <button
                    key={prompt}
                    className="rounded-xl border border-border/60 bg-card hover:border-primary/40 hover:bg-accent/30 transition-colors px-4 py-3 text-left text-sm"
                    onClick={() => {
                      // Dispatch a custom event that ChatInterface listens for
                      const el = document.querySelector('textarea[placeholder*="message"]') as HTMLTextAreaElement | null;
                      if (el) {
                        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
                        nativeInputValueSetter?.call(el, prompt);
                        el.dispatchEvent(new Event('input', { bubbles: true }));
                        el.focus();
                      }
                    }}
                  >
                    {prompt}
                  </button>
                ))}
              </div>
            </div>
          )}
          {chatMessages.map((msg: any, idx: number) => renderMessage(msg, idx))}

          {toolActivity.length > 0 && !chatMessages.some((m: any) => m?.type === 'tool_event') && (
            <div className="mb-4 space-y-2">
              {toolActivity.map((activity) => {
                const isExpanded = expandedToolIds.has(activity.id);
                return (
                  <div key={activity.id} className="flex justify-start">
                    <div className="max-w-[90%] rounded-xl border border-amber-300/40 bg-amber-50/50 text-sm text-amber-900 dark:border-amber-900/40 dark:bg-amber-900/20 dark:text-amber-100 overflow-hidden">
                      <button
                        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-amber-100/50 dark:hover:bg-amber-900/40 transition-colors"
                        onClick={() => activity.detail && toggleToolExpand(activity.id)}
                        style={{ cursor: activity.detail ? 'pointer' : 'default' }}
                      >
                        <Wrench className="h-3.5 w-3.5 shrink-0" />
                        <span className="flex-1">{activity.label}</span>
                        {activity.detail && (
                          <span className="text-xs opacity-60 ml-2">{isExpanded ? '▲ hide' : '▼ details'}</span>
                        )}
                      </button>
                      {isExpanded && activity.detail && (
                        <div className="border-t border-amber-300/30 dark:border-amber-900/30 px-3 py-2">
                          <pre className="whitespace-pre-wrap break-words text-xs font-mono opacity-90 max-h-64 overflow-auto">{activity.detail}</pre>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          
          {/* Streaming indicator */}
          {isStreaming && streamingState.currentContent && (
            <div className="mb-4 flex justify-start">
              <div className="max-w-[80%] bg-accent/50 backdrop-blur-sm rounded-2xl p-4 border border-accent">
                <div className="whitespace-pre-wrap break-words">
                  {streamingState.currentContent}
                </div>
                <div className="flex items-center gap-2 mt-3 text-xs text-muted-foreground">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  <span>AI is thinking...</span>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Input area */}
      <div className="border-t bg-card/30 backdrop-blur-sm p-4 shrink-0">
        {queuedMessages.length > 0 && (
          <div className="max-w-4xl mx-auto mb-2 rounded-xl border bg-muted/30 p-2">
            <div className="text-xs text-muted-foreground mb-2">
              {queuedMessages.length} message{queuedMessages.length > 1 ? 's' : ''} queued
            </div>
            <div className="space-y-1">
              {queuedMessages.map((q, idx) => (
                <div key={`${idx}-${q.text.slice(0, 20)}`} className="flex items-center gap-2 rounded-md bg-background/70 px-2 py-1">
                  <div className="text-xs text-muted-foreground w-5 shrink-0">{idx + 1}.</div>
                  <div className="text-xs flex-1 truncate">{q.text || `${q.files.length} file${q.files.length > 1 ? 's' : ''}`}</div>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="h-6 w-6"
                    onClick={() => moveQueuedMessageUp(idx)}
                    disabled={idx === 0}
                    title="Move up"
                  >
                    <ChevronUp className="h-3 w-3" />
                  </Button>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="h-6 w-6"
                    onClick={() => moveQueuedMessageDown(idx)}
                    disabled={idx === queuedMessages.length - 1}
                    title="Move down"
                  >
                    <ChevronDown className="h-3 w-3" />
                  </Button>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="h-6 w-6 text-destructive"
                    onClick={() => removeQueuedMessageAt(idx)}
                    title="Remove"
                  >
                    <X className="h-3 w-3" />
                  </Button>
                </div>
              ))}
            </div>
          </div>
        )}
        {/* File previews */}
        {files.length > 0 && (
          <div className="mb-2">
            {files.map((file, idx) => renderFilePreview(file, idx))}
          </div>
        )}

        {/* Input box */}
        <div className="max-w-4xl mx-auto w-full">
          <div
            className="flex gap-3 items-center p-3 rounded-2xl border bg-background/50 backdrop-blur-sm shadow-lg"
            onDrop={handleDrop}
            onDragOver={(e) => e.preventDefault()}
          >
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={handleFileSelect}
            />
            
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={handleNewChat}
              className="shrink-0 hover:bg-accent h-10 w-10"
              title="New chat"
            >
              <MessageSquarePlus className="h-4 w-4" />
            </Button>

            <Button
              variant="ghost"
              size="icon"
              onClick={() => fileInputRef.current?.click()}
              className="shrink-0 hover:bg-accent h-10 w-10"
            >
              <Paperclip className="h-4 w-4" />
            </Button>

            {chatTargetMode === 'model' && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant={webSearchMode !== 'off' ? 'default' : 'ghost'}
                    size="sm"
                    className="h-10 shrink-0 gap-2 px-3 hover:bg-accent"
                    title={`${getWebModeLabel()}${webSearchMode !== 'off' && webSearchProvider ? ` via ${webSearchProvider === 'duckduckgo' ? 'DuckDuckGo' : 'Ollama'}` : ''}`}
                  >
                    <Globe2 className="h-4 w-4" />
                    <span className="hidden text-xs sm:inline">{getWebModeLabel()}</span>
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" side="top" className="w-64">
                  <DropdownMenuLabel>Web mode</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => { setWebSearchMode('off'); setWebSearchProvider(null); }}>
                    <Globe2 className="mr-2 h-4 w-4" />
                    Off
                    {webSearchMode === 'off' && <span className="ml-auto text-xs text-muted-foreground">Active</span>}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => { setWebSearchMode('search'); setWebSearchProvider(prev => prev || 'duckduckgo'); }}>
                    <Search className="mr-2 h-4 w-4" />
                    Search only
                    {webSearchMode === 'search' && <span className="ml-auto text-xs text-muted-foreground">Active</span>}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => { setWebSearchMode('search_fetch'); setWebSearchProvider(prev => prev || 'duckduckgo'); }}>
                    <Globe2 className="mr-2 h-4 w-4" />
                    Search + fetch
                    {webSearchMode === 'search_fetch' && <span className="ml-auto text-xs text-muted-foreground">Active</span>}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => { setWebSearchMode('deep'); setWebSearchProvider(prev => prev || 'duckduckgo'); }}>
                    <Radio className="mr-2 h-4 w-4" />
                    Deep research
                    {webSearchMode === 'deep' && <span className="ml-auto text-xs text-muted-foreground">Active</span>}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel>Provider</DropdownMenuLabel>
                  <DropdownMenuItem onClick={() => { setWebSearchProvider('duckduckgo'); if (webSearchMode === 'off') setWebSearchMode('search_fetch'); }}>
                    <Search className="mr-2 h-4 w-4" />
                    DuckDuckGo
                    {webSearchProvider === 'duckduckgo' && <span className="ml-auto text-xs text-muted-foreground">Active</span>}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => { void enableOllamaHostedWebSearch(); }}>
                    <Radio className="mr-2 h-4 w-4" />
                    Ollama hosted
                    {webSearchProvider === 'ollama' && <span className="ml-auto text-xs text-muted-foreground">Active</span>}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}

            <Textarea
              ref={textareaRef}
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              placeholder="Type a message or use mic... (Shift+Enter for new line)"
              className="flex-1 min-h-[40px] max-h-[200px] resize-none border-0 bg-transparent focus-visible:ring-0 focus-visible:ring-offset-0 py-[10px]"
            />

            {speechSupported && (
              <>
                <Button
                  onClick={toggleSpeechInput}
                  size="icon"
                  variant={voiceModeEnabled ? 'default' : 'ghost'}
                  className={`shrink-0 h-10 w-10 ${isListening ? 'ring-2 ring-red-400 ring-offset-1' : ''}`}
                  title={voiceModeEnabled ? 'Turn off voice mode' : 'Turn on voice mode'}
                >
                  {voiceModeEnabled ? (
                    <MicOff className="h-4 w-4" />
                  ) : (
                    <Mic className="h-4 w-4" />
                  )}
                </Button>

                {voiceModeEnabled && availableVoices.length > 0 && (
                  <select
                    value={selectedVoice?.voiceURI ?? ''}
                    onChange={(e) => {
                      const v = availableVoices.find((v) => v.voiceURI === e.target.value);
                      if (v) {
                        setSelectedVoice(v);
                        void setStoredString('tts-voice-uri', v.voiceURI);

                        if (window.speechSynthesis.speaking && currentTtsChunkRef.current) {
                          ttsQueueRef.current.unshift(currentTtsChunkRef.current);
                          currentTtsChunkRef.current = null;
                          ttsVoiceSwitchPendingRef.current = true;
                          ttsSpeakingRef.current = false;
                          setIsTtsSpeaking(false);
                          clearTtsKeepAlive();
                          window.speechSynthesis.cancel();
                        }
                      }
                    }}
                    className="w-52 shrink-0 h-10 px-2 py-1 text-xs bg-white dark:bg-slate-800 border border-gray-300 dark:border-slate-600 text-gray-900 dark:text-gray-100 rounded-md shadow-sm focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none cursor-pointer"
                    title="Select voice for AI responses"
                  >
                    {availableVoices.map((voice) => (
                      <option key={voice.voiceURI} value={voice.voiceURI}>
                        {voice.name}
                      </option>
                    ))}
                  </select>
                )}

                {voiceModeEnabled && isTtsSpeaking && (
                  <Button
                    onClick={stopSpeakingCurrentReply}
                    size="icon"
                    variant="destructive"
                    className="shrink-0 h-10 w-10"
                    title="Stop AI speech"
                  >
                    <Square className="h-4 w-4 fill-current" />
                  </Button>
                )}

                {speechStatus && (
                  <span className="max-w-[220px] shrink-0 truncate text-[11px] text-muted-foreground" title={speechStatus}>
                    {speechStatus}
                  </span>
                )}
              </>
            )}

            {isStreaming ? (
              <Button
                onClick={handleStopResponse}
                size="icon"
                variant="destructive"
                className="shrink-0 shadow-md h-10 w-10"
                title="Stop response"
              >
                <Square className="h-4 w-4 fill-current" />
              </Button>
            ) : (
              <Button
                onClick={handleSend}
                disabled={!inputText.trim() && files.length === 0}
                size="icon"
                className="shrink-0 shadow-md h-10 w-10"
              >
                <Send className="h-4 w-4" />
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
