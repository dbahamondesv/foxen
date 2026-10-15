/** Store global de Foxen con Zustand. */

import { create } from 'zustand';
import * as ipc from '../lib/ipc';
import { errorMessage } from '../lib/ipc';
import { applyTheme, loadTheme, saveTheme, type Theme } from '../lib/theme';
import {
  clampColumnWidth,
  loadColumnWidths,
  saveColumnWidths,
  type ColumnKey,
  type ColumnWidths,
} from '../lib/columns';
import type {
  BranchList,
  CommitDetail,
  CommitGraph,
  DiffResult,
  FlowStatus,
  ReflogEntry,
  RemoteInfo,
  RepositoryHandle,
  RepositoryOperationState,
  RepoStatus,
  StashEntry,
  TagInfo,
  GitHubUser,
  GitHubRepo,
} from '../lib/types';

export type Toast = { id: number; kind: 'info' | 'error' | 'success'; text: string };

/** Vista activa del panel derecho. */
export type SidePanel = 'changes' | 'branches' | 'stashes' | 'remotes' | 'flow' | 'reflog';

interface FoxenState {
  // --- Repositorios ---
  repositories: RepositoryHandle[];
  repoId: string | null;

  // --- Datos del repositorio abierto ---
  status: RepoStatus | null;
  graph: CommitGraph | null;
  branches: BranchList | null;
  tags: TagInfo[];
  stashes: StashEntry[];
  remotes: RemoteInfo[];
  flow: FlowStatus | null;
  reflog: ReflogEntry[];
  /** Estado de operaciones en curso (merge/rebase y archivos en conflicto). */
  operationState: RepositoryOperationState | null;

  // --- Seleccion ---
  selectedOid: string | null;
  selectedDetail: CommitDetail | null;
  selectedFile: string | null;
  /** Lado del diff seleccionado: working tree, staged o commit. */
  selectedSide: 'worktree' | 'staged' | 'commit';
  /** Commit contra el que se compara cuando `selectedSide` es `commit`. */
  selectedOldOid: string | null;
  diff: DiffResult | null;

  // --- UI ---
  panel: SidePanel;
  /** Preferencia de tema; `system` sigue a la del sistema operativo. */
  theme: Theme;
  /** Tema ya resuelto, para componentes que no pueden usar CSS. */
  resolvedTheme: 'light' | 'dark';
  settingsOpen: boolean;
  /** Terminal embebida visible en la parte inferior. */
  terminalOpen: boolean;
  /** Panel lateral izquierdo visible. */
  sidebarOpen: boolean;
  loading: boolean;
  toasts: Toast[];
  commitMessage: string;
  graphHighlight: string;
  /** Anchos de la tabla de commits, arrastrables desde la cabecera. */
  columnWidths: ColumnWidths;

  // --- GitHub ---
  githubUser: GitHubUser | null;
  githubLoginOpen: boolean;
  githubReposOpen: boolean;
  githubRepos: GitHubRepo[];
  githubReposLoading: boolean;

  // --- Acciones ---
  refreshRepositories: () => Promise<void>;
  openPath: (path: string) => Promise<void>;
  cloneAndOpen: (url: string, path: string) => Promise<void>;
  closeCurrent: () => Promise<void>;

  openGitHubLogin: () => void;
  closeGitHubLogin: () => void;
  openGitHubRepos: () => void;
  closeGitHubRepos: () => void;
  refreshGitHubUser: () => Promise<void>;
  refreshGitHubRepos: () => Promise<void>;
  logoutGitHub: () => Promise<void>;

  refreshAll: () => Promise<void>;
  refreshStatus: () => Promise<void>;
  refreshGraph: () => Promise<void>;
  refreshBranches: () => Promise<void>;
  refreshStashes: () => Promise<void>;
  refreshRemotes: () => Promise<void>;
  refreshFlow: () => Promise<void>;
  refreshOperationState: () => Promise<void>;
  refreshReflog: () => Promise<void>;

  selectCommit: (oid: string | null) => Promise<void>;
  /**
   * Selecciona un archivo para ver su diff.
   *
   * `side` admite `commit` (con `oldOid`) porque el detalle de un commit debe
   * comparar contra su arbol, no contra el working tree.
   */
  selectFile: (
    path: string | null,
    side?: 'worktree' | 'staged' | 'commit',
    oldOid?: string | null,
  ) => Promise<void>;

  setPanel: (panel: SidePanel) => void;
  setTheme: (theme: Theme) => void;
  openSettings: () => void;
  closeSettings: () => void;
  toggleTerminal: () => void;
  toggleSidebar: () => void;
  syncSystemTheme: () => void;
  setCommitMessage: (message: string) => void;
  setGraphHighlight: (value: string) => void;
  setColumnWidth: (key: ColumnKey, width: number) => void;

  notify: (kind: Toast['kind'], text: string) => void;
  dismissToast: (id: number) => void;

  /** Envoltura para ejecutar una accion mutante y refrescar lo afectado. */
  run: (label: string, action: () => Promise<unknown>) => Promise<boolean>;
}

let toastSeq = 0;

export const useStore = create<FoxenState>((set, get) => ({
  repositories: [],
  repoId: null,

  status: null,
  graph: null,
  branches: null,
  tags: [],
  stashes: [],
  remotes: [],
  flow: null,
  reflog: [],
  operationState: null,

  selectedOid: null,
  selectedDetail: null,
  selectedFile: null,
  selectedSide: 'worktree',
  selectedOldOid: null,
  diff: null,

  panel: 'changes',
  theme: loadTheme(),
  resolvedTheme: applyTheme(loadTheme()),
  settingsOpen: false,
  terminalOpen: false,
  sidebarOpen: true,
  loading: false,
  toasts: [],
  commitMessage: '',
  graphHighlight: '',
  columnWidths: loadColumnWidths(),

  // --- GitHub ---
  githubUser: null,
  githubLoginOpen: false,
  githubReposOpen: false,
  githubRepos: [],
  githubReposLoading: false,

  // -------------------------------------------------------------------------
  // Repositorios
  // -------------------------------------------------------------------------

  refreshRepositories: async () => {
    try {
      const repositories = await ipc.listRepositories();
      set({ repositories });
    } catch (error) {
      get().notify('error', errorMessage(error));
    }
  },

  openPath: async (path: string) => {
    set({ loading: true });
    try {
      const { handle } = await ipc.openRepository(path);
      set({
        repoId: handle.id,
        selectedOid: null,
        selectedDetail: null,
        selectedFile: null,
        diff: null,
      });
      await get().refreshRepositories();
      await get().refreshAll();
      get().notify('success', `Repositorio abierto: ${handle.name}`);
    } catch (error) {
      get().notify('error', errorMessage(error));
    } finally {
      set({ loading: false });
    }
  },

  cloneAndOpen: async (url: string, path: string) => {
    set({ loading: true });
    try {
      const { handle } = await ipc.cloneRepository(url, path);
      set({
        repoId: handle.id,
        selectedOid: null,
        selectedDetail: null,
        selectedFile: null,
        diff: null,
        githubReposOpen: false,
      });
      await get().refreshRepositories();
      await get().refreshAll();
      get().notify('success', `Repositorio clonado y abierto: ${handle.name}`);
    } catch (error) {
      get().notify('error', errorMessage(error));
    } finally {
      set({ loading: false });
    }
  },

  openGitHubLogin: () => set({ githubLoginOpen: true }),
  closeGitHubLogin: () => set({ githubLoginOpen: false }),

  openGitHubRepos: () => {
    set({ githubReposOpen: true });
    void get().refreshGitHubRepos();
  },
  closeGitHubRepos: () => set({ githubReposOpen: false }),

  refreshGitHubUser: async () => {
    try {
      const user = await ipc.githubGetUser();
      set({ githubUser: user });
    } catch {
      set({ githubUser: null });
    }
  },

  refreshGitHubRepos: async () => {
    set({ githubReposLoading: true });
    try {
      const repos = await ipc.githubListRepos();
      set({ githubRepos: repos });
    } catch (error) {
      get().notify('error', errorMessage(error));
    } finally {
      set({ githubReposLoading: false });
    }
  },

  logoutGitHub: async () => {
    try {
      await ipc.githubLogout();
      set({ githubUser: null, githubRepos: [], githubReposOpen: false });
      get().notify('info', 'Sesión de GitHub cerrada');
    } catch (error) {
      get().notify('error', errorMessage(error));
    }
  },

  closeCurrent: async () => {
    const { repoId } = get();
    if (!repoId) return;
    try {
      await ipc.closeRepository(repoId);
    } catch (error) {
      get().notify('error', errorMessage(error));
      return;
    }
    set({
      repoId: null,
      status: null,
      graph: null,
      branches: null,
      tags: [],
      stashes: [],
      remotes: [],
      flow: null,
      reflog: [],
      operationState: null,
      selectedOid: null,
      selectedDetail: null,
      selectedFile: null,
      diff: null,
    });
    await get().refreshRepositories();
  },

  // -------------------------------------------------------------------------
  // Carga de datos
  // -------------------------------------------------------------------------

  refreshAll: async () => {
    const { repoId } = get();
    if (!repoId) return;
    set({ loading: true });
    try {
      // Primero status+grafo: son lo que pinta la pantalla principal.
      await Promise.all([get().refreshStatus(), get().refreshGraph()]);
      await Promise.all([
        get().refreshBranches(),
        get().refreshStashes(),
        get().refreshRemotes(),
        get().refreshFlow(),
        get().refreshOperationState(),
      ]);
    } finally {
      set({ loading: false });
    }
  },

  refreshStatus: async () => {
    const { repoId } = get();
    if (!repoId) return;
    try {
      const status = await ipc.getStatus(repoId);
      set({ status });

      // El archivo seleccionado puede haber desaparecido tras un cambio, pero
      // solo hay que limpiarlo si venia del working tree: los archivos de un
      // commit no aparecen nunca en el status.
      const { selectedFile: selected, selectedSide } = get();
      if (
        selected &&
        selectedSide !== 'commit' &&
        !status.files.some((f) => f.path === selected)
      ) {
        await get().selectFile(null);
      }
    } catch (error) {
      get().notify('error', errorMessage(error));
    }
  },

  refreshGraph: async () => {
    const { repoId, graphHighlight } = get();
    if (!repoId) return;
    try {
      const graph = await ipc.loadGraph({
        repoId,
        limit: 750,
        heads: [],
        allRefs: true,
        currentOnly: false,
        highlight: graphHighlight || null,
      });
      set({ graph });

      // Mantiene la seleccion si el commit sigue en el grafo.
      const selected = get().selectedOid;
      if (selected && !graph.nodes.some((n) => n.oid === selected)) {
        set({ selectedOid: null, selectedDetail: null });
      }
    } catch (error) {
      get().notify('error', errorMessage(error));
    }
  },

  refreshBranches: async () => {
    const { repoId } = get();
    if (!repoId) return;
    try {
      const [branches, tags] = await Promise.all([
        ipc.listBranches(repoId),
        ipc.listTags(repoId),
      ]);
      set({ branches, tags });
    } catch (error) {
      get().notify('error', errorMessage(error));
    }
  },

  refreshStashes: async () => {
    const { repoId } = get();
    if (!repoId) return;
    try {
      set({ stashes: await ipc.listStashes(repoId) });
    } catch (error) {
      get().notify('error', errorMessage(error));
    }
  },

  refreshRemotes: async () => {
    const { repoId } = get();
    if (!repoId) return;
    try {
      set({ remotes: await ipc.listRemotes(repoId) });
    } catch (error) {
      get().notify('error', errorMessage(error));
    }
  },

  refreshFlow: async () => {
    const { repoId } = get();
    if (!repoId) return;
    try {
      set({ flow: await ipc.flowStatus(repoId) });
    } catch {
      // Git Flow es opcional: si falla, el panel simply lo muestra inactivo.
      set({ flow: null });
    }
  },

  refreshOperationState: async () => {
    const { repoId } = get();
    if (!repoId) return;
    try {
      set({ operationState: await ipc.repositoryOperationState(repoId) });
    } catch (error) {
      get().notify('error', errorMessage(error));
    }
  },

  refreshReflog: async () => {
    const { repoId } = get();
    if (!repoId) return;
    try {
      set({ reflog: await ipc.listReflog(repoId, 200) });
    } catch (error) {
      get().notify('error', errorMessage(error));
    }
  },

  // -------------------------------------------------------------------------
  // Seleccion
  // -------------------------------------------------------------------------

  selectCommit: async (oid) => {
    const { repoId } = get();
    set({ selectedOid: oid });
    if (!repoId || !oid) {
      set({ selectedDetail: null });
      return;
    }
    try {
      set({ selectedDetail: await ipc.getCommitDetail(repoId, oid) });
    } catch (error) {
      set({ selectedDetail: null });
      get().notify('error', errorMessage(error));
    }
  },

  selectFile: async (path, side = 'worktree', oldOid = null) => {
    const { repoId } = get();
    set({ selectedFile: path, selectedSide: side, selectedOldOid: oldOid });
    if (!repoId || !path) {
      set({ diff: null });
      return;
    }
    try {
      const diff = await ipc.getDiff({
        repoId,
        side,
        path,
        oldOid,
        newOid: null,
        includeContext: false,
        context: 3,
        maxFileBytes: 2_000_000,
      });
      set({ diff });
    } catch (error) {
      set({ diff: null });
      get().notify('error', errorMessage(error));
    }
  },

  // -------------------------------------------------------------------------
  // UI
  // -------------------------------------------------------------------------

  setPanel: (panel) => {
    set({ panel });
    // El reflog se carga bajo demanda porque puede ser largo.
    if (panel === 'reflog') void get().refreshReflog();
  },

  setTheme: (theme) => {
    saveTheme(theme);
    // Se resuelve en el acto, no en un efecto, para que el repintado sea inmediato.
    set({ theme, resolvedTheme: applyTheme(theme) });
  },

  openSettings: () => set({ settingsOpen: true }),
  closeSettings: () => set({ settingsOpen: false }),
  toggleTerminal: () => set({ terminalOpen: !get().terminalOpen }),
  toggleSidebar: () => set({ sidebarOpen: !get().sidebarOpen }),

  /** Reacciona a un cambio de tema del sistema mientras el modo es `system`. */
  syncSystemTheme: () => {
    const { theme } = get();
    if (theme === 'system') set({ resolvedTheme: applyTheme(theme) });
  },

  setCommitMessage: (commitMessage) => set({ commitMessage }),

  setGraphHighlight: (graphHighlight) => {
    set({ graphHighlight });
    void get().refreshGraph();
  },

  setColumnWidth: (key, width) => {
    const columnWidths = { ...get().columnWidths };
    // Asignacion por clave dinamica: con `key` union el spread no infiere el tipo.
    columnWidths[key] = clampColumnWidth(key, width);
    saveColumnWidths(columnWidths);
    set({ columnWidths });
  },

  notify: (kind, text) => {
    const id = (toastSeq += 1);
    set((state) => ({ toasts: [...state.toasts, { id, kind, text }] }));
    if (kind !== 'error') {
      window.setTimeout(() => get().dismissToast(id), 4000);
    }
  },

  dismissToast: (id) => set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) })),

  run: async (label, action) => {
    const { repoId } = get();
    if (!repoId) return false;
    set({ loading: true });
    try {
      const result = await action();
      await get().refreshAll();
      const message =
        result && typeof result === 'object' && 'message' in result
          ? String((result as { message: unknown }).message)
          : '';
      get().notify('success', message || `${label}: correcto`);
      return true;
    } catch (error) {
      get().notify('error', `${label}: ${errorMessage(error)}`);
      // Tras un conflicto el estado del repositorio cambia: hay que recargarlo.
      await get().refreshAll();
      return false;
    } finally {
      set({ loading: false });
    }
  },
}));