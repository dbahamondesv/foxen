import { useStore } from '../store/useAppStore';
import * as ipc from '../lib/ipc';
import { baseName, changeColor } from '../lib/format';

/** Detalle del commit seleccionado: metadatos, mensaje y archivos. */
export function CommitDetailView() {
  const repoId = useStore((s) => s.repoId);
  const detail = useStore((s) => s.selectedDetail);
  const run = useStore((s) => s.run);
  const selectFile = useStore((s) => s.selectFile);
  const currentBranch = useStore((s) => s.status?.headBranch ?? null);
  const notify = useStore((s) => s.notify);

  if (!repoId || !detail) {
    return <p className="empty">Selecciona un commit en el grafo.</p>;
  }

  const message = `${detail.subject}${detail.body ? `\n\n${detail.body}` : ''}`;

  return (
    <div className="panel-body commit-detail">
      <header className="detail-header">
        <h2>{detail.subject}</h2>
        <div className="detail-meta">
          <span>
            <strong>{detail.authorName}</strong> &lt;{detail.authorEmail}&gt;
          </span>
          <span>{detail.authorTimeIso.replace('T', ' ').replace('.000Z', '')}</span>
          <code>{detail.shortOid}</code>
        </div>
        {detail.parents.length > 1 && (
          <p className="detail-parents">
            Merge con {detail.parents.length} padres:{' '}
            {detail.parents.map((p) => p.slice(0, 7)).join(', ')}
          </p>
        )}
      </header>

      <div className="detail-stats">
        <span>{detail.stats.filesChanged} archivos</span>
        <span className="ins">+{detail.stats.insertions}</span>
        <span className="del">−{detail.stats.deletions}</span>
        {!detail.reachableFromHead && <span className="badge badge-warn">no alcanzable</span>}
      </div>

      {detail.body && <pre className="detail-body">{detail.body}</pre>}

      <div className="detail-actions">
        <button
          type="button"
          onClick={() => void run('Cherry-pick', () => ipc.cherryPick(repoId, detail.oid))}
        >
          Cherry-pick
        </button>
        <button
          type="button"
          onClick={() => void run('Revert', () => ipc.revertCommit(repoId, detail.oid))}
        >
          Revert
        </button>
        <button
          type="button"
          className="danger-outline"
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
          Resetear rama a aqui
        </button>
      </div>

      <h3>Archivos ({detail.files.length})</h3>
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
        <summary>Mensaje completo</summary>
        <pre>{message}</pre>
      </details>
    </div>
  );
}