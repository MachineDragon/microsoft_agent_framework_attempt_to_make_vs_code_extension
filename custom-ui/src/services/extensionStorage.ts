import { apiClient } from '@/services/api';

export async function getStoredString(name: string): Promise<string | null> {
  return apiClient.getUserStorageItem(name);
}

export async function setStoredString(name: string, value: string): Promise<void> {
  await apiClient.setUserStorageItem(name, value);
}

export async function removeStoredString(name: string): Promise<void> {
  await apiClient.removeUserStorageItem(name);
}

export async function getStoredJSON<T>(name: string, fallback: T): Promise<T> {
  const value = await getStoredString(name);
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export async function setStoredJSON(name: string, value: unknown): Promise<void> {
  await setStoredString(name, JSON.stringify(value));
}