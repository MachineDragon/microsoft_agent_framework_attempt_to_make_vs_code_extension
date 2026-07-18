import { useState, useCallback, useRef, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Upload, Trash2, RefreshCw, Download, MessageSquare, Workflow, ChevronLeft, ChevronRight, ChevronDown, Mic, X, CheckCircle2, GripVertical, LayoutDashboard, Gauge, Table2, BarChart3, LineChart, PieChart } from 'lucide-react';
import { useDataStore } from '@/stores/dataStore';
import type { CSVData } from '@/stores/dataStore';
import { useAppStore } from '@/stores/appStore';
import type { AgentInfo } from '@/types';
import { apiClient } from '@/services/api';
import { getStoredJSON, getStoredString, setStoredJSON, setStoredString } from '@/services/extensionStorage';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ScrollArea } from '@/components/ui/scroll-area';

type DashboardWidgetType = 'kpi' | 'bar' | 'pie' | 'line' | 'table';

type DashboardWidget = {
  type: DashboardWidgetType;
  title: string;
  category?: string;
  value?: string;
  columns?: string[];
  aggregation?: 'count' | 'sum' | 'avg' | 'min' | 'max';
  limit?: number;
};

type DashboardSpec = {
  title: string;
  widgets: DashboardWidget[];
};

type DashboardCalculation = {
  id: string;
  name: string;
  fileId: string;
  fileName: string;
  formula: string;
  createdAt: string;
  updatedAt: string;
};

type DashboardFilters = Record<string, string>;

type DataAssistantMode = 'chat' | 'dashboards' | 'builder';

type SavedDashboard = {
  id: string;
  name: string;
  fileId: string;
  fileName: string;
  spec?: DashboardSpec;
  sheetIds?: string[];
  createdAt: string;
  updatedAt: string;
};

type SavedSheet = {
  id: string;
  name: string;
  fileId: string;
  fileName: string;
  widget: DashboardWidget;
  createdAt: string;
  updatedAt: string;
};

const DASHBOARD_COLORS = ['#2563eb', '#16a34a', '#f97316', '#dc2626', '#7c3aed', '#0891b2', '#ca8a04', '#db2777'];

function extractJsonObject(text: string) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1] || text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

function isNumericColumn(rows: string[][], columnIndex: number) {
  const values = rows.map(row => row[columnIndex]).filter(value => value !== undefined && String(value).trim() !== '');
  if (values.length === 0) return false;
  return values.slice(0, 25).every(value => Number.isFinite(Number(String(value).replace(/[$,%]/g, ''))));
}

function parseNumericValue(value: string | undefined) {
  const parsed = Number(String(value ?? '').replace(/[$,%]/g, ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function evaluateCalculatedField(file: CSVData, row: string[], calculation: DashboardCalculation) {
  const expression = calculation.formula.replace(/\[([^\]]+)\]/g, (_match, fieldName: string) => {
    const columnIndex = file.headers.indexOf(fieldName.trim());
    return String(parseNumericValue(columnIndex === -1 ? '0' : row[columnIndex]));
  });
  if (!/^[\d+\-*/().\s]+$/.test(expression)) return 0;
  try {
    const value = Function(`"use strict"; return (${expression});`)();
    return Number.isFinite(Number(value)) ? Number(value) : 0;
  } catch {
    return 0;
  }
}

function getFieldDisplayValue(file: CSVData, row: string[], fieldName: string, calculations: DashboardCalculation[] = []) {
  const columnIndex = file.headers.indexOf(fieldName);
  if (columnIndex !== -1) return String(row[columnIndex] || '(blank)');
  const calculation = calculations.find(calc => calc.name === fieldName);
  if (!calculation) return '(blank)';
  return Number(evaluateCalculatedField(file, row, calculation).toFixed(2)).toLocaleString();
}

function getFieldNumericValue(file: CSVData, row: string[], fieldName: string, calculations: DashboardCalculation[] = []) {
  const columnIndex = file.headers.indexOf(fieldName);
  if (columnIndex !== -1) return parseNumericValue(row[columnIndex]);
  const calculation = calculations.find(calc => calc.name === fieldName);
  return calculation ? evaluateCalculatedField(file, row, calculation) : 0;
}

function getUniqueFieldValues(file: CSVData, fieldName: string, calculations: DashboardCalculation[] = []) {
  return Array.from(new Set(file.rows.map(row => getFieldDisplayValue(file, row, fieldName, calculations)))).sort();
}

function getFilteredRows(file: CSVData, filters: DashboardFilters, calculations: DashboardCalculation[] = []) {
  const activeFilters = Object.entries(filters).filter(([, value]) => value && value !== '__all__');
  if (activeFilters.length === 0) return file.rows;
  return file.rows.filter(row => activeFilters.every(([header, value]) => {
    return getFieldDisplayValue(file, row, header, calculations) === value;
  }));
}

function buildDefaultDashboard(file: CSVData): DashboardSpec {
  const numericHeader = file.headers.find((_, index) => isNumericColumn(file.rows, index));
  const categoryHeader = file.headers.find((_, index) => !isNumericColumn(file.rows, index) && new Set(file.rows.map(row => row[index]).filter(Boolean)).size <= 12) || file.headers[0];
  return {
    title: `${file.filename} Dashboard`,
    widgets: [
      { type: 'kpi', title: 'Total Rows', aggregation: 'count' },
      ...(numericHeader ? [{ type: 'kpi' as const, title: `Total ${numericHeader}`, value: numericHeader, aggregation: 'sum' as const }] : []),
      ...(categoryHeader ? [{ type: 'pie' as const, title: `Rows by ${categoryHeader}`, category: categoryHeader, aggregation: 'count' as const, limit: 6 }] : []),
      ...(categoryHeader && numericHeader ? [{ type: 'bar' as const, title: `${numericHeader} by ${categoryHeader}`, category: categoryHeader, value: numericHeader, aggregation: 'sum' as const, limit: 8 }] : []),
      { type: 'table', title: 'Sample Rows', limit: 5 },
    ],
  };
}

function summarizeWidget(file: CSVData, widget: DashboardWidget, filters: DashboardFilters = {}, calculations: DashboardCalculation[] = []) {
  const rows = getFilteredRows(file, filters, calculations);
  const aggregation = widget.aggregation || (widget.value ? 'sum' : 'count');
  const limit = Math.max(1, Math.min(widget.limit || 8, 20));

  if (widget.type === 'kpi') {
    if (aggregation === 'count' || !widget.value) return { value: rows.length, label: `${rows.length} rows` };
    const values = rows.map(row => getFieldNumericValue(file, row, widget.value!, calculations));
    const total = values.reduce((sum, value) => sum + value, 0);
    const value = aggregation === 'avg' ? total / Math.max(values.length, 1) : aggregation === 'min' ? Math.min(...values) : aggregation === 'max' ? Math.max(...values) : total;
    return { value, label: Number(value.toFixed(2)).toLocaleString() };
  }

  if (widget.type === 'table') {
    return { rows: rows.slice(0, limit) };
  }

  if (!widget.category) return { groups: [] };
  const grouped = new Map<string, number[]>();
  for (const row of rows) {
    const key = getFieldDisplayValue(file, row, widget.category, calculations);
    const values = grouped.get(key) || [];
    values.push(widget.value ? getFieldNumericValue(file, row, widget.value, calculations) : 1);
    grouped.set(key, values);
  }

  const groups = [...grouped.entries()].map(([name, values]) => {
    const sum = values.reduce((total, value) => total + value, 0);
    const value = aggregation === 'count' ? values.length : aggregation === 'avg' ? sum / Math.max(values.length, 1) : aggregation === 'min' ? Math.min(...values) : aggregation === 'max' ? Math.max(...values) : sum;
    return { name, value };
  }).sort((a, b) => b.value - a.value).slice(0, limit);
  return { groups };
}

function buildWidgetFromControls(type: DashboardWidgetType, title: string, category: string, value: string, aggregation: DashboardWidget['aggregation'], limit: number, columns: string[] = []): DashboardWidget {
  return {
    type,
    title,
    ...(category ? { category } : {}),
    ...(value ? { value } : {}),
    ...(columns.length > 0 ? { columns } : {}),
    aggregation: aggregation || (value ? 'sum' : 'count'),
    limit,
  };
}

function inferColumnsFromText(file: CSVData, text: string, allowedColumns?: string[]) {
  const normalizedText = text.toLowerCase();
  const headers = allowedColumns?.length ? file.headers.filter(header => allowedColumns.includes(header)) : file.headers;
  const mentionedHeaders = headers.filter(header => normalizedText.includes(header.toLowerCase()));
  const mentionedNumericHeader = mentionedHeaders.find(header => isNumericColumn(file.rows, file.headers.indexOf(header))) || '';
  const mentionedCategoryHeader = mentionedHeaders.find(header => !isNumericColumn(file.rows, file.headers.indexOf(header))) || '';
  const fallbackNumericHeader = headers.find(header => isNumericColumn(file.rows, file.headers.indexOf(header))) || '';
  const fallbackCategoryHeader = headers.find(header => !isNumericColumn(file.rows, file.headers.indexOf(header))) || headers[0] || '';
  return {
    category: mentionedCategoryHeader || fallbackCategoryHeader,
    value: mentionedNumericHeader || fallbackNumericHeader,
  };
}

function describeArcSlice(startPercent: number, endPercent: number) {
  const toPoint = (percent: number) => {
    const angle = (percent * 360 - 90) * Math.PI / 180;
    return { x: 50 + 42 * Math.cos(angle), y: 50 + 42 * Math.sin(angle) };
  };
  const start = toPoint(startPercent);
  const end = toPoint(endPercent);
  const largeArc = endPercent - startPercent > 0.5 ? 1 : 0;
  return `M 50 50 L ${start.x} ${start.y} A 42 42 0 ${largeArc} 1 ${end.x} ${end.y} Z`;
}

type DataPageProps = {
  initialAssistantMode?: DataAssistantMode;
  onOpenDashboards?: () => void;
};

export function DataPage({ initialAssistantMode = 'chat', onOpenDashboards }: DataPageProps) {
  const { csvFiles, selectedFile, addCSVFile, updateCSVFile, removeCSVFile, selectFile, getFileContext } = useDataStore();
  const { 
    agents,
    orchestrationType,
    setOrchestrationType,
    sendMessageToMultipleAgents,
    chatMessages,
    isStreaming,
    setSelectedAgents,
    stopCurrentResponse
  } = useAppStore();
  
  // Local state for data page agent selection
  const [dataChatTarget, setDataChatTarget] = useState<'agents' | 'model'>('agents');
  const [dataPageSelectedAgents, setDataPageSelectedAgents] = useState<AgentInfo[]>([]);
  const [availableModels, setAvailableModels] = useState<Array<{ name: string; id: string; size: string; modified: string }>>([]);
  const [selectedModel, setSelectedModel] = useState('');
  const [modelMessages, setModelMessages] = useState<Array<{ role: 'user' | 'assistant'; content: string }>>([]);
  const [modelIsStreaming, setModelIsStreaming] = useState(false);
  const [dashboardSpec, setDashboardSpec] = useState<DashboardSpec | null>(null);
  const [dashboardIsGenerating, setDashboardIsGenerating] = useState(false);
  const [dashboardPrompt, setDashboardPrompt] = useState('Create a useful dashboard for this CSV data');
  const [, setDashboardBuildStatus] = useState('Ready to build a dashboard.');
  const [dashboardBuildPreview, setDashboardBuildPreview] = useState('');
  const [dashboardFilters, setDashboardFilters] = useState<DashboardFilters>({});
  const [savedDashboardSpec, setSavedDashboardSpec] = useState<DashboardSpec | null>(null);
  const [dashboardName, setDashboardName] = useState('');
  const [savedDashboards, setSavedDashboards] = useState<SavedDashboard[]>([]);
  const [savedSheets, setSavedSheets] = useState<SavedSheet[]>([]);
  const [dashboardCalculations, setDashboardCalculations] = useState<DashboardCalculation[]>([]);
  const [selectedSavedDashboardId, setSelectedSavedDashboardId] = useState('');
  const [dashboardSearch, setDashboardSearch] = useState('');
  const [sheetName, setSheetName] = useState('New Sheet');
  const [sheetType, setSheetType] = useState<DashboardWidgetType>('bar');
  const [sheetCategory, setSheetCategory] = useState('');
  const [sheetValue, setSheetValue] = useState('');
  const [sheetAllowedColumns, setSheetAllowedColumns] = useState<string[]>([]);
  const [sheetAggregation, setSheetAggregation] = useState<DashboardWidget['aggregation']>('sum');
  const [sheetLimit, setSheetLimit] = useState(8);
  const [sheetAdvancedOpen, setSheetAdvancedOpen] = useState(false);
  const [sheetBuilderStep, setSheetBuilderStep] = useState<'configure' | 'review'>('configure');
  const [sheetDraft, setSheetDraft] = useState<DashboardWidget | null>(null);
  const [targetDashboardId, setTargetDashboardId] = useState('');
  const [newDashboardName, setNewDashboardName] = useState('');
  const [sheetSaveDestinationOpen, setSheetSaveDestinationOpen] = useState(false);
  const [sheetSaveSuccess, setSheetSaveSuccess] = useState('');
  const [draggedSheetId, setDraggedSheetId] = useState('');
  const [dragOverSheetId, setDragOverSheetId] = useState('');
  const [selectedDashboardSheetId, setSelectedDashboardSheetId] = useState('');
  const [dashboardFilterColumn, setDashboardFilterColumn] = useState('');
  const [calculationName, setCalculationName] = useState('');
  const [calculationFormula, setCalculationFormula] = useState('');
  const [sheetTooltip, setSheetTooltip] = useState<{ x: number; y: number; content: string } | null>(null);
  const [isListening, setIsListening] = useState(false);
  const [isAgentSelectorOpen, setIsAgentSelectorOpen] = useState(false);
  const [isOrchestrationSelectorOpen, setIsOrchestrationSelectorOpen] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState<string | null>(null);
  const [chatInput, setChatInput] = useState('');
  const [liveUpdateEnabled, setLiveUpdateEnabled] = useState<Record<string, boolean>>({});
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [isChatCollapsed, setIsChatCollapsed] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const fileMapRef = useRef<Map<string, any>>(new Map());
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const modelAbortControllerRef = useRef<AbortController | null>(null);
  const speechRecognitionRef = useRef<any>(null);
  const voiceInputBaseRef = useRef('');
  const dataPreferencesLoadedRef = useRef(false);
  const visibleMessages = dataChatTarget === 'model' ? modelMessages : chatMessages;
  const chatBusy = dataChatTarget === 'model' ? modelIsStreaming : isStreaming;
  const liveModelAssistantIndex = dataChatTarget === 'model' && modelIsStreaming && modelMessages.at(-1)?.role === 'assistant'
    ? modelMessages.length - 1
    : -1;
  const dashboardHasUnsavedChanges = Boolean(dashboardSpec && JSON.stringify(dashboardSpec) !== JSON.stringify(savedDashboardSpec));
  const visibleSavedDashboards = savedDashboards.filter(dashboard => dashboard.name.toLowerCase().includes(dashboardSearch.toLowerCase()));
  const selectedSheetColumns = selectedFile ? (sheetAllowedColumns.length > 0 ? selectedFile.headers.filter(header => sheetAllowedColumns.includes(header)) : selectedFile.headers) : [];
  const fileCalculations = selectedFile ? dashboardCalculations.filter(calculation => calculation.fileId === selectedFile.id) : [];
  const availableSheetFields = selectedFile ? [...selectedFile.headers, ...fileCalculations.map(calculation => calculation.name)] : [];

  const persistSavedDashboards = (dashboards: SavedDashboard[]) => {
    setSavedDashboards(dashboards);
    void setStoredJSON('data.savedDashboards', dashboards);
  };

  const persistSavedSheets = (sheets: SavedSheet[]) => {
    setSavedSheets(sheets);
    void setStoredJSON('data.savedSheets', sheets);
  };

  const persistDashboardCalculations = (calculations: DashboardCalculation[]) => {
    setDashboardCalculations(calculations);
    void setStoredJSON('data.dashboardCalculations', calculations);
  };

  const showSheetTooltip = (event: React.MouseEvent, content: string) => {
    setSheetTooltip({ x: event.clientX + 12, y: event.clientY + 12, content });
  };

  const toggleSheetColumn = (header: string) => {
    setSheetAllowedColumns(prev => prev.includes(header) ? prev.filter(column => column !== header) : [...prev, header]);
  };

  const getDashboardSpec = useCallback((dashboard: SavedDashboard): DashboardSpec => {
    if (dashboard.spec) return dashboard.spec;
    const widgets = (dashboard.sheetIds || [])
      .map(sheetId => savedSheets.find(sheet => sheet.id === sheetId))
      .filter((sheet): sheet is SavedSheet => Boolean(sheet))
      .map(sheet => ({ ...sheet.widget, title: sheet.widget.title || sheet.name }));
    return { title: dashboard.name, widgets };
  }, [savedSheets]);

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatMessages, modelMessages, dataChatTarget, modelIsStreaming]);

  useEffect(() => {
    let cancelled = false;
    const loadDataPreferences = async () => {
      const [storedTarget, storedModel, dashboards, sheets, calculations] = await Promise.all([
        getStoredString('data.chatTarget'),
        getStoredString('data.selectedModel'),
        getStoredJSON<SavedDashboard[]>('data.savedDashboards', []),
        getStoredJSON<SavedSheet[]>('data.savedSheets', []),
        getStoredJSON<DashboardCalculation[]>('data.dashboardCalculations', []),
      ]);
      if (cancelled) return;
      setDataChatTarget(storedTarget === 'model' ? 'model' : 'agents');
      if (storedModel) setSelectedModel(storedModel);
      setSavedDashboards(Array.isArray(dashboards) ? dashboards : []);
      setSavedSheets(Array.isArray(sheets) ? sheets : []);
      setDashboardCalculations(Array.isArray(calculations) ? calculations : []);
      dataPreferencesLoadedRef.current = true;
    };
    void loadDataPreferences();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    async function fetchModels() {
      const models = await apiClient.getOllamaModels();
      setAvailableModels(models);
      setSelectedModel(prev => {
        if (prev && models.some(model => model.name === prev)) return prev;
        return models[0]?.name || '';
      });
    }
    void fetchModels();
  }, []);

  useEffect(() => {
    if (!dataPreferencesLoadedRef.current) return;
    void setStoredString('data.chatTarget', dataChatTarget);
  }, [dataChatTarget]);

  useEffect(() => {
    if (!dataPreferencesLoadedRef.current) return;
    if (selectedModel) {
      void setStoredString('data.selectedModel', selectedModel);
    }
  }, [selectedModel]);

  useEffect(() => {
    if (!sheetSaveSuccess) return;
    const timeoutId = window.setTimeout(() => setSheetSaveSuccess(''), 2500);
    return () => window.clearTimeout(timeoutId);
  }, [sheetSaveSuccess]);

  useEffect(() => {
    const selectedSaved = savedDashboards.find(dashboard => dashboard.id === selectedSavedDashboardId && dashboard.fileId === selectedFile?.id);
    if (selectedSaved) {
      const selectedSpec = getDashboardSpec(selectedSaved);
      setDashboardSpec(selectedSpec);
      setSavedDashboardSpec(selectedSpec);
      setDashboardName(selectedSaved.name);
    } else {
      setDashboardSpec(null);
      setSavedDashboardSpec(null);
      setDashboardName(selectedFile ? `${selectedFile.filename} Dashboard` : '');
    }
    setDashboardFilters({});
    setDashboardBuildStatus('Ready to build a dashboard.');
    setDashboardBuildPreview('');
    setSheetDraft(null);
    setSheetBuilderStep('configure');
    setSheetName(selectedFile ? `${selectedFile.filename} Sheet` : 'New Sheet');
    setSheetCategory(selectedFile?.headers[0] || '');
    setSheetValue(selectedFile?.headers.find((_, index) => isNumericColumn(selectedFile.rows, index)) || '');
    setSheetAllowedColumns(selectedFile?.headers || []);
    setTargetDashboardId('');
    setNewDashboardName(selectedFile ? `${selectedFile.filename} Dashboard` : '');
    setDashboardFilterColumn('');
    setCalculationName('');
    setCalculationFormula('');
  }, [selectedFile, selectedSavedDashboardId, savedDashboards, getDashboardSpec]);

  // Toggle agent selection
  const toggleAgentSelection = (agent: AgentInfo) => {
    setDataPageSelectedAgents(prev => {
      const isSelected = prev.some(a => a.id === agent.id);
      if (isSelected) {
        return prev.filter(a => a.id !== agent.id);
      } else {
        return [...prev, agent];
      }
    });
  };

  // File watching with polling (check every 1 second)
  useEffect(() => {
    if (!selectedFile) return;
    
    const fileId = selectedFile.id;
    const fileHandle = fileMapRef.current.get(fileId);
    if (!fileHandle) return;

    // Only enable live updates for FileSystemFileHandle
    const hasLiveUpdate = 'getFile' in fileHandle;
    setLiveUpdateEnabled(prev => ({ ...prev, [fileId]: hasLiveUpdate }));

    if (!hasLiveUpdate) {
      console.log('Live updates not available for', selectedFile.filename, '- use "Select Files" button instead of drag & drop');
      return;
    }

    const interval = setInterval(async () => {
      try {
        // Re-fetch the file from the handle to get latest content
        const freshFile = await fileHandle.getFile();
        const currentContent = await freshFile.text();
        const { headers, rows } = parseCSV(currentContent);
        
        // Check if content has changed
        const currentFile = csvFiles.find(f => f.id === fileId);
        if (currentFile) {
          const contentChanged = 
            JSON.stringify(currentFile.headers) !== JSON.stringify(headers) ||
            JSON.stringify(currentFile.rows) !== JSON.stringify(rows);
          
          if (contentChanged) {
            console.log('✅ CSV file changed, updating UI:', currentFile.filename);
            updateCSVFile(fileId, {
              ...currentFile,
              headers,
              rows,
              lastModified: new Date(),
            });
          }
        }
      } catch (error) {
        console.error('Error watching file:', error);
      }
    }, 1000); // Check every 1 second

    return () => clearInterval(interval);
  }, [selectedFile, csvFiles, updateCSVFile]);

  // Parse CSV content
  const parseCSV = (content: string): { headers: string[]; rows: string[][] } => {
    const lines = content.split('\n').filter((line) => line.trim());
    if (lines.length === 0) return { headers: [], rows: [] };

    const headers = lines[0].split(',').map((h) => h.trim());
    const rows = lines.slice(1).map((line) => {
      // Handle quoted fields and commas within quotes
      const regex = /(".*?"|[^",\s]+)(?=\s*,|\s*$)/g;
      const fields: string[] = [];
      let match;
      while ((match = regex.exec(line)) !== null) {
        fields.push(match[0].replace(/^"|"$/g, '').trim());
      }
      return fields;
    });

    return { headers, rows };
  };

  // Handle file upload
  async function handleFileUpload(file: File) {
    try {
      const content = await file.text();
      const { headers, rows } = parseCSV(content);

      const csvData: CSVData = {
        id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        filename: file.name,
        headers,
        rows,
        uploadedAt: new Date(),
        lastModified: new Date(),
      };

      addCSVFile(csvData);
      selectFile(csvData.id);
      fileMapRef.current.set(csvData.id, file);
    } catch (error) {
      console.error('Error parsing CSV:', error);
      alert('Failed to parse CSV file');
    }
  }

  const handleNativeCSVPicker = async () => {
    try {
      const data = await apiClient.pickDataCSVFiles();
      if (data.cancelled || data.files.length === 0) return;

      for (const pickedFile of data.files) {
        const { headers, rows } = parseCSV(pickedFile.content);
        const csvData: CSVData = {
          id: `pc:${pickedFile.path}`,
          filename: pickedFile.filename,
          headers,
          rows,
          uploadedAt: new Date(),
          lastModified: new Date(pickedFile.last_modified),
        };

        const existing = useDataStore.getState().csvFiles.some(file => file.id === csvData.id);
        if (existing) {
          updateCSVFile(csvData.id, csvData);
        } else {
          addCSVFile(csvData);
        }
        selectFile(csvData.id);
      }
    } catch (error) {
      console.error('Error picking CSV file:', error);
      await handleFileSystemPicker();
    }
  };

  // Use File System Access API as browser fallback
  const handleFileSystemPicker = async () => {
    try {
      // Check if File System Access API is available
      if ('showOpenFilePicker' in window) {
        const [fileHandle] = await (window as any).showOpenFilePicker({
          types: [
            {
              description: 'CSV Files',
              accept: { 'text/csv': ['.csv'] },
            },
          ],
          multiple: false,
        });

        const file = await fileHandle.getFile();
        const content = await file.text();
        const { headers, rows } = parseCSV(content);

        const csvData: CSVData = {
          id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
          filename: file.name,
          headers,
          rows,
          uploadedAt: new Date(),
          lastModified: new Date(),
        };

        addCSVFile(csvData);
        selectFile(csvData.id);
        // Store the FileSystemFileHandle for live updates
        fileMapRef.current.set(csvData.id, fileHandle);
      } else {
        // Fallback to regular file input
        fileInputRef.current?.click();
      }
    } catch (error) {
      // User cancelled or error occurred
      if ((error as Error).name !== 'AbortError') {
        console.error('Error picking file:', error);
      }
    }
  };

  // Manual refresh
  const handleRefresh = async (fileId: string) => {
    setIsRefreshing(fileId);
    try {
      const file = fileMapRef.current.get(fileId);
      if (file) {
        const content = await file.text();
        const { headers, rows } = parseCSV(content);
        
        const currentFile = csvFiles.find((f) => f.id === fileId);
        if (currentFile) {
          updateCSVFile(fileId, {
            ...currentFile,
            headers,
            rows,
            lastModified: new Date(),
          });
        }
      }
    } catch (error) {
      console.error('Error refreshing file:', error);
    } finally {
      setIsRefreshing(null);
    }
  };

  // Download CSV
  const handleDownload = (file: CSVData) => {
    const csvContent = [
      file.headers.join(','),
      ...file.rows.map((row) => row.join(',')),
    ].join('\n');

    const blob = new Blob([csvContent], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = file.filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Drag and drop handlers
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);

    const files = Array.from(e.dataTransfer.files);
    const csvFiles = files.filter((file) => file.name.endsWith('.csv'));

    for (const file of csvFiles) {
      await handleFileUpload(file);
    }
  };

  const handleStopChat = () => {
    modelAbortControllerRef.current?.abort();
    stopCurrentResponse();
    setModelIsStreaming(false);
  };

  const handleSaveDashboard = () => {
    if (!dashboardSpec || !selectedFile || !dashboardName.trim()) return;
    const now = new Date().toISOString();
    const existingId = selectedSavedDashboardId || savedDashboards.find(dashboard => dashboard.fileId === selectedFile.id && dashboard.name.toLowerCase() === dashboardName.trim().toLowerCase())?.id;
    const savedDashboard: SavedDashboard = {
      id: existingId || `${selectedFile.id}-${Date.now()}`,
      name: dashboardName.trim(),
      fileId: selectedFile.id,
      fileName: selectedFile.filename,
      spec: dashboardSpec,
      createdAt: savedDashboards.find(dashboard => dashboard.id === existingId)?.createdAt || now,
      updatedAt: now,
    };
    persistSavedDashboards(existingId
      ? savedDashboards.map(dashboard => dashboard.id === existingId ? savedDashboard : dashboard)
      : [savedDashboard, ...savedDashboards]);
    setSelectedSavedDashboardId(savedDashboard.id);
    setSavedDashboardSpec(dashboardSpec);
    setDashboardBuildStatus(`Dashboard saved as "${savedDashboard.name}".`);
  };

  const handleEditDashboard = () => {
    if (!dashboardSpec) return;
    onOpenDashboards?.();
    setDashboardPrompt('Edit this dashboard: ');
    setDashboardBuildStatus('Describe what you want changed, then ask the model to update the dashboard.');
  };

  const handleDiscardDashboard = () => {
    setDashboardSpec(null);
    setSavedDashboardSpec(null);
    setSelectedSavedDashboardId('');
    setDashboardFilters({});
    setDashboardBuildPreview('');
    setDashboardBuildStatus('Dashboard discarded.');
  };

  const handleSelectSavedDashboard = (dashboard: SavedDashboard) => {
    selectFile(dashboard.fileId);
    const selectedSpec = getDashboardSpec(dashboard);
    setSelectedSavedDashboardId(dashboard.id);
    setSelectedDashboardSheetId('');
    setDashboardName(dashboard.name);
    setDashboardSpec(selectedSpec);
    setSavedDashboardSpec(selectedSpec);
    setDashboardFilters({});
    setDashboardBuildStatus(`Opened saved dashboard "${dashboard.name}".`);
  };

  const handleDeleteSavedDashboard = (dashboardId: string) => {
    persistSavedDashboards(savedDashboards.filter(dashboard => dashboard.id !== dashboardId));
    if (selectedSavedDashboardId === dashboardId) {
      setSelectedSavedDashboardId('');
      setSelectedDashboardSheetId('');
      setDashboardSpec(null);
      setSavedDashboardSpec(null);
      setDashboardBuildStatus('Saved dashboard deleted.');
    }
  };

  const handleReorderDashboardSheet = (dashboardId: string, targetSheetId: string, sourceSheetId = draggedSheetId) => {
    if (!sourceSheetId || sourceSheetId === targetSheetId) return;
    const dashboard = savedDashboards.find(savedDashboard => savedDashboard.id === dashboardId);
    if (!dashboard?.sheetIds?.length) return;
    const nextSheetIds = dashboard.sheetIds.filter(sheetId => sheetId !== sourceSheetId);
    const targetIndex = nextSheetIds.indexOf(targetSheetId);
    if (targetIndex === -1) return;
    nextSheetIds.splice(targetIndex, 0, sourceSheetId);
    const nextDashboard = { ...dashboard, sheetIds: nextSheetIds, updatedAt: new Date().toISOString() };
    persistSavedDashboards(savedDashboards.map(savedDashboard => savedDashboard.id === dashboardId ? nextDashboard : savedDashboard));
    const nextSpec = {
      title: nextDashboard.name,
      widgets: nextSheetIds
        .map(sheetId => savedSheets.find(sheet => sheet.id === sheetId))
        .filter((sheet): sheet is SavedSheet => Boolean(sheet))
        .map(sheet => ({ ...sheet.widget, title: sheet.widget.title || sheet.name })),
    };
    setDashboardSpec(nextSpec);
    setSavedDashboardSpec(nextSpec);
    setDraggedSheetId('');
    setDragOverSheetId('');
  };

  const handleRemoveSheetFromDashboard = (dashboardId: string, sheetId: string) => {
    const dashboard = savedDashboards.find(savedDashboard => savedDashboard.id === dashboardId);
    if (!dashboard?.sheetIds?.length) return;
    const nextSheetIds = dashboard.sheetIds.filter(existingSheetId => existingSheetId !== sheetId);
    const nextDashboard = { ...dashboard, sheetIds: nextSheetIds, updatedAt: new Date().toISOString() };
    persistSavedDashboards(savedDashboards.map(savedDashboard => savedDashboard.id === dashboardId ? nextDashboard : savedDashboard));
    const nextSpec = {
      title: nextDashboard.name,
      widgets: nextSheetIds
        .map(nextSheetId => savedSheets.find(sheet => sheet.id === nextSheetId))
        .filter((sheet): sheet is SavedSheet => Boolean(sheet))
        .map(sheet => ({ ...sheet.widget, title: sheet.widget.title || sheet.name })),
    };
    setDashboardSpec(nextSpec);
    setSavedDashboardSpec(nextSpec);
    if (selectedDashboardSheetId === sheetId) setSelectedDashboardSheetId('');
    setDashboardBuildStatus('Sheet removed from dashboard.');
  };

  const handleSaveCalculation = () => {
    if (!selectedFile || !calculationName.trim() || !calculationFormula.trim()) return;
    const now = new Date().toISOString();
    const name = calculationName.trim();
    const existingCalculation = fileCalculations.find(calculation => calculation.name.toLowerCase() === name.toLowerCase());
    const nextCalculation: DashboardCalculation = {
      id: existingCalculation?.id || `${selectedFile.id}-calc-${Date.now()}`,
      name,
      fileId: selectedFile.id,
      fileName: selectedFile.filename,
      formula: calculationFormula.trim(),
      createdAt: existingCalculation?.createdAt || now,
      updatedAt: now,
    };
    const nextCalculations = existingCalculation
      ? dashboardCalculations.map(calculation => calculation.id === existingCalculation.id ? nextCalculation : calculation)
      : [nextCalculation, ...dashboardCalculations];
    persistDashboardCalculations(nextCalculations);
    setSheetValue(name);
    setCalculationName('');
    setCalculationFormula('');
    setDashboardBuildStatus(`Calculation "${name}" saved.`);
  };

  const handleDeleteCalculation = (calculationId: string) => {
    const calculation = dashboardCalculations.find(item => item.id === calculationId);
    persistDashboardCalculations(dashboardCalculations.filter(item => item.id !== calculationId));
    if (calculation?.name === sheetValue) setSheetValue('');
    setDashboardFilters(prev => {
      if (!calculation?.name || !(calculation.name in prev)) return prev;
      const remainingFilters = { ...prev };
      delete remainingFilters[calculation.name];
      return remainingFilters;
    });
    setDashboardBuildStatus('Calculation removed.');
  };

  const handlePreviewSheet = () => {
    if (!selectedFile || !sheetName.trim()) return;
    const allowedColumns = selectedSheetColumns.length > 0 ? selectedSheetColumns : selectedFile.headers;
    const allowedFields = [...allowedColumns, ...fileCalculations.map(calculation => calculation.name)];
    const inferredColumns = inferColumnsFromText(selectedFile, `${sheetName} ${dashboardPrompt}`, allowedColumns);
    const inferredCategory = sheetAdvancedOpen && allowedFields.includes(sheetCategory) ? sheetCategory : inferredColumns.category;
    const inferredValue = sheetAdvancedOpen && allowedFields.includes(sheetValue) ? sheetValue : inferredColumns.value;
    const inferredAggregation = sheetAdvancedOpen ? sheetAggregation : (inferredColumns.value ? 'avg' : 'count');
    const inferredLimit = sheetAdvancedOpen ? sheetLimit : 8;
    const widget = buildWidgetFromControls(sheetType, sheetName.trim(), inferredCategory, inferredValue, inferredAggregation, inferredLimit, allowedColumns);
    setSheetDraft(widget);
    setSheetSaveDestinationOpen(false);
    setSheetSaveSuccess('');
    setDashboardSpec({ title: sheetName.trim(), widgets: [widget] });
    setDashboardBuildStatus('Sheet preview generated. Save it to add it to a dashboard.');
  };

  const handleGenerateSheet = async () => {
    if (!selectedFile || !sheetName.trim()) return;
    setSheetBuilderStep('review');
    setDashboardIsGenerating(true);
    setDashboardBuildPreview('');
    setDashboardBuildStatus('Preparing the AI sheet request...');
    try {
      if (!selectedModel) {
        handlePreviewSheet();
        return;
      }
      const allowedColumns = selectedSheetColumns.length > 0 ? selectedSheetColumns : selectedFile.headers;
      const allowedFields = [...allowedColumns, ...fileCalculations.map(calculation => calculation.name)];
      const calculationContext = fileCalculations.length
        ? `Calculated fields available as value fields:\n${fileCalculations.map(calculation => `${calculation.name} = ${calculation.formula}`).join('\n')}`
        : 'No calculated fields are available yet.';
      const dataContext = getFileContext(selectedFile.id);
      const messages = [
        {
          role: 'system' as const,
          content: 'You create one Tableau-style sheet widget for CSV data. Return only valid JSON for one widget. Widget type must match the requested type and be one of kpi, bar, pie, line, table. Use raw columns for table columns. Category and value may use allowed raw columns; value may also use a calculated field name. If the user mentions an allowed field by name, prioritize that field as the value or category. aggregation must be count, sum, avg, min, or max.',
        },
        {
          role: 'user' as const,
          content: `CSV context:\n${dataContext}\n\nAllowed raw columns for this sheet: ${allowedColumns.join(', ')}\nAllowed value fields, including calculations: ${allowedFields.join(', ')}\n${calculationContext}\nRequested sheet type: ${sheetType}\nSheet name: ${sheetName}\n${sheetAdvancedOpen ? `Manual advanced choices:\nCategory field: ${allowedFields.includes(sheetCategory) ? sheetCategory : '(none)'}\nValue field: ${allowedFields.includes(sheetValue) ? sheetValue : '(none)'}\nAggregation: ${sheetAggregation}\nLimit: ${sheetLimit}\n` : 'No manual advanced choices were provided. Infer the best category, value, aggregation, and limit from the allowed fields and user guidance.\n'}User guidance: ${dashboardPrompt}\n\nReturn JSON only in this shape: {"type":"${sheetType}","title":"${sheetName}","category":"allowed field if needed","value":"allowed numeric or calculated field if needed","columns":["allowed raw columns for table if needed"],"aggregation":"count|sum|avg|min|max","limit":8}`,
        },
      ];
      let reply = '';
      setDashboardBuildStatus(`Asking ${selectedModel} to create one ${sheetType} sheet...`);
      for await (const chunk of apiClient.streamDirectModelChat(selectedModel, messages)) {
        if (chunk.type === 'content') {
          reply += chunk.delta;
          setDashboardBuildPreview(reply.slice(-700));
          setDashboardBuildStatus(`${selectedModel} is drafting the sheet spec...`);
        }
      }
      const parsed = extractJsonObject(reply) as DashboardWidget | null;
      const inferredColumns = inferColumnsFromText(selectedFile, `${sheetName} ${dashboardPrompt}`, allowedColumns);
      const validWidget = parsed && parsed.type === sheetType
        && (!parsed.category || allowedFields.includes(parsed.category))
        && (!parsed.value || allowedFields.includes(parsed.value))
        ? parsed
        : buildWidgetFromControls(sheetType, sheetName.trim(), sheetAdvancedOpen && allowedFields.includes(sheetCategory) ? sheetCategory : inferredColumns.category, sheetAdvancedOpen && allowedFields.includes(sheetValue) ? sheetValue : inferredColumns.value, sheetAdvancedOpen ? sheetAggregation : 'avg', sheetAdvancedOpen ? sheetLimit : 8, allowedColumns);
      const widget = {
        ...validWidget,
        title: validWidget.title || sheetName.trim(),
        columns: (validWidget.columns || allowedColumns).filter(column => allowedColumns.includes(column)),
        ...(!sheetAdvancedOpen && inferredColumns.value ? { value: inferredColumns.value } : {}),
        ...(!sheetAdvancedOpen && inferredColumns.category ? { category: inferredColumns.category } : {}),
      };
      setSheetDraft(widget);
      setSheetSaveDestinationOpen(false);
      setSheetSaveSuccess('');
      setDashboardSpec({ title: sheetName.trim(), widgets: [widget] });
      setDashboardBuildStatus('AI sheet built. Confirm the sheet name and choose a dashboard to save it into.');
    } catch (error) {
      console.error('Sheet generation error:', error);
      handlePreviewSheet();
    } finally {
      setDashboardIsGenerating(false);
    }
  };

  const handleSaveSheetToDashboard = () => {
    if (!selectedFile || !sheetDraft || !sheetName.trim()) return;
    const now = new Date().toISOString();
    const savedSheet: SavedSheet = {
      id: `${selectedFile.id}-sheet-${Date.now()}`,
      name: sheetName.trim(),
      fileId: selectedFile.id,
      fileName: selectedFile.filename,
      widget: { ...sheetDraft, title: sheetName.trim() },
      createdAt: now,
      updatedAt: now,
    };
    const nextSheets = [savedSheet, ...savedSheets];
    persistSavedSheets(nextSheets);

    const existingDashboard = savedDashboards.find(dashboard => dashboard.id === targetDashboardId);
    const dashboardNameToUse = existingDashboard?.name || newDashboardName.trim() || `${selectedFile.filename} Dashboard`;
    const dashboardId = existingDashboard?.id || `${selectedFile.id}-dashboard-${Date.now()}`;
    const savedDashboard: SavedDashboard = {
      id: dashboardId,
      name: dashboardNameToUse,
      fileId: selectedFile.id,
      fileName: selectedFile.filename,
      sheetIds: [...(existingDashboard?.sheetIds || []), savedSheet.id],
      createdAt: existingDashboard?.createdAt || now,
      updatedAt: now,
    };
    const nextDashboards = existingDashboard
      ? savedDashboards.map(dashboard => dashboard.id === dashboardId ? savedDashboard : dashboard)
      : [savedDashboard, ...savedDashboards];
    persistSavedDashboards(nextDashboards);

    const spec = { title: savedDashboard.name, widgets: savedDashboard.sheetIds!.map(sheetId => nextSheets.find(sheet => sheet.id === sheetId)).filter((sheet): sheet is SavedSheet => Boolean(sheet)).map(sheet => sheet.widget) };
    setSelectedSavedDashboardId(savedDashboard.id);
    setDashboardName(savedDashboard.name);
    setDashboardSpec(null);
    setSavedDashboardSpec(spec);
    setSheetDraft(null);
    setSheetSaveDestinationOpen(false);
    setSheetBuilderStep('review');
    setTargetDashboardId(savedDashboard.id);
    setNewDashboardName('');
    setDashboardBuildPreview('');
    setSheetSaveSuccess(`Successfully saved to ${savedDashboard.name}.`);
    setDashboardBuildStatus(`Saved sheet "${savedSheet.name}" to dashboard "${savedDashboard.name}".`);
  };

  const handleSaveSheetClick = () => {
    if (!sheetDraft) return;
    if (!sheetSaveDestinationOpen) {
      setSheetSaveDestinationOpen(true);
      return;
    }
    handleSaveSheetToDashboard();
  };

  const handleDiscardSheet = () => {
    setSheetDraft(null);
    setSheetSaveDestinationOpen(false);
    setSheetSaveSuccess('');
    setDashboardSpec(null);
    setDashboardBuildPreview('');
    setDashboardBuildStatus('Sheet discarded.');
  };

  const handleGenerateDashboard = async (prompt = 'Create a useful dashboard for this CSV data', editExisting = false) => {
    if (!selectedFile) return;
    setDashboardIsGenerating(true);
    setDashboardBuildPreview('');
    setDashboardBuildStatus('Preparing CSV context for the dashboard builder...');
    try {
      if (!selectedModel) {
        const defaultDashboard = buildDefaultDashboard(selectedFile);
        setDashboardSpec(defaultDashboard);
        setDashboardName(defaultDashboard.title);
        setDashboardBuildStatus('No model selected, so a default dashboard was built locally below the table. Save it when you like it.');
        return;
      }

      const dataContext = getFileContext(selectedFile.id);
      const allowedFields = [...selectedFile.headers, ...fileCalculations.map(calculation => calculation.name)];
      const calculationContext = fileCalculations.length
        ? `Calculated fields available as value fields:\n${fileCalculations.map(calculation => `${calculation.name} = ${calculation.formula}`).join('\n')}`
        : 'No calculated fields are available yet.';
      setDashboardBuildStatus(`Asking ${selectedModel} to design dashboard widgets from the CSV columns...`);
      const messages = [
        {
          role: 'system' as const,
          content: 'You create and edit dashboard JSON specs for CSV data. Return only valid JSON with title and widgets. Widget type must be one of kpi, bar, pie, line, table. Use raw CSV columns for table columns. Category and value may use allowed raw columns; value may also use a calculated field name. aggregation must be count, sum, avg, min, or max. Keep 4 to 6 widgets. If an existing dashboard is provided, update it according to the user request instead of starting over unless the user asks for a new dashboard.',
        },
        {
          role: 'user' as const,
          content: `CSV context:\n${dataContext}\n\nAllowed fields: ${allowedFields.join(', ')}\n${calculationContext}\n\n${editExisting && dashboardSpec ? `Existing dashboard JSON:\n${JSON.stringify(dashboardSpec, null, 2)}\n\n` : ''}User request: ${prompt}\n\nReturn JSON only in this shape: {"title":"...","widgets":[{"type":"kpi","title":"Total Rows","aggregation":"count"},{"type":"pie","title":"Rows by Plan","category":"plan","aggregation":"count","limit":6},{"type":"bar","title":"Spend by Plan","category":"plan","value":"monthly_spend or calculated field","aggregation":"sum","limit":8},{"type":"line","title":"Trend by Symbol","category":"symbol","value":"price or calculated field","aggregation":"sum","limit":8},{"type":"table","title":"Sample Rows","limit":5}]}`,
        },
      ];
      let reply = '';
      for await (const chunk of apiClient.streamDirectModelChat(selectedModel, messages)) {
        if (chunk.type === 'content') {
          reply += chunk.delta;
          setDashboardBuildStatus(`${selectedModel} is thinking and drafting the dashboard spec...`);
          setDashboardBuildPreview(reply.slice(-700));
        }
      }
      setDashboardBuildStatus('Parsing the model response and validating columns...');
      const parsed = extractJsonObject(reply) as DashboardSpec | null;
      if (parsed?.title && Array.isArray(parsed.widgets)) {
        const validWidgets = parsed.widgets
          .filter(widget => ['kpi', 'bar', 'pie', 'line', 'table'].includes(widget.type))
          .filter(widget => !widget.category || allowedFields.includes(widget.category))
          .filter(widget => !widget.value || allowedFields.includes(widget.value))
          .slice(0, 8);
        const nextDashboard = { title: parsed.title, widgets: validWidgets.length ? validWidgets : buildDefaultDashboard(selectedFile).widgets };
        setDashboardSpec(nextDashboard);
        setDashboardName(parsed.title || dashboardName || `${selectedFile.filename} Dashboard`);
        setDashboardBuildStatus(editExisting ? 'Dashboard updated and rendered below the CSV table. Save it when you like the changes.' : 'Dashboard built and rendered below the CSV table. Save it when you like it.');
      } else {
        const defaultDashboard = buildDefaultDashboard(selectedFile);
        setDashboardSpec(defaultDashboard);
        setDashboardName(defaultDashboard.title);
        setDashboardBuildStatus('The model response was not valid dashboard JSON, so a default dashboard was built below the table.');
      }
    } catch (error) {
      console.error('Dashboard generation error:', error);
      const defaultDashboard = buildDefaultDashboard(selectedFile);
      setDashboardSpec(defaultDashboard);
      setDashboardName(defaultDashboard.title);
      setDashboardBuildStatus('The model request failed, so a default dashboard was built below the table.');
    } finally {
      setDashboardIsGenerating(false);
    }
  };

  const renderDashboardWidget = (widget: DashboardWidget, index: number) => {
    if (!selectedFile) return null;
    const summary = summarizeWidget(selectedFile, widget, dashboardFilters, fileCalculations) as any;

    if (widget.type === 'kpi') {
      return (
        <Card key={`${widget.title}-${index}`} className="p-3" onMouseMove={(event) => showSheetTooltip(event, `${widget.title}: ${summary.label}`)} onMouseLeave={() => setSheetTooltip(null)}>
          <div className="text-xs text-muted-foreground">{widget.title}</div>
          <div className="mt-1 text-[11px] font-medium text-muted-foreground">{widget.value || widget.aggregation || 'Rows'}</div>
          <div className="mt-2 text-2xl font-semibold">{summary.label}</div>
        </Card>
      );
    }

    if (widget.type === 'bar' || widget.type === 'line') {
      const maxValue = Math.max(...summary.groups.map((group: any) => group.value), 1);
      if (widget.type === 'line') {
        const chartLeft = 24;
        const chartRight = 94;
        const plotLeft = 30;
        const plotRight = 90;
        const chartTop = 10;
        const chartBottom = 78;
        const xAxisName = String(widget.category || 'Category').slice(0, 18);
        const yAxisName = String(widget.value || widget.aggregation || 'Value').slice(0, 40);
        const yTicks = [0, 0.5, 1].map(percent => ({
          percent,
          y: chartBottom - percent * (chartBottom - chartTop),
          value: maxValue * percent,
        }));
        const points = summary.groups.map((group: any, groupIndex: number) => {
          const x = summary.groups.length <= 1 ? (plotLeft + plotRight) / 2 : plotLeft + (groupIndex / (summary.groups.length - 1)) * (plotRight - plotLeft);
          const y = chartBottom - (group.value / maxValue) * (chartBottom - chartTop);
          return { ...group, x, y };
        });
        return (
          <Card key={`${widget.title}-${index}`} className="p-3">
            <div className="mb-3 text-sm font-semibold">{widget.title}</div>
            <div className="mb-2 text-[11px] font-medium text-muted-foreground">{widget.category || 'Category'} by {widget.value || widget.aggregation || 'Value'}</div>
            <svg viewBox="0 0 100 100" className="h-52 w-full overflow-visible rounded border bg-background p-2" preserveAspectRatio="none">
              <text x="7" y={(chartTop + chartBottom) / 2} textAnchor="middle" transform={`rotate(-90 7 ${(chartTop + chartBottom) / 2})`} className="fill-muted-foreground text-[5px]">{yAxisName}</text>
              {yTicks.map(tick => (
                <g key={tick.percent}>
                  <line x1={chartLeft} y1={tick.y} x2={chartRight} y2={tick.y} stroke="currentColor" strokeOpacity="0.12" strokeWidth="0.5" />
                  <text x={chartLeft - 2} y={tick.y + 1.5} textAnchor="end" className="fill-muted-foreground text-[3px]">{Number(tick.value.toFixed(0)).toLocaleString()}</text>
                </g>
              ))}
              <line x1={chartLeft} y1={chartTop} x2={chartLeft} y2={chartBottom} stroke="currentColor" strokeOpacity="0.5" strokeWidth="0.8" />
              <line x1={chartLeft} y1={chartBottom} x2={chartRight} y2={chartBottom} stroke="currentColor" strokeOpacity="0.5" strokeWidth="0.8" />
              {points.slice(1).map((point: any, pointIndex: number) => {
                const previousPoint = points[pointIndex];
                return <line key={`${previousPoint.name}-${point.name}`} x1={previousPoint.x} y1={previousPoint.y} x2={point.x} y2={point.y} stroke={DASHBOARD_COLORS[pointIndex % DASHBOARD_COLORS.length]} strokeWidth="2.5" />;
              })}
              {points.map((point: any, pointIndex: number) => <circle key={point.name} cx={point.x} cy={point.y} r="4" fill={DASHBOARD_COLORS[pointIndex % DASHBOARD_COLORS.length]} className="cursor-crosshair" onMouseMove={(event) => showSheetTooltip(event, `${widget.title}\n${point.name}: ${Number(point.value.toFixed(2)).toLocaleString()}`)} onMouseLeave={() => setSheetTooltip(null)} />)}
              {points.map((point: any) => <text key={`${point.name}-x`} x={point.x} y={chartBottom + 6} textAnchor="middle" className="fill-muted-foreground text-[3px]">{String(point.name).slice(0, 8)}</text>)}
              <text x={(chartLeft + chartRight) / 2} y="96" textAnchor="middle" className="fill-muted-foreground text-[5px]">{xAxisName}</text>
            </svg>
            <div className="mt-2 grid grid-cols-2 gap-1 text-xs text-muted-foreground">
              {points.map((point: any, pointIndex: number) => <div key={point.name} className="flex min-w-0 items-center gap-1.5" onMouseMove={(event) => showSheetTooltip(event, `${widget.title}\n${point.name}: ${Number(point.value.toFixed(2)).toLocaleString()}`)} onMouseLeave={() => setSheetTooltip(null)}><span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ backgroundColor: DASHBOARD_COLORS[pointIndex % DASHBOARD_COLORS.length] }} /><span className="truncate">{point.name}: {Number(point.value.toFixed(2)).toLocaleString()}</span></div>)}
            </div>
          </Card>
        );
      }
      return (
        <Card key={`${widget.title}-${index}`} className="p-3">
          <div className="mb-3 text-sm font-semibold">{widget.title}</div>
          <div className="space-y-2">
            <div className="grid grid-cols-[96px_minmax(0,1fr)_56px] items-center gap-2 text-[11px] font-medium text-muted-foreground">
              <div className="truncate">{widget.category || 'Category'}</div>
              <div className="truncate">Bar</div>
              <div className="truncate text-right">{widget.value || widget.aggregation || 'Value'}</div>
            </div>
            {summary.groups.map((group: any, groupIndex: number) => (
              <div key={group.name} className="grid grid-cols-[96px_minmax(0,1fr)_56px] items-center gap-2 text-xs" onMouseMove={(event) => showSheetTooltip(event, `${widget.title}\n${group.name}: ${Number(group.value.toFixed(2)).toLocaleString()}`)} onMouseLeave={() => setSheetTooltip(null)}>
                <div className="truncate">{group.name}</div>
                <div className="h-2 rounded bg-muted">
                  <div className="h-2 rounded" style={{ width: `${Math.max(4, (group.value / maxValue) * 100)}%`, backgroundColor: DASHBOARD_COLORS[groupIndex % DASHBOARD_COLORS.length] }} />
                </div>
                <div className="text-right tabular-nums">{Number(group.value.toFixed(2)).toLocaleString()}</div>
              </div>
            ))}
          </div>
        </Card>
      );
    }

    if (widget.type === 'pie') {
      const total = summary.groups.reduce((sum: number, group: any) => sum + group.value, 0) || 1;
      let cursor = 0;
      const slices = summary.groups.map((group: any, groupIndex: number) => {
        const start = cursor;
        const percent = group.value / total;
        cursor += percent;
        const midAngle = ((start + cursor) / 2) * 360 - 90;
        const labelRadius = 25;
        return {
          ...group,
          start,
          end: cursor,
          percent,
          labelX: 50 + labelRadius * Math.cos(midAngle * Math.PI / 180),
          labelY: 50 + labelRadius * Math.sin(midAngle * Math.PI / 180),
          color: DASHBOARD_COLORS[groupIndex % DASHBOARD_COLORS.length],
        };
      });
      return (
        <Card key={`${widget.title}-${index}`} className="p-3">
          <div className="mb-3 text-sm font-semibold">{widget.title}</div>
          <div className="mb-2 grid grid-cols-[minmax(0,1fr)_64px_44px] items-center gap-2 text-[11px] font-medium text-muted-foreground">
            <div className="truncate">{widget.category || 'Category'}</div>
            <div className="truncate text-right">{widget.value || widget.aggregation || 'Value'}</div>
            <div className="text-right">Percent</div>
          </div>
          <div className="flex items-center gap-4">
            <svg viewBox="0 0 100 100" className="h-28 w-28 shrink-0 rounded-full border bg-background">
              {slices.map((slice: any) => (
                <path key={slice.name} d={describeArcSlice(slice.start, slice.end)} fill={slice.color} className="cursor-crosshair" onMouseMove={(event) => showSheetTooltip(event, `${widget.title}\n${slice.name}: ${Number(slice.value.toFixed(2)).toLocaleString()} (${Math.round(slice.percent * 100)}%)`)} onMouseLeave={() => setSheetTooltip(null)}>
                  <title>{`${widget.title} - ${slice.name}: ${Number(slice.value.toFixed(2)).toLocaleString()} (${Math.round(slice.percent * 100)}%)`}</title>
                </path>
              ))}
              {slices.filter((slice: any) => slice.percent >= 0.08).map((slice: any) => (
                <text key={`${slice.name}-percent`} x={slice.labelX} y={slice.labelY + 1.5} textAnchor="middle" className="pointer-events-none fill-white text-[8px] font-semibold drop-shadow-sm">
                  {Math.round(slice.percent * 100)}%
                </text>
              ))}
            </svg>
            <div className="min-w-0 flex-1 space-y-1">
              {slices.map((slice: any) => (
                <div key={slice.name} className="grid grid-cols-[12px_minmax(0,1fr)_64px_36px] items-center gap-2 text-xs" onMouseMove={(event) => showSheetTooltip(event, `${widget.title}\n${slice.name}: ${Number(slice.value.toFixed(2)).toLocaleString()} (${Math.round(slice.percent * 100)}%)`)} onMouseLeave={() => setSheetTooltip(null)}>
                  <span className="h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: slice.color }} />
                  <span className="min-w-0 flex-1 truncate">{slice.name}</span>
                  <span className="text-right tabular-nums">{Number(slice.value.toFixed(2)).toLocaleString()}</span>
                  <span className="tabular-nums">{Math.round(slice.percent * 100)}%</span>
                </div>
              ))}
            </div>
          </div>
        </Card>
      );
    }

    const tableColumns = widget.columns?.length ? widget.columns : selectedFile.headers.slice(0, 6);
    return (
      <Card key={`${widget.title}-${index}`} className="p-3 md:col-span-2">
        <div className="mb-2 text-sm font-semibold">{widget.title}</div>
        <div className="mb-2 text-[11px] font-medium text-muted-foreground">Columns: {tableColumns.join(', ')}</div>
        <div className="overflow-auto rounded border">
          <Table>
            <TableHeader>
              <TableRow>{tableColumns.map(header => <TableHead key={header}>{header}</TableHead>)}</TableRow>
            </TableHeader>
            <TableBody>
              {summary.rows.map((row: string[], rowIndex: number) => (
                <TableRow key={rowIndex}>{tableColumns.map(header => {
                  const cell = getFieldDisplayValue(selectedFile, row, header, fileCalculations);
                  return <TableCell key={header} onMouseMove={(event) => showSheetTooltip(event, `${header}: ${cell}`)} onMouseLeave={() => setSheetTooltip(null)}>{cell}</TableCell>;
                })}</TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </Card>
    );
  };

  const renderDashboardSection = () => {
    if (!selectedFile || !dashboardSpec) return null;
    const selectedSavedDashboard = savedDashboards.find(dashboard => dashboard.id === selectedSavedDashboardId);
    const orderedDashboardSheets = (selectedSavedDashboard?.sheetIds || [])
      .map(sheetId => savedSheets.find(sheet => sheet.id === sheetId))
      .filter((sheet): sheet is SavedSheet => Boolean(sheet));
    const canReorderSheets = initialAssistantMode === 'dashboards' && (selectedSavedDashboard?.sheetIds?.length || 0) > 1;
    const selectedDashboardSheet = orderedDashboardSheets.find(sheet => sheet.id === selectedDashboardSheetId);
    const availableFilterFields = [...selectedFile.headers, ...fileCalculations.map(calculation => calculation.name)];
    const filterableHeaders = availableFilterFields.filter(field => {
      const uniqueValues = getUniqueFieldValues(selectedFile, field, fileCalculations);
      return uniqueValues.length > 1 && uniqueValues.length <= 25;
    }).slice(0, 4);
    const preferredFilterColumn = selectedDashboardSheet?.widget.category || '';
    const activeFilterColumn = dashboardFilterColumn && filterableHeaders.includes(dashboardFilterColumn)
      ? dashboardFilterColumn
      : filterableHeaders.includes(preferredFilterColumn) ? preferredFilterColumn : filterableHeaders[0] || '';
    const activeFilterValues = activeFilterColumn ? getUniqueFieldValues(selectedFile, activeFilterColumn, fileCalculations).slice(0, 25) : [];
    const filteredCount = getFilteredRows(selectedFile, dashboardFilters, fileCalculations).length;

    return (
      <div className="border-t pt-4">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <LayoutDashboard className="h-4 w-4 text-blue-600" />
              Dashboard
            </div>
            <div className="truncate text-xs text-muted-foreground">{dashboardSpec.title} · {selectedFile.filename} · {filteredCount} of {selectedFile.rows.length} rows shown</div>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <Button size="sm" variant={dashboardHasUnsavedChanges ? 'default' : 'outline'} onClick={handleSaveDashboard} disabled={!dashboardSpec || !dashboardHasUnsavedChanges}>Save</Button>
            <Button size="sm" variant="outline" onClick={handleEditDashboard}>Edit</Button>
            <Button size="sm" variant="ghost" onClick={handleDiscardDashboard}>Discard</Button>
          </div>
        </div>
        <div className="mb-3 text-xs text-muted-foreground">
          {dashboardHasUnsavedChanges ? 'Unsaved dashboard draft' : savedDashboardSpec ? 'Saved dashboard' : 'Dashboard draft'}
        </div>
        <div className="mb-4 grid gap-3 rounded-md border bg-muted/20 p-3 lg:grid-cols-[minmax(0,1.5fr)_minmax(280px,1fr)]">
          <div className="min-w-0">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <div className="text-xs font-medium text-muted-foreground">Click-to-select filters</div>
              {Object.values(dashboardFilters).some(value => value && value !== '__all__') && (
                <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => setDashboardFilters({})}>Clear filters</Button>
              )}
            </div>
            {filterableHeaders.length > 0 ? (
              <div className="grid gap-2">
                <Select value={activeFilterColumn} onValueChange={setDashboardFilterColumn}>
                  <SelectTrigger className="h-8 max-w-sm"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {filterableHeaders.map(header => <SelectItem key={header} value={header}>{header}</SelectItem>)}
                  </SelectContent>
                </Select>
                <div className="flex flex-wrap gap-1.5">
                  <button
                    type="button"
                    onClick={() => setDashboardFilters(prev => ({ ...prev, [activeFilterColumn]: '__all__' }))}
                    className={`rounded-md border px-2 py-1 text-xs transition-colors ${!dashboardFilters[activeFilterColumn] || dashboardFilters[activeFilterColumn] === '__all__' ? 'border-blue-600 bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300' : 'bg-background text-muted-foreground hover:bg-accent'}`}
                  >
                    All
                  </button>
                  {activeFilterValues.map(value => (
                    <button
                      key={value}
                      type="button"
                      onClick={() => setDashboardFilters(prev => ({ ...prev, [activeFilterColumn]: value }))}
                      className={`max-w-[180px] truncate rounded-md border px-2 py-1 text-xs transition-colors ${dashboardFilters[activeFilterColumn] === value ? 'border-blue-600 bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300' : 'bg-background text-muted-foreground hover:bg-accent'}`}
                      title={value}
                    >
                      {value}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="text-xs text-muted-foreground">No low-cardinality fields available for quick filters.</div>
            )}
          </div>
          <div className="grid gap-2 rounded-md border bg-background/70 p-2">
            <div className="flex items-center justify-between gap-2">
              <div className="text-xs font-medium text-muted-foreground">Calculated fields</div>
              <Button size="sm" className="h-7 px-2 text-xs" onClick={handleSaveCalculation} disabled={!calculationName.trim() || !calculationFormula.trim()}>Save calc</Button>
            </div>
            <Input value={calculationName} onChange={(event) => setCalculationName(event.target.value)} placeholder="Calculation name" className="h-8" />
            <Input value={calculationFormula} onChange={(event) => setCalculationFormula(event.target.value)} placeholder="Formula, e.g. ([Revenue] - [Cost]) / [Cost]" className="h-8" />
            {fileCalculations.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {fileCalculations.map(calculation => (
                  <span key={calculation.id} className="inline-flex max-w-full items-center gap-1 rounded-md border bg-muted/40 px-2 py-1 text-xs">
                    <span className="truncate" title={`${calculation.name} = ${calculation.formula}`}>{calculation.name}</span>
                    <button type="button" className="text-muted-foreground hover:text-destructive" onClick={() => handleDeleteCalculation(calculation.id)} title="Delete calculation">
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
        {orderedDashboardSheets.length > 0 && (
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
            <span>{selectedDashboardSheetId ? `Selected sheet: ${orderedDashboardSheets.find(sheet => sheet.id === selectedDashboardSheetId)?.name || 'Sheet'}` : 'Click a sheet to select it.'}</span>
            {selectedDashboardSheetId && <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => setSelectedDashboardSheetId('')}>Clear selection</Button>}
          </div>
        )}
        {canReorderSheets && <div className="mb-3 text-xs text-muted-foreground">Drag a sheet handle onto another sheet to reorder this dashboard.</div>}
        {initialAssistantMode === 'dashboards' && selectedSavedDashboard?.sheetIds?.length === 1 && <div className="mb-3 text-xs text-muted-foreground">Add another sheet to this dashboard to enable reordering.</div>}
        <div className="grid gap-3 md:grid-cols-2">
          {orderedDashboardSheets.length > 0 ? orderedDashboardSheets.map((sheet, index) => (
            <div
              key={sheet.id}
              role="button"
              tabIndex={0}
              onClick={() => setSelectedDashboardSheetId(sheet.id)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  setSelectedDashboardSheetId(sheet.id);
                }
              }}
              onDragEnter={() => draggedSheetId && setDragOverSheetId(sheet.id)}
              onDragOver={(event) => {
                event.preventDefault();
                event.dataTransfer.dropEffect = 'move';
              }}
              onDrop={(event) => {
                event.preventDefault();
                handleReorderDashboardSheet(selectedSavedDashboard!.id, sheet.id, event.dataTransfer.getData('text/plain') || draggedSheetId);
              }}
              className={`relative rounded-lg transition-opacity ${sheet.widget.type === 'table' ? 'md:col-span-2' : ''} ${draggedSheetId === sheet.id ? 'opacity-50' : ''} ${dragOverSheetId === sheet.id && draggedSheetId !== sheet.id ? 'outline outline-2 outline-blue-500 outline-offset-2' : ''} ${selectedDashboardSheetId === sheet.id ? 'ring-2 ring-blue-600 ring-offset-2 ring-offset-background' : 'cursor-pointer hover:ring-1 hover:ring-muted-foreground/30'}`}
            >
              {selectedDashboardSheetId === sheet.id && <div className="absolute left-2 top-2 z-10 rounded-md bg-blue-600 px-2 py-1 text-[11px] font-medium text-white shadow-sm">Selected</div>}
              <Button
                size="icon"
                variant="ghost"
                className="absolute right-10 top-2 z-10 h-7 w-7 rounded-md border bg-background/90 text-muted-foreground shadow-sm hover:text-destructive"
                onClick={(event) => {
                  event.stopPropagation();
                  handleRemoveSheetFromDashboard(selectedSavedDashboard!.id, sheet.id);
                }}
                title="Remove sheet from dashboard"
              >
                <X className="h-4 w-4" />
              </Button>
              {canReorderSheets && (
                <div
                  draggable
                  onClick={(event) => event.stopPropagation()}
                  onDragStart={(event) => {
                    event.dataTransfer.effectAllowed = 'move';
                    event.dataTransfer.setData('text/plain', sheet.id);
                    setDraggedSheetId(sheet.id);
                  }}
                  onDragEnd={() => {
                    setDraggedSheetId('');
                    setDragOverSheetId('');
                  }}
                  className="absolute right-2 top-2 z-10 cursor-grab rounded-md border bg-background/90 p-1 text-muted-foreground shadow-sm active:cursor-grabbing"
                  title="Drag to reorder"
                >
                  <GripVertical className="h-4 w-4" />
                </div>
              )}
              {renderDashboardWidget({ ...sheet.widget, title: sheet.widget.title || sheet.name }, index)}
            </div>
          )) : dashboardSpec.widgets.map(renderDashboardWidget)}
        </div>
      </div>
    );
  };

  const renderBuilderSheetPreview = () => {
    if (!selectedFile || !dashboardSpec) return null;
    return (
      <div className="rounded-lg border bg-background p-3">
        <div className="mb-3 flex items-center gap-2 text-sm font-semibold">
          <LayoutDashboard className="h-4 w-4 text-blue-600" />
          Generated sheet preview
        </div>
        <div className="grid gap-3">
          {dashboardSpec.widgets.map(renderDashboardWidget)}
        </div>
      </div>
    );
  };

  const renderDashboardEmptyState = () => (
    <div className="mt-6 rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
      <LayoutDashboard className="mx-auto mb-3 h-10 w-10 opacity-50" />
      <div className="font-medium text-foreground">No dashboard selected</div>
      <div className="mt-1">Search and select a saved dashboard from the Dashboards panel.</div>
    </div>
  );

  const handleToggleVoiceInput = () => {
    if (isListening) {
      speechRecognitionRef.current?.stop?.();
      setIsListening(false);
      return;
    }

    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) {
      const unsupportedMessage = { role: 'assistant' as const, content: 'Voice input is not supported in this browser.' };
      if (dataChatTarget === 'model') {
        setModelMessages(prev => [...prev, unsupportedMessage]);
      }
      return;
    }

    const recognition = new SpeechRecognition();
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.lang = navigator.language || 'en-US';
    voiceInputBaseRef.current = chatInput;
    let finalTranscript = '';

    recognition.onresult = (event: any) => {
      let interimTranscript = '';
      for (let index = event.resultIndex; index < event.results.length; index++) {
        const transcript = String(event.results[index][0]?.transcript || '');
        if (event.results[index].isFinal) {
          finalTranscript += transcript;
        } else {
          interimTranscript += transcript;
        }
      }
      const dictated = `${finalTranscript}${interimTranscript}`.trim();
      if (dictated) {
        const base = voiceInputBaseRef.current.trimEnd();
        setChatInput(`${base}${base ? ' ' : ''}${dictated}`);
      }
    };
    recognition.onend = () => {
      setIsListening(false);
      speechRecognitionRef.current = null;
    };
    recognition.onerror = () => {
      setIsListening(false);
      speechRecognitionRef.current = null;
    };

    speechRecognitionRef.current = recognition;
    setIsListening(true);
    recognition.start();
  };

  // Multi-agent chat with CSV context
  const handleSendChatMessage = async () => {
    if (!chatInput.trim() || !selectedFile) return;
    if (dataChatTarget === 'agents' && dataPageSelectedAgents.length === 0) return;
    if (dataChatTarget === 'model' && !selectedModel) return;

    const userMessage = chatInput.trim();
    setChatInput('');

    try {
      const dataContext = getFileContext(selectedFile.id);
      const contextualMessage = `CSV Data Context:\n${dataContext}\n\n---\n\nUser Question: ${userMessage}`;

      if (/\b(dashboard|chart|graph|pie|bar chart|visuali[sz]e)\b/i.test(userMessage)) {
        await handleGenerateDashboard(userMessage);
        if (dataChatTarget === 'model') {
          setModelMessages(prev => [...prev, { role: 'user', content: userMessage }, { role: 'assistant', content: 'I built a dashboard from the CSV data.' }]);
          return;
        }
      }

      if (dataChatTarget === 'model') {
        const abortController = new AbortController();
        modelAbortControllerRef.current = abortController;
        setModelMessages(prev => [...prev, { role: 'user', content: userMessage }, { role: 'assistant', content: '' }]);
        setModelIsStreaming(true);
        let assistantReply = '';
        for await (const chunk of apiClient.streamDirectModelChat(selectedModel, [
          { role: 'system', content: 'You are a data analysis assistant. Answer using the provided CSV context. Be concise and cite column names when useful.' },
          { role: 'user', content: contextualMessage },
        ], abortController.signal)) {
          if (chunk.type === 'content') {
            assistantReply += chunk.delta;
            setModelMessages(prev => prev.map((message, index) => index === prev.length - 1 ? { role: 'assistant', content: assistantReply } : message));
          }
        }
        return;
      }

      setSelectedAgents(dataPageSelectedAgents);
      await sendMessageToMultipleAgents(contextualMessage, []);
    } catch (error) {
      console.error('Chat error:', error);
      if (dataChatTarget === 'model') {
        if (error instanceof DOMException && error.name === 'AbortError') {
          setModelMessages(prev => prev.map((message, index) => index === prev.length - 1 && message.role === 'assistant' && !message.content.trim() ? { role: 'assistant', content: 'Stopped.' } : message));
          return;
        }
        const message = error instanceof Error ? error.message : 'Unable to get model response.';
        setModelMessages(prev => [...prev, { role: 'assistant', content: `Error: ${message}` }]);
      }
    } finally {
      modelAbortControllerRef.current = null;
      setModelIsStreaming(false);
    }
  };

  if (initialAssistantMode === 'dashboards') {
    const selectedDashboardExists = Boolean(selectedSavedDashboardId && savedDashboards.some(dashboard => dashboard.id === selectedSavedDashboardId));
    return (
      <div className="flex h-full w-full min-w-0 overflow-hidden p-4">
        <Card className="flex min-h-0 w-full min-w-0 flex-1 flex-col overflow-hidden p-4">
          <div className="shrink-0 border-b pb-4">
            <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
              <div>
                <h2 className="font-semibold">Dashboards</h2>
                <p className="text-xs text-muted-foreground">Search saved dashboards and open one to view or reorder its sheets.</p>
              </div>
              <Input
                value={dashboardSearch}
                onChange={(event) => setDashboardSearch(event.target.value)}
                placeholder="Search dashboards..."
                className="h-9 md:w-80"
              />
            </div>
          </div>

          <ScrollArea className="min-h-0 w-full flex-1">
            <div className="w-full space-y-6 py-4">
            {visibleSavedDashboards.length === 0 ? (
              <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
                No saved dashboards found. Use AI Dashboard Builder to create one.
              </div>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
                {visibleSavedDashboards.map(dashboard => {
                  const dashboardSheets = (dashboard.sheetIds || [])
                    .map(sheetId => savedSheets.find(sheet => sheet.id === sheetId))
                    .filter((sheet): sheet is SavedSheet => Boolean(sheet));
                  const widgetTitles = dashboard.spec?.widgets.map(widget => widget.title) || [];
                  const sheetLabels = dashboardSheets.length > 0
                    ? dashboardSheets.map(sheet => `${sheet.name} · ${sheet.widget.type}`)
                    : widgetTitles;
                  const sheetCount = dashboardSheets.length || dashboard.spec?.widgets.length || 0;
                  return (
                    <Card
                      key={dashboard.id}
                      className={`flex min-h-[190px] cursor-pointer flex-col justify-between p-4 transition-colors ${selectedSavedDashboardId === dashboard.id ? 'border-blue-600 bg-blue-50 dark:bg-blue-950/30' : 'hover:bg-accent/50'}`}
                      onClick={() => handleSelectSavedDashboard(dashboard)}
                    >
                      <div className="space-y-3">
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <div className="truncate text-sm font-semibold">{dashboard.name}</div>
                            <div className="truncate text-xs text-muted-foreground">{dashboard.fileName}</div>
                          </div>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-7 w-7 shrink-0"
                            onClick={(event) => {
                              event.stopPropagation();
                              handleDeleteSavedDashboard(dashboard.id);
                            }}
                            title="Delete dashboard"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                        <div className="rounded-md border bg-background/70 p-2 text-xs text-muted-foreground">
                          <div className="font-medium text-foreground">{sheetCount} {sheetCount === 1 ? 'sheet' : 'sheets'}</div>
                          <div className="mt-1 space-y-1">
                            {sheetLabels.slice(0, 3).map(label => <div key={label} className="truncate">{label}</div>)}
                            {sheetLabels.length > 3 && <div>+{sheetLabels.length - 3} more</div>}
                            {sheetLabels.length === 0 && <div>No sheets saved yet</div>}
                          </div>
                        </div>
                      </div>
                      <div className="mt-3 text-[11px] text-muted-foreground">Updated {new Date(dashboard.updatedAt).toLocaleString()}</div>
                    </Card>
                  );
                })}
              </div>
            )}

            <div className="w-full border-t pt-4">
              <div className="w-full min-w-0 pb-1">
                {selectedDashboardExists && dashboardSpec ? renderDashboardSection() : renderDashboardEmptyState()}
              </div>
            </div>
          </div>
          </ScrollArea>
        </Card>
        {sheetTooltip && (
          <div className="pointer-events-none fixed z-[100] max-w-64 whitespace-pre-line rounded-md border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-lg" style={{ left: sheetTooltip.x, top: sheetTooltip.y }}>
            {sheetTooltip.content}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className={`flex h-full gap-4 overflow-hidden relative transition-all duration-300 ${isSidebarCollapsed ? 'p-4' : 'p-4'}`}>
      {/* Toggle Button */}
      <Button
        variant="outline"
        size="sm"
        onClick={() => setIsSidebarCollapsed(!isSidebarCollapsed)}
        className="fixed left-4 top-16 z-10 h-8 w-8 p-0 transition-all duration-300 shadow-md"
        title={isSidebarCollapsed ? 'Show file list' : 'Hide file list'}
      >
        {isSidebarCollapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
      </Button>

      {/* Left Panel - File List & Upload */}
      <div className={`flex-shrink-0 flex-col gap-4 overflow-hidden pt-10 transition-all duration-300 ${isSidebarCollapsed ? 'w-0 hidden' : 'w-80 flex'}`}>
        {/* Upload Area */}
        <Card
          className={`p-6 border-2 border-dashed transition-colors ${
            isDragging ? 'border-primary bg-primary/5' : 'border-muted-foreground/25'
          }`}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          <div className="flex flex-col items-center gap-4">
            <Upload className="h-8 w-8 text-muted-foreground" />
            <div className="text-center">
              <p className="text-sm font-medium">Drop CSV files here</p>
              <p className="text-xs text-muted-foreground mt-1">or click to browse</p>
            </div>
            <Button
              size="sm"
              onClick={handleNativeCSVPicker}
            >
              Select Files
            </Button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv"
              multiple
              className="hidden"
              onChange={(e) => {
                const files = e.target.files;
                if (files) {
                  Array.from(files).forEach(handleFileUpload);
                }
              }}
            />
          </div>
        </Card>

        {/* File List */}
        <Card className="flex-1 p-4 overflow-hidden flex flex-col">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-semibold">CSV Files ({csvFiles.length})</h3>
          </div>
          <ScrollArea className="flex-1">
            <div className="space-y-2 pr-4">
              {csvFiles.map((file) => (
                <Card
                  key={file.id}
                  className={`p-3 cursor-pointer transition-colors ${
                    selectedFile?.id === file.id ? 'border-primary' : ''
                  }`}
                  onClick={() => selectFile(file.id)}
                >
                  <div className="flex items-start justify-between">
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-sm truncate">{file.filename}</p>
                      <p className="text-xs text-muted-foreground">
                        {file.rows.length} rows × {file.headers.length} columns
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Updated: {new Date(file.lastModified).toLocaleTimeString()}
                      </p>
                      {liveUpdateEnabled[file.id] && (
                        <p className="text-xs text-green-500 font-medium">
                          🟢 Live updates enabled
                        </p>
                      )}
                      {liveUpdateEnabled[file.id] === false && selectedFile?.id === file.id && (
                        <p className="text-xs text-yellow-600 font-medium">
                          ⚠️ Live updates unavailable
                        </p>
                      )}
                    </div>
                    <div className="flex gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 w-7 p-0"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleRefresh(file.id);
                        }}
                        disabled={isRefreshing === file.id}
                      >
                        <RefreshCw className={`h-3 w-3 ${isRefreshing === file.id ? 'animate-spin' : ''}`} />
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 w-7 p-0"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDownload(file);
                        }}
                      >
                        <Download className="h-3 w-3" />
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 w-7 p-0"
                        onClick={(e) => {
                          e.stopPropagation();
                          removeCSVFile(file.id);
                        }}
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </div>
                  </div>
                </Card>
              ))}
            </div>
          </ScrollArea>
        </Card>
      </div>

      {/* Right Panel - Data View & Chat */}
      <div className={`flex-1 flex gap-4 min-h-0 min-w-0 overflow-hidden transition-all duration-300`}>
        {selectedFile ? (
          <>
            {/* Data Table */}
            <Card className="flex-1 p-4 flex flex-col min-h-0 min-w-0 overflow-hidden transition-all duration-300">
              <div className="mb-4 flex items-center justify-between gap-3">
                <div>
                  <h3 className="font-semibold">{selectedFile.filename}</h3>
                  <p className="text-xs text-muted-foreground">
                    {selectedFile.rows.length} rows × {selectedFile.headers.length} columns
                  </p>
                </div>
              </div>
              <ScrollArea className="flex-1 min-h-0">
                <div className="min-w-[960px] pb-4 pr-4">
                  <Table className="min-w-[900px]">
                    <TableHeader>
                      <TableRow>
                        {selectedFile.headers.map((header, i) => (
                          <TableHead key={i}>{header}</TableHead>
                        ))}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {selectedFile.rows.map((row, i) => (
                        <TableRow key={i}>
                          {row.map((cell, j) => (
                            <TableCell key={j}>{cell}</TableCell>
                          ))}
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </ScrollArea>
            </Card>

            {/* Chat Panel - Always visible */}
            <Card className={`${isChatCollapsed ? 'w-12' : 'w-[450px]'} flex-shrink-0 flex flex-col min-h-0 overflow-hidden p-0 transition-all duration-300`}>
              {isChatCollapsed ? (
                <div className="flex h-full flex-col items-center border-l bg-card py-2">
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-8 w-8"
                    onClick={() => setIsChatCollapsed(false)}
                    title="Expand chat"
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </Button>
                  <div className="mt-4 rotate-90 whitespace-nowrap text-xs font-medium text-muted-foreground">Data Assistant</div>
                </div>
              ) : (
                <>
              <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
                <MessageSquare className="h-4 w-4" />
                <div className="min-w-0 flex-1">
                  <div className="font-semibold text-sm">{initialAssistantMode === 'builder' ? 'AI Dashboard Builder' : 'Chat'}</div>
                  <div className="truncate text-[11px] text-muted-foreground">{selectedFile.filename}</div>
                </div>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-8 w-8"
                  onClick={() => setIsChatCollapsed(true)}
                  title="Collapse chat"
                >
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>

              {initialAssistantMode === 'chat' ? (
                <>
              {/* Agent Configuration at top of chat */}
              <div className="grid shrink-0 gap-2 border-b p-2">
                <div className="grid grid-cols-[92px_minmax(0,1fr)] gap-2">
                  <Select value={dataChatTarget} onValueChange={(value) => setDataChatTarget(value as 'agents' | 'model')}>
                    <SelectTrigger className="h-8 w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="agents">Agents</SelectItem>
                      <SelectItem value="model">Model</SelectItem>
                    </SelectContent>
                  </Select>
                  {dataChatTarget === 'model' ? (
                    <Select value={selectedModel} onValueChange={setSelectedModel}>
                      <SelectTrigger className="h-8 w-full min-w-0">
                        <SelectValue placeholder="Select model" />
                      </SelectTrigger>
                      <SelectContent>
                        {availableModels.map((model) => (
                          <SelectItem key={model.id || model.name} value={model.name}>{model.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <div className="flex h-8 items-center rounded-md border px-3 text-xs text-muted-foreground">
                      Agent chat
                    </div>
                  )}
                </div>

                {/* Agent Selector */}
                {dataChatTarget === 'agents' && <div>
                  <div className="relative">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setIsAgentSelectorOpen(!isAgentSelectorOpen)}
                      className="w-full justify-between gap-2"
                    >
                      <span className="flex items-center gap-2">
                        <MessageSquare className="h-4 w-4" />
                        {dataPageSelectedAgents.length > 0 
                          ? `${dataPageSelectedAgents.length} Agent${dataPageSelectedAgents.length > 1 ? 's' : ''} Selected` 
                          : 'Select Agents'}
                      </span>
                    </Button>
                    {isAgentSelectorOpen && (
                      <>
                        <div 
                          className="fixed inset-0 z-10" 
                          onClick={() => setIsAgentSelectorOpen(false)}
                        />
                        <div className="absolute top-full mt-2 left-0 right-0 border rounded-lg p-3 bg-card shadow-lg z-20 max-w-full">
                          <div className="flex items-center justify-between mb-2">
                            <div className="text-sm font-semibold">Select Agents</div>
                            {dataPageSelectedAgents.length > 0 && (
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-6 text-xs"
                                onClick={() => setDataPageSelectedAgents([])}
                              >
                                Clear All
                              </Button>
                            )}
                          </div>
                          {agents.length > 0 ? (
                            <div className="flex flex-col gap-2 max-h-48 overflow-y-auto">
                              {agents.map(agent => (
                                <label
                                  key={agent.id}
                                  className="flex items-center gap-2 p-2 rounded hover:bg-accent cursor-pointer transition-colors"
                                >
                                  <input
                                    type="checkbox"
                                    checked={dataPageSelectedAgents.some(a => a.id === agent.id)}
                                    onChange={() => toggleAgentSelection(agent)}
                                    className="w-4 h-4"
                                  />
                                  <div className="flex-1 min-w-0">
                                    <div className="text-sm font-medium truncate">{agent.name}</div>
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
                </div>}

                {/* Orchestration Type Selector - Only when multiple agents */}
                {dataChatTarget === 'agents' && dataPageSelectedAgents.length > 1 && (
                  <div className="relative">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setIsOrchestrationSelectorOpen(!isOrchestrationSelectorOpen)}
                      className="w-full justify-between gap-2"
                    >
                      <span className="flex items-center gap-2">
                        <Workflow className="h-4 w-4" />
                        {orchestrationType === 'group_chat' ? 'Group Chat' : 
                         orchestrationType === 'sequential' ? 'Sequential' :
                         orchestrationType === 'concurrent' ? 'Concurrent' :
                         orchestrationType === 'handoff' ? 'Handoff' : 'Magentic'}
                      </span>
                    </Button>
                    {isOrchestrationSelectorOpen && (
                      <>
                        <div 
                          className="fixed inset-0 z-10" 
                          onClick={() => setIsOrchestrationSelectorOpen(false)}
                        />
                        <div className="absolute top-full mt-2 left-0 right-0 border rounded-lg p-2 bg-card shadow-lg z-20 max-w-full">
                          {[
                            { value: 'group_chat' as const, label: 'Group Chat', desc: 'Agents discuss and collaborate' },
                            { value: 'sequential' as const, label: 'Sequential', desc: 'One agent at a time' },
                            { value: 'concurrent' as const, label: 'Concurrent', desc: 'All agents respond simultaneously' },
                            { value: 'handoff' as const, label: 'Handoff', desc: 'Pass control between agents' },
                            { value: 'magentic' as const, label: 'Magentic', desc: 'Manager-directed coordination' },
                          ].map((option) => (
                            <button
                              key={option.value}
                              onClick={() => {
                                setOrchestrationType(option.value);
                                setIsOrchestrationSelectorOpen(false);
                              }}
                              className={`w-full text-left px-3 py-2 rounded hover:bg-accent transition-colors ${
                                orchestrationType === option.value ? 'bg-accent' : ''
                              }`}
                            >
                              <div className="font-medium text-sm">{option.label}</div>
                              <div className="text-xs text-muted-foreground">{option.desc}</div>
                            </button>
                          ))}
                        </div>
                      </>
                    )}
                  </div>
                )}
              </div>

              {/* Messages Display */}
                <ScrollArea className="min-h-0 flex-1">
                  <div className="space-y-3 p-3 pr-4">
                    {visibleMessages.length === 0 ? (
                      <div className="flex min-h-[220px] flex-col items-center justify-center text-center text-sm text-muted-foreground">
                        <MessageSquare className="h-8 w-8 mb-2 opacity-50" />
                        <p>Ask a question about your CSV data</p>
                      </div>
                    ) : (
                      visibleMessages.map((message, idx) => ({ message, idx })).filter(({ message, idx }) => idx === liveModelAssistantIndex || String(message.content || '').trim()).map(({ message, idx }) => (
                        <div key={idx} className={`flex ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                          <div className={`max-w-[92%] whitespace-pre-wrap break-words rounded-lg border px-3 py-2 text-sm ${
                            message.role === 'user' ? 'border-primary/30 bg-primary text-primary-foreground' : 'bg-muted/50'
                          }`}>
                            <div className="mb-1 text-[11px] font-semibold uppercase opacity-70">
                              {message.role === 'user' ? 'user' : (message as any).agentName || 'assistant'}
                            </div>
                            {idx === liveModelAssistantIndex && <div className="animate-pulse text-muted-foreground">AI is thinking...</div>}
                            {String(message.content || '').trim() && <div className={idx === liveModelAssistantIndex ? 'mt-2' : ''}>{message.content}</div>}
                          </div>
                        </div>
                      ))
                    )}
                    {chatBusy && liveModelAssistantIndex === -1 && (
                      <div className="flex justify-start">
                        <div className="max-w-[92%] rounded-lg border bg-muted/50 px-3 py-2 text-sm">
                          <div className="mb-1 text-[11px] font-semibold uppercase opacity-70">assistant</div>
                          <div className="animate-pulse text-muted-foreground">{dataChatTarget === 'model' ? 'AI is thinking...' : 'Agents are thinking...'}</div>
                        </div>
                      </div>
                    )}
                    <div ref={messagesEndRef} />
                  </div>
                </ScrollArea>

                {/* Chat Input */}
                <div className="shrink-0 border-t bg-card p-2">
                  <div className="rounded-md border bg-background p-2">
                    <Input
                      className="border-0 bg-transparent px-0 shadow-none focus-visible:ring-0"
                      value={chatInput}
                      onChange={(e) => setChatInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey) {
                          e.preventDefault();
                          handleSendChatMessage();
                        }
                      }}
                      placeholder="Ask about your data..."
                      disabled={chatBusy || (dataChatTarget === 'agents' ? dataPageSelectedAgents.length === 0 : !selectedModel)}
                    />
                    <div className="mt-2 flex items-center justify-between gap-2">
                      <span className="min-w-0 truncate text-xs text-muted-foreground">
                        CSV data is included automatically
                      </span>
                      <div className="flex shrink-0 items-center gap-2">
                        <Button
                          size="icon"
                          variant={isListening ? 'secondary' : 'ghost'}
                          className="h-8 w-8"
                          onClick={handleToggleVoiceInput}
                          title={isListening ? 'Stop voice input' : 'Start voice input'}
                        >
                          <Mic className={`h-4 w-4 ${isListening ? 'text-primary' : ''}`} />
                        </Button>
                        {chatBusy ? (
                          <Button size="icon" variant="destructive" className="h-8 w-8" onClick={handleStopChat} title="Stop response">
                            <X className="h-4 w-4" />
                          </Button>
                        ) : (
                          <Button
                            size="sm"
                            onClick={handleSendChatMessage}
                            disabled={!chatInput.trim() || (dataChatTarget === 'agents' ? dataPageSelectedAgents.length === 0 : !selectedModel)}
                          >
                            Send
                          </Button>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
                  </>
                ) : (
                  <ScrollArea className="min-h-0 flex-1">
                    <div className="grid gap-3 border-b p-3">
                      <div>
                        <div className="text-sm font-semibold">AI Dashboard Builder</div>
                        <div className="text-xs text-muted-foreground">
                          Build one sheet at a time, then save it into a dashboard.
                        </div>
                      </div>
                      <div className="grid gap-2">
                        <label className="text-xs font-medium text-muted-foreground">Model</label>
                        <Select value={selectedModel} onValueChange={setSelectedModel}>
                          <SelectTrigger className="h-8 w-full min-w-0">
                            <SelectValue placeholder="Select model" />
                          </SelectTrigger>
                          <SelectContent>
                            {availableModels.map((model) => (
                              <SelectItem key={model.id || model.name} value={model.name}>{model.name}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="grid grid-cols-[minmax(0,1fr)_130px] gap-2">
                        <div className="grid gap-1">
                          <label className="text-xs font-medium text-muted-foreground">Sheet name</label>
                          <Input value={sheetName} onChange={(event) => setSheetName(event.target.value)} placeholder="Name this sheet" className="h-8" />
                        </div>
                        <div className="grid gap-1">
                          <label className="text-xs font-medium text-muted-foreground">Sheet type</label>
                          <Select value={sheetType} onValueChange={(value) => setSheetType(value as DashboardWidgetType)}>
                            <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
                            <SelectContent>
                              <SelectItem value="kpi"><span className="flex items-center gap-2"><Gauge className="h-4 w-4" />KPI</span></SelectItem>
                              <SelectItem value="table"><span className="flex items-center gap-2"><Table2 className="h-4 w-4" />Table</span></SelectItem>
                              <SelectItem value="bar"><span className="flex items-center gap-2"><BarChart3 className="h-4 w-4" />Bar graph</span></SelectItem>
                              <SelectItem value="line"><span className="flex items-center gap-2"><LineChart className="h-4 w-4" />Line graph</span></SelectItem>
                              <SelectItem value="pie"><span className="flex items-center gap-2"><PieChart className="h-4 w-4" />Pie chart</span></SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                      </div>
                      <div className="grid gap-2 rounded-md border bg-muted/20 p-2">
                        <div className="flex items-center justify-between gap-2">
                          <div>
                            <div className="text-xs font-medium text-muted-foreground">Column checker</div>
                            <div className="text-[11px] text-muted-foreground">Selected columns guide AI and previews.</div>
                          </div>
                          <div className="flex shrink-0 gap-1">
                            <Button type="button" size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => setSheetAllowedColumns(selectedFile.headers)}>All</Button>
                            <Button type="button" size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => setSheetAllowedColumns([])}>Clear</Button>
                          </div>
                        </div>
                        <div className="flex flex-wrap gap-1.5">
                          {selectedFile.headers.map((header, index) => {
                            const selected = selectedSheetColumns.includes(header);
                            const numeric = isNumericColumn(selectedFile.rows, index);
                            return (
                              <button
                                key={header}
                                type="button"
                                onClick={() => toggleSheetColumn(header)}
                                className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs transition-colors ${selected ? 'border-blue-600 bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300' : 'bg-background text-muted-foreground hover:bg-accent'}`}
                                title={`${header}${numeric ? ' is numeric' : ' is text/category'}`}
                              >
                                <span>{header}{numeric ? ' #' : ''}</span>
                                {selected && <X className="h-3 w-3" aria-hidden="true" />}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                      <div className="rounded-md border bg-muted/20 p-2">
                        <Button type="button" variant="ghost" size="sm" className="h-7 w-full justify-between px-2" onClick={() => setSheetAdvancedOpen(open => !open)}>
                          Advanced
                          <ChevronDown className={`h-4 w-4 transition-transform ${sheetAdvancedOpen ? 'rotate-180' : ''}`} />
                        </Button>
                        {!sheetAdvancedOpen ? (
                          <div className="px-2 pb-1 text-xs text-muted-foreground">AI will infer category, value, aggregation, and limit.</div>
                        ) : (
                          <div className="mt-2 grid gap-2">
                            <div className="grid grid-cols-2 gap-2">
                              <div className="grid gap-1">
                                <label className="text-xs font-medium text-muted-foreground">Category</label>
                                <Select value={sheetCategory || '__none__'} onValueChange={(value) => setSheetCategory(value === '__none__' ? '' : value)}>
                                  <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
                                  <SelectContent>
                                    <SelectItem value="__none__">None</SelectItem>
                                    {availableSheetFields.map(header => <SelectItem key={header} value={header}>{header}</SelectItem>)}
                                  </SelectContent>
                                </Select>
                              </div>
                              <div className="grid gap-1">
                                <label className="text-xs font-medium text-muted-foreground">Value</label>
                                <Select value={sheetValue || '__none__'} onValueChange={(value) => setSheetValue(value === '__none__' ? '' : value)}>
                                  <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
                                  <SelectContent>
                                    <SelectItem value="__none__">None</SelectItem>
                                    {availableSheetFields.map(header => <SelectItem key={header} value={header}>{header}</SelectItem>)}
                                  </SelectContent>
                                </Select>
                              </div>
                            </div>
                            <div className="grid grid-cols-2 gap-2">
                              <div className="grid gap-1">
                                <label className="text-xs font-medium text-muted-foreground">Aggregation</label>
                                <Select value={sheetAggregation} onValueChange={(value) => setSheetAggregation(value as DashboardWidget['aggregation'])}>
                                  <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
                                  <SelectContent>
                                    <SelectItem value="count">Count</SelectItem>
                                    <SelectItem value="sum">Sum</SelectItem>
                                    <SelectItem value="avg">Average</SelectItem>
                                    <SelectItem value="min">Min</SelectItem>
                                    <SelectItem value="max">Max</SelectItem>
                                  </SelectContent>
                                </Select>
                              </div>
                              <div className="grid gap-1">
                                <label className="text-xs font-medium text-muted-foreground">Limit</label>
                                <Input type="number" min={1} max={20} value={sheetLimit} onChange={(event) => setSheetLimit(Math.max(1, Math.min(20, Number(event.target.value) || 1)))} className="h-8" />
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                      <div className="grid gap-2">
                        <label className="text-xs font-medium text-muted-foreground">AI guidance</label>
                        <Input
                          value={dashboardPrompt}
                          onChange={(event) => setDashboardPrompt(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                              event.preventDefault();
                              void handleGenerateSheet();
                            }
                          }}
                          placeholder="Tell AI what this sheet should emphasize"
                        />
                      </div>
                      {sheetBuilderStep === 'configure' ? (
                        <Button onClick={() => setSheetBuilderStep('review')} disabled={!sheetName.trim()}>
                          Next
                        </Button>
                      ) : (
                        <div className="grid gap-2">
                          <Button variant="ghost" size="sm" className="justify-start px-0" onClick={() => setSheetBuilderStep('configure')}>Back to setup</Button>
                          {dashboardIsGenerating && (
                            <div className="rounded-md border border-blue-500/30 bg-blue-500/10 px-3 py-2 text-xs text-blue-700 dark:text-blue-300">
                              <div className="flex items-center gap-2 font-medium">
                                <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                                AI is building your sheet
                              </div>
                              <div className="mt-1 text-blue-700/80 dark:text-blue-300/80">Asking {selectedModel || 'local builder'} to create the sheet spec. The preview will update when it finishes.</div>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                    {sheetBuilderStep === 'review' && (
                      <div className="space-y-3 p-3 text-sm">
                        {dashboardBuildPreview && (
                          <div className="rounded-lg border bg-background p-3">
                            <div className="mb-2 text-xs font-medium text-muted-foreground">Live model draft</div>
                            <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words text-[11px] leading-relaxed text-muted-foreground">{dashboardBuildPreview}</pre>
                          </div>
                        )}
                        <div className="grid grid-cols-2 gap-2 rounded-lg border bg-muted/30 p-3">
                          <Button variant="outline" onClick={handlePreviewSheet} disabled={!sheetName.trim()}>Preview without AI</Button>
                          <Button variant="outline" onClick={() => void handleGenerateSheet()} disabled={dashboardIsGenerating || !sheetName.trim()}>
                            <LayoutDashboard className="mr-2 h-4 w-4" />
                            {dashboardIsGenerating ? 'AI is building...' : selectedModel ? 'Ask AI to build sheet' : 'Build sheet'}
                          </Button>
                        </div>
                        {renderBuilderSheetPreview()}
                        {sheetSaveDestinationOpen && (
                          <div className="grid gap-2 rounded-lg border bg-muted/20 p-3">
                            <div className="text-xs font-medium text-muted-foreground">Save destination</div>
                            <div className="grid gap-1">
                              <label className="text-xs font-medium text-muted-foreground">Sheet name</label>
                              <Input value={sheetName} onChange={(event) => setSheetName(event.target.value)} placeholder="Name this sheet" className="h-8" />
                            </div>
                            <div className="grid gap-1">
                              <label className="text-xs font-medium text-muted-foreground">Add to dashboard</label>
                              <Select value={targetDashboardId || '__choose__'} onValueChange={(value) => setTargetDashboardId(value === '__choose__' ? '' : value)}>
                                <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="__choose__" disabled>Choose destination</SelectItem>
                                  <SelectItem value="__new__">Create new dashboard</SelectItem>
                                  {savedDashboards.map(dashboard => <SelectItem key={dashboard.id} value={dashboard.id}>{dashboard.name}</SelectItem>)}
                                </SelectContent>
                              </Select>
                            </div>
                            {targetDashboardId === '__new__' && (
                              <div className="grid gap-1">
                                <label className="text-xs font-medium text-muted-foreground">New dashboard name</label>
                                <Input value={newDashboardName} onChange={(event) => setNewDashboardName(event.target.value)} placeholder="Name the dashboard" className="h-8" />
                              </div>
                            )}
                          </div>
                        )}
                        {sheetSaveSuccess && (
                          <div className="flex items-center gap-2 rounded-lg border border-green-500/30 bg-green-500/10 px-3 py-2 text-xs font-medium text-green-700 dark:text-green-300">
                            <CheckCircle2 className="h-4 w-4" />
                            {sheetSaveSuccess}
                          </div>
                        )}
                        {(sheetDraft || dashboardSpec) && (
                          <div className="grid grid-cols-2 gap-2 rounded-lg border bg-muted/30 p-3">
                            <Button size="sm" onClick={handleSaveSheetClick} disabled={!sheetDraft || !sheetName.trim() || (sheetSaveDestinationOpen && (!targetDashboardId || (targetDashboardId === '__new__' && !newDashboardName.trim())))}>{sheetSaveDestinationOpen ? 'Save to dashboard' : 'Save sheet'}</Button>
                            <Button size="sm" variant="ghost" onClick={handleDiscardSheet} disabled={!sheetDraft && !dashboardSpec}>Discard sheet</Button>
                          </div>
                        )}
                      </div>
                    )}
                  </ScrollArea>
                )}
                </>
              )}
              </Card>
          </>
        ) : (
          <Card className="flex-1 flex items-center justify-center">
            <div className="text-center text-muted-foreground">
              <Upload className="h-12 w-12 mx-auto mb-4 opacity-50" />
              <p className="text-lg font-medium">Upload a CSV file to get started</p>
              <p className="text-sm mt-2">Drag & drop or click the upload button</p>
            </div>
          </Card>
        )}
      </div>
      {sheetTooltip && (
        <div className="pointer-events-none fixed z-[100] max-w-64 whitespace-pre-line rounded-md border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-lg" style={{ left: sheetTooltip.x, top: sheetTooltip.y }}>
          {sheetTooltip.content}
        </div>
      )}
    </div>
  );
}
