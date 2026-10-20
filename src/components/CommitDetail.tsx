import { useStore } from '../store/useAppStore';
import * as ipc from '../lib/ipc';
import { authorColor, authorInitial, baseName, changeColor } from '../lib/format';

/** Detalle del commit seleccionado: metadatos, mensaje y archivos. */
export function CommitDetailView() {
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
        <p>Selecciona un commit en el grafo para explorar su detalle.</p>
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
            title={`SHA completo: ${detail.oid} (clic para copiar)`}
            onClick={() => {
              void navigator.clipboard.writeText(detail.oid);
              notify('info', `SHA ${detail.shortOid} copiado al portapapeles`);
            }}
          >
            {detail.shortOid}
          </span>
        </div>

        <h2 className="detail-title">{detail.subject}</h2>

        {detail.parents.length > 1 && (
          <p className="detail-parents">
            Merge con {detail.parents.length} padres:{' '}
            {detail.parents.map((p) => (
              <code key={p} className="parent-sha" title={p}>
                {p.slice(0, 7)}
              </code>
            ))}
          </p>
        )}
      </header>

      <div className="detail-stats">
        <span className="stats-pill files-count">{detail.stats.filesChanged} archivos</span>
        <span className="stats-pill ins">+{detail.stats.insertions}</span>
        <span className="stats-pill del">−{detail.stats.deletions}</span>
        {!detail.reachableFromHead && <span className="badge badge-warn">no alcanzable</span>}
      </div>

      {detail.body && <pre className="detail-body">{detail.body}</pre>}

      <div className="detail-actions">
        <button
          type="button"
          className="topbar-action-btn"
          onClick={() => void run('Cherry-pick', () => ipc.cherryPick(repoId, detail.oid))}
          title="Aplica los cambios de este commit sobre la rama actual"
        >
          <span className="btn-icon">🍒</span>
          <span>Cherry-pick</span>
        </button>
        <button
          type="button"
          className="topbar-action-btn"
          onClick={() => void run('Revert', () => ipc.revertCommit(repoId, detail.oid))}
          title="Crea un nuevo commit que invierte los cambios de este commit"
        >
          <span className="btn-icon">↩</span>
          <span>Revert</span>
        </button>
        <button
          type="button"
          className="topbar-action-btn danger-outline"
          title="Mueve la rama actual a este commit conservando los cambios en el working tree"
          onClick={() => {
            const branch = currentBranch;
            if (!branch) {
              notify('error', 'HEAD esta desligado: no hay rama que mover');
              return;
            }
            if (!window.confirm(`¿Resetear ${branch} a ${detail.shortOid}?`)) return;
            void run(`Resetear ${branch}`, () =>
              ipc.resetBranch(repoId, branch, detail.oid, 'mixed'),
            );
          }}
        >
          <span>Resetear a aquí</span>
        </button>
      </div>

      <div className="detail-files-header">
        <h3>Archivos modificados ({detail.files.length})</h3>
      </div>

      <ul className="detail-files">
        {detail.files.map((file) => (
          <li key={file.path}>
            <button
              type="button"
              className="detail-file"
              onClick={() => void selectFile(file.path, 'commit', detail.oid)}
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
        <summary>Mensaje de commit sin formato</summary>
        <pre>{message}</pre>
      </details>
    </div>
  );
}
