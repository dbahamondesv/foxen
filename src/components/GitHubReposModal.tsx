import { useEffect, useRef, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { openUrl } from '@tauri-apps/plugin-opener';
import { useStore } from '../store/useAppStore';
import { relativeTime } from '../lib/format';
import type { GitHubRepo } from '../lib/types';

export function GitHubReposModal() {
  const close = useStore((s) => s.closeGitHubRepos);
  const user = useStore((s) => s.githubUser);
  const repos = useStore((s) => s.githubRepos);
  const reposLoading = useStore((s) => s.githubReposLoading);
  const refreshRepos = useStore((s) => s.refreshGitHubRepos);
  const logout = useStore((s) => s.logoutGitHub);
  const cloneAndOpen = useStore((s) => s.cloneAndOpen);
  const notify = useStore((s) => s.notify);

  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<'all' | 'public' | 'private'>('all');
  const [cloningRepo, setCloningRepo] = useState<string | null>(null);

  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !cloningRepo) close();
    };
    window.addEventListener('keydown', onKey);
    dialogRef.current?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [close, cloningRepo]);

  const filteredRepos = repos.filter((r) => {
    const matchesSearch =
      r.name.toLowerCase().includes(search.toLowerCase()) ||
      (r.description?.toLowerCase().includes(search.toLowerCase()) ?? false);
    if (!matchesSearch) return false;
    if (filter === 'public') return !r.private;
    if (filter === 'private') return r.private;
    return true;
  });

  const handleClone = async (repo: GitHubRepo) => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: `Selecciona la carpeta donde guardar ${repo.name}`,
      });

      if (typeof selected !== 'string') return;

      // Normaliza la ruta de destino añadiendo el nombre del repositorio
      const separator = selected.includes('\\') ? '\\' : '/';
      const destination = selected.endsWith(separator)
        ? `${selected}${repo.name}`
        : `${selected}${separator}${repo.name}`;

      setCloningRepo(repo.fullName);
      notify('info', `Clonando ${repo.fullName} en ${destination}...`);
      await cloneAndOpen(repo.cloneUrl, destination);
    } catch (err) {
      notify('error', `Error al clonar: ${String(err)}`);
    } finally {
      setCloningRepo(null);
    }
  };

  return (
    <div
      className="modal-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget && !cloningRepo) close();
      }}
    >
      <div
        className="modal github-repos-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="github-repos-title"
        ref={dialogRef}
        tabIndex={-1}
        style={{ maxWidth: 840, width: '90%', maxHeight: '88vh', display: 'flex', flexDirection: 'column' }}
      >
        <header className="modal-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            {user?.avatarUrl && (
              <img
                src={user.avatarUrl}
                alt={user.login}
                style={{ width: 36, height: 36, borderRadius: '50%' }}
              />
            )}
            <div>
              <h2 id="github-repos-title" style={{ margin: 0, fontSize: '1.2em' }}>
                {user ? `${user.name || user.login} (@${user.login})` : 'Repositorios de GitHub'}
              </h2>
              <small style={{ color: 'var(--text-muted)' }}>
                Gestión de fuentes y clonación en tu espacio local
              </small>
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <button
              type="button"
              className="link danger"
              style={{ fontSize: 13 }}
              onClick={() => {
                if (window.confirm('¿Deseas cerrar tu sesión de GitHub en Foxen?')) {
                  void logout();
                }
              }}
            >
              Cerrar sesión
            </button>
            <button type="button" className="icon-button" onClick={close} aria-label="Cerrar">
              ×
            </button>
          </div>
        </header>

        <div className="modal-body" style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 14 }}>
          {/* Barra de herramientas: Búsqueda, Filtros y Nuevo Repo */}
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <input
              type="search"
              placeholder="Buscar repositorios por nombre o descripción..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={{ flex: 1, minWidth: 220 }}
            />

            <div className="segmented" role="radiogroup">
              <button
                type="button"
                className={`segmented-option ${filter === 'all' ? 'is-active' : ''}`}
                onClick={() => setFilter('all')}
              >
                Todos ({repos.length})
              </button>
              <button
                type="button"
                className={`segmented-option ${filter === 'public' ? 'is-active' : ''}`}
                onClick={() => setFilter('public')}
              >
                Públicos
              </button>
              <button
                type="button"
                className={`segmented-option ${filter === 'private' ? 'is-active' : ''}`}
                onClick={() => setFilter('private')}
              >
                Privados
              </button>
            </div>

            <button
              type="button"
              onClick={() => void refreshRepos()}
              disabled={reposLoading}
              title="Actualizar lista de repositorios"
            >
              {reposLoading ? '↻ Cargando…' : '↻ Actualizar'}
            </button>

            <button
              type="button"
              onClick={() => void openUrl('https://github.com/new')}
              className="secondary"
              title="Crear un nuevo repositorio en GitHub"
            >
              + Nuevo en GitHub
            </button>
          </div>

          {/* Estado de clonación activa */}
          {cloningRepo && (
            <div
              style={{
                padding: 12,
                borderRadius: 6,
                background: 'var(--bg-subtle, rgba(255, 255, 255, 0.05))',
                border: '1px solid var(--accent, #58a6ff)',
                display: 'flex',
                alignItems: 'center',
                gap: 12,
              }}
            >
              <span className="spinner">⏳</span>
              <span>
                Clonando <strong>{cloningRepo}</strong>... Esto puede tardar unos segundos dependiendo del tamaño.
              </span>
            </div>
          )}

          {/* Lista de repositorios */}
          {reposLoading && repos.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--text-muted)' }}>
              Cargando tus repositorios de GitHub...
            </div>
          ) : filteredRepos.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--text-muted)' }}>
              {search ? 'No se encontraron repositorios con ese criterio.' : 'No se encontraron repositorios.'}
            </div>
          ) : (
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
              {filteredRepos.map((repo) => (
                <li
                  key={repo.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '12px 16px',
                    borderRadius: 6,
                    border: '1px solid var(--border)',
                    background: 'var(--bg-subtle, rgba(255, 255, 255, 0.02))',
                    gap: 16,
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                      <strong style={{ fontSize: 15, wordBreak: 'break-word' }}>
                        {repo.fullName}
                      </strong>
                      <span
                        className={`badge ${repo.private ? 'badge-warn' : 'badge-ahead'}`}
                        style={{ fontSize: 11, padding: '2px 6px' }}
                      >
                        {repo.private ? '🔒 Privado' : '🌐 Público'}
                      </span>
                      {repo.defaultBranch && (
                        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                          rama: <code>{repo.defaultBranch}</code>
                        </span>
                      )}
                    </div>

                    {repo.description && (
                      <p style={{ margin: '4px 0', fontSize: 13, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {repo.description}
                      </p>
                    )}

                    <div style={{ display: 'flex', gap: 14, fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
                      {repo.updatedAt && (
                        <span>Actualizado {relativeTime(new Date(repo.updatedAt).getTime() / 1000)}</span>
                      )}
                      {repo.stargazersCount !== undefined && repo.stargazersCount !== null && repo.stargazersCount > 0 && (
                        <span>★ {repo.stargazersCount}</span>
                      )}
                    </div>
                  </div>

                  <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                    <button
                      type="button"
                      className="primary"
                      onClick={() => void handleClone(repo)}
                      disabled={Boolean(cloningRepo)}
                      title="Clonar a una carpeta local y abrir en Foxen"
                    >
                      📥 Clonar y Abrir
                    </button>
                    <button
                      type="button"
                      onClick={() => void openUrl(repo.htmlUrl)}
                      className="secondary"
                      title="Ver en GitHub"
                    >
                      ↗ Ver
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <footer className="modal-footer" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            Total: {repos.length} repositorios sincronizados con GitHub
          </span>
          <button type="button" onClick={close}>
            Cerrar
          </button>
        </footer>
      </div>
    </div>
  );
}

