import { useEffect, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { useStore, type SidePanel } from '../store/useAppStore';
import * as ipc from '../lib/ipc';
import { errorMessage } from '../lib/ipc';

const PANELS: { id: SidePanel; label: string }[] = [
  { id: 'changes', label: 'Cambios' },
  { id: 'branches', label: 'Ramas' },
  { id: 'stashes', label: 'Stashes' },
  { id: 'remotes', label: 'Remotos' },
  { id: 'flow', label: 'Git Flow' },
  { id: 'reflog', label: 'Reflog' },
];

/** Selector de repositorio, abre el dialogo nativo del sistema. */
function RepositoryPicker() {
  const repositories = useStore((s) => s.repositories);
  const openPath = useStore((s) => s.openPath);
  const notify = useStore((s) => s.notify);
  const githubUser = useStore((s) => s.githubUser);
  const openGitHubLogin = useStore((s) => s.openGitHubLogin);
  const openGitHubRepos = useStore((s) => s.openGitHubRepos);
  const [open_, setOpen] = useState(false);

  useEffect(() => {
    void useStore.getState().refreshRepositories();
  }, []);

  const browse = async () => {
    try {
      // El dialogo de Tauri usa el portal de Flatpak: el usuario concede
      // acceso solo a la carpeta que elige, no a todo el disco.
      const selected = await open({
        directory: true,
        multiple: false,
        title: 'Abrir repositorio Git',
      });
      if (typeof selected === 'string') await openPath(selected);
    } catch (error) {
      notify('error', errorMessage(error));
    }
  };

  return (
    <div className="repo-picker">
      <button type="button" className="repo-button" onClick={() => setOpen((v) => !v)}>
        Foxen ▾
      </button>

      {open_ && (
        <div className="repo-menu">
          <button type="button" className="repo-menu-item" onClick={() => void browse()}>
            Abrir repositorio…
          </button>
          <button
            type="button"
            className="repo-menu-item"
            onClick={() => {
              setOpen(false);
              if (githubUser) {
                openGitHubRepos();
              } else {
                openGitHubLogin();
              }
            }}
          >
            🐙 Clonar desde GitHub…
          </button>
          {repositories.length > 0 && (
            <>
              <div className="repo-menu-sep">Abiertos recientemente</div>
              {repositories.map((repo) => (
                <button
                  key={repo.id}
                  type="button"
                  className="repo-menu-item"
                  onClick={() => {
                    setOpen(false);
                    void openPath(repo.path);
                  }}
                >
                  <strong>{repo.name}</strong>
                  <small>{repo.path}</small>
                </button>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** Barra superior: rama actual, estado y acciones rapidas. */
export function TopBar() {
  const repoId = useStore((s) => s.repoId);
  const status = useStore((s) => s.status);
  const run = useStore((s) => s.run);
  const highlight = useStore((s) => s.graphHighlight);
  const setHighlight = useStore((s) => s.setGraphHighlight);
  const loading = useStore((s) => s.loading);
  const openSettings = useStore((s) => s.openSettings);
  const terminalOpen = useStore((s) => s.terminalOpen);
  const toggleTerminal = useStore((s) => s.toggleTerminal);
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const toggleSidebar = useStore((s) => s.toggleSidebar);
  const githubUser = useStore((s) => s.githubUser);
  const openGitHubLogin = useStore((s) => s.openGitHubLogin);
  const openGitHubRepos = useStore((s) => s.openGitHubRepos);
  const refreshGitHubUser = useStore((s) => s.refreshGitHubUser);

  useEffect(() => {
    void refreshGitHubUser();
  }, [refreshGitHubUser]);

  const fetchAll = () => {
    if (!repoId) return;
    void run('Fetch', () => ipc.fetchRemote(repoId, null, true, null));
  };

  return (
    <header className="topbar">
      <button
        type="button"
        className="icon-button"
        onClick={toggleSidebar}
        aria-label={sidebarOpen ? 'Ocultar panel lateral' : 'Mostrar panel lateral'}
        aria-expanded={sidebarOpen}
        title={sidebarOpen ? 'Ocultar panel lateral' : 'Mostrar panel lateral'}
      >
        ☰
      </button>

      <RepositoryPicker />

      {status && (
        <div className="topbar-branch">
          <strong>{status.headBranch ?? 'HEAD desligado'}</strong>
          {status.hasUpstream && (
            <span className="topbar-tracking">
              {status.ahead > 0 && <span className="badge badge-ahead">↑{status.ahead}</span>}
              {status.behind > 0 && <span className="badge badge-behind">↓{status.behind}</span>}
              <code>{status.upstream}</code>
            </span>
          )}
          {status.conflictedCount > 0 && (
            <span className="badge badge-conflict">{status.conflictedCount} conflictos</span>
          )}
        </div>
      )}

      <div className="topbar-actions">
        <input
          type="search"
          className="graph-filter"
          placeholder="Resaltar commit…"
          value={highlight}
          onChange={(e) => setHighlight(e.target.value)}
          disabled={!repoId}
        />
        <button type="button" onClick={fetchAll} disabled={!repoId || loading}>
          Fetch
        </button>
        <button
          type="button"
          onClick={toggleTerminal}
          disabled={!repoId}
          aria-pressed={terminalOpen}
          title="Mostrar u ocultar la terminal del repositorio"
        >
          Terminal
        </button>
        {githubUser ? (
          <button
            type="button"
            onClick={openGitHubRepos}
            title={`Conectado como @${githubUser.login}. Ver repositorios de GitHub.`}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 8px' }}
          >
            {githubUser.avatarUrl ? (
              <img
                src={githubUser.avatarUrl}
                alt={githubUser.login}
                style={{ width: 16, height: 16, borderRadius: '50%' }}
              />
            ) : (
              <span>🐙</span>
            )}
            <span>@{githubUser.login}</span>
          </button>
        ) : (
          <button
            type="button"
            onClick={openGitHubLogin}
            title="Iniciar sesión en GitHub con tu navegador"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
          >
            <span>🐙</span>
            <span>GitHub</span>
          </button>
        )}
        {/* El ajuste vive junto al resto de acciones globales, no en el sidebar,
            porque los ajustes son de la aplicacion y no del repositorio. */}
        <button
          type="button"
          className="icon-button"
          onClick={openSettings}
          aria-label="Abrir configuracion"
          title="Configuracion"
        >
          ⚙
        </button>
      </div>
    </header>
  );
}

/** Selector de paneles del lateral izquierdo. */
export function PanelTabs() {
  const panel = useStore((s) => s.panel);
  const setPanel = useStore((s) => s.setPanel);
  const status = useStore((s) => s.status);
  const stashes = useStore((s) => s.stashes);

  const badgeFor = (id: SidePanel): number | null => {
    if (!status) return null;
    switch (id) {
      case 'changes':
        return status.files.length > 0 ? status.files.length : null;
      case 'stashes':
        return stashes.length > 0 ? stashes.length : null;
      case 'reflog':
        return null;
      default:
        return null;
    }
  };

  return (
    <nav className="panel-tabs" role="tablist">
      {PANELS.map(({ id, label }) => {
        const badge = badgeFor(id);
        return (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={panel === id}
            className={`panel-tab${panel === id ? ' is-active' : ''}`}
            onClick={() => setPanel(id)}
          >
            {label}
            {badge !== null && <span className="tab-badge">{badge}</span>}
          </button>
        );
      })}
    </nav>
  );
}

/** Avisos flotantes. */
export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  const dismiss = useStore((s) => s.dismissToast);

  if (toasts.length === 0) return null;

  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <button
          key={toast.id}
          type="button"
          className={`toast toast-${toast.kind}`}
          onClick={() => dismiss(toast.id)}
        >
          {toast.text}
        </button>
      ))}
    </div>
  );
}