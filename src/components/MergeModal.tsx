import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../store/useAppStore';
import { isMainBranch } from '../lib/tags';
import * as ipc from '../lib/ipc';
import { useI18n } from '../lib/useI18n';
import { HelpButton } from './HelpPanel';

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
    hint: 'Con squash se crea un commit único con todos los cambios; el historial de la rama no se fusiona.',
  },
];

/**
 * Dialogo para fusionar una rama en otra (por defecto, en la actual).
 *
 * A diferencia del flujo antiguo, permite elegir el destino, asi que se puede
 * hacer `feature/x -> develop` sin cambiar de rama a mano.
 */
export function MergeModal() {
  const { t } = useI18n();
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
      setMessage(t('Merge de {branch}', { branch: source }));
    }
  }, [source, current, t]);

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
    void run(t('Fusionar {source} en {destination}', { source, destination }), async () => {
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
        aria-label={t('Fusionar {branch}', { branch: source })}
        tabIndex={-1}
        ref={dialogRef}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="modal-header">
          <h2>{t('Fusionar ramas')}</h2>
          <HelpButton section="branches" label={t('¿Cómo funciona?')} />
        </header>

        <div className="modal-body">
          <div className="merge-branches">
            <label className="field">
              <span>{t('Rama a fusionar')}</span>
              <input type="text" value={source} readOnly />
            </label>
            <span className="merge-arrow" aria-hidden="true">
              →
            </span>
            <label className="field">
              <span>{t('Rama destino')}</span>
              <select
                value={destination}
                onChange={(e) => setDestination(e.target.value)}
                autoFocus
              >
                {current && <option value={current}>{current} ({t('actual')})</option>}
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
              {t('Se cambiará a')} <strong>{destination}</strong>{' '}
              {t('para hacer la fusión y quedarás en esa rama.')}
            </p>
          )}
          {destination === source && (
            <p className="alert alert-error">{t('No se puede fusionar una rama consigo misma.')}</p>
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
                  <strong>{t(option.label)}</strong>
                  <small>{t(option.hint)}</small>
                </span>
              </label>
            ))}
          </fieldset>

          {strategy !== 'ff-only' && (
            <label className="field">
              <span>{t('Mensaje del merge')}</span>
              <input
                type="text"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder={t('Merge de {branch}', { branch: source })}
              />
            </label>
          )}

          {strategy === 'squash' && (
            <p className="hint">
              {t('Con squash se crea un commit único con todos los cambios; el historial de la rama no se fusiona.')}
            </p>
          )}
        </div>

        <footer className="modal-footer">
          <button type="button" onClick={close} disabled={loading}>
            {t('Cancelar')}
          </button>
          <button
            type="button"
            className="primary"
            onClick={merge}
            disabled={loading || !valid}
          >
            {t('Fusionar')}
          </button>
        </footer>
      </div>
    </div>
  );
}
