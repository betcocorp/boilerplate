/**
 * Client-side permission store for UI only (feature toggles, nav).
 * Source of truth is server/Redis; this is a short-lived cache for convenience.
 * Consuming components call load() themselves — there is no global provider.
 */

import { create } from 'zustand';

export interface MeState {
  permissions: string[];
  user: { USER_ID?: string; EMAIL?: string; NAME?: string } | null;
  loaded: boolean;
  setFromApi: (data: { user: unknown; permissions: string[] }) => void;
  clear: () => void;
  hasPermission: (permission: string) => boolean;
  load: () => Promise<void>;
}

export const usePermissionsStore = create<MeState>((set, get) => ({
  permissions: [],
  user: null,
  loaded: false,

  setFromApi: (data) => {
    set({
      user: (data.user as MeState['user']) ?? null,
      permissions: Array.isArray(data.permissions) ? data.permissions : [],
      loaded: true,
    });
  },

  clear: () => set({ permissions: [], user: null, loaded: false }),

  /**
   * Check if the user has a permission (exact or wildcard).
   * Supports wildcards: e.g. "navigation.*" matches "navigation.sidebar.bex".
   * Must stay in sync with the server-side hasPermission in ~/lib/permissions/permissions-server.
   */
  hasPermission: (permission: string) => {
    const { permissions } = get();
    if (permissions.includes(permission)) return true;
    const parts = permission.split('.');
    for (let i = parts.length - 1; i > 0; i--) {
      const wild = [...parts.slice(0, i), '*'].join('.');
      if (permissions.includes(wild)) return true;
    }
    return permissions.includes('*');
  },

  load: async () => {
    try {
      const res = await fetch('/api/me', { credentials: 'include' });
      if (!res.ok) {
        set({ loaded: true });
        return;
      }
      const data = await res.json();
      get().setFromApi({
        user: data.user ?? null,
        permissions: data.permissions ?? [],
      });
    } catch {
      set({ loaded: true });
    }
  },
}));
