import { CommitGraphView } from './components/CommitGraph';
import { ChangesPanel, DiffPanel } from './components/ChangesPanel';
import { BranchesPanel, StashesPanel } from './components/BranchesPanel';
import { FlowPanel, ReflogPanel, RemotesPanel } from './components/RemotesPanel';
import { CommitDetailModal } from './components/CommitDetailModal';
import { TerminalPanel } from './components/TerminalPanel';
import { PanelTabs, Toasts, TopBar } from './components/TopBar';
import { SettingsPanel } from './components/SettingsPanel';
import { GitHubAuthModal } from './components/GitHubAuthModal';
import { GitHubReposModal } from './components/GitHubReposModal';
import { PublishToGitHubModal } from './components/PublishToGitHubModal';
import { MergeModal } from './components/MergeModal';
import { CreateTagModal } from './components/CreateTagModal';
import { OperationBanner } from './components/OperationBanner';
import { useStore } from './store/useAppStore';
import * as ipc from './lib/ipc';
import { useEffect } from 'react';
import { onSystemThemeChange } from './lib/theme';
import { open } from '@tauri-apps/plugin-dialog';
import { join } from '@tauri-apps/api/path';

/** Nombre de carpeta sugerido a partir de una URL de clonado. */
function repoNameFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const last = parsed.pathname.replace(/\/+$/, '').split('/').pop() ?? '';
    const name = last.replace(/\.git$/i, '');
    if (name) return name;
  } catch {
    // URL no parseable: se usa el nombre generico.
  }
  return 'repositorio';
}

export default function App() {
  const repoId = useStore((s) => s.repoId);
  const graph = useStore((s) => s.graph);
  const panel = useStore((s) => s.panel);
  const detailOpen = useStore((s) => s.detailOpen);
  const selectedFile = useStore((s) => s.selectedFile);
  const selectedSide = useStore((s) => s.selectedSide);
  const loading = useStore((s) => s.loading);
  const settingsOpen = useStore((s) => s.settingsOpen);
  const terminalOpen = useStore((s) => s.terminalOpen);
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const syncSystemTheme = useStore((s) => s.syncSystemTheme);
  const githubLoginOpen = useStore((s) => s.githubLoginOpen);
  const githubReposOpen = useStore((s) => s.githubReposOpen);
  const githubUser = useStore((s) => s.githubUser);
  const openGitHubLogin = useStore((s) => s.openGitHubLogin);
  const openGitHubRepos = useStore((s) => s.openGitHubRepos);
  const openPath = useStore((s) => s.openPath);
  const restoreSession = useStore((s) => s.restoreSession);
  const publishOpen = useStore((s) => s.publishOpen);
  const mergeTarget = useStore((s) => s.mergeTarget);
  const tagPrompt = useStore((s) => s.tagPrompt);
  // En modo «seguir al sistema» hay que repintar cuando cambia la preferencia
  // del SO con la app abierta.
  useEffect(() => onSystemThemeChange(() => syncSystemTheme()), [syncSystemTheme]);

  // El primer pintado usa la cache; el backend confirma el tema persistido.
  useEffect(() => {
    void useStore.getState().hydrateTheme();
  }, []);

  // Reabre los repositorios que quedaron abiertos en la sesion anterior.
  useEffect(() => {
    void restoreSession();
  }, [restoreSession]);

  // El backend vigila el repositorio con inotify: cualquier cambio externo
  // (git en una terminal, un rebase, un editor...) refresca la UI sola.
  useEffect(() => {
    let timer: number | undefined;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    const schedule = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const state = useStore.getState();
        if (state.repoId) void state.refreshAll();
      }, 200);
    };
    void ipc
      .onGitChanged((id) => {
        if (id === useStore.getState().repoId) schedule();
      })
      .then((fn) => {
        // Si el efecto ya se limpio antes de resolverse la promesa, se quita el
        // listener en el acto para no dejarlo colgado (StrictMode monta dos veces).
        if (cancelled) fn();
        else unlisten = fn;
      });
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      unlisten?.();
    };
  }, []);

  // Las ediciones del arbol de trabajo no tocan `.git`: al volver a la ventana
  // se refresca igualmente (cubre ademas sistemas sin inotify disponible).
  useEffect(() => {
    let timer: number | undefined;
    const onFocus = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const state = useStore.getState();
        if (state.repoId) void state.refreshAll();
      }, 500);
    };
    window.addEventListener('focus', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
      window.clearTimeout(timer);
    };
  }, []);

  // Refresco manual. F5 recargaria el webview y Ctrl+R tambien, asi que se
  // interceptan para refrescar el repositorio en su lugar.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const wantsRefresh =
        (event.ctrlKey && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'r') ||
        event.key === 'F5';
      if (!wantsRefresh) return;
      event.preventDefault();
      const state = useStore.getState();
      if (state.repoId) void state.refreshAll();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Enlaces git://: xdg-open lanza Foxen con la URL (primer arranque) o la pasa
  // a la instancia abierta. Se pide la carpeta destino y se clona.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    const startClone = async (url: string) => {
      try {
        const parent = await open({
          directory: true,
          multiple: false,
          title: 'Elegir carpeta donde clonar',
        });
        if (typeof parent !== 'string') return;
        const dest = await join(parent, repoNameFromUrl(url));
        await useStore.getState().cloneAndOpen(url, dest);
      } catch (error) {
        useStore.getState().notify('error', ipc.errorMessage(error));
      }
    };
    const drain = () => {
      void ipc.takePendingCloneUrl().then((url) => {
        if (url) void startClone(url);
      });
    };
    drain();
    void ipc.onCloneRequest(drain).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const handleBrowseLocal = async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: 'Abrir repositorio Git',
      });
      if (typeof selected === 'string') await openPath(selected);
    } catch {
      // Ignorar cancelaciones
    }
  };

  if (!repoId) {
    return (
      <div className="app">
        <TopBar />
        <div className="welcome">
          <h1>Foxen</h1>
          <p>Abre un repositorio Git para empezar o gestiona tus fuentes desde GitHub.</p>
          <div style={{ display: 'flex', gap: 12, justifyContent: 'center', margin: '24px 0', flexWrap: 'wrap' }}>
            <button type="button" className="primary" onClick={() => void handleBrowseLocal()} style={{ padding: '8px 16px' }}>
              📁 Abrir repositorio local…
            </button>
            {githubUser ? (
              <button type="button" onClick={openGitHubRepos} style={{ padding: '8px 16px', display: 'flex', alignItems: 'center', gap: 8 }}>
                <span>🐙</span>
                <span>Explorar repositorios de GitHub (@{githubUser.login})</span>
              </button>
            ) : (
              <button type="button" onClick={openGitHubLogin} style={{ padding: '8px 16px', display: 'flex', alignItems: 'center', gap: 8 }}>
                <span>🐙</span>
                <span>Iniciar sesión en GitHub</span>
              </button>
            )}
          </div>
          <p className="hint">
            Usa el menú <strong>Foxen ▾</strong> o el botón <strong>🐙 GitHub</strong> de la barra superior.
          </p>
        </div>
        {settingsOpen && <SettingsPanel />}
        {githubLoginOpen && <GitHubAuthModal />}
        {githubReposOpen && <GitHubReposModal />}
        {publishOpen && <PublishToGitHubModal />}
        <Toasts />
      </div>
    );
  }

  /**
   * El diff del archivo seleccionado tiene prioridad sobre la lista de paneles.
   * Los diffs de commits viven en el popup de detalle, no en la barra lateral.
   */
  const showDiff = selectedFile !== null && selectedSide !== 'commit';

  return (
    <div className="app">
      <TopBar />

      <OperationBanner />

      <div className={`layout${sidebarOpen ? '' : ' sidebar-hidden'}`}>
        <aside className={`sidebar${sidebarOpen ? '' : ' is-hidden'}`}>
          <PanelTabs />
          <div className="sidebar-content">
            {panel === 'changes' && !showDiff && <ChangesPanel />}
            {panel === 'branches' && <BranchesPanel />}
            {panel === 'stashes' && <StashesPanel />}
            {panel === 'remotes' && <RemotesPanel />}
            {panel === 'flow' && <FlowPanel />}
            {panel === 'reflog' && <ReflogPanel />}
            {showDiff && <DiffPanel />}
          </div>
        </aside>

        <main className="main">
          {loading && <div className="loading-bar" />}
          {graph ? (
            <CommitGraphView
              nodes={graph.nodes}
              edges={graph.edges}
              laneCount={graph.laneCount}
              truncated={graph.truncated}
              totalReachable={graph.totalReachable}
            />
          ) : (
            <p className="empty">Cargando grafo…</p>
          )}
        </main>

      </div>

      {terminalOpen && <TerminalPanel key={repoId} />}

      {settingsOpen && <SettingsPanel />}
      {githubLoginOpen && <GitHubAuthModal />}
      {githubReposOpen && <GitHubReposModal />}
      {publishOpen && <PublishToGitHubModal />}
      {mergeTarget && <MergeModal />}
      {tagPrompt && <CreateTagModal />}
      {detailOpen && <CommitDetailModal />}
      <Toasts />
    </div>
  );
}