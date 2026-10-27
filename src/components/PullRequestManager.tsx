import { useEffect, useState } from 'react';
import { useStore } from '../store/useAppStore';
import * as ipc from '../lib/ipc';
import { useI18n } from '../lib/useI18n';

interface PR {
  number: number;
  title: string;
  state: string;
  headRefName: string;
  baseRefName: string;
  url: string;
  author: any;
  createdAt: string;
}

export function PullRequestManager({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const repoId = useStore((s) => s.repoId);
  const [prs, setPrs] = useState<PR[]>([]);
  const [loading, setLoading] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [currentBranch, setCurrentBranch] = useState('');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [base, setBase] = useState('develop');
  const [creating, setCreating] = useState(false);

  const loadPRs = async () => {
    setLoading(true);
    try {
      const result: any = await ipc.listPullRequests('open');
      setPrs(Array.isArray(result) ? result : []);
    } catch (e: any) {
      alert(e?.message || e?.detail || String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadPRs();
    if (repoId) {
      ipc.getCurrentBranch(repoId).then(setCurrentBranch).catch(() => {});
    }
  }, [repoId]);

  const handleCreate = async () => {
    if (!title.trim()) {
      alert(t('El título es obligatorio'));
      return;
    }
    setCreating(true);
    try {
      const result: any = await ipc.createPullRequest({
        title: title.trim(),
        body: body.trim() || undefined,
        base,
        head: currentBranch,
      });
      alert(t('PR creado correctamente'));
      if (result?.url) {
        window.open(result.url, '_blank');
      }
      setShowCreate(false);
      setTitle('');
      setBody('');
      void loadPRs();
    } catch (e: any) {
      alert(e?.message || e?.detail || String(e));
    } finally {
      setCreating(false);
    }
  };

  const handleMerge = async (number: number) => {
    if (!confirm(t('¿Seguro que quieres hacer merge de este PR?'))) return;
    try {
      await ipc.mergePullRequest(number, 'merge');
      alert(t('PR mergeado correctamente'));
      void loadPRs();
    } catch (e: any) {
      alert(e?.message || e?.detail || String(e));
    }
  };

  return (
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ maxWidth: 700, width: '90%' }}>
        <header className="modal-header">
          <h2>{t('Gestor de Pull Requests')}</h2>
          <button type="button" onClick={onClose}>×</button>
        </header>
        <div className="modal-body" style={{ maxHeight: 500, overflowY: 'auto' }}>
          {!showCreate ? (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
                <div>
                  <strong>{t('Rama actual')}:</strong> {currentBranch || '-'}
                </div>
                <button type="button" className="primary" onClick={() => setShowCreate(true)} disabled={!currentBranch || currentBranch === 'main' || currentBranch === 'develop'}>
                  {t('Crear PR desde esta rama')}
                </button>
              </div>
              {loading ? (
                <p>{t('Cargando...')}</p>
              ) : prs.length === 0 ? (
                <p style={{ color: 'var(--text-muted)' }}>{t('No hay PRs abiertos')}</p>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {prs.map((pr) => (
                    <div key={pr.number} style={{ padding: 12, border: '1px solid var(--border)', borderRadius: 6 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                        <strong>#{pr.number} {pr.title}</strong>
                        <button type="button" onClick={() => window.open(pr.url, '_blank')}>{t('Ver en GitHub')}</button>
                      </div>
                      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8 }}>
                        {pr.headRefName} → {pr.baseRefName}
                      </div>
                      {pr.baseRefName === 'develop' && (
                        <button type="button" className="primary" onClick={() => handleMerge(pr.number)}>
                          {t('Hacer merge a develop')}
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div>
                <label style={{ display: 'block', marginBottom: 4 }}>{t('Título')} *</label>
                <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} style={{ width: '100%' }} />
              </div>
              <div>
                <label style={{ display: 'block', marginBottom: 4 }}>{t('Descripción')}</label>
                <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={4} style={{ width: '100%', resize: 'vertical' }} />
              </div>
              <div style={{ display: 'flex', gap: 12 }}>
                <div style={{ flex: 1 }}>
                  <label style={{ display: 'block', marginBottom: 4 }}>{t('Base (destino)')}</label>
                  <select value={base} onChange={(e) => setBase(e.target.value)} style={{ width: '100%' }}>
                    <option value="develop">develop</option>
                    <option value="main">main</option>
                  </select>
                </div>
                <div style={{ flex: 1 }}>
                  <label style={{ display: 'block', marginBottom: 4 }}>{t('Head (origen)')}</label>
                  <input type="text" value={currentBranch} disabled style={{ width: '100%' }} />
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <button type="button" onClick={() => setShowCreate(false)}>{t('Cancelar')}</button>
                <button type="button" className="primary" onClick={handleCreate} disabled={creating}>
                  {creating ? t('Creando...') : t('Crear PR')}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
