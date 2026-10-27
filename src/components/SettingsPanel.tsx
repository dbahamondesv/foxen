import { useEffect, useRef, useState } from 'react';
import { useStore } from '../store/useAppStore';
import * as ipc from '../lib/ipc';
import { CredentialsForm } from './CredentialsForm';
import { HelpButton } from './HelpPanel';
import { isGitHubHost, normalizeHost } from '../lib/hosts';
import type { CredentialStatus } from '../lib/types';
import type { Theme } from '../lib/theme';
import type { Locale } from '../lib/i18n';
import { useI18n } from '../lib/useI18n';

const THEMES: { id: Theme; label: string; hint: string }[] = [
  { id: 'light', label: 'Claro', hint: 'Fondo blanco, para salas iluminadas' },
  { id: 'dark', label: 'Oscuro', hint: 'Fondo oscuro, para trabajar de noche' },
  { id: 'system', label: 'Seguir al sistema', hint: 'Cambia solo con la preferencia del SO' },
];

const LANGUAGES: { id: Locale; label: string; hint: string }[] = [
  { id: 'es', label: 'Español', hint: 'Interfaz y mensajes en español' },
  { id: 'en', label: 'English', hint: 'Interfaz y mensajes en inglés' },
];

/**
 * Panel de configuracion de la aplicacion.
 *
 * Es un dialogo modal y no una pestana mas del sidebar porque los ajustes son de
 * la app, no del repositorio: deben abrirse incluso sin ningun repo abierto.
 */
export function SettingsPanel() {
  const { t } = useI18n();
  const theme = useStore((s) => s.theme);
  const setTheme = useStore((s) => s.setTheme);
  const locale = useStore((s) => s.locale);
  const setLocale = useStore((s) => s.setLocale);
  const closeSettings = useStore((s) => s.closeSettings);
  const remotes = useStore((s) => s.remotes);
  const githubUser = useStore((s) => s.githubUser);
  const openGitHubLogin = useStore((s) => s.openGitHubLogin);
  const openGitHubRepos = useStore((s) => s.openGitHubRepos);
  const logoutGitHub = useStore((s) => s.logoutGitHub);
  const dialogRef = useRef<HTMLDivElement>(null);

  const [host, setHost] = useState('');
  const [status, setStatus] = useState<CredentialStatus | undefined>();
  const [refresh, setRefresh] = useState(0);

  // Hosts comunes para configurar sin tener repo abierto. Solo GitHub por ahora:
  // GitLab, Bitbucket y el resto llegaran en proximas versiones.
  const commonHosts = ['github.com'];

  // Al abrir el dialogo se preselecciona el último host usado, o el primer remoto del repo abierto.
  useEffect(() => {
    const saved = localStorage.getItem('foxen:lastCredHost') ?? '';
    const first = remotes.find((remote) => remote.url.startsWith('http'))?.host ?? '';
    setHost((current) => current || saved || first);
  }, [remotes]);

  // Solo HTTPS: SSH resuelve las claves con ssh-agent, no hay nada que guardar.
  // Se limita a GitHub mientras el resto de forges no este implementado.
  const httpRemotes = remotes.filter(
    (remote) => remote.url.startsWith('http') && isGitHubHost(remote.host),
  );

  // La consulta va con rebote: cada letra del host no debe abrir el llavero.
  useEffect(() => {
    const value = host.trim();
    setStatus(undefined);
    if (!value) return;
    const normalized = normalizeHost(value);
    if (normalized !== host) {
      setHost(normalized);
      return;
    }
    localStorage.setItem('foxen:lastCredHost', normalized);
    const timer = setTimeout(() => {
      void ipc.credentialStatus(normalized).then(
        (result) => setStatus(result),
        () => setStatus(undefined),
      );
    }, 250);
    return () => clearTimeout(timer);
  }, [host, refresh]);

  // Escape cierra y el foco entra al dialogo al abrirlo.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeSettings();
    };
    window.addEventListener('keydown', onKey);
    dialogRef.current?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [closeSettings]);

  return (
    <div
      className="modal-overlay"
      onClick={(e) => {
        // Solo cierra si el clic viene del fondo, no de dentro del dialogo.
        if (e.target === e.currentTarget) closeSettings();
      }}
    >
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        ref={dialogRef}
        tabIndex={-1}
      >
        <header className="modal-header">
          <h2 id="settings-title">{t('Configuracion')}</h2>
          <button
            type="button"
            className="icon-button"
            onClick={closeSettings}
            aria-label={t('Cerrar configuracion')}
          >
            ×
          </button>
        </header>

        <div className="modal-body">
          <section className="settings-group">
            <h3 className="settings-label">{t('Tema')}</h3>
            <p className="settings-hint">
              {t('Elige el aspecto de la interfaz. «Seguir al sistema» usa la preferencia de tu escritorio y se actualiza sola si esta cambia.')}
            </p>
            <div className="segmented" role="radiogroup" aria-label={t('Tema de la interfaz')}>
              {THEMES.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  role="radio"
                  aria-checked={theme === option.id}
                  className={`segmented-option${theme === option.id ? ' is-active' : ''}`}
                  onClick={() => setTheme(option.id)}
                >
                  {t(option.label)}
                </button>
              ))}
            </div>
            <p className="settings-hint">
              {t(THEMES.find((option) => option.id === theme)?.hint ?? '')}
            </p>
          </section>

          <section className="settings-group">
            <h3 className="settings-label">{t('Idioma')}</h3>
            <p className="settings-hint">
              {t('Elige el idioma de la interfaz. El cambio se aplica al instante.')}
            </p>
            <div className="segmented" role="radiogroup" aria-label={t('Idioma de la interfaz')}>
              {LANGUAGES.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  role="radio"
                  aria-checked={locale === option.id}
                  className={`segmented-option${locale === option.id ? ' is-active' : ''}`}
                  onClick={() => setLocale(option.id)}
                >
                  {option.label}
                </button>
              ))}
            </div>
            <p className="settings-hint">
              {t(LANGUAGES.find((option) => option.id === locale)?.hint ?? '')}
            </p>
          </section>

          <section className="settings-group">
            <h3 className="settings-label">{t('Cuenta de GitHub')}</h3>
            {githubUser ? (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: 12,
                  borderRadius: 6,
                  border: '1px solid var(--border)',
                  background: 'var(--bg-subtle, rgba(255, 255, 255, 0.03))',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  {githubUser.avatarUrl && (
                    <img
                      src={githubUser.avatarUrl}
                      alt={githubUser.login}
                      style={{ width: 32, height: 32, borderRadius: '50%' }}
                    />
                  )}
                  <div>
                    <strong>{githubUser.name || githubUser.login}</strong>
                    <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                      @{githubUser.login} · {githubUser.email || t('Conectado')}
                    </div>
                  </div>
                </div>

                <div style={{ display: 'flex', gap: 8 }}>
                  <button
                    type="button"
                    onClick={() => {
                      closeSettings();
                      openGitHubRepos();
                    }}
                  >
                    {t('Ver repositorios')}
                  </button>
                  <button
                    type="button"
                    className="danger-outline"
                    onClick={() => void logoutGitHub()}
                  >
                    {t('Cerrar sesión')}
                  </button>
                </div>
              </div>
            ) : (
              <div>
                <p className="settings-hint">
                  {t('Inicia sesión con tu cuenta de GitHub para autorizar Foxen con acceso a tus repositorios y clonar/gestionar tus fuentes directamente.')}
                </p>
                <button
                  type="button"
                  className="primary"
                  onClick={() => {
                    closeSettings();
                    openGitHubLogin();
                  }}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}
                >
                  <span>🐙</span> {t('Iniciar sesión en GitHub')}
                </button>
              </div>
            )}
          </section>

          <section className="settings-group">
            <h3 className="settings-label">{t('GitHub CLI (recomendado)')}</h3>
            <p className="settings-hint">
              {t('Si tienes GitHub CLI instalado y autenticado, puedes configurar Git automáticamente para usarlo con todos los repositorios. Esto evita tener que introducir usuario/token manualmente.')}
            </p>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button
                type="button"
                onClick={async () => {
                  try {
                    const res = await ipc.gitAuthStatusGh();
                    alert(res);
                  } catch (e: any) {
                    alert(e?.message || String(e));
                  }
                }}
              >
                {t('Comprobar estado de gh')}
              </button>
              <button
                type="button"
                className="primary"
                onClick={async () => {
                  try {
                    const res = await ipc.gitAuthSetupGh();
                    alert(res);
                    setRefresh((n) => n + 1);
                  } catch (e: any) {
                    alert(e?.detail || e?.message || String(e));
                  }
                }}
              >
                {t('Configurar Git con GitHub CLI')}
              </button>
            </div>
          </section>

          <section className="settings-group">
            <h3 className="settings-label">{t('Credenciales')}</h3>
            <p className="settings-hint">
              {t('Por ahora Foxen solo admite GitHub; la integración con GitLab, Bitbucket y otros servicios llegará en una próxima versión. Usuario y contraseña o token para los remotos HTTPS de GitHub. Los remotos SSH (git@...) usan ssh-agent y no necesitan credenciales aquí. Se guardan en el llavero del sistema con el host como clave, asi que valen para todos los repositorios. La contrasena nunca se guarda en Foxen.')}
            </p>

            <div className="host-chips">
              <span className="host-chips-label">{t('Host')}</span>
              {commonHosts.map((h) => (
                <button
                  key={h}
                  type="button"
                  className={host.trim() === h ? 'is-active' : ''}
                  onClick={() => setHost(h)}
                >
                  {h}
                </button>
              ))}
            </div>

            {httpRemotes.length > 0 && (
              <div className="host-chips">
                <span className="host-chips-label">{t('Del repositorio abierto')}</span>
                {httpRemotes.map((remote) => (
                  <button
                    key={remote.name}
                    type="button"
                    className={host.trim() === remote.host ? 'is-active' : ''}
                    onClick={() => setHost(remote.host)}
                  >
                    {remote.name} · {remote.host}
                  </button>
                ))}
              </div>
            )}

            <div className="field-row">
              <input
                type="text"
                placeholder={t('host, por ejemplo github.com o https://github.com/owner/repo.git')}
                value={host}
                onChange={(e) => setHost(e.target.value)}
                aria-label={t('Host de las credenciales')}
              />
            </div>
            {host.trim() !== '' && normalizeHost(host) !== host.trim() && (
              <p className="settings-hint">
                {t('Se guardará para:')} <code>{normalizeHost(host)}</code>
              </p>
            )}

            {host.trim() !== '' && (
              <CredentialsForm
                host={normalizeHost(host.trim())}
                label={normalizeHost(host.trim())}
                status={status}
                onChanged={() => setRefresh((n) => n + 1)}
              />
            )}
          </section>

          <section className="settings-group">
            <h3 className="settings-label">{t('Ayuda y manual')}</h3>
            <p className="settings-hint">
              {t('Consulta el manual integrado para aprender el flujo de trabajo, los atajos y la resolución de problemas.')}
            </p>
            <div className="settings-help-actions">
              <HelpButton section="settings" label={t('Abrir manual')} />
              <span className="settings-hint">{t('También puedes pulsar F1 o ? en cualquier momento.')}</span>
            </div>
          </section>
        </div>

        <footer className="modal-footer">
          <button type="button" className="primary" onClick={closeSettings}>
            {t('Cerrar')}
          </button>
        </footer>
      </div>
    </div>
  );
}