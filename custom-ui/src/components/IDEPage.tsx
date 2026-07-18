// ============================================================
// IDEPage.tsx – Production-grade AI IDE
// Monaco Editor · Tabs · Diff View · Markdown Chat · Terminal
// ============================================================

import { useState, useEffect, useRef, useCallback } from "react";
import Editor, { DiffEditor } from "@monaco-editor/react";
import type { OnMount } from "@monaco-editor/react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { apiClient } from "@/services/api";
import { getStoredJSON, getStoredString, setStoredJSON, setStoredString } from "@/services/extensionStorage";
import {
	Check,
	ChevronDown,
	ChevronLeft,
	ChevronRight,
	ChevronUp,
	FolderOpen,
	FolderPlus,
	FilePlus,
	Folder,
	FileText,
	MessageSquarePlus,
	Mic,
	PanelLeftClose,
	PanelRightClose,
	Send,
	Terminal,
	X,
	Loader2,
	CheckCircle2,
	XCircle,
	GitPullRequestDraft,
	Wrench,
	Globe,
	RotateCcw,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

type FileNode = {
	type: "file" | "folder";
	name: string;
	children?: FileNode[];
};

type IDEToolCall = {
	name:
		| "list_files"
		| "read_file"
		| "search_files"
		| "web_search"
		| "web_fetch"
		| "run_command"
		| "send_terminal";
	arguments?: Record<string, unknown>;
};

type AgentActivity = {
	id: string;
	label: string;
	detail?: string;
	status: "running" | "done" | "error";
};

type PendingChange = {
	filename: string;
	oldContent: string;
	newContent: string;
};

type TerminalCommandWaiter = {
	sentinel: string;
	chunks: string[];
	resolve: (output: string) => void;
	timeoutId: number;
};

type WebFetchPermission = {
	domain: string;
	url: string;
	resolve: (decision: "allow_once" | "always" | "deny") => void;
};

// ─── Constants ────────────────────────────────────────────────────────────────

const IDE_SELECTED_MODEL_KEY = "ide.selectedModel";
const IDE_CHAT_MODE_KEY = "ide.chatMode";

const MONACO_EDITOR_OPTIONS = {
	fontSize: 13,
	fontFamily:
		"'Cascadia Code', 'JetBrains Mono', 'Fira Code', Consolas, 'Courier New', monospace",
	fontLigatures: true,
	lineNumbers: "on" as const,
	minimap: { enabled: false },
	scrollBeyondLastLine: false,
	wordWrap: "off" as const,
	tabSize: 2,
	insertSpaces: true,
	automaticLayout: true,
	padding: { top: 8, bottom: 8 },
	renderLineHighlight: "all" as const,
	bracketPairColorization: { enabled: true },
	cursorBlinking: "smooth" as const,
	cursorSmoothCaretAnimation: "on" as const,
	scrollbar: { verticalScrollbarSize: 6, horizontalScrollbarSize: 6 },
	lineNumbersMinChars: 3,
	renderWhitespace: "selection" as const,
	smoothScrolling: true,
	mouseWheelZoom: true,
};

const MONACO_DIFF_OPTIONS = {
	...MONACO_EDITOR_OPTIONS,
	renderSideBySide: true,
	originalEditable: false,
	enableSplitViewResizing: true,
	ignoreTrimWhitespace: false,
};

// ─── Language / colour helpers ────────────────────────────────────────────────

function getMonacoLanguage(path: string): string {
	const ext = path.split(".").pop()?.toLowerCase() ?? "";
	const map: Record<string, string> = {
		py: "python", js: "javascript", jsx: "javascript",
		ts: "typescript", tsx: "typescript", json: "json", jsonc: "json",
		md: "markdown", markdown: "markdown", css: "css", scss: "scss",
		html: "html", xml: "xml", sh: "shell", bash: "shell", zsh: "shell",
		yaml: "yaml", yml: "yaml", toml: "ini", txt: "plaintext",
		csv: "plaintext", env: "plaintext", rs: "rust", go: "go",
		java: "java", cs: "csharp", cpp: "cpp", c: "c", h: "cpp",
		rb: "ruby", php: "php", swift: "swift", kt: "kotlin",
		sql: "sql", graphql: "graphql",
	};
	return map[ext] ?? "plaintext";
}

function getFileColor(ext: string): string {
	const map: Record<string, string> = {
		py: "text-blue-500", js: "text-yellow-400", jsx: "text-yellow-400",
		ts: "text-sky-400", tsx: "text-sky-400", json: "text-orange-400",
		jsonc: "text-orange-400", md: "text-slate-400", css: "text-pink-400",
		scss: "text-pink-500", html: "text-orange-500", sh: "text-green-400",
		bash: "text-green-400", yaml: "text-purple-400", yml: "text-purple-400",
		toml: "text-red-400", rs: "text-orange-600", go: "text-cyan-400",
		rb: "text-red-500",
	};
	return map[ext] ?? "text-muted-foreground";
}

// ─── Small presentational components ─────────────────────────────────────────

function ActivityIcon({ status }: { status: "running" | "done" | "error" }) {
	if (status === "running")
		return <Loader2 className="w-3.5 h-3.5 shrink-0 text-amber-500 animate-spin" />;
	if (status === "done")
		return <CheckCircle2 className="w-3.5 h-3.5 shrink-0 text-green-500" />;
	return <XCircle className="w-3.5 h-3.5 shrink-0 text-red-500" />;
}

function MarkdownContent({ content }: { content: string }) {
	return (
		<ReactMarkdown
			remarkPlugins={[remarkGfm]}
			rehypePlugins={[rehypeHighlight]}
			components={{
				pre: ({ children }) => (
					<pre className="overflow-x-auto rounded-md bg-muted/80 border border-border/50 p-3 text-xs my-2 font-mono">
						{children}
					</pre>
				),
				code: ({ className, children }) =>
					className ? (
						<code className={`${className} text-xs`}>{children}</code>
					) : (
						<code className="rounded bg-muted/80 px-1.5 py-0.5 text-xs font-mono border border-border/50">
							{children}
						</code>
					),
				p: ({ children }) => <p className="mb-2 last:mb-0 leading-relaxed">{children}</p>,
				ul: ({ children }) => <ul className="list-disc pl-4 mb-2 space-y-0.5">{children}</ul>,
				ol: ({ children }) => <ol className="list-decimal pl-4 mb-2 space-y-0.5">{children}</ol>,
				li: ({ children }) => <li className="leading-relaxed">{children}</li>,
				h1: ({ children }) => <h1 className="text-base font-bold mb-2 mt-3 first:mt-0">{children}</h1>,
				h2: ({ children }) => <h2 className="text-sm font-semibold mb-2 mt-3 first:mt-0">{children}</h2>,
				h3: ({ children }) => <h3 className="text-xs font-semibold mb-1 mt-2 first:mt-0 uppercase tracking-wide opacity-70">{children}</h3>,
				a: ({ href, children }) => (
					<a href={href} target="_blank" rel="noopener noreferrer"
						className="text-primary underline underline-offset-2 hover:opacity-80">
						{children}
					</a>
				),
				blockquote: ({ children }) => (
					<blockquote className="border-l-2 border-primary/40 pl-3 text-muted-foreground italic my-2">
						{children}
					</blockquote>
				),
				table: ({ children }) => (
					<div className="overflow-x-auto my-2">
						<table className="text-xs border-collapse w-full">{children}</table>
					</div>
				),
				th: ({ children }) => <th className="border border-border bg-muted/50 px-2 py-1 text-left font-semibold">{children}</th>,
				td: ({ children }) => <td className="border border-border px-2 py-1">{children}</td>,
			}}
		>
			{content}
		</ReactMarkdown>
	);
}

// ─── File-tree helpers ────────────────────────────────────────────────────────

function normalizeFilePath(path: string) {
	return "/" + path.trim().replace(/\\/g, "/").replace(/^\/+/, "");
}

function upsertFileNode(nodes: FileNode[], path: string): FileNode[] {
	const parts = normalizeFilePath(path).slice(1).split("/").filter(Boolean);
	if (!parts.length) return nodes;
	const insert = (cur: FileNode[], depth: number): FileNode[] => {
		const name = parts[depth];
		const isFile = depth === parts.length - 1;
		const idx = cur.findIndex((n) => n.name === name);
		if (idx >= 0) {
			if (!isFile && cur[idx].type === "folder") {
				const next = [...cur];
				next[idx] = { ...cur[idx], children: insert(cur[idx].children || [], depth + 1) };
				return next;
			}
			return cur;
		}
		const node: FileNode = isFile
			? { type: "file", name }
			: { type: "folder", name, children: insert([], depth + 1) };
		return [...cur, node];
	};
	return insert(nodes, 0);
}

function flattenFilePaths(nodes: FileNode[], parentPath = ""): string[] {
	const paths: string[] = [];
	for (const n of nodes) {
		const p = `${parentPath}/${n.name}`;
		if (n.type === "file") paths.push(p);
		else paths.push(...flattenFilePaths(n.children || [], p));
	}
	return paths;
}

function hasFilePath(nodes: FileNode[], path: string) {
	return flattenFilePaths(nodes).includes(normalizeFilePath(path));
}

function removeFileNode(nodes: FileNode[], path: string): FileNode[] {
	const parts = normalizeFilePath(path).slice(1).split("/").filter(Boolean);
	if (!parts.length) return nodes;
	const remove = (cur: FileNode[], depth: number): FileNode[] =>
		cur
			.map((n) => {
				if (n.name !== parts[depth]) return n;
				if (depth === parts.length - 1) return null;
				if (n.type !== "folder") return n;
				return { ...n, children: remove(n.children || [], depth + 1) };
			})
			.filter(Boolean) as FileNode[];
	return remove(nodes, 0);
}

// ─── JSON / misc helpers ──────────────────────────────────────────────────────

function extractJsonObject(text: string) {
	const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
	const candidate = fenced?.[1] || text;
	const start = candidate.indexOf("{");
	const end = candidate.lastIndexOf("}");
	if (start === -1 || end === -1 || end <= start) return null;
	try { return JSON.parse(candidate.slice(start, end + 1)); } catch { return null; }
}

function extractJsonSummary(text: string) {
	const match = text.match(/"summary"\s*:\s*"((?:\\.|[^"\\])*)"/);
	if (!match) return "";
	try { return JSON.parse(`"${match[1]}"`); } catch { return match[1]; }
}

function isVagueEditRequest(text: string) {
	return /^(please\s+)?(edit|change|modify|update)\s+(this\s+)?(file|it)$/i.test(text.trim());
}

function isRunOnlyRequest(text: string) {
	const n = text.toLowerCase();
	return /\b(run|execute|start|test)\b/.test(n) && !/\b(edit|change|modify|update|create|write|fix|add\s+to\s+file)\b/.test(n);
}

// ─── IDEPage ──────────────────────────────────────────────────────────────────

export function IDEPage() {
	// ── File system ──────────────────────────────────────────────────────────
	const [files, setFiles] = useState<FileNode[]>([]);
	const [fileContents, setFileContents] = useState<Record<string, string>>({});
	const [selectedFile, setSelectedFile] = useState<string | null>(null);
	const [editorContent, setEditorContent] = useState("");
	const [ideRoot, setIdeRoot] = useState("");
	const [isPickingFolder, setIsPickingFolder] = useState(false);

	// ── File tree UI ─────────────────────────────────────────────────────────
	const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
	const [showNewFileInput, setShowNewFileInput] = useState(false);
	const [showNewFolderInput, setShowNewFolderInput] = useState(false);
	const [showOpenFolderInput, setShowOpenFolderInput] = useState(false);
	const [newFileName, setNewFileName] = useState("");
	const [newFolderName, setNewFolderName] = useState("");
	const [openFolderPath, setOpenFolderPath] = useState("");

	// ── Editor ───────────────────────────────────────────────────────────────
	const [openTabs, setOpenTabs] = useState<string[]>([]);
	const [cursorPos, setCursorPos] = useState({ line: 1, col: 1 });
	const [isDark, setIsDark] = useState(() => document.documentElement.classList.contains("dark"));
	const editorRef = useRef<Parameters<OnMount>[0] | null>(null);
	const diffEditorRef = useRef<any>(null);
	const pendingChangeRef = useRef<PendingChange | null>(null);
	const selectedFileRef = useRef<string | null>(null);

	// ── Panels ───────────────────────────────────────────────────────────────
	const [filesCollapsed, setFilesCollapsed] = useState(false);
	const [editorCollapsed, setEditorCollapsed] = useState(false);
	const [chatCollapsed, setChatCollapsed] = useState(false);
	const [filesWidth, setFilesWidth] = useState(260);
	const [chatWidth, setChatWidth] = useState(380);

	// ── Terminal ─────────────────────────────────────────────────────────────
	const [terminalCollapsed, setTerminalCollapsed] = useState(false);
	const [terminalHeight, setTerminalHeight] = useState(288);
	const [terminalCwd, setTerminalCwd] = useState("");
	const [ptyStatus, setPtyStatus] = useState<"disconnected" | "connecting" | "connected" | "error">("disconnected");
	const [ptyRestartKey, setPtyRestartKey] = useState(0);
	const terminalContainerRef = useRef<HTMLDivElement | null>(null);
	const ptySocketRef = useRef<WebSocket | null>(null);
	const xtermRef = useRef<XTerm | null>(null);
	const fitAddonRef = useRef<FitAddon | null>(null);
	const terminalCommandWaiterRef = useRef<TerminalCommandWaiter | null>(null);
	const terminalInputBufferRef = useRef("");

	// ── Chat ─────────────────────────────────────────────────────────────────
	const [selectedModel, setSelectedModel] = useState("");
	const [chatInput, setChatInput] = useState("");
	const [historyIndex, setHistoryIndex] = useState(-1);
	const [chatMessages, setChatMessages] = useState<Array<{ role: string; content: string }>>([]);
	const [agentActivities, setAgentActivities] = useState<AgentActivity[]>([]);
	const [webFetchPermission, setWebFetchPermission] = useState<WebFetchPermission | null>(null);
	const [isThinking, setIsThinking] = useState(false);
	const [isListening, setIsListening] = useState(false);
	const [streamingContent, setStreamingContent] = useState("");
	const [chatMode, setChatMode] = useState<"ask" | "agent">("ask");
	const [allowedWebFetchDomains, setAllowedWebFetchDomains] = useState<Set<string>>(new Set());
	const [pendingChanges, setPendingChanges] = useState<PendingChange[]>([]);
	const [availableModels, setAvailableModels] = useState<Array<{ name: string; id: string; size: string; modified: string }>>([]);

	const chatAbortControllerRef = useRef<AbortController | null>(null);
	const chatStopRequestedRef = useRef(false);
	const speechRecognitionRef = useRef<any>(null);
	const voiceInputBaseRef = useRef("");
	const inputDraftRef = useRef("");
	const chatScrollRef = useRef<HTMLDivElement | null>(null);
	const idePreferencesLoadedRef = useRef(false);

	// ── Derived ──────────────────────────────────────────────────────────────
	const ideRootName = ideRoot.split(/[\\/]/).filter(Boolean).pop() || ideRoot;
	const pendingChange =
		(selectedFile ? pendingChanges.find((c) => normalizeFilePath(c.filename) === selectedFile) : null) ||
		pendingChanges[0] || null;
	const pendingPath = pendingChange ? normalizeFilePath(pendingChange.filename) : null;
	const pendingIsNewFile = pendingChange ? !pendingChange.oldContent : false;
	const showDiffEditor = pendingChange !== null && pendingPath === selectedFile;
	const language = selectedFile ? getMonacoLanguage(selectedFile) : "plaintext";
	const statusBarLanguage = language === "plaintext" ? "Plain Text" : language.charAt(0).toUpperCase() + language.slice(1);

	// Keep refs in sync for Monaco command closures
	useEffect(() => { pendingChangeRef.current = pendingChange; }, [pendingChange]);
	useEffect(() => { selectedFileRef.current = selectedFile; }, [selectedFile]);

	// ── Effects ───────────────────────────────────────────────────────────────

	// Dark mode
	useEffect(() => {
		const ob = new MutationObserver(() =>
			setIsDark(document.documentElement.classList.contains("dark"))
		);
		ob.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
		return () => ob.disconnect();
	}, []);

	// Models
	useEffect(() => {
		let cancelled = false;
		Promise.all([
			getStoredString(IDE_SELECTED_MODEL_KEY),
			getStoredString(IDE_CHAT_MODE_KEY),
			getStoredJSON<string[]>("ide_web_fetch_allowed_domains", []),
		]).then(([storedModel, storedChatMode, storedDomains]) => {
			if (cancelled) return;
			if (storedModel) setSelectedModel(storedModel);
			if (storedChatMode === "agent" || storedChatMode === "ask") setChatMode(storedChatMode);
			setAllowedWebFetchDomains(new Set((Array.isArray(storedDomains) ? storedDomains : []).map(String)));
			idePreferencesLoadedRef.current = true;
		});
		return () => { cancelled = true; };
	}, []);

	useEffect(() => {
		apiClient.getOllamaModels().then((models) => {
			setAvailableModels(models);
			setSelectedModel((prev) => {
				if (prev && models.some((m) => m.name === prev)) return prev;
				return models[0]?.name || "";
			});
		});
	}, []);

	useEffect(() => { if (idePreferencesLoadedRef.current && selectedModel) void setStoredString(IDE_SELECTED_MODEL_KEY, selectedModel); }, [selectedModel]);
	useEffect(() => { if (idePreferencesLoadedRef.current) void setStoredString(IDE_CHAT_MODE_KEY, chatMode); }, [chatMode]);

	// Auto-scroll chat
	useEffect(() => {
		const el = chatScrollRef.current;
		if (el) el.scrollTop = el.scrollHeight;
	}, [chatMessages, agentActivities, webFetchPermission, isThinking, streamingContent]);

	// Load workspace
	useEffect(() => {
		apiClient.listIDEFiles().then((data) => {
			setIdeRoot(data.root);
			setTerminalCwd(data.root);
			const treeFiles = Array.isArray(data.files) ? data.files as FileNode[] : [];
			setFiles(treeFiles);
			setExpandedFolders(new Set(
				treeFiles.filter((f) => f.type === "folder").map((f) => `/${f.name}`)
			));
		}).catch(console.error);
	}, []);

	// PTY terminal
	useEffect(() => {
		if (!terminalCwd || !terminalContainerRef.current) return;
		let disposed = false;
		setPtyStatus("connecting");
		ptySocketRef.current?.close();
		xtermRef.current?.dispose();

		const terminal = new XTerm({
			cursorBlink: true,
			convertEol: true,
			fontFamily: "Consolas, 'Cascadia Mono', 'Courier New', monospace",
			fontSize: 13,
			theme: {
				background: "#0d1117", foreground: "#e6edf3", cursor: "#58a6ff",
				black: "#21262d", brightBlack: "#484f58", red: "#ff7b72", brightRed: "#ffa198",
				green: "#3fb950", brightGreen: "#56d364", yellow: "#d29922", brightYellow: "#e3b341",
				blue: "#388bfd", brightBlue: "#79c0ff", magenta: "#bc8cff", brightMagenta: "#d2a8ff",
				cyan: "#39c5cf", brightCyan: "#56d4dd", white: "#b1bac4", brightWhite: "#f0f6fc",
			},
		});
		const fitAddon = new FitAddon();
		terminal.loadAddon(fitAddon);
		terminal.open(terminalContainerRef.current);
		fitAddon.fit();
		terminal.focus();

		const protocol = window.location.protocol === "https:" ? "wss" : "ws";
		const params = new URLSearchParams({ cwd: terminalCwd, cols: String(terminal.cols), rows: String(terminal.rows) });
		const socket = new WebSocket(`${protocol}://localhost:8081/api/ide/terminal/pty?${params}`);
		ptySocketRef.current = socket;
		xtermRef.current = terminal;
		fitAddonRef.current = fitAddon;

		const send = (input: string) => socket.readyState === WebSocket.OPEN && socket.send(JSON.stringify({ type: "input", data: input }));
		const dataDisposable = terminal.onData((data) => {
			if (data.startsWith("\x1b") || data === "\x03") { send(data); return; }
			for (const ch of data) {
				if (ch === "\r" || ch === "\n") {
					terminal.write("\r\n"); send(`${terminalInputBufferRef.current}\r`); terminalInputBufferRef.current = "";
				} else if (ch === "\u007f" || ch === "\b") {
					if (terminalInputBufferRef.current.length > 0) { terminalInputBufferRef.current = terminalInputBufferRef.current.slice(0, -1); terminal.write("\b \b"); }
				} else { terminalInputBufferRef.current += ch; terminal.write(ch); }
			}
		});
		const ro = new ResizeObserver(() => {
			fitAddon.fit();
			if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "resize", cols: terminal.cols, rows: terminal.rows }));
		});
		ro.observe(terminalContainerRef.current);

		socket.onopen = () => { if (!disposed) { setPtyStatus("connected"); socket.send(JSON.stringify({ type: "resize", cols: terminal.cols, rows: terminal.rows })); } };
		socket.onmessage = (event) => {
			const output = String(event.data);
			terminal.write(output);
			const waiter = terminalCommandWaiterRef.current;
			if (waiter) {
				waiter.chunks.push(output);
				const combined = waiter.chunks.join("");
				if (combined.includes(waiter.sentinel)) {
					window.clearTimeout(waiter.timeoutId);
					terminalCommandWaiterRef.current = null;
					waiter.resolve(combined.split(waiter.sentinel)[0]);
				}
			}
		};
		socket.onerror = () => { if (!disposed) setPtyStatus("error"); };
		socket.onclose = () => { if (!disposed) setPtyStatus("disconnected"); };

		return () => {
			disposed = true;
			ro.disconnect(); dataDisposable.dispose(); socket.close(); terminal.dispose();
			if (ptySocketRef.current === socket) ptySocketRef.current = null;
			if (xtermRef.current === terminal) xtermRef.current = null;
			if (fitAddonRef.current === fitAddon) fitAddonRef.current = null;
		};
	}, [terminalCwd, ptyRestartKey]);

	useEffect(() => {
		if (!terminalCollapsed) window.requestAnimationFrame(() => { fitAddonRef.current?.fit(); xtermRef.current?.focus(); });
	}, [terminalCollapsed]);

	// ── Monaco mounts ──────────────────────────────────────────────────────────

	const handleEditorMount: OnMount = useCallback((editor, monaco) => {
		editorRef.current = editor;
		editor.onDidChangeCursorPosition((e) => setCursorPos({ line: e.position.lineNumber, col: e.position.column }));
		editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, async () => {
			const pc = pendingChangeRef.current;
			const sf = selectedFileRef.current;
			const content = editor.getValue();
			if (pc) {
				const path = normalizeFilePath(pc.filename);
				try {
					await apiClient.writeIDEFile(path, pc.newContent);
					setPendingChanges((prev) => prev.filter((c) => normalizeFilePath(c.filename) !== path));
					setFileContents((prev) => ({ ...prev, [path]: pc.newContent }));
					setChatMessages((prev) => [...prev, { role: "assistant", content: `✓ Saved \`${path}\`` }]);
				} catch (e) { console.error(e); }
			} else if (sf) {
				try { await apiClient.writeIDEFile(sf, content); setFileContents((prev) => ({ ...prev, [sf]: content })); }
				catch (e) { console.error(e); }
			}
		});
	}, []);

	const handleDiffEditorMount = useCallback((diffEditor: any, monaco: any) => {
		diffEditorRef.current = diffEditor;
		const mod = diffEditor.getModifiedEditor();
		mod.onDidChangeCursorPosition((e: any) => setCursorPos({ line: e.position.lineNumber, col: e.position.column }));
		mod.onDidChangeModelContent(() => {
			const pc = pendingChangeRef.current;
			const sf = selectedFileRef.current;
			if (!pc || !sf) return;
			setPendingChanges((prev) => prev.map((c) => normalizeFilePath(c.filename) === sf ? { ...c, newContent: mod.getValue() } : c));
		});
		mod.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, async () => {
			const pc = pendingChangeRef.current;
			if (!pc) return;
			const path = normalizeFilePath(pc.filename);
			const newContent = mod.getValue();
			try {
				await apiClient.writeIDEFile(path, newContent);
				setPendingChanges((prev) => prev.filter((c) => normalizeFilePath(c.filename) !== path));
				setFileContents((prev) => ({ ...prev, [path]: newContent }));
				setEditorContent(newContent);
			} catch (e) { console.error(e); }
		});
	}, []);

	// ── Tabs ──────────────────────────────────────────────────────────────────

	function handleCloseTab(path: string) {
		setOpenTabs((prev) => {
			const next = prev.filter((t) => t !== path);
			if (selectedFile === path) {
				const idx = prev.indexOf(path);
				const fallback = next[Math.max(0, idx - 1)] ?? next[0] ?? null;
				setSelectedFile(fallback);
				setEditorContent(fallback ? (fileContents[fallback] ?? "") : "");
			}
			return next;
		});
	}

	// ── File ops ──────────────────────────────────────────────────────────────

	async function handleSelectFile(path: string) {
		setSelectedFile(path);
		setOpenTabs((prev) => prev.includes(path) ? prev : [...prev, path]);
		if (fileContents[path] !== undefined) { setEditorContent(fileContents[path]); return; }
		setEditorContent("// Loading…");
		try {
			const result = await apiClient.readIDEFile(path);
			setSelectedFile(result.path);
			setEditorContent(result.content);
			setFileContents((prev) => ({ ...prev, [result.path]: result.content }));
		} catch (error) {
			setEditorContent(`// Error: ${error instanceof Error ? error.message : "Failed to load file"}`);
		}
	}

	function toggleFolder(path: string) {
		setExpandedFolders((prev) => {
			const next = new Set(prev);
			if (next.has(path)) next.delete(path);
			else next.add(path);
			return next;
		});
	}

	function handleAddFile() {
		if (!newFileName.trim()) return;
		const path = normalizeFilePath(newFileName);
		setFiles(upsertFileNode(files, path));
		setFileContents((prev) => ({ ...prev, [path]: prev[path] ?? "" }));
		setNewFileName(""); setShowNewFileInput(false);
	}

	function handleAddFolder() {
		if (!newFolderName.trim()) return;
		setFiles([...files, { type: "folder", name: newFolderName, children: [] }]);
		setNewFolderName(""); setShowNewFolderInput(false);
	}

	function applyOpenedFolder(data: { root: string; files: Array<{ type: "file" | "folder"; name: string; children?: any[] }> }) {
		const treeFiles = data.files as FileNode[];
		setIdeRoot(data.root); setTerminalCwd(data.root); setPtyRestartKey((p) => p + 1);
		setFiles(treeFiles); setFileContents({}); setSelectedFile(null); setEditorContent(""); setOpenTabs([]); setPendingChanges([]);
		setExpandedFolders(new Set(treeFiles.filter((f) => f.type === "folder").map((f) => `/${f.name}`)));
	}

	async function handleOpenFolder() {
		const path = openFolderPath.trim(); if (!path) return;
		try {
			const data = await apiClient.openIDEFolder(path);
			applyOpenedFolder(data); setOpenFolderPath(""); setShowOpenFolderInput(false);
			setChatMessages((prev) => [...prev, { role: "assistant", content: `Opened folder: ${data.root}` }]);
		} catch (error) {
			setChatMessages((prev) => [...prev, { role: "assistant", content: `Error: ${error instanceof Error ? error.message : "Failed"}` }]);
		}
	}

	async function handleBrowseFolder() {
		setIsPickingFolder(true);
		try {
			const data = await apiClient.pickIDEFolder();
			if (!data.cancelled) { applyOpenedFolder(data); setShowOpenFolderInput(false); setChatMessages((prev) => [...prev, { role: "assistant", content: `Opened folder: ${data.root}` }]); }
		} catch (error) {
			setShowOpenFolderInput(true);
			setChatMessages((prev) => [...prev, { role: "assistant", content: `Error: ${error instanceof Error ? error.message : "Failed"}` }]);
		} finally { setIsPickingFolder(false); }
	}

	// ── Pending changes ───────────────────────────────────────────────────────

	function getNextPendingChange(currentPath: string, changes: PendingChange[]) {
		const p = normalizeFilePath(currentPath);
		const idx = changes.findIndex((c) => normalizeFilePath(c.filename) === p);
		const remaining = changes.filter((c) => normalizeFilePath(c.filename) !== p);
		return { remaining, nextChange: remaining[Math.min(idx >= 0 ? idx : 0, remaining.length - 1)] || null };
	}

	function openPendingChange(change: PendingChange) {
		const path = normalizeFilePath(change.filename);
		setSelectedFile(path);
		setOpenTabs((prev) => prev.includes(path) ? prev : [...prev, path]);
		setEditorContent(change.newContent);
	}

	async function handleAcceptChange() {
		if (!pendingChange) return;
		const path = normalizeFilePath(pendingChange.filename);
		const newContent = diffEditorRef.current?.getModifiedEditor()?.getValue() ?? pendingChange.newContent;
		try {
			const result = await apiClient.writeIDEFile(path, newContent);
			const { remaining, nextChange } = getNextPendingChange(path, pendingChanges);
			setFiles((prev) => upsertFileNode(prev, result.path));
			setFileContents((prev) => ({ ...prev, [result.path]: newContent }));
			setPendingChanges(remaining);
			if (nextChange) openPendingChange(nextChange);
			else { setSelectedFile(result.path); setEditorContent(newContent); }
			setChatMessages((prev) => [...prev, { role: "assistant", content: `✓ Applied \`${result.path}\`` }]);
		} catch (error) {
			setChatMessages((prev) => [...prev, { role: "assistant", content: `Error: ${error instanceof Error ? error.message : "Failed"}` }]);
		}
	}

	/** Accept a specific pending change by path (used from the Explorer list). */
	async function handleAcceptSpecificChange(change: PendingChange) {
		const path = normalizeFilePath(change.filename);
		try {
			const result = await apiClient.writeIDEFile(path, change.newContent);
			setFiles((prev) => upsertFileNode(prev, result.path));
			setFileContents((prev) => ({ ...prev, [result.path]: change.newContent }));
			const { remaining, nextChange } = getNextPendingChange(path, pendingChanges);
			setPendingChanges(remaining);
			if (nextChange) openPendingChange(nextChange);
			else if (selectedFile === path) setEditorContent(change.newContent);
			setChatMessages((prev) => [...prev, { role: "assistant", content: `✓ Applied \`${result.path}\`` }]);
		} catch (error) {
			setChatMessages((prev) => [...prev, { role: "assistant", content: `Error: ${error instanceof Error ? error.message : "Failed"}` }]);
		}
	}

	/** Discard a specific pending change by path (used from the Explorer list). */
	function handleDiscardSpecificChange(change: PendingChange) {
		const path = normalizeFilePath(change.filename);
		if (!change.oldContent) setFiles((prev) => removeFileNode(prev, change.filename));
		const { remaining, nextChange } = getNextPendingChange(path, pendingChanges);
		setPendingChanges(remaining);
		if (nextChange) openPendingChange(nextChange);
		else if (selectedFile === path) {
			if (!change.oldContent) { setSelectedFile(null); setEditorContent(""); }
			else setEditorContent(change.oldContent);
		}
	}

	async function handleAcceptAllChanges() {
		const all = [...pendingChanges];
		for (const change of all) {
			const path = normalizeFilePath(change.filename);
			try {
				const result = await apiClient.writeIDEFile(path, change.newContent);
				setFiles((prev) => upsertFileNode(prev, result.path));
				setFileContents((prev) => ({ ...prev, [result.path]: change.newContent }));
				setPendingChanges((prev) => prev.filter((c) => normalizeFilePath(c.filename) !== path));
			} catch (error) {
				setChatMessages((prev) => [...prev, { role: "assistant", content: `Error on ${path}: ${error instanceof Error ? error.message : "Failed"}` }]);
				return;
			}
		}
		setChatMessages((prev) => [...prev, { role: "assistant", content: `✓ Applied ${all.length} change${all.length === 1 ? "" : "s"}` }]);
	}

	function handleDiscardChange() {
		if (!pendingChange || !pendingPath) return;
		const { remaining, nextChange } = getNextPendingChange(pendingPath, pendingChanges);
		if (!pendingChange.oldContent) setFiles((prev) => removeFileNode(prev, pendingChange.filename));
		setPendingChanges(remaining);
		if (nextChange) openPendingChange(nextChange);
		else if (!pendingChange.oldContent && selectedFile === pendingPath) { setSelectedFile(null); setEditorContent(""); }
		else if (selectedFile === pendingPath) setEditorContent(pendingChange.oldContent);
	}

	function handleDiscardAllChanges() {
		for (const c of pendingChanges) if (!c.oldContent) setFiles((prev) => removeFileNode(prev, c.filename));
		if (pendingChange && selectedFile === normalizeFilePath(pendingChange.filename)) setEditorContent(pendingChange.oldContent);
		setPendingChanges([]);
	}

	// ── Panel resize ──────────────────────────────────────────────────────────

	function startResizePane(pane: "files" | "chat", e: React.MouseEvent<HTMLDivElement>) {
		e.preventDefault();
		const startX = e.clientX;
		const init = pane === "files" ? filesWidth : chatWidth;
		const onMove = (ev: MouseEvent) => {
			const delta = ev.clientX - startX;
			if (pane === "files") setFilesWidth(Math.max(180, Math.min(520, init + delta)));
			else setChatWidth(Math.max(260, Math.min(620, init - delta)));
		};
		const onUp = () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
		window.addEventListener("mousemove", onMove); window.addEventListener("mouseup", onUp);
	}

	function startResizeTerminal(e: React.MouseEvent<HTMLDivElement>) {
		e.preventDefault();
		const startY = e.clientY;
		const init = terminalHeight;
		const onMove = (ev: MouseEvent) => {
			setTerminalHeight(Math.max(140, Math.min(520, init + startY - ev.clientY)));
			window.requestAnimationFrame(() => fitAddonRef.current?.fit());
		};
		const onUp = () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); fitAddonRef.current?.fit(); };
		window.addEventListener("mousemove", onMove); window.addEventListener("mouseup", onUp);
	}

	// ── Agent tools ───────────────────────────────────────────────────────────

	function getAllowedDomains(): Set<string> {
		return allowedWebFetchDomains;
	}
	function saveDomain(domain: string) {
		const nextDomains = new Set(allowedWebFetchDomains);
		nextDomains.add(domain);
		setAllowedWebFetchDomains(nextDomains);
		void setStoredJSON("ide_web_fetch_allowed_domains", [...nextDomains].sort());
	}
	function getUrlDomain(url: string) { try { return new URL(url).hostname; } catch { return ""; } }

	async function requestWebFetchPermission(url: string) {
		const domain = getUrlDomain(url);
		if (!domain) throw new Error("web_fetch requires a valid URL");
		if (getAllowedDomains().has(domain)) return;
		const decision = await new Promise<"allow_once" | "always" | "deny">((resolve) => setWebFetchPermission({ domain, url, resolve }));
		setWebFetchPermission(null);
		if (decision === "deny") throw new Error(`User denied web_fetch for ${domain}`);
		if (decision === "always") saveDomain(domain);
	}

	function shouldRunInTerminal(command: string) {
		return /^(python|py|python3)\s+[^&|<>\r\n]+\.py(?:\s*)$/.test(command.trim().toLowerCase());
	}

	function writeCapturedOutput(command: string, stdin: string[], result?: { exit_code: number; output: string }) {
		if (terminalCollapsed) setTerminalCollapsed(false);
		const t = xtermRef.current; if (!t) return;
		const lines = result ? ["", result.output.trimEnd() || "(no output)", `[exit ${result.exit_code}]`] : ["", `$ ${command}`, ...stdin.map((l) => `[stdin] ${l}`)];
		t.write(`${lines.join("\r\n")}\r\n`);
	}

	const wait = (ms: number) => new Promise((r) => window.setTimeout(r, ms));

	async function waitForTerminalSocket() {
		if (terminalCollapsed) { setTerminalCollapsed(false); await wait(100); }
		if (!ptySocketRef.current || ptySocketRef.current.readyState === WebSocket.CLOSED || ptySocketRef.current.readyState === WebSocket.CLOSING) setPtyRestartKey((p) => p + 1);
		for (let i = 0; i < 50; i++) {
			if (ptySocketRef.current?.readyState === WebSocket.OPEN) return ptySocketRef.current;
			await wait(100);
		}
		throw new Error("Terminal is not connected");
	}

	async function sendCommandToTerminal(command: string) {
		const socket = await waitForTerminalSocket();
		socket.send(JSON.stringify({ type: "input", data: `${command}\r` }));
		return { cwd: terminalCwd || ideRoot, started: true, command };
	}

	async function executeIdeTool(toolCall: IDEToolCall) {
		if (chatStopRequestedRef.current) throw new Error("Agent run stopped");
		const args = toolCall.arguments || {};
		const strArr = (v: unknown) => Array.isArray(v) ? v.map(String).filter(Boolean) : [];

		if (toolCall.name === "list_files") return { files: flattenFilePaths(files).sort() };
		if (toolCall.name === "read_file") {
			const path = String(args.path || "").trim(); if (!path) return { error: "read_file requires path" };
			return await apiClient.readIDEFile(path);
		}
		if (toolCall.name === "search_files") {
			const query = String(args.query || "").trim(); if (!query) return { error: "search_files requires query" };
			return await apiClient.searchIDEFiles(query, Number(args.max_results || 50));
		}
		if (toolCall.name === "web_search") {
			const query = String(args.query || "").trim(); if (!query) return { error: "web_search requires query" };
			const id = crypto.randomUUID();
			setAgentActivities((prev) => [...prev, { id, label: "Web search", detail: query, status: "running" as const }].slice(-20));
			const result = await apiClient.searchIDEWeb(query, Number(args.max_results || 5), strArr(args.allowed_domains), strArr(args.blocked_domains));
			setAgentActivities((prev) => prev.map((a) => a.id === id ? { ...a, detail: `${result.results.length} results`, status: "done" } : a));
			return result;
		}
		if (toolCall.name === "web_fetch") {
			const url = String(args.url || "").trim(); if (!url) return { error: "web_fetch requires url" };
			await requestWebFetchPermission(url);
			const id = crypto.randomUUID();
			setAgentActivities((prev) => [...prev, { id, label: "Fetch page", detail: getUrlDomain(url), status: "running" as const }].slice(-20));
			const result = await apiClient.fetchIDEWeb(url, String(args.prompt || "Extract relevant information.").trim());
			setAgentActivities((prev) => prev.map((a) => a.id === id ? { ...a, detail: `${result.cached ? "cached" : "fetched"}`, status: "done" } : a));
			return result;
		}
		if (toolCall.name === "run_command") {
			const command = String(args.command || "").trim(); if (!command) return { error: "run_command requires command" };
			if (/exec\s*\(\s*open\s*\(/i.test(command) || /\.replace\s*\(\s*['"]input['"]/i.test(command)) return { error: "Do not rewrite input()." };
			const stdin = Array.isArray(args.stdin) ? args.stdin.map(String) : typeof args.stdin === "string" ? args.stdin.split(/\r?\n/) : [];
			if (shouldRunInTerminal(command) && !stdin.length) return await sendCommandToTerminal(command);
			writeCapturedOutput(command, stdin);
			const result = await apiClient.runIDECommand(command, Number(args.timeout_seconds || 30), terminalCwd || ideRoot, stdin);
			writeCapturedOutput(command, stdin, result);
			return result;
		}
		if (toolCall.name === "send_terminal") {
			const command = String(args.command || "").trim(); if (!command) return { error: "send_terminal requires command" };
			return await sendCommandToTerminal(command);
		}
		return { error: `Unknown tool: ${(toolCall as { name: string }).name}` };
	}

	// ── Chat ──────────────────────────────────────────────────────────────────

	function buildPrompt(instruction: string, mode: "ask" | "agent") {
		const fileList = flattenFilePaths(files).sort().join("\n");
		const ctx = selectedFile ? `Selected file: ${selectedFile}\n\nContent:\n\`\`\`\n${editorContent}\n\`\`\`` : "No file selected.";
		return `You are an IDE coding agent for the locally opened folder.\n\nOpened folder: ${ideRoot || "(unknown)"}\nFiles:\n${fileList || "(empty)"}\n\n${ctx}\n\nUser request:\n${instruction}\n\nYou may call tools by returning ONLY valid JSON:\n{"tool_calls":[{"name":"list_files"},{"name":"read_file","arguments":{"path":"src/main.py"}},{"name":"search_files","arguments":{"query":"fn","max_results":20}},{"name":"run_command","arguments":{"command":"python run.py","stdin":["5","3"],"timeout_seconds":30}}]}\n\nWhen done, return ONLY valid JSON. ${mode === "agent" ? `For changes:\n{"summary":"...","changes":[{"path":"rel/path.py","content":"full content"}]}` : `For answers:\n{"answer":"..."}\nFor edits use changes shape.`}\n\nRules:\n- Use relative paths in JSON.\n- Include full final file contents.\n- For run requests use run_command with stdin; do not edit source files.\n- Do not wrap JSON in markdown.`;
	}

	function handleStopChat() {
		chatStopRequestedRef.current = true; chatAbortControllerRef.current?.abort();
		setWebFetchPermission((prev) => { prev?.resolve("deny"); return null; });
		setAgentActivities((prev) => [...prev.map((a) => a.status === "running" ? { ...a, status: "error" as const, detail: "Stopped" } : a), { id: crypto.randomUUID(), label: "Stopped", status: "error" as const }].slice(-20));
	}

	function handleNewChat() {
		chatStopRequestedRef.current = true; chatAbortControllerRef.current?.abort();
		speechRecognitionRef.current?.stop?.();
		setWebFetchPermission((prev) => { prev?.resolve("deny"); return null; });
		setChatMessages([]); setAgentActivities([]); setStreamingContent(""); setChatInput(""); setIsThinking(false); setIsListening(false);
	}

	function handleToggleVoiceInput() {
		if (isListening) { speechRecognitionRef.current?.stop?.(); setIsListening(false); return; }
		const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
		if (!SR) { setChatMessages((prev) => [...prev, { role: "assistant", content: "Voice input not supported in this browser." }]); return; }
		const rec = new SR(); rec.continuous = false; rec.interimResults = true; rec.lang = navigator.language || "en-US";
		voiceInputBaseRef.current = chatInput;
		let final = "";
		rec.onresult = (event: any) => {
			let interim = "";
			for (let i = event.resultIndex; i < event.results.length; i++) {
				const t = String(event.results[i][0]?.transcript || "");
				if (event.results[i].isFinal) final += t;
				else interim += t;
			}
			const d = `${final}${interim}`.trim();
			if (d) { const base = voiceInputBaseRef.current.trimEnd(); setChatInput(`${base}${base ? " " : ""}${d}`); }
		};
		rec.onend = () => { setIsListening(false); speechRecognitionRef.current = null; };
		rec.onerror = () => { setIsListening(false); speechRecognitionRef.current = null; };
		speechRecognitionRef.current = rec; setIsListening(true); rec.start();
	}

	async function runAgentLoop(instruction: string, mode: "ask" | "agent", signal: AbortSignal) {
		setAgentActivities([{ id: crypto.randomUUID(), label: "Agent started", detail: instruction.slice(0, 60), status: "running" }]);
		const messages: Array<{ role: "user" | "assistant" | "system"; content: string }> = [
			{ role: "system", content: `Terminal tools: send_terminal starts a command in the visible terminal; run_command captures output. Use stdin array for interactive scripts. Never replace input() or monkeypatch files unless user explicitly asks.` },
			{ role: "system", content: `Web tools available for factual/URL questions: web_search then web_fetch. Include source links in final answer.` },
			{ role: "user", content: buildPrompt(instruction, mode) },
		];
		let finalReply = "";

		for (let step = 0; step < 8; step++) {
			if (chatStopRequestedRef.current || signal.aborted) throw new DOMException("Stopped", "AbortError");
			setAgentActivities((prev) => [...prev, { id: crypto.randomUUID(), label: "Thinking", detail: `step ${step + 1}`, status: "running" as const }].slice(-20));
			let aiReply = "";
			for await (const chunk of apiClient.streamDirectModelChat(selectedModel, messages, signal)) {
				if (chatStopRequestedRef.current || signal.aborted) throw new DOMException("Stopped", "AbortError");
				if (chunk.type === "content") { aiReply += chunk.delta; setStreamingContent(aiReply); }
			}
			finalReply = aiReply;
			const parsed = extractJsonObject(aiReply);
			const toolCalls = Array.isArray(parsed?.tool_calls) ? parsed.tool_calls as IDEToolCall[] : [];
			if (!toolCalls.length) {
				setAgentActivities((prev) => [...prev.map((a, i) => i === prev.length - 1 ? { ...a, status: "done" as const } : a), { id: crypto.randomUUID(), label: "Done", status: "done" as const }].slice(-20));
				return finalReply;
			}
			messages.push({ role: "assistant", content: aiReply });
			const results = [];
			for (const tc of toolCalls.slice(0, 4)) {
				if (chatStopRequestedRef.current || signal.aborted) throw new DOMException("Stopped", "AbortError");
				const id = crypto.randomUUID();
				const label = ({ web_search: "Search", web_fetch: "Fetch", run_command: "Run", read_file: "Read", list_files: "List", search_files: "Search files", send_terminal: "Terminal" } as Record<string, string>)[tc.name] ?? tc.name;
				setAgentActivities((prev) => [...prev, { id, label, detail: JSON.stringify(tc.arguments || {}), status: "running" as const }].slice(-20));
				try {
					const result = await executeIdeTool(tc);
					results.push({ tool: tc.name, arguments: tc.arguments || {}, result });
					setAgentActivities((prev) => prev.map((a) => a.id === id ? { ...a, status: "done" } : a));
				} catch (error) {
					const msg = error instanceof Error ? error.message : String(error);
					results.push({ tool: tc.name, arguments: tc.arguments || {}, error: msg });
					setAgentActivities((prev) => prev.map((a) => a.id === id ? { ...a, detail: msg, status: "error" } : a));
				}
			}
			messages.push({ role: "user", content: `Tool results:\n${JSON.stringify(results, null, 2)}\n\nContinue.` });
		}
		setAgentActivities((prev) => [...prev, { id: crypto.randomUUID(), label: "Reached max steps", status: "error" as const }].slice(-20));
		return finalReply;
	}

	async function handleSendChat() {
		if (!chatInput.trim() || !selectedModel || isThinking) return;
		const instruction = chatInput;
		const runOnly = isRunOnlyRequest(instruction);
		// Reset history browsing when a message is sent
		setHistoryIndex(-1);
		inputDraftRef.current = "";
		if (chatMode === "agent" && isVagueEditRequest(instruction)) {
			setChatMessages((prev) => [...prev, { role: "user", content: instruction }, { role: "assistant", content: `What change should I make${selectedFile ? ` to \`${selectedFile}\`` : ""}?` }]);
			setChatInput(""); return;
		}
		const abort = new AbortController();
		chatAbortControllerRef.current = abort;
		chatStopRequestedRef.current = false;
		setChatMessages((prev) => [...prev, { role: "user", content: instruction }]);
		setIsThinking(true); setStreamingContent(""); setChatInput("");
		try {
			const aiReply = await runAgentLoop(instruction, chatMode, abort.signal);
			if (chatStopRequestedRef.current || abort.signal.aborted) { setChatMessages((prev) => [...prev, { role: "assistant", content: "Stopped." }]); return; }
			const parsed = extractJsonObject(aiReply);
			const rawChanges = Array.isArray(parsed?.changes) ? parsed.changes : [];
			const proposed: PendingChange[] = rawChanges
				.filter((c: any) => c?.path && typeof c.content === "string")
				.map((c: any) => { const path = normalizeFilePath(String(c.path)); return { filename: path, oldContent: fileContents[path] || "", newContent: c.content }; });

			if (proposed.length > 0 && runOnly) {
				setChatMessages((prev) => [...prev, { role: "assistant", content: parsed?.summary || parsed?.answer || extractJsonSummary(aiReply) || "Ran (file edits ignored — you asked to run, not edit)." }]);
			} else if (proposed.length > 0) {
				setPendingChanges(proposed);
				setFiles((prev) => proposed.reduce((nodes, c) => upsertFileNode(nodes, c.filename), prev));
				openPendingChange(proposed[0]);
				setChatMessages((prev) => [...prev, { role: "assistant", content: parsed?.summary || `Proposed ${proposed.length} change${proposed.length === 1 ? "" : "s"} — review the diff then **Accept** or **Discard**.` }]);
			} else if (chatMode === "agent") {
				setChatMessages((prev) => [...prev, { role: "assistant", content: parsed?.summary || parsed?.answer || extractJsonSummary(aiReply) || "No changes made." }]);
			} else {
				setChatMessages((prev) => [...prev, { role: "assistant", content: parsed?.answer || aiReply || "(No reply)" }]);
			}
		} catch (err) {
			if (chatStopRequestedRef.current || abort.signal.aborted || (err instanceof DOMException && err.name === "AbortError")) { setChatMessages((prev) => [...prev, { role: "assistant", content: "Stopped." }]); return; }
			setChatMessages((prev) => [...prev, { role: "assistant", content: `Error: ${err instanceof Error ? err.message : "Unable to get response."}` }]);
		} finally {
			if (chatAbortControllerRef.current === abort) chatAbortControllerRef.current = null;
			chatStopRequestedRef.current = false; setIsThinking(false); setStreamingContent("");
		}
	}

	// ── File tree render ──────────────────────────────────────────────────────

	function renderFiles(nodes: FileNode[], parentPath = ""): React.ReactNode {
		return nodes.map((file) => {
			const path = `${parentPath}/${file.name}`;
			if (file.type === "folder") {
				const isExpanded = expandedFolders.has(path);
				return (
					<div key={path}>
						<div className="flex items-center gap-1 px-1 py-0.5 rounded hover:bg-accent/50 cursor-pointer select-none" onClick={() => toggleFolder(path)}>
							{isExpanded ? <ChevronDown className="w-3 h-3 text-muted-foreground shrink-0" /> : <ChevronRight className="w-3 h-3 text-muted-foreground shrink-0" />}
							{isExpanded ? <FolderOpen className="w-4 h-4 text-amber-400 shrink-0" /> : <Folder className="w-4 h-4 text-amber-400 shrink-0" />}
							<span className="text-sm truncate min-w-0">{file.name}</span>
						</div>
						{isExpanded && <div className="ml-3.5 border-l border-border/40 pl-1.5">{renderFiles(file.children || [], path)}</div>}
					</div>
				);
			}
			const isPending = pendingPath === path;
			const isActive = selectedFile === path;
			const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
			return (
				<div key={path} className={`group flex items-center gap-1.5 rounded px-1 py-0.5 cursor-pointer text-sm transition-colors ${isPending ? "text-amber-400 bg-amber-500/10" : isActive ? "bg-accent text-accent-foreground" : "hover:bg-accent/50"}`} onClick={() => void handleSelectFile(path)}>
					<FileText className={`w-3.5 h-3.5 shrink-0 ${getFileColor(ext)}`} />
					<span className="min-w-0 flex-1 truncate">{file.name}</span>
					{isPending && <span className="w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0" />}
				</div>
			);
		});
	}

	function renderPendingFileFallback() {
		if (!pendingPath || hasFilePath(files, pendingPath)) return null;
		const fileName = pendingPath.split("/").filter(Boolean).pop() || pendingPath;
		return (
			<div className="mt-1 flex items-center gap-1.5 rounded border border-amber-400/60 bg-amber-500/10 px-1 py-0.5 text-amber-400 cursor-pointer text-sm" onClick={() => { setSelectedFile(pendingPath); setEditorContent(pendingChange?.newContent || ""); }}>
				<FileText className="w-3.5 h-3.5 shrink-0" />
				<span className="min-w-0 flex-1 truncate">{fileName}</span>
				<span className="rounded bg-amber-400/20 px-1 py-0.5 text-[10px] font-semibold uppercase">new</span>
			</div>
		);
	}

	// ── Render ────────────────────────────────────────────────────────────────

	return (
		<div className="flex w-full h-full min-h-0 flex-col overflow-hidden bg-background">
			{/* ═══ Main row ═══════════════════════════════════════════════ */}
			<div className="flex min-h-0 flex-1 overflow-hidden">

				{/* ── Explorer ───────────────────────────────────────────── */}
				{filesCollapsed ? (
					<Button className="h-full w-9 rounded-none border-r border-border/50 shrink-0" variant="ghost" size="icon" onClick={() => setFilesCollapsed(false)} title="Open explorer">
						<ChevronRight className="h-4 w-4" />
					</Button>
				) : (
					<div className="flex flex-col bg-card border-r border-border/50 overflow-hidden shrink-0" style={{ width: filesWidth }}>
						{/* Explorer header */}
						<div className="flex items-center gap-1 px-2 py-1.5 border-b border-border/50 shrink-0">
							<span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground flex-1 select-none">Explorer</span>
							<Button size="icon" variant="ghost" className="h-6 w-6" onClick={() => void handleBrowseFolder()} title="Open folder" disabled={isPickingFolder}><FolderOpen className="h-3.5 w-3.5" /></Button>
							<Button size="icon" variant="ghost" className="h-6 w-6" onClick={() => setShowNewFileInput(true)} title="New file"><FilePlus className="h-3.5 w-3.5" /></Button>
							<Button size="icon" variant="ghost" className="h-6 w-6" onClick={() => setShowNewFolderInput(true)} title="New folder"><FolderPlus className="h-3.5 w-3.5" /></Button>
							<Button size="icon" variant="ghost" className="h-6 w-6" onClick={() => setFilesCollapsed(true)} title="Close explorer"><PanelLeftClose className="h-3.5 w-3.5" /></Button>
						</div>

						{/* Root label */}
						{ideRoot && (
							<div className="px-2 py-1 border-b border-border/50 shrink-0 cursor-pointer hover:opacity-80" onClick={() => setShowOpenFolderInput((v) => !v)} title={ideRoot}>
								<div className="flex items-center gap-1.5">
									<Folder className="h-3.5 w-3.5 text-amber-400 shrink-0" />
									<span className="text-xs font-semibold truncate uppercase">{ideRootName}</span>
								</div>
							</div>
						)}

						{/* Open folder input */}
						{showOpenFolderInput && (
							<div className="flex gap-1 p-2 border-b border-border/50 shrink-0">
								<Input type="text" value={openFolderPath} onChange={(e) => setOpenFolderPath(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void handleOpenFolder(); if (e.key === "Escape") { setOpenFolderPath(""); setShowOpenFolderInput(false); } }} placeholder="Folder path…" className="h-7 text-xs" autoFocus />
								<Button size="sm" className="h-7 px-2 text-xs" onClick={() => void handleOpenFolder()}>Open</Button>
								<Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => { setOpenFolderPath(""); setShowOpenFolderInput(false); }}><X className="h-3 w-3" /></Button>
							</div>
						)}

						{/* Pending changes panel — like VS Code Source Control */}
						{pendingChanges.length > 0 && (
							<div className="border-b border-amber-400/30 bg-amber-500/5 shrink-0">
								{/* Header row */}
								<div className="flex items-center gap-1 px-2 pt-1.5 pb-1">
									<GitPullRequestDraft className="h-3.5 w-3.5 text-amber-400 shrink-0" />
									<span className="text-[11px] font-semibold text-amber-400 uppercase tracking-wide flex-1">
										Changes ({pendingChanges.length})
									</span>
									<button
										className="h-5 w-5 flex items-center justify-center rounded hover:bg-green-600/20 text-green-400 transition-colors"
										title="Accept All"
										onClick={() => void handleAcceptAllChanges()}
									>
										<Check className="h-3 w-3" />
									</button>
									<button
										className="h-5 w-5 flex items-center justify-center rounded hover:bg-red-500/20 text-muted-foreground hover:text-red-400 transition-colors"
										title="Discard All"
										onClick={handleDiscardAllChanges}
									>
										<X className="h-3 w-3" />
									</button>
								</div>

								{/* Per-file list */}
								<div className="max-h-40 overflow-y-auto pb-1">
									{pendingChanges.map((change) => {
										const path = normalizeFilePath(change.filename);
										const name = path.split("/").filter(Boolean).pop() ?? path;
										const isActive = selectedFile === path;
										const isNew = !change.oldContent;
										const ext = name.split(".").pop()?.toLowerCase() ?? "";
										return (
											<div
												key={path}
												className={`group flex items-center gap-1.5 px-2 py-0.5 cursor-pointer transition-colors ${isActive ? "bg-amber-500/20" : "hover:bg-amber-500/10"}`}
												onClick={() => openPendingChange(change)}
												title={path}
											>
												<FileText className={`w-3 h-3 shrink-0 ${getFileColor(ext)}`} />
												<span className="flex-1 min-w-0 truncate text-[11px] text-amber-300">
													{name}
												</span>
												<span className={`text-[9px] font-semibold uppercase px-1 rounded shrink-0 ${isNew ? "bg-green-500/20 text-green-400" : "bg-amber-500/20 text-amber-400"}`}>
													{isNew ? "A" : "M"}
												</span>
												{/* Per-file accept / discard — visible on hover */}
												<button
													className="opacity-0 group-hover:opacity-100 h-4 w-4 flex items-center justify-center rounded hover:bg-green-600/30 text-green-400 transition-opacity"
													title="Accept this file"
													onClick={(e) => { e.stopPropagation(); void handleAcceptSpecificChange(change); }}
												>
													<Check className="h-2.5 w-2.5" />
												</button>
												<button
													className="opacity-0 group-hover:opacity-100 h-4 w-4 flex items-center justify-center rounded hover:bg-red-500/30 text-muted-foreground hover:text-red-400 transition-opacity"
													title="Discard this file"
													onClick={(e) => { e.stopPropagation(); handleDiscardSpecificChange(change); }}
												>
													<X className="h-2.5 w-2.5" />
												</button>
											</div>
										);
									})}
								</div>

								{/* Bottom action bar */}
								<div className="flex gap-1 px-2 pb-1.5">
									<Button size="sm" className="h-6 px-2 text-[11px] bg-green-600 hover:bg-green-700 text-white flex-1" onClick={() => void handleAcceptAllChanges()}>
										<Check className="h-3 w-3 mr-1" />Accept All
									</Button>
									<Button size="sm" variant="ghost" className="h-6 px-2 text-[11px] flex-1" onClick={handleDiscardAllChanges}>
										<X className="h-3 w-3 mr-1" />Discard All
									</Button>
								</div>
							</div>
						)}

						{/* New file input */}
						{showNewFileInput && (
							<div className="flex gap-1 p-2 border-b border-border/50 shrink-0">
								<Input type="text" value={newFileName} onChange={(e) => setNewFileName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") handleAddFile(); if (e.key === "Escape") { setNewFileName(""); setShowNewFileInput(false); } }} placeholder="filename.py" className="h-7 text-xs" autoFocus />
								<Button size="sm" className="h-7 px-2 text-xs" onClick={handleAddFile}>Add</Button>
								<Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => { setNewFileName(""); setShowNewFileInput(false); }}><X className="h-3 w-3" /></Button>
							</div>
						)}

						{/* New folder input */}
						{showNewFolderInput && (
							<div className="flex gap-1 p-2 border-b border-border/50 shrink-0">
								<Input type="text" value={newFolderName} onChange={(e) => setNewFolderName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") handleAddFolder(); if (e.key === "Escape") { setNewFolderName(""); setShowNewFolderInput(false); } }} placeholder="folder-name" className="h-7 text-xs" autoFocus />
								<Button size="sm" className="h-7 px-2 text-xs" onClick={handleAddFolder}>Add</Button>
								<Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => { setNewFolderName(""); setShowNewFolderInput(false); }}><X className="h-3 w-3" /></Button>
							</div>
						)}

						{/* File tree */}
						<div className="flex-1 min-h-0 overflow-y-auto p-1 text-sm">
							{files.length > 0 ? renderFiles(files) : (
								<div className="p-4 text-xs text-muted-foreground text-center leading-relaxed">
									No folder open.<br />Click the folder icon above.
								</div>
							)}
							{renderPendingFileFallback()}
						</div>
					</div>
				)}

				{/* Resize handle: explorer/editor */}
				{!filesCollapsed && !editorCollapsed && (
					<div className="w-1 shrink-0 cursor-col-resize bg-border/20 hover:bg-primary/60 transition-colors" onMouseDown={(e) => startResizePane("files", e)} />
				)}

				{/* ── Editor ─────────────────────────────────────────────── */}
				{editorCollapsed ? (
					<Button className="h-full w-9 rounded-none border-r border-border/50 shrink-0" variant="ghost" size="icon" onClick={() => setEditorCollapsed(false)} title="Open editor">
						<ChevronRight className="h-4 w-4" />
					</Button>
				) : (
					<div className="flex-1 min-w-0 flex flex-col min-h-0 overflow-hidden">
						{/* Tab bar */}
						<div className="flex items-stretch border-b border-border/50 bg-muted/20 shrink-0 overflow-x-auto" style={{ scrollbarWidth: "none" }}>
							{openTabs.map((tab) => {
								const name = tab.split("/").filter(Boolean).pop() ?? tab;
								const isActive = tab === selectedFile;
								const isPending = pendingChanges.some((c) => normalizeFilePath(c.filename) === tab);
								const ext = name.split(".").pop()?.toLowerCase() ?? "";
								return (
									<div key={tab} className={`group flex items-center gap-1.5 px-3 py-1.5 cursor-pointer text-sm shrink-0 border-r border-border/30 transition-colors select-none ${isActive ? "bg-background text-foreground border-b-2 border-b-primary -mb-px" : "text-muted-foreground hover:text-foreground hover:bg-background/50"}`} onClick={() => void handleSelectFile(tab)}>
										<FileText className={`w-3.5 h-3.5 shrink-0 ${getFileColor(ext)}`} />
										<span className={isPending ? "text-amber-400" : ""}>{name}</span>
										{isPending && <span className="w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0" />}
										<button className="opacity-0 group-hover:opacity-100 h-4 w-4 flex items-center justify-center rounded hover:bg-muted/80 ml-0.5 transition-opacity" onClick={(e) => { e.stopPropagation(); handleCloseTab(tab); }}><X className="h-2.5 w-2.5" /></button>
									</div>
								);
							})}
							{openTabs.length === 0 && <div className="flex items-center px-3 text-xs text-muted-foreground select-none">No files open</div>}
							<div className="flex-1" />
							<Button size="icon" variant="ghost" className="h-full w-8 rounded-none shrink-0" onClick={() => setEditorCollapsed(true)} title="Collapse editor"><PanelLeftClose className="h-3.5 w-3.5" /></Button>
						</div>

						{/* Diff banner */}
						{showDiffEditor && pendingChange && (
							<div className="flex items-center gap-2 px-3 py-1.5 bg-amber-500/10 border-b border-amber-400/30 shrink-0">
								<GitPullRequestDraft className="h-3.5 w-3.5 text-amber-400 shrink-0" />
								<span className="text-xs text-amber-400 font-medium flex-1 truncate">
									{pendingIsNewFile ? "New file" : "Proposed edit"} · <span className="opacity-70">{pendingPath}</span>
								</span>
								<Button size="sm" className="h-6 px-2 text-[11px] bg-green-600 hover:bg-green-700 text-white shrink-0" onClick={() => void handleAcceptChange()}><Check className="h-3 w-3 mr-1" />Accept</Button>
								{pendingChanges.length > 1 && <Button size="sm" className="h-6 px-2 text-[11px] bg-green-600 hover:bg-green-700 text-white shrink-0" onClick={() => void handleAcceptAllChanges()}>Accept All ({pendingChanges.length})</Button>}
								<Button size="sm" variant="ghost" className="h-6 px-2 text-[11px] shrink-0" onClick={handleDiscardChange}><X className="h-3 w-3 mr-1" />Discard</Button>
								<span className="text-[10px] text-muted-foreground hidden sm:block opacity-60">Ctrl+S to accept</span>
							</div>
						)}

						{/* Monaco */}
						<div className="flex-1 min-h-0 overflow-hidden">
							{!selectedFile ? (
								<div className="h-full flex items-center justify-center text-muted-foreground">
									<div className="text-center space-y-3">
										<FileText className="h-12 w-12 mx-auto opacity-20" />
										<p className="text-sm">Select a file to open</p>
										<p className="text-xs opacity-50">or ask the agent to create one</p>
									</div>
								</div>
							) : showDiffEditor && pendingChange ? (
								<DiffEditor
									original={pendingChange.oldContent}
									modified={pendingChange.newContent}
									language={language}
									theme={isDark ? "vs-dark" : "vs"}
									height="100%"
									options={MONACO_DIFF_OPTIONS}
									onMount={handleDiffEditorMount}
								/>
							) : (
								<Editor
									value={editorContent}
									language={language}
									theme={isDark ? "vs-dark" : "vs"}
									height="100%"
									options={MONACO_EDITOR_OPTIONS}
									onMount={handleEditorMount}
									onChange={(value: string | undefined) => {
										const v = value ?? "";
										setEditorContent(v);
										if (selectedFile) setFileContents((prev) => ({ ...prev, [selectedFile]: v }));
									}}
								/>
							)}
						</div>

						{/* Status bar */}
						<div className="flex items-center gap-3 px-3 py-0.5 bg-primary text-primary-foreground text-[11px] shrink-0 select-none">
							<span className="font-medium">{statusBarLanguage}</span>
							<span className="opacity-70">Ln {cursorPos.line}, Col {cursorPos.col}</span>
							{selectedFile && <span className="opacity-50 truncate max-w-[40%]">{selectedFile}</span>}
							<div className="flex-1" />
							<span className="opacity-50">UTF-8</span>
							{pendingChanges.length > 0 && <span className="rounded bg-amber-400/30 px-1.5 py-0.5 font-semibold">{pendingChanges.length} pending</span>}
						</div>
					</div>
				)}

				{/* Resize handle: editor/chat */}
				{!chatCollapsed && !editorCollapsed && (
					<div className="w-1 shrink-0 cursor-col-resize bg-border/20 hover:bg-primary/60 transition-colors" onMouseDown={(e) => startResizePane("chat", e)} />
				)}

				{/* ── Chat ───────────────────────────────────────────────── */}
				{chatCollapsed ? (
					<Button className="h-full w-9 rounded-none border-l border-border/50 shrink-0" variant="ghost" size="icon" onClick={() => setChatCollapsed(false)} title="Open chat">
						<ChevronLeft className="h-4 w-4" />
					</Button>
				) : (
					<div className="flex flex-col bg-card border-l border-border/50 overflow-hidden shrink-0" style={{ width: chatWidth }}>
						{/* Chat header */}
						<div className="flex items-center gap-1 px-2 py-1.5 border-b border-border/50 shrink-0">
							<span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground flex-1 select-none">AI Assistant</span>
							<Button size="icon" variant="ghost" className="h-6 w-6" onClick={handleNewChat} title="New chat"><MessageSquarePlus className="h-3.5 w-3.5" /></Button>
							<Button size="icon" variant="ghost" className="h-6 w-6" onClick={() => setChatCollapsed(true)} title="Close chat"><PanelRightClose className="h-3.5 w-3.5" /></Button>
						</div>

						{/* Mode / model */}
						<div className="flex gap-2 px-2 py-1.5 border-b border-border/50 shrink-0">
							<Select value={chatMode} onValueChange={(v) => setChatMode(v as "ask" | "agent")}>
								<SelectTrigger className="h-7 w-24 text-xs"><SelectValue /></SelectTrigger>
								<SelectContent>
									<SelectItem value="ask">Ask</SelectItem>
									<SelectItem value="agent">Agent</SelectItem>
								</SelectContent>
							</Select>
							<Select value={selectedModel} onValueChange={setSelectedModel}>
								<SelectTrigger className="h-7 flex-1 text-xs min-w-0"><SelectValue placeholder="Model" /></SelectTrigger>
								<SelectContent>{availableModels.map((m) => <SelectItem key={m.id || m.name} value={m.name}>{m.name}</SelectItem>)}</SelectContent>
							</Select>
						</div>

						{/* Messages */}
						<div ref={chatScrollRef} className="flex-1 min-h-0 overflow-y-auto p-2 space-y-3">
							{chatMessages.length === 0 && !isThinking && agentActivities.length === 0 && (
								<div className="flex h-full items-center justify-center p-4">
									<div className="text-center space-y-2">
										<div className="text-2xl opacity-40">✦</div>
										<p className="text-xs text-muted-foreground leading-relaxed">
											{chatMode === "agent" ? "Agent mode: I can read, create and edit files." : "Ask mode: I'll answer questions about your code."}
										</p>
									</div>
								</div>
							)}

							{/* Activity feed */}
							{agentActivities.length > 0 && (
								<div className="rounded-md border border-border/50 bg-muted/20 overflow-hidden">
									<div className="px-2 py-1 border-b border-border/30 flex items-center gap-1.5">
										<Wrench className="h-3 w-3 text-muted-foreground" />
										<span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">Activity</span>
									</div>
									<div className="p-1.5 space-y-0.5 max-h-36 overflow-y-auto">
										{agentActivities.slice(-12).map((a) => (
											<div key={a.id} className="flex items-start gap-1.5 py-0.5">
												<ActivityIcon status={a.status} />
												<span className="min-w-0 flex-1 truncate text-[11px] text-foreground/80" title={a.detail ? `${a.label}: ${a.detail}` : a.label}>
													{a.label}{a.detail && <span className="text-muted-foreground"> · {a.detail.slice(0, 50)}{a.detail.length > 50 ? "…" : ""}</span>}
												</span>
											</div>
										))}
									</div>
								</div>
							)}

							{/* Web fetch dialog */}
							{webFetchPermission && (
								<div className="rounded-md border border-amber-400/50 bg-amber-500/10 p-2.5">
									<div className="flex items-center gap-1.5 mb-1.5"><Globe className="h-3.5 w-3.5 text-amber-400" /><span className="text-xs font-semibold text-amber-400">Allow web access?</span></div>
									<p className="text-xs text-muted-foreground mb-1">{webFetchPermission.domain}</p>
									<p className="text-[10px] text-muted-foreground/60 mb-2 truncate">{webFetchPermission.url}</p>
									<div className="flex gap-1 flex-wrap">
										<Button size="sm" className="h-6 px-2 text-[11px]" onClick={() => webFetchPermission.resolve("allow_once")}>Allow once</Button>
										<Button size="sm" variant="secondary" className="h-6 px-2 text-[11px]" onClick={() => webFetchPermission.resolve("always")}>Always</Button>
										<Button size="sm" variant="ghost" className="h-6 px-2 text-[11px]" onClick={() => webFetchPermission.resolve("deny")}>Deny</Button>
									</div>
								</div>
							)}

							{/* Messages */}
							{chatMessages.map((msg, idx) => (
								<div key={idx} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
									{msg.role === "user" ? (
										<div className="max-w-[88%] rounded-2xl rounded-tr-sm bg-primary text-primary-foreground px-3 py-2 text-sm">{msg.content}</div>
									) : (
										<div className="max-w-[96%] rounded-xl rounded-tl-sm border border-border/50 bg-background px-3 py-2 text-sm">
											<MarkdownContent content={msg.content} />
										</div>
									)}
								</div>
							))}

							{/* Streaming */}
							{isThinking && (
								<div className="flex justify-start">
									<div className="max-w-[96%] rounded-xl rounded-tl-sm border border-border/50 bg-background px-3 py-2 text-sm">
										{streamingContent ? <MarkdownContent content={streamingContent} /> : (
											<div className="flex items-center gap-2 text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" /><span className="text-xs">Thinking…</span></div>
										)}
									</div>
								</div>
							)}
						</div>

						{/* Input */}
						<div className="shrink-0 border-t border-border/50 p-2">
							<div className="rounded-xl border border-border/60 bg-background focus-within:border-primary/60 transition-colors">
								<textarea
									className="w-full resize-none bg-transparent text-sm outline-none px-3 pt-2.5 pb-1 placeholder:text-muted-foreground max-h-32 min-h-[44px]"
									value={chatInput}
									onChange={(e) => {
										setChatInput(e.target.value);
										// If user edits while browsing history, exit history mode
										if (historyIndex !== -1) {
											setHistoryIndex(-1);
											inputDraftRef.current = e.target.value;
										}
									}}
									onKeyDown={(e) => {
										if (e.key === "Enter" && !e.shiftKey) {
											e.preventDefault();
											void handleSendChat();
											return;
										}
										if (e.key === "ArrowUp") {
											// Only navigate history when cursor is on the first line
											const el = e.currentTarget;
											const atTop = el.selectionStart === 0 || !el.value.slice(0, el.selectionStart).includes("\n");
											if (!atTop) return;
											const userMsgs = chatMessages.filter((m) => m.role === "user").map((m) => m.content);
											if (!userMsgs.length) return;
											e.preventDefault();
											// Save current input as draft on first ↑
											if (historyIndex === -1) inputDraftRef.current = chatInput;
											const next = Math.min(historyIndex + 1, userMsgs.length - 1);
											setHistoryIndex(next);
											setChatInput(userMsgs[userMsgs.length - 1 - next]);
											return;
										}
										if (e.key === "ArrowDown" && historyIndex !== -1) {
											e.preventDefault();
											const userMsgs = chatMessages.filter((m) => m.role === "user").map((m) => m.content);
											const next = historyIndex - 1;
											if (next < 0) {
												// Back to draft
												setHistoryIndex(-1);
												setChatInput(inputDraftRef.current);
											} else {
												setHistoryIndex(next);
												setChatInput(userMsgs[userMsgs.length - 1 - next]);
											}
										}
									}}
									placeholder={chatMode === "agent" ? "Ask agent to write or edit code…" : "Ask a question about your code…"}
									rows={2}
									disabled={isThinking}
								/>
								<div className="flex items-center justify-between px-2 pb-1.5">
									<span className="text-[10px] text-muted-foreground/40 select-none">⏎ send · ⇧⏎ newline · ↑↓ history</span>
									<div className="flex items-center gap-1">
										<Button size="icon" variant={isListening ? "secondary" : "ghost"} className="h-7 w-7" onClick={handleToggleVoiceInput} title={isListening ? "Stop voice" : "Voice input"}>
											<Mic className={`h-3.5 w-3.5 ${isListening ? "text-primary animate-pulse" : ""}`} />
										</Button>
										{isThinking ? (
											<Button size="icon" variant="destructive" className="h-7 w-7" onClick={handleStopChat} title="Stop"><X className="h-3.5 w-3.5" /></Button>
										) : (
											<Button size="icon" className="h-7 w-7" onClick={() => void handleSendChat()} disabled={!selectedModel || !chatInput.trim()} title="Send (Enter)"><Send className="h-3.5 w-3.5" /></Button>
										)}
									</div>
								</div>
							</div>
						</div>
					</div>
				)}
			</div>

			{/* ═══ Terminal resize ═══════════════════════════════════════ */}
			{!terminalCollapsed && (
				<div className="h-1 shrink-0 cursor-row-resize bg-border/20 hover:bg-primary/60 transition-colors" onMouseDown={startResizeTerminal} />
			)}

			{/* ═══ Terminal ══════════════════════════════════════════════ */}
			<div className="shrink-0 border-t border-border/50 bg-[#0d1117] overflow-hidden">
				<div className="flex items-center gap-2 px-3 py-1 border-b border-white/5">
					<Terminal className="h-3.5 w-3.5 text-white/40" />
					<span className="text-[11px] font-semibold text-white/40 uppercase tracking-wide flex-1 select-none">Terminal</span>
					<span className="max-w-[40%] truncate text-[10px] text-white/30" title={terminalCwd || ideRoot}>{terminalCwd || ideRoot}</span>
					<span className={`text-[10px] font-medium ${ptyStatus === "connected" ? "text-green-400" : ptyStatus === "error" ? "text-red-400" : "text-white/30"}`}>{ptyStatus}</span>
					<Button size="icon" variant="ghost" className="h-6 w-6 text-white/40 hover:text-white hover:bg-white/10" onClick={() => setPtyRestartKey((p) => p + 1)} title="Restart terminal"><RotateCcw className="h-3 w-3" /></Button>
					<Button size="icon" variant="ghost" className="h-6 w-6 text-white/40 hover:text-white hover:bg-white/10" onClick={() => setTerminalCollapsed((v) => !v)} title={terminalCollapsed ? "Show terminal" : "Hide terminal"}>
						{terminalCollapsed ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
					</Button>
				</div>
				<div className={terminalCollapsed ? "hidden" : "p-1"} style={{ height: terminalCollapsed ? 0 : terminalHeight }}>
					<div ref={terminalContainerRef} className="w-full h-full rounded overflow-hidden" onMouseDown={() => xtermRef.current?.focus()} onFocus={() => xtermRef.current?.focus()} tabIndex={0} />
				</div>
			</div>
		</div>
	);
}
