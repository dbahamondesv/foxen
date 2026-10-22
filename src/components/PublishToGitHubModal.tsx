import { useEffect, useRef, useState } from 'react';
import { confirm } from '@tauri-apps/plugin-dialog';
import { openUrl } from '@tauri-apps/plugin-opener';
import { useStore } from '../store/useAppStore';
import { errorMessage } from '../lib/ipc';
import type { GitHubRepo } from '../lib/types';
import { useI18n } from '../lib/useI18n';

export function PublishToGitHubModal() {
  const { t } = useI18n();
  const close = useStore((s) => s.closePublish);
  const publishToGitHub = useStore((s) => s.publishToGitHub);
  const repoId = useStore((s) => s.repoId);
  const repositories = useStore((s) => s.repositories);
  const remotes = useStore((s) => s.remotes);
  const githubUser = useStore((s) => s.githubUser);
  const loading = useStore((s) => s.loading);
  const notify = useStore((s) => s.notify);

  const openRepoUrl = (url: string) => {
    openUrl(url).catch((err) => notify('error', errorMessage(err)));
  };

  const currentRepo = repoId ? repositories.find((r) => r.id === repoId) : null;
  const defaultName = currentRepo?.name.trim().replace(/\s+/g, '-') || '';

  const [name, setName] = useState(defaultName);
  const [description, setDescription] = useState('');
  const [visibility, setVisibility] = useState<'private' | 'public'>('private');
  const [owner, setOwner] = useState('');
  /** Repo publicado en GitHub; si existe, el formulario se sustituye por el resumen. */
  const [published, setPublished] = useState<GitHubRepo | null>(null);

  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setName(defaultName);
  }, [defaultName]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !loading) close();
    };
    window.addEventListener('keydown', onKey);
    dialogRef.current?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [close, loading]);

  const submit = async () => {
    const repoName = name.trim();
    if (!repoName) return;

    // Publicar pisa `origin` si ya existe: avisar antes de crear el repo
    // remoto, porque el push no se puede deshacer desde la UI.
    let replaceOrigin = false;
    const origin = remotes.find((r) => r.name === 'origin');
    if (origin) {
      const accepted = await confirm(
        t('El repositorio ya tiene un remoto «origin» apuntando a:\n\n{url}\n\nSe sobreescribirá con la URL del nuevo repositorio de GitHub y se hará push de la rama actual. ¿Continuar?', {
          url: origin.url,
        }),
        {
          title: t('Sobreescribir origin'),
          kind: 'warning',
          okLabel: t('Publicar'),
          cancelLabel: t('Cancelar'),
        },
      );
      if (!accepted) return;
      replaceOrigin = true;
    }

    const repo = await publishToGitHub({
      name: repoName,
      private: visibility === 'private',
      description: description.trim() === '' ? null : description.trim(),
      owner: owner.trim() === '' ? null : owner.trim(),
      replaceOrigin,
    });
    if (repo) setPublished(repo);
  };

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    void submit();
  };

  return (
    <div
      className="modal-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget && !loading) close();
      }}
    >
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="publish-github-title"
        ref={dialogRef}
        tabIndex={-1}
        style={{ maxWidth: 560, width: '92%' }}
      >
        <header className="modal-header">
          <div>
            <h2 id="publish-github-title" style={{ margin: 0, fontSize: '1.2em' }}>
              {published ? t('Repositorio publicado') : t('Publicar en GitHub')}
            </h2>
            <small style={{ color: 'var(--text-muted)' }}>
              {published
                ? published.fullName
                : githubUser
                  ? t('Usando la cuenta @{user}', { user: githubUser.login })
                  : t('Crea el repositorio y sube esta rama')}
            </small>
          </div>
          <button
            type="button"
            className="icon-button"
            onClick={close}
            aria-label={t('Cerrar')}
            disabled={loading}
          >
            ×
          </button>
        </header>

        {published ? (
          <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ textAlign: 'center', padding: '12px 0' }}>
              <div style={{ fontSize: 48, marginBottom: 8 }}>🚀</div>
              <h3 style={{ margin: 0, color: 'var(--color-ahead, #3fb950)' }}>
                {t('¡Publicado con éxito!')}
              </h3>
              <p style={{ marginTop: 8, color: 'var(--text-muted)', wordBreak: 'break-all' }}>
                <strong>{published.fullName}</strong> ·{' '}
                {published.private ? t('privado') : t('público')} ·{' '}
                {published.defaultBranch
                  ? t('rama predeterminada: {branch}', { branch: published.defaultBranch })
                  : ''}
              </p>
              <p style={{ marginTop: 4, fontSize: 13, color: 'var(--text-muted)' }}>
                {t('La rama actual se subió y quedó vinculada a su upstream.')}
              </p>
            </div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
              <button
                type="button"
                className="primary"
                onClick={() => openRepoUrl(published.htmlUrl)}
              >
                🌐 {t('Ver en GitHub')}
              </button>
              <button type="button" onClick={close}>
                {t('Cerrar')}
              </button>
            </div>
          </div>
        ) : (
          <form
            className="modal-body"
            style={{ display: 'flex', flexDirection: 'column', gap: 14 }}
            onSubmit={onSubmit}
          >
            <div>
              <label style={{ display: 'block', marginBottom: 6, fontSize: 13 }}>
                {t('Nombre del repositorio')}
              </label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="nombre-repo"
                style={{ width: '100%' }}
                required
                disabled={loading}
              />
              <small style={{ color: 'var(--text-muted)' }}>
                {t('Solo letras, dígitos, «-», «_» y «.»')}
              </small>
            </div>

            <div>
              <label style={{ display: 'block', marginBottom: 6, fontSize: 13 }}>
                {t('Descripción (opcional)')}
              </label>
              <input
                type="text"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder={t('Describe de qué trata este proyecto')}
                style={{ width: '100%' }}
                disabled={loading}
              />
            </div>

            <div>
              <label style={{ display: 'block', marginBottom: 6, fontSize: 13 }}>
                {t('Visibilidad')}
              </label>
              <div style={{ display: 'flex', gap: 16 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <input
                    type="radio"
                    name="visibility"
                    value="private"
                    checked={visibility === 'private'}
                    onChange={() => setVisibility('private')}
                    disabled={loading}
                  />
                  {t('Privado')}
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <input
                    type="radio"
                    name="visibility"
                    value="public"
                    checked={visibility === 'public'}
                    onChange={() => setVisibility('public')}
                    disabled={loading}
                  />
                  {t('Público')}
                </label>
              </div>
              <small style={{ color: 'var(--text-muted)' }}>
                {visibility === 'private'
                  ? t('Solo tú (y colaboradores) podrás verlo.')
                  : t('Cualquiera podrá ver este repositorio.')}
              </small>
            </div>

            <div>
              <label style={{ display: 'block', marginBottom: 6, fontSize: 13 }}>
                {t('Organización (opcional)')}
              </label>
              <input
                type="text"
                value={owner}
                onChange={(e) => setOwner(e.target.value)}
                placeholder="org-nombre"
                style={{ width: '100%' }}
                disabled={loading}
              />
              <small style={{ color: 'var(--text-muted)' }}>
                {t('Deja vacío para crearlo en tu cuenta personal.')}
              </small>
            </div>
          </form>
        )}

        {!published && (
          <footer
            className="modal-footer"
            style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}
          >
            <button type="button" onClick={close} disabled={loading}>
              {t('Cancelar')}
            </button>
            <button
              type="button"
              className="primary"
              onClick={() => void submit()}
              disabled={loading || !name.trim()}
            >
              {loading ? t('Publicando…') : t('Crear y publicar')}
            </button>
          </footer>
        )}
      </div>
    </div>
  );
}
