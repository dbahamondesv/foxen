import { useStore } from '../store/useAppStore';
import * as ipc from '../lib/ipc';

/**
 * Aviso de operacion en curso (fusion o rebase) con acciones para cerrarla.
 *
 * Git deja el repositorio a medias cuando hay conflictos; sin estos botones
 * habia que terminar la operacion desde la terminal.
 */
export function OperationBanner() {
  const repoId = useStore((s) => s.repoId);
  const operationState = useStore((s) => s.operationState);
  const loading = useStore((s) => s.loading);
  const run = useStore((s) => s.run);
  const commitMessage = useStore((s) => s.commitMessage);

  if (!repoId || !operationState) return null;

  const { mergeInProgress, rebaseInProgress, conflictedFiles } = operationState;
  if (!mergeInProgress && !rebaseInProgress) return null;

  const kind = rebaseInProgress ? 'Rebase' : 'Fusion';
  const conflicts = conflictedFiles.length;

  const continueOp = () => {
    if (rebaseInProgress) {
      void run('Continuar rebase', () => ipc.rebaseContinue(repoId));
      return;
    }
    void run('Continuar fusion', () =>
      ipc.mergeContinue(repoId, commitMessage.trim() ? commitMessage.trim() : null),
    );
  };

  const abortOp = () => {
    void run(rebaseInProgress ? 'Abortar rebase' : 'Abortar fusion', () =>
      rebaseInProgress ? ipc.rebaseAbort(repoId) : ipc.abortMerge(repoId),
    );
  };

  return (
    <div className="op-banner" role="status">
      <span className="op-banner-text">
        <strong>{kind} en curso</strong>
        {conflicts > 0
          ? ` · ${conflicts} archivo(s) en conflicto: resolvelos en el panel Cambios`
          : ' · sin conflictos pendientes'}
      </span>
      <div className="op-banner-actions">
        {rebaseInProgress && (
          <button
            type="button"
            onClick={() => void run('Saltar paso', () => ipc.rebaseSkip(repoId))}
            disabled={loading}
            title="Descarta este commit del rebase y continua con el siguiente"
          >
            Saltar
          </button>
        )}
        <button
          type="button"
          className="primary"
          onClick={continueOp}
          disabled={loading || conflicts > 0}
          title={
            conflicts > 0
              ? 'Resuelve los conflictos antes de continuar'
              : rebaseInProgress
                ? 'Reaplica el commit siguiente'
                : 'Crea el commit de fusion y cierra la operacion'
          }
        >
          Continuar
        </button>
        <button type="button" className="danger" onClick={abortOp} disabled={loading}>
          Abortar
        </button>
      </div>
    </div>
  );
}
