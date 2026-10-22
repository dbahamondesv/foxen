import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../store/useAppStore';
import * as ipc from '../lib/ipc';
import { baseName, changeColor, dirName, statusChar } from '../lib/format';
import { generateCommitMessage } from '../lib/commitMessage';
import type { FileStatus, HunkSelection, LineSelection } from '../lib/types';

/** Agrupa los archivos por directorio para mostrar un arbol plano. */
function groupByDirectory(files: FileStatus[]) {
  const groups = new Map<string, FileStatus[]>();
  for (const file of files) {
    const dir = dirName(file.path);
    const list = groups.get(dir);
    if (list) list.push(file);
    else groups.set(dir, [file]);
  }
  return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

export function ChangesPanel() {
  const repoId = useStore((s) => s.repoId);
  const status = useStore((s) => s.status);
  const selectedFile = useStore((s) => s.selectedFile);
  const selectFile = useStore((s) => s.selectFile);
  const commitMessage = useStore((s) => s.commitMessage);
  const setCommitMessage = useStore((s) => s.setCommitMessage);
  const run = useStore((s) => s.run);
  const notify = useStore((s) => s.notify);

  const [expanded, setExpanded] = useState(true);

  const staged = useMemo(() => status?.files.filter((f) => f.staged) ?? [], [status]);
  // Un archivo puede estar a la vez en stage y tener cambios sin anadir: con
  // `!f.staged` solo aparecia en la columna izquierda y sus cambios sin anadir
  // quedaban invisibles. Los untracked se incluyen aparte porque el backend los
  // marca como `untracked`, no como `unstaged`.
  const unstaged = useMemo(
    () => status?.files.filter((f) => f.unstaged || (f.untracked && !f.staged)) ?? [],
    [status],
  );

  if (!repoId || !status) return <p className="empty">Sin repositorio abierto.</p>;

  /** Stagea/unstagea un archivo desde su columna. */
  const toggle = (file: FileStatus, e: React.MouseEvent) => {
    e.stopPropagation();
    const action = file.staged
      ? () => ipc.unstageFiles(repoId, [file.path])
      : () => ipc.stageFiles(repoId, [file.path]);
    void run(file.staged ? 'Deshacer stage' : 'Hacer stage', action);
  };

  const stageEverything = () => void run('Hacer stage de todo', () => ipc.stageAll(repoId));

  const unstageEverything = () =>
    void run('Quitar todo del stage', () =>
      ipc.unstageFiles(
        repoId,
        staged.map((f) => f.path),
      ),
    );

  /** Rellena el mensaje con una propuesta generada a partir del stage. */
  const generateMessage = () => {
    const suggestion = generateCommitMessage(staged);
    if (!suggestion) {
      notify('info', 'Añade archivos al stage para generar un mensaje');
      return;
    }
    setCommitMessage(suggestion);
  };

  const discard = (file: FileStatus) => {
    void run(`Descartar ${baseName(file.path)}`, () => ipc.discardFiles(repoId, [file.path]));
  };

  /** Resuelve un archivo en conflicto (lado `ours`/`theirs`/`base` o staged). */
  const resolve = (file: FileStatus, side: 'ours' | 'theirs' | 'base' | null) =>
    void run(`Resolver ${baseName(file.path)}`, () =>
      ipc.resolveConflict(repoId, file.path, side),
    );

  const commit = () => {
    const message = commitMessage.trim();
    if (!message) {
      notify('error', 'El mensaje del commit no puede estar vacio');
      return;
    }
    void run('Crear commit', async () => {
      const result = await ipc.createCommit(repoId, message, false, false, true);
      setCommitMessage('');
      return result;
    });
  };

  const stashAll = () => void run('Crear stash', () => ipc.pushStash(repoId, null, true, false, false));

  const commitAndPush = () => {
    const message = commitMessage.trim();
    if (!message) {
      notify('error', 'El mensaje del commit no puede estar vacio');
      return;
    }
    void run('Commit y push', async () => {
      await ipc.createCommit(repoId, message, false, false, true);
      setCommitMessage('');
      return useStore.getState().pushCurrent();
    });
  };

  const renderGroup = (title: string, files: FileStatus[], isStagedColumn: boolean) => {
    if (files.length === 0) return null;
    return (
      <section className="changes-group">
        <header className="changes-group-header">
          <button
            type="button"
            className="changes-toggle"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
          >
            {expanded ? '▾' : '▸'} {title} ({files.length})
          </button>
          {isStagedColumn ? (
            <button type="button" className="link" onClick={unstageEverything}>
              Quitar todo
            </button>
          ) : (
            <button type="button" className="link" onClick={stageEverything}>
              Anadir todo
            </button>
          )}
        </header>

        {expanded &&
          groupByDirectory(files).map(([dir, group]) => (
            <div key={dir || '.'} className="file-group">
              {dir && <div className="file-group-dir">{dir}/</div>}
              {group.map((file) => (
                <div
                  key={`${file.path}-${isStagedColumn}`}
                  className={`file-row${selectedFile === file.path ? ' is-selected' : ''}`}
                  onClick={() => void selectFile(file.path, isStagedColumn ? 'staged' : 'worktree')}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      void selectFile(file.path, isStagedColumn ? 'staged' : 'worktree');
                    }
                  }}
                >
                  {/* Columna del indice */}
                  <button
                    type="button"
                    className={`status-cell ${changeColor(file.kind)}`}
                    title={isStagedColumn ? 'Quitar del stage' : 'Anadir al stage'}
                    onClick={(e) => toggle(file, e)}
                  >
                    {isStagedColumn ? (file.staged ? statusChar(file) : '') : ''}
                  </button>

                  {/* Columna del working tree */}
                  <button
                    type="button"
                    className={`status-cell ${changeColor(file.kind)}`}
                    title={isStagedColumn ? '' : 'Anadir al stage'}
                    onClick={(e) => toggle(file, e)}
                  >
                    {!isStagedColumn && !file.staged ? statusChar(file) : ''}
                  </button>

                  <span className="file-name" title={file.path}>
                    {baseName(file.path)}
                    {file.oldPath && <em className="file-old"> ← {baseName(file.oldPath)}</em>}
                  </span>

                  {file.conflicted && <span className="badge badge-conflict">conflicto</span>}

                  {file.conflicted && (
                    <span className="conflict-actions">
                      <button
                        type="button"
                        className="link"
                        title="Quedarse con la version de la rama actual"
                        onClick={(e) => {
                          e.stopPropagation();
                          resolve(file, 'ours');
                        }}
                      >
                        mío
                      </button>
                      <button
                        type="button"
                        className="link"
                        title="Quedarse con la version de la rama que se fusiona"
                        onClick={(e) => {
                          e.stopPropagation();
                          resolve(file, 'theirs');
                        }}
                      >
                        suyo
                      </button>
                      <button
                        type="button"
                        className="link"
                        title="Restaurar la version base comun"
                        onClick={(e) => {
                          e.stopPropagation();
                          resolve(file, 'base');
                        }}
                      >
                        base
                      </button>
                      <button
                        type="button"
                        className="link"
                        title="Marcar como resuelto usando el archivo tal como esta"
                        onClick={(e) => {
                          e.stopPropagation();
                          resolve(file, null);
                        }}
                      >
                        resuelto
                      </button>
                    </span>
                  )}

                  <span className="file-stats">
                    {file.insertions > 0 && <span className="ins">+{file.insertions}</span>}
                    {file.deletions > 0 && <span className="del">−{file.deletions}</span>}
                  </span>

                  {file.unstaged && (
                    <button
                      type="button"
                      className="link danger"
                      title="Descartar cambios"
                      onClick={(e) => {
                        e.stopPropagation();
                        discard(file);
                      }}
                    >
                      descartar
                    </button>
                  )}
                </div>
              ))}
            </div>
          ))}
      </section>
    );
  };

  return (
    <div className="panel-body changes">
      {status.conflictedCount > 0 && (
        <p className="alert alert-error">
          {status.conflictedCount} archivo(s) en conflicto. Resuelvelos para continuar.
        </p>
      )}

      {renderGroup('Staged', staged, true)}
      {renderGroup('Unstaged', unstaged, false)}

      {status.files.length === 0 && <p className="empty">Working tree limpio.</p>}

      <div className="commit-box">
        <textarea
          className="commit-message"
          placeholder={`Mensaje para ${status.headBranch ?? 'HEAD'}`}
          value={commitMessage}
          onChange={(e) => setCommitMessage(e.target.value)}
          rows={4}
        />
        <div className="commit-actions">
          <button
            type="button"
            className="primary"
            disabled={staged.length === 0}
            onClick={commit}
          >
            Commit {staged.length > 0 ? `(${staged.length})` : ''}
          </button>
          <button
            type="button"
            disabled={staged.length === 0}
            onClick={commitAndPush}
            title="Crear el commit y subir la rama actual al remoto"
          >
            Commit y push
          </button>
          <button
            type="button"
            disabled={staged.length === 0}
            onClick={generateMessage}
            title="Generar un mensaje a partir de los cambios en el stage"
          >
            Generar mensaje
          </button>
          <button
            type="button"
            disabled={status.clean}
            onClick={() => stashAll()}
          >
            Stash
          </button>
        </div>
      </div>
    </div>
  );
}

/** Vista del diff del archivo seleccionado, con stage por fragmento. */
export function DiffPanel() {
  const repoId = useStore((s) => s.repoId);
  const diff = useStore((s) => s.diff);
  const selectedFile = useStore((s) => s.selectedFile);
  const selectedSide = useStore((s) => s.selectedSide);
  const selectFile = useStore((s) => s.selectFile);
  const run = useStore((s) => s.run);
  // La clave incluye el hunk: antes se indexaba solo por `lineIndex`, asi que
  // excluir la linea 0 de un hunk excluia tambien la linea 0 de todos los demas.
  const lineKey = (hunkIndex: number, lineIndex: number) => `${hunkIndex}:${lineIndex}`;
  const [excluded, setExcluded] = useState<Record<string, Set<string>>>({});

  // Al cambiar el diff sus indices dejan de tener sentido.
  useEffect(() => {
    setExcluded({});
  }, [diff]);

  if (!repoId || !diff || !selectedFile) {
    return <p className="empty">Selecciona un archivo para ver el diff.</p>;
  }

  const file = diff.files[0];
  if (!file) return <p className="empty">Sin diferencias para este archivo.</p>;
  // Los diffs de un commit son de solo lectura: no se stagea ni se descarta.
  const canEdit = selectedSide !== 'commit';

  const selectionFor = (hunkIndex: number): HunkSelection => {
    const skip = excluded[file.path];
    const lineSelections: LineSelection[] = [];
    if (skip) {
      for (const key of skip) {
        const [keyHunk, lineIndex] = key.split(':');
        if (Number(keyHunk) !== hunkIndex) continue;
        lineSelections.push({ hunkIndex, lineIndex: Number(lineIndex), include: false });
      }
    }
    return {
      path: file.path,
      oldPath: file.oldPath,
      hunkIndices: [hunkIndex],
      lineSelections,
      unstage: selectedSide === 'staged',
    };
  };

  const toggleLine = (hunkIndex: number, lineIndex: number) => {
    setExcluded((prev) => {
      const path = file.path;
      const set = new Set(prev[path] ?? []);
      const key = lineKey(hunkIndex, lineIndex);
      if (set.has(key)) set.delete(key);
      else set.add(key);
      return { ...prev, [path]: set };
    });
  };

  const stageHunk = (hunkIndex: number) =>
    void run(
      selectedSide === 'staged' ? 'Quitar del stage' : 'Hacer stage del fragmento',
      () => ipc.stageHunks(repoId, [selectionFor(hunkIndex)]),
    );

  const discardHunk = (hunkIndex: number) =>
    void run('Descartar fragmento', () =>
      ipc.discardHunk(repoId, file.path, hunkIndex, selectedSide === 'staged'),
    );

  if (file.isBinary) return <p className="empty">Archivo binario: no se puede mostrar el diff.</p>;
  if (file.tooLarge) return <p className="empty">Archivo demasiado grande para mostrar el diff.</p>;

  return (
    <div className="panel-body diff">
      <div className="diff-header">
        {canEdit && (
          <button
            type="button"
            className="detail-back"
            onClick={() => void selectFile(null)}
          >
            ← Volver
          </button>
        )}
        <strong>{file.path}</strong>
        <span className="file-stats">
          <span className="ins">+{file.additions}</span>
          <span className="del">−{file.deletions}</span>
        </span>
      </div>

      {file.hunks.map((hunk, hunkIndex) => (
        <div key={hunkIndex} className="hunk">
          <div className="hunk-header">
            <code>{hunk.header}</code>
            {canEdit && (
              <div className="hunk-actions">
                <button type="button" className="link" onClick={() => stageHunk(hunkIndex)}>
                  {selectedSide === 'staged' ? 'quitar del stage' : 'stagear'}
                </button>
                <button
                  type="button"
                  className="link danger"
                  hidden={selectedSide === 'staged'}
                  onClick={() => discardHunk(hunkIndex)}
                >
                  descartar
                </button>
              </div>
            )}
          </div>

          {hunk.lines.map((line, lineIndex) => {
            const skip = excluded[file.path];
            const isExcluded = skip?.has(lineKey(hunkIndex, lineIndex)) ?? false;
            const cls =
              line.origin === '+' ? 'ins' : line.origin === '-' ? 'del' : 'ctx';
            return (
              <div
                key={lineIndex}
                className={`diff-line ${cls}${isExcluded ? ' is-excluded' : ''}${canEdit ? '' : ' is-readonly'}`}
                onClick={() => {
                  if (canEdit) toggleLine(hunkIndex, lineIndex);
                }}
                role={canEdit ? 'button' : undefined}
                tabIndex={canEdit ? 0 : undefined}
                onKeyDown={(e) => {
                  if (canEdit && e.key === 'Enter') toggleLine(hunkIndex, lineIndex);
                }}
              >
                <span className="ln">{line.oldLineno ?? ''}</span>
                <span className="ln">{line.newLineno ?? ''}</span>
                <span className="origin">{line.origin}</span>
                <span className="code">{line.content}</span>
              </div>
            );
          })}
        </div>
      ))}

      {file.hunks.length === 0 && <p className="empty">Sin cambios visibles.</p>}
      {canEdit && <p className="hint">Pulsa una linea para excluirla del siguiente stage.</p>}
    </div>
  );
}