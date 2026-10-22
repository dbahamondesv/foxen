import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../store/useAppStore';
import { isMainBranch } from '../lib/tags';
import * as ipc from '../lib/ipc';

type Strategy = 'auto' | 'no-ff' | 'ff-only' | 'squash';

/**
 * Tras fusionar hacia la principal, consulta los tags y abre el dialogo para
 * crear la version siguiente. Los fallos se ignoran: es una comodidad, no un
 * paso obligatorio del merge.
 */
async function offerTag(branch: string): Promise<void> {
  const repoId = useStore.getState().repoId;
  if (!repoId) return;
  try {
    const suggestion = await ipc.suggestTag(repoId);
    useStore.getState().openTagPrompt(branch, suggestion.suggested, suggestion.latest);
  } catch {
    // Sin sugerencia no se interrumpe la fusion.
  }
}

const STRATEGIES: { id: Strategy; label: string; hint: string }[] = [
  {
    id: 'auto',
    label: 'Automatica',
    hint: 'Fast-forward si es posible; merge commit cuando las ramas divergen.',
  },
  {
    id: 'no-ff',
    label: 'Merge commit (--no-ff)',
    hint: 'Crea siempre un commit de fusion, aunque sea fast-forward.',
  },
  {
    id: 'ff-only',
    label: 'Solo fast-forward (--ff-only)',
    hint: 'Falla si la rama actual y la objetivo han divergido.',
  },
  {
    id: 'squash',
    label: 'Squash',
    hint: 'Trae los cambios sin fusionar el historial; requiere commit despues.',
  },
];

/**
 * Dialogo para fusionar una rama en otra (por defecto, en la actual).
 *
 * A diferencia del flujo antiguo, permite elegir el destino, asi que se puede
 * hacer `feature/x -> develop` sin cambiar de rama a mano.
 */
export function MergeModal() {
  const source = useStore((s) => s.mergeTarget);
  const close = useStore((s) => s.closeMerge);
  const run = useStore((s) => s.run);
  const repoId = useStore((s) => s.repoId);
  const loading = useStore((s) => s.loading);
  const status = useStore((s) => s.status);
  const branches = useStore((s) => s.branches);
  const current = status?.headBranch ?? null;

  const locals = useMemo(
    () => (branches?.branches ?? []).filter((b) => !b.isRemote).map((b) => b.name),
    [branches],
  );

  const [destination, setDestination] = useState<string>('');
  const [strategy, setStrategy] = useState<Strategy>('auto');
  const [message, setMessage] = useState('');
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (source) {
      setDestination(current ?? '');
      setStrategy('auto');
      setMessage(`Merge de ${source}`);
    }
  }, [source, current]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !loading) close();
    };
    window.addEventListener('keydown', onKey);
    dialogRef.current?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [close, loading]);

  if (!source || !repoId) return null;

  const switchesBranch = destination !== '' && destination !== current;
  const valid = destination !== '' && destination !== source;

  const merge = () => {
    if (!valid) return;
    void run(`Fusionar ${source} en ${destination}`, async () => {
      const result = await ipc.mergeInto(
        repoId,
        source,
        destination,
        strategy === 'no-ff',
        strategy === 'ff-only',
        strategy === 'squash',
        message.trim() ? message.trim() : null,
      );
      close();
      // Tras fusionar hacia la rama principal se ofrece etiquetar la version.
      if (result.success && isMainBranch(destination)) {
        void offerTag(destination);
      }
      return result;
    });
  };

  return (
    <div className="modal-overlay" onClick={() => !loading && close()}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={`Fusionar ${source}`}
        tabIndex={-1}
        ref={dialogRef}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="modal-header">
          <h2>Fusionar ramas</h2>
        </header>

        <div className="modal-body">
          <div className="merge-branches">
            <label className="field">
              <span>Rama a fusionar</span>
              <input type="text" value={source} readOnly />
            </label>
            <span className="merge-arrow" aria-hidden="true">
              →
            </span>
            <label className="field">
              <span>Rama destino</span>
              <select
                value={destination}
                onChange={(e) => setDestination(e.target.value)}
                autoFocus
              >
                {current && <option value={current}>{current} (actual)</option>}
                {locals
                  .filter((name) => name !== current)
                  .map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
              </select>
            </label>
          </div>

          {switchesBranch && (
            <p className="hint">
              Se cambiará a <strong>{destination}</strong> para hacer la fusión y
              quedarás en esa rama.
            </p>
          )}
          {destination === source && (
            <p className="alert alert-error">No se puede fusionar una rama consigo misma.</p>
          )}

          <fieldset className="merge-strategies">
            {STRATEGIES.map((option) => (
              <label key={option.id} className="merge-strategy">
                <input
                  type="radio"
                  name="merge-strategy"
                  checked={strategy === option.id}
                  onChange={() => setStrategy(option.id)}
                />
                <span>
                  <strong>{option.label}</strong>
                  <small>{option.hint}</small>
                </span>
              </label>
            ))}
          </fieldset>

          {strategy !== 'ff-only' && (
            <label className="field">
              <span>Mensaje del merge</span>
              <input
                type="text"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder={`Merge de ${source}`}
              />
            </label>
          )}

          {strategy === 'squash' && (
            <p className="hint">
              Con squash los cambios quedan en el indice sin commit: crea el commit
              desde el panel Cambios.
            </p>
          )}
        </div>

        <footer className="modal-footer">
          <button type="button" onClick={close} disabled={loading}>
            Cancelar
          </button>
          <button
            type="button"
            className="primary"
            onClick={merge}
            disabled={loading || !valid}
          >
            Fusionar
          </button>
        </footer>
      </div>
    </div>
  );
}
