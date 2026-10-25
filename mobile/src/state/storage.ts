import * as SecureStore from 'expo-secure-store';

/** Where the pairing lives. The real one is the Android Keystore; tests use memory. */
export interface KeyValueStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

export const secureStorage: KeyValueStore = {
  async get(key) {
    try {
      return await SecureStore.getItemAsync(key);
    } catch {
      return null; // an unreadable entry is the same as no entry: the user simply pairs again
    }
  },
  set: (key, value) => SecureStore.setItemAsync(key, value), // failures propagate: pairing must not pretend it saved
  async remove(key) {
    try {
      await SecureStore.deleteItemAsync(key);
    } catch {
      // nothing to delete
    }
  },
};

export function memoryStorage(initial: Record<string, string> = {}): KeyValueStore & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    get: async (key) => data.get(key) ?? null,
    set: async (key, value) => void data.set(key, value),
    remove: async (key) => void data.delete(key),
  };
}
