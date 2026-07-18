import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { createExtensionJSONStorage } from '@/stores/extensionStorage';

export interface CSVData {
  id: string;
  filename: string;
  headers: string[];
  rows: string[][];
  uploadedAt: Date;
  lastModified: Date;
}

interface DataStore {
  csvFiles: CSVData[];
  selectedFile: CSVData | null;
  addCSVFile: (file: CSVData) => void;
  updateCSVFile: (id: string, file: CSVData) => void;
  removeCSVFile: (id: string) => void;
  selectFile: (id: string | null) => void;
  getFileContext: (fileId: string) => string;
}

export const useDataStore = create<DataStore>()(
  persist(
    (set, get) => ({
      csvFiles: [],
      selectedFile: null,

      addCSVFile: (file) =>
        set((state) => ({
          csvFiles: [...state.csvFiles, file],
        })),

      updateCSVFile: (id, file) =>
        set((state) => ({
          csvFiles: state.csvFiles.map((f) => (f.id === id ? file : f)),
          selectedFile: state.selectedFile?.id === id ? file : state.selectedFile,
        })),

      removeCSVFile: (id) =>
        set((state) => ({
          csvFiles: state.csvFiles.filter((f) => f.id !== id),
          selectedFile: state.selectedFile?.id === id ? null : state.selectedFile,
        })),

      selectFile: (id) =>
        set((state) => ({
          selectedFile: id ? state.csvFiles.find((f) => f.id === id) || null : null,
        })),

      getFileContext: (fileId) => {
        const file = get().csvFiles.find((f) => f.id === fileId);
        if (!file) return '';

        // Format CSV data as context string
        const headerRow = file.headers.join(', ');
        const dataRows = file.rows.slice(0, 100).map((row) => row.join(', ')); // Limit to 100 rows for context
        
        return `File: ${file.filename}\nColumns: ${headerRow}\n\nData:\n${dataRows.join('\n')}\n\nTotal rows: ${file.rows.length}`;
      },
    }),
    {
      name: 'data-store',
      storage: createExtensionJSONStorage<DataStore>(),
    }
  )
);
