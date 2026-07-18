import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { createExtensionJSONStorage } from '@/stores/extensionStorage';

export interface NoteFolder {
  id: string;
  name: string;
  parentId: string | null; // null = root
  createdAt: number;
}

export interface SavedAiNote {
  id: string;
  title: string;
  content: string;
  messages?: Array<{ role: 'user' | 'assistant'; content: string }>;
  createdAt: number;
}

export interface Note {
  id: string;
  name: string;
  description: string;
  rawContent: string;   // raw typed / speech-to-text content
  aiContent: string;    // latest AI-processed / saved content, kept for older notes
  aiNotes: SavedAiNote[];
  folderId: string | null; // null = root
  createdAt: number;
  updatedAt: number;
}

interface NoteStore {
  folders: NoteFolder[];
  notes: Note[];

  // Folders
  createFolder: (name: string, parentId: string | null) => NoteFolder;
  renameFolder: (id: string, name: string) => void;
  deleteFolder: (id: string) => void; // also deletes contained notes + subfolders

  // Notes
  createNote: (name: string, description: string, folderId: string | null) => Note;
  updateNote: (id: string, patch: Partial<Pick<Note, 'name' | 'description' | 'rawContent' | 'aiContent' | 'aiNotes' | 'folderId'>>) => void;
  deleteNote: (id: string) => void;

  // Helpers
  getNotesInFolder: (folderId: string | null) => Note[];
  getSubfolders: (parentId: string | null) => NoteFolder[];
  getAllDescendantFolderIds: (folderId: string) => string[];
}

export const useNoteStore = create<NoteStore>()(
  persist(
    (set, get) => ({
      folders: [],
      notes: [],

      createFolder: (name, parentId) => {
        const folder: NoteFolder = {
          id: `folder_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          name,
          parentId,
          createdAt: Date.now(),
        };
        set((s) => ({ folders: [...s.folders, folder] }));
        return folder;
      },

      renameFolder: (id, name) => {
        set((s) => ({ folders: s.folders.map((f) => f.id === id ? { ...f, name } : f) }));
      },

      deleteFolder: (id) => {
        const state = get();
        const allIds = [id, ...state.getAllDescendantFolderIds(id)];
        set((s) => ({
          folders: s.folders.filter((f) => !allIds.includes(f.id)),
          notes: s.notes.filter((n) => n.folderId === null || !allIds.includes(n.folderId)),
        }));
      },

      createNote: (name, description, folderId) => {
        const note: Note = {
          id: `note_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          name,
          description,
          rawContent: '',
          aiContent: '',
          aiNotes: [],
          folderId,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        set((s) => ({ notes: [...s.notes, note] }));
        return note;
      },

      updateNote: (id, patch) => {
        set((s) => ({
          notes: s.notes.map((n) =>
            n.id === id ? { ...n, ...patch, updatedAt: Date.now() } : n
          ),
        }));
      },

      deleteNote: (id) => {
        set((s) => ({ notes: s.notes.filter((n) => n.id !== id) }));
      },

      getNotesInFolder: (folderId) => {
        return get().notes.filter((n) => n.folderId === folderId);
      },

      getSubfolders: (parentId) => {
        return get().folders.filter((f) => f.parentId === parentId);
      },

      getAllDescendantFolderIds: (folderId) => {
        const { folders } = get();
        const result: string[] = [];
        const queue = [folderId];
        while (queue.length) {
          const current = queue.shift()!;
          const children = folders.filter((f) => f.parentId === current).map((f) => f.id);
          result.push(...children);
          queue.push(...children);
        }
        return result;
      },
    }),
    { name: 'notes-store', storage: createExtensionJSONStorage<NoteStore>() }
  )
);
