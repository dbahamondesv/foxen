import { useEffect, useState } from 'react';
import { useStore } from '../store/useAppStore';
import * as ipc from '../lib/ipc';
import { isGitHubHost } from '../lib/hosts';
import { useI18n } from '../lib/useI18n';

export function GitAuthWarningBanner() {
  const { t } = useI18n();
  const remotes = useStore((s) => s.remotes);
  const openSettings = useStore((s) => s.openSettings);

  const [show, setShow] = useState(false);

  useEffect(() => {
    const checkAuth = async () => {
      const httpGitHubRemotes = remotes.filter(
        (remote) => remote.url.startsWith('http') && isGitHubHost(remote.host)
      );

      if (httpGitHubRemotes.length === 0) {
        setShow(false);
        return;
      }

      try {
        // Intentar verificar con git credential helper
        const ghStatus = await ipc.gitAuthStatusGh().catch(() => null);
        if (ghStatus) {
          setShow(false);
          return;
        }

        // Verificar si hay credenciales guardadas en keyring
        let hasAnyCred = false;
        for (const remote of httpGitHubRemotes) {
          try {
            const status = await ipc.credentialStatus(remote.host);
            if (status.saved) {
              hasAnyCred = true;
              break;
            }
          } catch {
            // ignore
          }
        }

        if (!hasAnyCred) {
          setShow(true);
        } else {
          setShow(false);
        }
      } catch {
        setShow(true);
      }
    };

    void checkAuth();
  }, [remotes]);

  if (!show) return null;

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        padding: '8px 16px',
        background: 'linear-gradient(90deg, #f59e0b 0%, #d97706 100%)',
        color: '#1a1a1a',
        fontSize: 13,
        fontWeight: 500,
        borderBottom: '1px solid rgba(0, 0, 0, 0.1)',
        boxShadow: '0 2px 4px rgba(245, 158, 11, 0.2)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1 }}>
        <span style={{ fontSize: 16 }}>⚠️</span>
        <span>
          {t('GitHub no está configurado correctamente.')} {' '}
          {t('Configura GitHub CLI o añade un token en Ajustes para poder hacer push/pull/fetch.')}
        </span>
      </div>
      <button
        type="button"
        onClick={openSettings}
        style={{
          padding: '4px 12px',
          background: 'rgba(0, 0, 0, 0.15)',
          color: '#1a1a1a',
          border: '1px solid rgba(0, 0, 0, 0.2)',
          borderRadius: 4,
          cursor: 'pointer',
          fontSize: 12,
          fontWeight: 600,
          whiteSpace: 'nowrap',
        }}
        onMouseOver={(e) => {
          e.currentTarget.style.background = 'rgba(0, 0, 0, 0.25)';
        }}
        onMouseOut={(e) => {
          e.currentTarget.style.background = 'rgba(0, 0, 0, 0.15)';
        }}
      >
        {t('Configurar ahora')}
      </button>
    </div>
  );
}
