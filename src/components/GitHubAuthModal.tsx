import { useEffect, useRef, useState } from 'react';
import { openUrl } from '@tauri-apps/plugin-opener';
import { useStore } from '../store/useAppStore';
import * as ipc from '../lib/ipc';
import type { GitHubLoginState } from '../lib/types';

export function GitHubAuthModal() {
  const close = useStore((s) => s.closeGitHubLogin);
  const openRepos = useStore((s) => s.openGitHubRepos);
  const refreshUser = useStore((s) => s.refreshGitHubUser);
  const notify = useStore((s) => s.notify);

  const [loading, setLoading] = useState(false);
  const [loginState, setLoginState] = useState<GitHubLoginState | null>(null);
  const [copied, setCopied] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successUser, setSuccessUser] = useState<string | null>(null);
  const [showManualPat, setShowManualPat] = useState(false);
  const [manualPat, setManualPat] = useState('');
  const [manualUser, setManualUser] = useState('');

  // Configuración de Client ID personalizado
  const [clientId, setClientId] = useState(() => localStorage.getItem('foxen:githubClientId') ?? '');
  const [showConfig, setShowConfig] = useState(false);
  /** Si el Device Flow está configurado en el backend (env FOXEN_GITHUB_CLIENT_ID). */
  const [envFlowConfigured, setEnvFlowConfigured] = useState<boolean | null>(null);

  // Sin Client ID (ni de entorno ni tecleado) el Device Flow fallaría con un
  // error de GitHub: se oculta la opción y se ofrece configurarlo.
  const flowReady = envFlowConfigured === true || clientId.trim() !== '';

  useEffect(() => {
    void ipc
      .githubDeviceFlowConfigured()
      .then(setEnvFlowConfigured)
      .catch(() => setEnvFlowConfigured(false));
  }, []);

  const pollingRef = useRef(false);
  const dialogRef = useRef<HTMLDivElement>(null);

  // Iniciar el flujo de login automáticamente al abrir el modal
  const startFlow = async (overrideClientId?: string) => {
    setErrorMsg(null);
    setLoading(true);
    setSuccessUser(null);
    const targetClientId = overrideClientId !== undefined ? overrideClientId : clientId.trim();
    try {
      const state = await ipc.githubStartLogin(targetClientId || null);
      setLoginState(state);

      // Abrir navegador con la URL de verificación
      const targetUrl = state.verificationUriComplete || state.verificationUri;
      if (targetUrl) {
        openUrl(targetUrl).catch((err) => notify('error', ipc.errorMessage(err)));
      }

      // Empezar a hacer polling
      pollingRef.current = true;
      void pollToken(state);
    } catch (err) {
      setErrorMsg(ipc.errorMessage(err));
      setLoading(false);
    }
  };

  const pollToken = async (state: GitHubLoginState) => {
    try {
      const result = await ipc.githubPollLogin(state);
      if (!pollingRef.current) return;

      if (result.success && result.token) {
        setSuccessUser(result.username ?? 'usuario');
        await refreshUser();
        notify('success', `Conectado a GitHub como @${result.username ?? 'usuario'}`);
        setTimeout(() => {
          close();
          openRepos();
        }, 1200);
      } else if (result.error) {
        setErrorMsg(result.errorDescription ?? result.error);
      }
    } catch (err) {
      if (pollingRef.current) {
        setErrorMsg(ipc.errorMessage(err));
      }
    } finally {
      setLoading(false);
    }
  };

  const handleGhLogin = async () => {
    setLoading(true);
    setErrorMsg(null);
    setSuccessUser(null);
    try {
      const res = await ipc.githubLoginWithGh();
      if (res.success) {
        setSuccessUser(res.username ?? 'usuario');
        await refreshUser();
        notify('success', `Conectado a GitHub como @${res.username ?? 'usuario'}`);
        setTimeout(() => {
          close();
          openRepos();
        }, 1200);
      } else {
        setErrorMsg(res.errorDescription ?? res.error ?? 'No se pudo iniciar sesión con gh');
      }
    } catch (err) {
      setErrorMsg(ipc.errorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    return () => {
      pollingRef.current = false;
    };
  }, []);

  // Manejo de tecla Escape
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        pollingRef.current = false;
        close();
      }
    };
    window.addEventListener('keydown', onKey);
    dialogRef.current?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [close]);

  const copyCode = async () => {
    if (!loginState?.userCode) return;
    try {
      await navigator.clipboard.writeText(loginState.userCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      notify('info', `Código: ${loginState.userCode}`);
    }
  };

  const openBrowserAgain = () => {
    if (!loginState) return;
    const url = loginState.verificationUriComplete || loginState.verificationUri;
    openUrl(url).catch((err) => notify('error', ipc.errorMessage(err)));
  };

  const handleSaveClientId = () => {
    const trimmed = clientId.trim();
    if (trimmed) {
      localStorage.setItem('foxen:githubClientId', trimmed);
    } else {
      localStorage.removeItem('foxen:githubClientId');
    }
    notify('info', 'Client ID actualizado. Reintentando...');
    void startFlow(trimmed);
  };

  const openNewTokenPage = () => {
    const url = 'https://github.com/settings/tokens/new?description=Foxen%20Desktop&scopes=repo,read:user,user:email';
    openUrl(url).catch((err) => notify('error', ipc.errorMessage(err)));
  };

  const openOAuthSettingsPage = () => {
    openUrl('https://github.com/settings/developers').catch((err) =>
      notify('error', ipc.errorMessage(err)),
    );
  };

  const handleManualSave = async () => {
    const pat = manualPat.trim();
    if (!pat) {
      notify('error', 'Ingresa un token de acceso personal');
      return;
    }
    setLoading(true);
    setErrorMsg(null);
    try {
      const res = await ipc.githubLoginComplete(pat, manualUser.trim() || null);
      if (res.success) {
        setSuccessUser(res.username ?? 'usuario');
        await refreshUser();
        notify('success', `Conectado con token a GitHub como @${res.username}`);
        setTimeout(() => {
          close();
          openRepos();
        }, 1200);
      } else {
        setErrorMsg(res.errorDescription ?? 'Token inválido');
      }
    } catch (err) {
      setErrorMsg(ipc.errorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  const is404 = errorMsg?.includes('404');

  return (
    <div
      className="modal-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          pollingRef.current = false;
          close();
        }
      }}
    >
      <div
        className="modal github-auth-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="github-auth-title"
        ref={dialogRef}
        tabIndex={-1}
        style={{ maxWidth: 560 }}
      >
        <header className="modal-header">
          <h2 id="github-auth-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: '1.3em' }}>🐙</span> Iniciar sesión en GitHub
          </h2>
          <button
            type="button"
            className="icon-button"
            onClick={() => {
              pollingRef.current = false;
              close();
            }}
            aria-label="Cerrar"
          >
            ×
          </button>
        </header>

        <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {successUser ? (
            <div className="github-auth-success" style={{ textAlign: 'center', padding: '24px 0' }}>
              <div style={{ fontSize: 48, marginBottom: 8 }}>✅</div>
              <h3 style={{ margin: 0, color: 'var(--color-ahead, #3fb950)' }}>
                ¡Autenticado con éxito!
              </h3>
              <p style={{ marginTop: 6, color: 'var(--text-muted)' }}>
                Conectado como <strong>@{successUser}</strong>. Abriendo tus repositorios...
              </p>
            </div>
          ) : !showManualPat ? (
            <>
              {!loginState && !successUser && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  <p style={{ margin: 0, lineHeight: 1.5 }}>
                    Elige cómo iniciar sesión en <strong>GitHub</strong>. Si tu cuenta tiene
                    verificación en dos pasos (MFA), GitHub te la pedirá en el navegador.
                  </p>
                  <button
                    type="button"
                    className="primary"
                    onClick={() => void handleGhLogin()}
                    disabled={loading}
                    style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}
                  >
                    ⚡ Usar sesión de GitHub CLI (gh)
                  </button>
                  <small style={{ color: 'var(--text-muted)', textAlign: 'center' }}>
                    Recomendado si ya usas <code>gh</code> en tu equipo: reutiliza tu sesión sin
                    volver a autenticarte.
                  </small>
                  {flowReady ? (
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => void startFlow()}
                      disabled={loading}
                      style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}
                    >
                      🌐 Iniciar sesión en el navegador (Device Flow)
                    </button>
                  ) : (
                    <div
                      style={{
                        padding: 10,
                        background: 'var(--bg-subtle, rgba(255, 255, 255, 0.03))',
                        borderRadius: 6,
                        border: '1px solid var(--border)',
                        fontSize: 12,
                        color: 'var(--text-muted)',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 6,
                      }}
                    >
                      <span>
                        El inicio en el navegador requiere una OAuth App propia con «Enable Device
                        Flow». Sin ella, usa <code>gh</code> o un PAT.
                      </span>
                      <button
                        type="button"
                        className="link"
                        style={{ alignSelf: 'flex-start', fontSize: 12 }}
                        onClick={() => setShowConfig(true)}
                      >
                        ⚙ Configurar Client ID para el Device Flow
                      </button>
                    </div>
                  )}
                </div>
              )}

              {loginState && (
                <p style={{ margin: 0, lineHeight: 1.5 }}>
                  Hemos abierto tu navegador web para que autorices a <strong>Foxen</strong> el acceso
                  a tus repositorios de GitHub.
                </p>
              )}

              {loginState && (
                <div
                  className="github-code-box"
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    gap: 12,
                    padding: 20,
                    background: 'var(--bg-subtle, rgba(255, 255, 255, 0.05))',
                    borderRadius: 8,
                    border: '1px solid var(--border)',
                  }}
                >
                  <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>
                    Código de verificación:
                  </span>
                  <div
                    style={{
                      fontSize: 32,
                      fontWeight: 'bold',
                      letterSpacing: '0.15em',
                      fontFamily: 'monospace',
                      userSelect: 'all',
                      color: 'var(--accent, #58a6ff)',
                    }}
                  >
                    {loginState.userCode}
                  </div>
                  <div style={{ display: 'flex', gap: 10 }}>
                    <button type="button" onClick={() => void copyCode()}>
                      {copied ? '✓ ¡Copiado!' : '📋 Copiar código'}
                    </button>
                    <button type="button" onClick={openBrowserAgain} className="secondary">
                      🌐 Abrir navegador de nuevo
                    </button>
                  </div>
                </div>
              )}

              {loading && !errorMsg && (
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 10,
                    color: 'var(--text-muted)',
                    fontSize: 14,
                  }}
                >
                  <span className="spinner">⏳</span>
                  <span>Esperando autorización en GitHub...</span>
                </div>
              )}

              {errorMsg && (
                <div
                  style={{
                    padding: 14,
                    background: 'rgba(248, 81, 73, 0.1)',
                    border: '1px solid var(--color-danger, #f85149)',
                    borderRadius: 6,
                    color: 'var(--text)',
                    fontSize: 13,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 10,
                  }}
                >
                  <div style={{ color: 'var(--color-danger, #f85149)' }}>
                    <strong>{is404 ? 'Configuración de OAuth requerida (404)' : 'Error:'}</strong>
                  </div>
                  <div>{errorMsg}</div>

                  {is404 && (
                    <div
                      style={{
                        background: 'var(--bg-subtle, rgba(255, 255, 255, 0.04))',
                        padding: 10,
                        borderRadius: 6,
                        border: '1px solid var(--border)',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 8,
                        fontSize: 12,
                      }}
                    >
                      <strong>¿Cómo solucionarlo en GitHub?</strong>
                      <ol style={{ margin: 0, paddingLeft: 18, lineHeight: 1.5 }}>
                        <li>Abre <strong>Developer Settings &gt; OAuth Apps</strong> en GitHub.</li>
                        <li>Selecciona tu App y activa la casilla <strong>Enable Device Flow</strong>.</li>
                        <li>Guarda los cambios y pulsa reintentar.</li>
                      </ol>
                      <button
                        type="button"
                        className="secondary"
                        style={{ alignSelf: 'flex-start', fontSize: 12 }}
                        onClick={openOAuthSettingsPage}
                      >
                        ↗ Ir a Developer Settings en GitHub
                      </button>
                    </div>
                  )}

                  <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 4 }}>
                    <button type="button" className="primary" onClick={() => void startFlow()}>
                      Reintentar conexión
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => void handleGhLogin()}
                      disabled={loading}
                    >
                      ⚡ Usar GitHub CLI (gh)
                    </button>
                    <button
                      type="button"
                      onClick={() => setShowConfig((v) => !v)}
                      style={{ fontSize: 12 }}
                    >
                      ⚙ {showConfig ? 'Ocultar Client ID' : 'Cambiar Client ID'}
                    </button>
                  </div>
                </div>
              )}

              {showConfig && (
                <div
                  style={{
                    padding: 12,
                    background: 'var(--bg-subtle, rgba(255, 255, 255, 0.03))',
                    borderRadius: 6,
                    border: '1px solid var(--border)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 8,
                  }}
                >
                  <label style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                    Client ID de GitHub OAuth App:
                  </label>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <input
                      type="text"
                      placeholder="Ej: Ov23li... o tu Client ID"
                      value={clientId}
                      onChange={(e) => setClientId(e.target.value)}
                      style={{ flex: 1 }}
                    />
                    <button type="button" onClick={handleSaveClientId}>
                      Guardar y Probar
                    </button>
                  </div>
                  <small style={{ color: 'var(--text-muted)' }}>
                    Puedes crear una OAuth App en GitHub (URL de devolución: <code>http://localhost</code>) y activar «Enable Device Flow».
                  </small>
                </div>
              )}

              <div
                style={{
                  borderTop: '1px solid var(--border)',
                  paddingTop: 12,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 8,
                  alignItems: 'center',
                }}
              >
                <button
                  type="button"
                  className="link"
                  style={{ fontSize: 13 }}
                  onClick={() => setShowManualPat(true)}
                >
                  🔑 O conéctate directamente con un Personal Access Token (PAT)
                </button>
              </div>
            </>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div
                style={{
                  padding: 12,
                  background: 'var(--bg-subtle, rgba(255, 255, 255, 0.04))',
                  borderRadius: 6,
                  border: '1px solid var(--border)',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  gap: 12,
                }}
              >
                <div>
                  <strong>Opción rápida sin configurar OAuth App</strong>
                  <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--text-muted)' }}>
                    Genera un token personal en GitHub con permisos de repositorios.
                  </p>
                </div>
                <button type="button" className="secondary" onClick={openNewTokenPage} style={{ flexShrink: 0 }}>
                  🌐 Generar en GitHub ↗
                </button>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <label style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                  Personal Access Token (PAT):
                </label>
                <input
                  type="password"
                  placeholder="ghp_... o github_pat_..."
                  value={manualPat}
                  onChange={(e) => setManualPat(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void handleManualSave();
                  }}
                  autoFocus
                />
                <input
                  type="text"
                  placeholder="Usuario de GitHub (opcional)"
                  value={manualUser}
                  onChange={(e) => setManualUser(e.target.value)}
                />
              </div>

              {errorMsg && (
                <div style={{ color: 'var(--color-danger, #f85149)', fontSize: 13 }}>{errorMsg}</div>
              )}

              <div style={{ display: 'flex', gap: 10 }}>
                <button
                  type="button"
                  className="primary"
                  onClick={() => void handleManualSave()}
                  disabled={loading || !manualPat.trim()}
                >
                  {loading ? 'Verificando…' : 'Conectar con Token'}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setShowManualPat(false);
                    setErrorMsg(null);
                  }}
                >
                  Volver al inicio de sesión con navegador
                </button>
              </div>
            </div>
          )}
        </div>

        <footer className="modal-footer">
          <button
            type="button"
            onClick={() => {
              pollingRef.current = false;
              close();
            }}
          >
            {successUser ? 'Cerrar' : 'Cancelar'}
          </button>
        </footer>
      </div>
    </div>
  );
}
