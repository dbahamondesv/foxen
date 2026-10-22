import { useStore } from '../store/useAppStore';
import * as ipc from '../lib/ipc';
import { useI18n } from '../lib/useI18n';

/**
 * Aviso de operacion en curso (fusion o rebase) con acciones para cerrarla.
 *
 * Git deja el repositorio a medias cuando hay conflictos; sin estos botones
 * habia que terminar la operacion desde la terminal.
 */
export function OperationBanner() {
  const { t } = useI18n();
  const repoId = useStore((s) => s.repoId);
  const operationState = useStore((s) => s.operationState);
  const loading = useStore((s) => s.loading);
  const run = useStore((s) => s.run);
  const commitMessage = useStore((s) => s.commitMessage);

  if (!repoId || !operationState) return null;

  const { mergeInProgress, rebaseInProgress, conflictedFiles } = operationState;
  if (!mergeInProgress && !rebaseInProgress) return null;

  const kind = rebaseInProgress ? t('Rebase') : t('Fusión');
  const conflicts = conflictedFiles.length;

  const continueOp = () => {
    if (rebaseInProgress) {
      void run(t('Continuar rebase'), () => ipc.rebaseContinue(repoId));
      return;
    }
    void run(t('Continuar fusión'), () =>
      ipc.mergeContinue(repoId, commitMessage.trim() ? commitMessage.trim() : null),
    );
  };

  const abortOp = () => {
    void run(rebaseInProgress ? t('Abortar rebase') : t('Abortar fusión'), () =>
      rebaseInProgress ? ipc.rebaseAbort(repoId) : ipc.abortMerge(repoId),
    );
  };

  return (
    <div className="op-banner" role="status">
      <span className="op-banner-text">
        <strong>{kind} {t('en curso')}</strong>
        {conflicts > 0
          ? ` · ${t('{count} archivo(s) en conflicto: resolvelos en el panel Cambios', { count: conflicts })}`
          : ` · ${t('sin conflictos pendientes')}`}
      </span>
      <div className="op-banner-actions">
        {rebaseInProgress && (
          <button
            type="button"
            onClick={() => void run(t('Saltar paso'), () => ipc.rebaseSkip(repoId))}
            disabled={loading}
            title={t('Descarta este commit del rebase y continua con el siguiente')}
          >
            {t('Saltar')}
          </button>
        )}
        <button
          type="button"
          className="primary"
          onClick={continueOp}
          disabled={loading || conflicts > 0}
          title={
            conflicts > 0
              ? t('Resuelve los conflictos antes de continuar')
              : rebaseInProgress
                ? t('Reaplica el commit siguiente')
                : t('Crea el commit de fusion y cierra la operacion')
          }
        >
          {t('Continuar')}
        </button>
        <button type="button" className="danger" onClick={abortOp} disabled={loading}>
          {t('Abortar')}
        </button>
      </div>
    </div>
  );
}
