import { useState } from 'react';
import { useStore } from '../store/useAppStore';
import * as ipc from '../lib/ipc';
import { relativeTime } from '../lib/format';
import type { BranchInfo } from '../lib/types';

/** Panel de ramas: locales, remotas y operaciones principales. */
export function BranchesPanel() {
  const repoId = useStore((s) => s.repoId);
  const branches = useStore((s) => s.branches);
  const run = useStore((s) => s.run);
  const openDetail = useStore((s) => s.openDetail);
  const openMerge = useStore((s) => s.openMerge);

  const [filter, setFilter] = useState('');
  const [newName, setNewName] = useState('');
  const [checkoutNew, setCheckoutNew] = useState(true);

  if (!repoId || !branches) return <p className="empty">Sin repositorio abierto.</p>;

  const locals = branches.branches.filter((b) => !b.isRemote);
  const remotes = branches.branches.filter((b) => b.isRemote);

  const matches = (branch: BranchInfo) =>
    filter === '' || branch.name.toLowerCase().includes(filter.toLowerCase());

  const create = () => {
    const name = newName.trim();
    if (!name) return;
    void run(`Crear rama ${name}`, async () => {
      const result = await ipc.createBranch(repoId, name, null, checkoutNew);
      setNewName('');
      return result;
    });
  };

  const checkout = (branch: BranchInfo) =>
    void run(`Cambiar a ${branch.name}`, () =>
      ipc.checkoutBranch(repoId, branch.isRemote ? branch.name.replace(/^[^/]+\//, '') : branch.name),
    );

  const remove = (branch: BranchInfo) =>
    void run(`Eliminar ${branch.name}`, () => ipc.deleteBranch(repoId, branch.name, false));

  const merge = (branch: BranchInfo) => openMerge(branch.name);

  // El rebase tomaba `branches.head` en vez de la rama pulsada, con lo que la
  // accion era un no-op cuando no estabas en la ultima rama de la lista.
  const rebase = (branch: BranchInfo) =>
    void run(`Rebase sobre ${branch.name}`, () =>
      ipc.rebaseOnto(repoId, branch.name, false),
    );

  const renderBranch = (branch: BranchInfo) => (
    <li key={branch.fullName} className={`branch${branch.isHead ? ' is-head' : ''}`}>
      <button
        type="button"
        className="branch-name"
        onClick={() => openDetail(branch.oid)}
        title={branch.subject}
      >
        {branch.name}
        {branch.isHead && <span className="badge">HEAD</span>}
        {branch.hasUncommittedChanges && <span className="badge badge-warn">!</span>}
        {branch.ahead > 0 && <span className="badge badge-ahead">↑{branch.ahead}</span>}
        {branch.behind > 0 && <span className="badge badge-behind">↓{branch.behind}</span>}
      </button>

      <div className="branch-meta">
        <span>{branch.shortOid}</span>
        <span>{branch.subject}</span>
        <span>{relativeTime(branch.authorTime)}</span>
      </div>

      {!branch.isHead && (
        <div className="branch-actions">
          <button type="button" className="link" onClick={() => checkout(branch)}>
            checkout
          </button>
          {!branch.isRemote && (
            <>
              <button type="button" className="link" onClick={() => merge(branch)}>
                fusionar
              </button>
              <button type="button" className="link" onClick={() => rebase(branch)}>
                rebase
              </button>
              <button type="button" className="link danger" onClick={() => remove(branch)}>
                borrar
              </button>
            </>
          )}
        </div>
      )}
    </li>
  );

  return (
    <div className="panel-body branches">
      <div className="field-row">
        <input
          type="text"
          placeholder="Nueva rama…"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') create();
          }}
        />
        <label className="checkbox">
          <input
            type="checkbox"
            checked={checkoutNew}
            onChange={(e) => setCheckoutNew(e.target.checked)}
          />
          cambiar
        </label>
        <button type="button" className="primary" onClick={create}>
          Crear
        </button>
      </div>

      <input
        type="search"
        className="filter"
        placeholder="Filtrar ramas…"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />

      <h3>Ramas locales ({locals.length})</h3>
      <ul className="branch-list">{locals.filter(matches).map(renderBranch)}</ul>

      <h3>Ramas remotas ({remotes.length})</h3>
      <ul className="branch-list">{remotes.filter(matches).map(renderBranch)}</ul>

      {locals.length + remotes.length === 0 && (
        <p className="empty">Este repositorio no tiene ramas.</p>
      )}
    </div>
  );
}

/** Panel de stashes. */
export function StashesPanel() {
  const repoId = useStore((s) => s.repoId);
  const stashes = useStore((s) => s.stashes);
  const run = useStore((s) => s.run);

  const [message, setMessage] = useState('');
  const [includeUntracked, setIncludeUntracked] = useState(true);

  if (!repoId) return <p className="empty">Sin repositorio abierto.</p>;

  const push = () =>
    void run('Crear stash', async () => {
      const result = await ipc.pushStash(repoId, message.trim() || null, includeUntracked, false, false);
      setMessage('');
      return result;
    });

  const branchFrom = (index: number, label: string) => {
    const name = window.prompt('Nombre de la nueva rama', `stash-${index}`);
    if (!name) return;
    void run('Crear rama desde el stash', () => ipc.branchFromStash(repoId, index, name.trim()));
    void label;
  };

  return (
    <div className="panel-body stashes">
      <div className="field-row">
        <input
          type="text"
          placeholder="Mensaje del stash (opcional)…"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') push();
          }}
        />
        <label className="checkbox">
          <input
            type="checkbox"
            checked={includeUntracked}
            onChange={(e) => setIncludeUntracked(e.target.checked)}
          />
          sin seguimiento
        </label>
        <button type="button" className="primary" onClick={push}>
          Stash
        </button>
      </div>

      {stashes.length === 0 ? (
        <p className="empty">No hay stashes.</p>
      ) : (
        <ul className="stash-list">
          {stashes.map((stash) => (
            <li key={stash.oid} className="stash">
              <div className="stash-main">
                <strong>{stash.message || `stash@{${stash.index}}`}</strong>
                <div className="stash-meta">
                  <span>{stash.branch}</span>
                  <span>{stash.oid.slice(0, 7)}</span>
                  <span>{relativeTime(stash.authorTime)}</span>
                  <span className="ins">+{stash.stagedCount}</span>
                  <span className="del">−{stash.unstagedCount}</span>
                </div>
              </div>
              <div className="stash-actions">
                <button
                  type="button"
                  className="link"
                  onClick={() => void run('Aplicar stash', () => ipc.applyStash(repoId, stash.index, false))}
                >
                  aplicar
                </button>
                <button
                  type="button"
                  className="link"
                  onClick={() => void run('Pop stash', () => ipc.popStash(repoId, stash.index))}
                >
                  pop
                </button>
                <button
                  type="button"
                  className="link"
                  onClick={() => branchFrom(stash.index, stash.message)}
                >
                  rama
                </button>
                <button
                  type="button"
                  className="link danger"
                  onClick={() => {
                    if (!window.confirm(`¿Eliminar ${stash.message}?`)) return;
                    void run('Eliminar stash', () => ipc.dropStash(repoId, stash.index));
                  }}
                >
                  borrar
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {stashes.length > 0 && (
        <button
          type="button"
          className="danger-outline"
          onClick={() => {
            if (!window.confirm(`¿Eliminar los ${stashes.length} stashes?`)) return;
            void run('Limpiar stashes', () => ipc.clearStashes(repoId));
          }}
        >
          Limpiar todos los stashes
        </button>
      )}

      <p className="hint">
        Los stashes se guardan con los indices que devuelve el backend; si eliminas uno, los
        indices se recalculan en el siguiente refresco.
      </p>
      <button
        type="button"
        className="link"
        onClick={() => {
          const refresh = useStore.getState().refreshStashes;
          void refresh().catch(() => undefined);
        }}
      >
        Refrescar
      </button>
    </div>
  );
}