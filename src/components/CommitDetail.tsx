import { useStore } from '../store/useAppStore';
import * as ipc from '../lib/ipc';
import { authorColor, authorInitial, baseName, changeColor } from '../lib/format';
import { useI18n } from '../lib/useI18n';

/** Detalle del commit seleccionado: metadatos, mensaje y archivos. */
export function CommitDetailView({ onFileOpen }: { onFileOpen?: () => void }) {
  const { t } = useI18n();
  const repoId = useStore((s) => s.repoId);
  const detail = useStore((s) => s.selectedDetail);
  const run = useStore((s) => s.run);
  const selectFile = useStore((s) => s.selectFile);
  const currentBranch = useStore((s) => s.status?.headBranch ?? null);
  const notify = useStore((s) => s.notify);

  if (!repoId || !detail) {
    return (
      <div className="panel-empty-state">
        <span className="empty-icon">📌</span>
        <p>{t('Selecciona un commit en el grafo para explorar su detalle.')}</p>
      </div>
    );
  }

  const message = `${detail.subject}${detail.body ? `\n\n${detail.body}` : ''}`;

  return (
    <div className="panel-body commit-detail">
      <header className="detail-header">
        <div className="detail-header-top">
          <span
            className="graph-avatar detail-avatar"
            style={{ backgroundColor: authorColor(detail.authorName) }}
            title={`${detail.authorName} <${detail.authorEmail}>`}
          >
            {authorInitial(detail.authorName)}
          </span>
          <div className="detail-meta">
            <span className="detail-author">
              <strong>{detail.authorName}</strong>
              <small className="detail-email">&lt;{detail.authorEmail}&gt;</small>
            </span>
            <span className="detail-time">{detail.authorTimeIso.replace('T', ' ').replace('.000Z', '')}</span>
          </div>
          <span
            className="graph-shortsha"
            title={t('SHA completo: {sha} (clic para copiar)', { sha: detail.oid })}
            onClick={() => {
              void navigator.clipboard.writeText(detail.oid);
              notify('info', t('SHA {sha} copiado al portapapeles', { sha: detail.shortOid }));
            }}
          >
            {detail.shortOid}
          </span>
        </div>

        <h2 className="detail-title">{detail.subject}</h2>

        {detail.parents.length > 1 && (
          <p className="detail-parents">
            {t('Merge con {count} padres:', { count: detail.parents.length })}{' '}
            {detail.parents.map((p) => (
              <code key={p} className="parent-sha" title={p}>
                {p.slice(0, 7)}
              </code>
            ))}
          </p>
        )}
      </header>

      <div className="detail-stats">
        <span className="stats-pill files-count">
          {t('{count} archivos', { count: detail.stats.filesChanged })}
        </span>
        <span className="stats-pill ins">+{detail.stats.insertions}</span>
        <span className="stats-pill del">−{detail.stats.deletions}</span>
        {!detail.reachableFromHead && (
          <span className="badge badge-warn">{t('no alcanzable')}</span>
        )}
      </div>

      {detail.body && <pre className="detail-body">{detail.body}</pre>}

      <div className="detail-actions">
        <button
          type="button"
          className="topbar-action-btn"
          onClick={() => void run(t('Cherry-pick'), () => ipc.cherryPick(repoId, detail.oid))}
          title={t('Aplica los cambios de este commit sobre la rama actual')}
        >
          <span className="btn-icon">🍒</span>
          <span>Cherry-pick</span>
        </button>
        <button
          type="button"
          className="topbar-action-btn"
          onClick={() => void run(t('Revert'), () => ipc.revertCommit(repoId, detail.oid))}
          title={t('Crea un nuevo commit que invierte los cambios de este commit')}
        >
          <span className="btn-icon">↩</span>
          <span>Revert</span>
        </button>
        <button
          type="button"
          className="topbar-action-btn danger-outline"
          title={t('Mueve la rama actual a este commit conservando los cambios en el working tree')}
          onClick={() => {
            const branch = currentBranch;
            if (!branch) {
              notify('error', t('HEAD esta desligado: no hay rama que mover'));
              return;
            }
            if (!window.confirm(t('¿Resetear {branch} a {sha}?', { branch, sha: detail.shortOid })))
              return;
            void run(t('Resetear {branch}', { branch }), () =>
              ipc.resetBranch(repoId, branch, detail.oid, 'mixed'),
            );
          }}
        >
          <span>{t('Resetear a aquí')}</span>
        </button>
      </div>

      <div className="detail-files-header">
        <h3>{t('Archivos modificados')} ({detail.files.length})</h3>
      </div>

      <ul className="detail-files">
        {detail.files.map((file) => (
          <li key={file.path}>
            <button
              type="button"
              className="detail-file"
              onClick={() => {
                void selectFile(file.path, 'commit', detail.oid);
                onFileOpen?.();
              }}
            >
              <span className={`status-cell ${changeColor(file.kind)}`}>{file.statusChar}</span>
              <span className="file-name" title={file.path}>
                {baseName(file.path)}
              </span>
              <span className="file-stats">
                <span className="ins">+{file.insertions}</span>
                <span className="del">−{file.deletions}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>

      <details className="detail-raw">
        <summary>{t('Mensaje de commit sin formato')}</summary>
        <pre>{message}</pre>
      </details>
    </div>
  );
}
