import { createJSONStorage, type StateStorage } from 'zustand/middleware';
import { apiClient } from '@/services/api';

const extensionStateStorage: StateStorage<Promise<void>> = {
  getItem: (name) => apiClient.getUserStorageItem(name),
  setItem: (name, value) => apiClient.setUserStorageItem(name, value),
  removeItem: (name) => apiClient.removeUserStorageItem(name),
};

export const createExtensionJSONStorage = <T>() => createJSONStorage<T>(() => extensionStateStorage);