import { CommitGraphView } from './components/CommitGraph';
import { ChangesPanel, DiffPanel } from './components/ChangesPanel';
import { BranchesPanel, StashesPanel } from './components/BranchesPanel';
import { FlowPanel, ReflogPanel, RemotesPanel } from './components/RemotesPanel';
import { CommitDetailView } from './components/CommitDetail';
import { TerminalPanel } from './components/TerminalPanel';
import { PanelTabs, Toasts, TopBar } from './components/TopBar';
import { SettingsPanel } from './components/SettingsPanel';
import { GitHubAuthModal } from './components/GitHubAuthModal';
import { GitHubReposModal } from './components/GitHubReposModal';
import { useStore } from './store/useAppStore';
import { useEffect } from 'react';
import { onSystemThemeChange } from './lib/theme';
import { open } from '@tauri-apps/plugin-dialog';

export default function App() {
  const repoId = useStore((s) => s.repoId);
  const graph = useStore((s) => s.graph);
  const panel = useStore((s) => s.panel);
  const selectedDetail = useStore((s) => s.selectedDetail);
  const selectedFile = useStore((s) => s.selectedFile);
  const loading = useStore((s) => s.loading);
  const status = useStore((s) => s.status);
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

  // En modo «seguir al sistema» hay que repintar cuando cambia la preferencia
  // del SO con la app abierta.
  useEffect(() => onSystemThemeChange(() => syncSystemTheme()), [syncSystemTheme]);

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
        <Toasts />
      </div>
    );
  }

  /** El diff del archivo seleccionado tiene prioridad sobre la lista de paneles. */
  const showDiff = selectedFile !== null && selectedDetail === null;

  return (
    <div className="app">
      <TopBar />

      <div className={`layout${sidebarOpen ? '' : ' sidebar-hidden'}`}>
        <aside className={`sidebar${sidebarOpen ? '' : ' is-hidden'}`}>
          <PanelTabs />
          {panel === 'changes' && !showDiff && <ChangesPanel />}
          {panel === 'branches' && <BranchesPanel />}
          {panel === 'stashes' && <StashesPanel />}
          {panel === 'remotes' && <RemotesPanel />}
          {panel === 'flow' && <FlowPanel />}
          {panel === 'reflog' && <ReflogPanel />}
          {showDiff && <DiffPanel />}
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

        <aside className="inspector">
          {selectedDetail ? (
            <CommitDetailView />
          ) : selectedFile ? (
            <p className="empty">Diff abierto en el panel izquierdo.</p>
          ) : status && !status.clean ? (
            <p className="empty">
              {status.files.length} archivo(s) con cambios. Usa el panel <strong>Cambios</strong>{' '}
              para revisarlos.
            </p>
          ) : (
            <p className="empty">Selecciona un commit para ver su detalle.</p>
          )}
        </aside>
      </div>

      {terminalOpen && <TerminalPanel key={repoId} />}

      {settingsOpen && <SettingsPanel />}
      {githubLoginOpen && <GitHubAuthModal />}
      {githubReposOpen && <GitHubReposModal />}
      <Toasts />
    </div>
  );
}