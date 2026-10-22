import { useEffect, useState } from 'react';
import { useStore } from '../store/useAppStore';
import * as ipc from '../lib/ipc';
import { isGitHubHost } from '../lib/hosts';
import type { CredentialStatus } from '../lib/types';
import { useI18n } from '../lib/useI18n';

/**
 * Formulario de credenciales para un host.
 *
 * Escribe usuario y contrasena o token, pulsa Guardar y a partir de ahi
 * fetch/pull/push no vuelven a pedir nada: el backend las lee del llavero del
 * sistema. La contrasena solo se teclea aqui; despues la interfaz solo puede
 * ver si existe y el usuario, nunca la contrasena.
 *
 * El estado (existe o no) vive en el padre: son dos sitios distintos los que
 * preguntan por el mismo host, el panel de remotos y la configuracion.
 */
export function CredentialsForm({
  host,
  label,
  status,
  onChanged,
}: {
  host: string;
  label: string;
  status: CredentialStatus | undefined;
  onChanged: () => void;
}) {
  const { t } = useI18n();
  const notify = useStore((s) => s.notify);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  const isGitHub = isGitHubHost(host);

  useEffect(() => {
    if (status?.username) {
      setUsername(status.username);
    }
  }, [status?.username, host]);

  const save = () => {
    const name = username.trim();
    if (!name || !password) {
      notify('error', t('Faltan usuario y contrasena'));
      return;
    }
    void ipc.storeCredential(host, { username: name, password }).then(
      () => {
        notify('success', t('Credencial guardada para {host}', { host: status?.host ?? host }));
        setPassword('');
        onChanged();
      },
      (error) => notify('error', ipc.errorMessage(error)),
    );
  };

  const forget = () => {
    void ipc.forgetCredential(host).then(
      () => {
        setUsername('');
        setPassword('');
        notify('info', t('Credencial olvidada'));
        onChanged();
      },
      (error) => notify('error', ipc.errorMessage(error)),
    );
  };

  const canSave = Boolean(username.trim() && password);

  return (
    <div className="creds-form">
      {!isGitHub ? (
        <>
          <span className="badge badge-warn">{t('solo GitHub')}</span>
          <p className="settings-hint">
            {t('Por ahora Foxen solo admite GitHub. La integración con GitLab, Bitbucket y otros servicios llegará en una próxima versión.')}
          </p>
        </>
      ) : (
        <>
          <span className={`badge ${status?.saved ? 'badge-ahead' : 'badge-warn'}`}>
            {status ? (
              status.saved ? (
                t('guardada · {user}', { user: status.username ?? status.host })
              ) : (
                t('sin guardar · {host}', { host: status.host })
              )
            ) : (
              t('consultando…')
            )}
          </span>
          <input
            type="text"
            placeholder={status?.username ?? t('usuario')}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            aria-label={t('Usuario para {label}', { label })}
            autoComplete="username"
          />
          <input
            type="password"
            placeholder={status?.saved ? t('ya guardada') : t('contrasena o token')}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && canSave) save();
            }}
            aria-label={t('Contrasena para {label}', { label })}
            autoComplete="off"
          />
          <button type="button" className="primary" onClick={save} disabled={!canSave}>
            {t('Guardar/Actualizar')}
          </button>
          <button type="button" className="link danger" onClick={forget} disabled={!status?.saved}>
            {t('olvidar')}
          </button>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, width: '100%' }}>
            <button
              type="button"
              className="secondary"
              onClick={() => useStore.getState().openGitHubLogin()}
              style={{ fontSize: 12, padding: '4px 10px', alignSelf: 'flex-start', marginTop: 4 }}
            >
              🐙 {t('Iniciar sesión con GitHub en el navegador')}
            </button>
            <small className="settings-hint">
              {t('O si prefieres, ingresa un Personal Access Token (PAT) con alcance')}{' '}
              <code>repo</code>.{' '}
              <a href="https://github.com/settings/tokens" target="_blank" rel="noopener noreferrer">
                {t('Crear token')}
              </a>
            </small>
          </div>
        </>
      )}
    </div>
  );
}
