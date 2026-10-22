import { useEffect, useState } from 'react';
import { useStore } from '../store/useAppStore';
import * as ipc from '../lib/ipc';
import { relativeTime } from '../lib/format';
import { CredentialsForm } from './CredentialsForm';
import { useI18n } from '../lib/useI18n';
import type { Credential, CredentialStatus } from '../lib/types';

/** Panel de remotos: fetch/pull/push y gestion de credenciales. */
export function RemotesPanel() {
  const { t } = useI18n();
  const repoId = useStore((s) => s.repoId);
  const remotes = useStore((s) => s.remotes);
  const run = useStore((s) => s.run);
  const notify = useStore((s) => s.notify);
  const githubUser = useStore((s) => s.githubUser);
  const openGitHubLogin = useStore((s) => s.openGitHubLogin);
  const openPublish = useStore((s) => s.openPublish);

  const [newName, setNewName] = useState('origin');
  const [newUrl, setNewUrl] = useState('');
  // Solo se guardan para prefijar los proximos avisos; la credencial que se envia
  // al IPC es la que devuelve `askCredential`.
  const [user, setUser] = useState('');
  const [pass, setPass] = useState('');
  // Estado del llavero por remoto: si ya hay credencial, no se vuelve a pedir.
  const [statuses, setStatuses] = useState<Record<string, CredentialStatus>>({});

  const refreshStatuses = () => {
    for (const remote of remotes) {
      void ipc.credentialStatus(remote.host).then(
        (status) => setStatuses((prev) => ({ ...prev, [remote.name]: status })),
        () => undefined,
      );
    }
  };

  useEffect(() => {
    let cancelled = false;
    for (const remote of remotes) {
      void ipc.credentialStatus(remote.host).then(
        (status) => {
          if (!cancelled) setStatuses((prev) => ({ ...prev, [remote.name]: status }));
        },
        () => undefined,
      );
    }
    return () => {
      cancelled = true;
    };
  }, [remotes]);

  if (!repoId) return <p className="empty">{t('Sin repositorio abierto.')}</p>;

  const add = () => {
    const name = newName.trim();
    const url = newUrl.trim();
    if (!name || !url) {
      notify('error', t('El remoto necesita nombre y URL'));
      return;
    }
    void run(t('Anadir remoto {name}', { name }), async () => {
      const remote = await ipc.addRemote(repoId, name, url, null, false);
      setNewName('origin');
      setNewUrl('');
      return remote;
    });
  };

  // Devuelve la credencial en vez de solo guardarla en el estado: `setCredential`
  // es asincrono, asi que leer el estado justo despues seguia dando la credencial
  // anterior (o null) y el IPC recibia las credenciales equivocadas.
  //
  // Tres salidas: `cancelled` si el usuario cierra el aviso (no se ejecuta nada),
  // `credential` si tecleo algo esta vez y `null` si no hace falta porque hay una
  // guardada en el llavero o el remoto no es http.
  const askCredential = (remoteName: string): { cancelled: boolean; credential: Credential | null } => {
    const remote = remotes.find((r) => r.name === remoteName);
    if (!remote?.url.startsWith('http')) return { cancelled: false, credential: null };
    if (statuses[remoteName]?.saved) return { cancelled: false, credential: null };

    const nextUser = window.prompt(t('Usuario para {remote}', { remote: remoteName }), user || 'git');
    if (nextUser === null) return { cancelled: true, credential: null };
    const nextPass = window.prompt(t('Contrasena o token'), pass);
    if (nextPass === null) return { cancelled: true, credential: null };

    setUser(nextUser);
    setPass(nextPass);
    return { cancelled: false, credential: { username: nextUser, password: nextPass } };
  };

  /** Pregunta si hace falta y lanza la operacion del remoto. */
  const runRemote = (
    remoteName: string,
    label: string,
    operation: (credential: Credential | null) => Promise<unknown>,
  ) => {
    const { cancelled, credential } = askCredential(remoteName);
    if (cancelled) return;
    void run(label, () => operation(credential));
  };

  return (
    <div className="panel-body remotes">
      <div className="field-row">
        <input
          type="text"
          placeholder={t('nombre')}
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          style={{ width: 90 }}
        />
        <input
          type="text"
          placeholder="https:// o ssh://"
          value={newUrl}
          onChange={(e) => setNewUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') add();
          }}
        />
        <button type="button" className="primary" onClick={add}>
          {t('Anadir')}
        </button>
      </div>

      <h3>{t('Remotos')} ({remotes.length})</h3>
      {remotes.length === 0 ? (
        <>
          <p className="empty">{t('Este repositorio no tiene remotos.')}</p>
          <div style={{ margin: '16px 0' }}>
            <button
              type="button"
              className="primary"
              onClick={() => {
                if (githubUser) {
                  openPublish();
                } else {
                  openGitHubLogin();
                }
              }}
            >
              🚀 {t('Publicar en GitHub…')}
            </button>
          </div>
        </>
      ) : (
        <ul className="remote-list">
          {remotes.map((remote) => (
            <li key={remote.name} className="remote">
              <div className="remote-main">
                <strong>{remote.name}</strong>
                <code className="remote-url">{remote.url}</code>
                {remote.pushUrl && remote.pushUrl !== remote.url && (
                  <code className="remote-url">push: {remote.pushUrl}</code>
                )}
              </div>

              <div className="remote-actions">
                <button
                  type="button"
                  className="link"
                  onClick={() =>
                    runRemote(remote.name, t('Fetch de {remote}', { remote: remote.name }), (cred) =>
                      ipc.fetchRemote(repoId, remote.name, true, cred),
                    )
                  }
                >
                  fetch
                </button>
                <button
                  type="button"
                  className="link"
                  onClick={() =>
                    runRemote(remote.name, t('Pull de {remote}', { remote: remote.name }), (cred) =>
                      ipc.pullRemote(repoId, remote.name, null, false, true, cred),
                    )
                  }
                >
                  pull
                </button>
                <button
                  type="button"
                  className="link"
                  onClick={() =>
                    runRemote(remote.name, t('Push a {remote}', { remote: remote.name }), (cred) =>
                      ipc.pushRemote(repoId, remote.name, null, false, false, false, cred),
                    )
                  }
                >
                  push
                </button>
                <button
                  type="button"
                  className="link"
                  onClick={() =>
                    runRemote(remote.name, t('Probar {remote}', { remote: remote.name }), (cred) =>
                      ipc.testRemote(repoId, remote.name, cred),
                    )
                  }
                >
                  test
                </button>
                <button
                  type="button"
                  className="link danger"
                  onClick={() => {
                    if (!window.confirm(t('¿Eliminar el remoto {remote}?', { remote: remote.name })))
                      return;
                    void run(t('Eliminar remoto'), () => ipc.removeRemote(repoId, remote.name));
                  }}
                >
                  {t('borrar')}
                </button>
              </div>

              {remote.url.startsWith('http') && (
                <CredentialsForm
                  host={remote.host}
                  label={remote.name}
                  status={statuses[remote.name]}
                  onChanged={refreshStatuses}
                />
              )}
            </li>
          ))}
        </ul>
      )}

      <p className="hint">
        {t('Para remotos SSH las claves se resuelven con ssh-agent; en Flatpak usa el permiso --socket=ssh-auth. Para HTTPS, guarda aquí usuario y contraseña o token: se guardan en el llavero del sistema (por host, así valen para todos los repositorios) y después no hace falta volver a teclearlos. La contraseña nunca se guarda en Foxen.')}
      </p>
    </div>
  );
}

/** Panel de Git Flow. */
export function FlowPanel() {
  const { t } = useI18n();
  const repoId = useStore((s) => s.repoId);
  const flow = useStore((s) => s.flow);
  const run = useStore((s) => s.run);
  const notify = useStore((s) => s.notify);
  const [name, setName] = useState('');
  const [version, setVersion] = useState('1.0.0');

  if (!repoId || !flow) return <p className="empty">{t('Git Flow no disponible.')}</p>;

  const { config } = flow;

  const init = () =>
    void run(t('Inicializar Git Flow'), () =>
      ipc.flowInit(repoId, {
        enabled: true,
        mainBranch: 'main',
        developBranch: 'develop',
        featurePrefix: 'feature/',
        releasePrefix: 'release/',
        hotfixPrefix: 'hotfix/',
      }),
    );

  const startFeature = () => {
    const value = name.trim();
    if (!value) return;
    void run(t('Iniciar feature'), async () => {
      const result = await ipc.flowFeatureStart(repoId, value, true);
      setName('');
      return result;
    });
  };

  const finish = (kind: 'feature' | 'release' | 'hotfix', branch: string) => {
    const action =
      kind === 'feature'
        ? ipc.flowFeatureFinish(repoId, branch, false)
        : kind === 'release'
          ? ipc.flowReleaseFinish(repoId, branch)
          : ipc.flowHotfixFinish(repoId, branch);
    void run(t('Finalizar {kind} {branch}', { kind, branch }), () => action);
  };

  const withoutPrefix = (branch: string, prefix: string) =>
    branch.startsWith(prefix) ? branch.slice(prefix.length) : branch;

  return (
    <div className="panel-body flow">
      {!flow.initialized ? (
        <>
          <p className="empty">{t('Git Flow no esta inicializado en este repositorio.')}</p>
          <button type="button" className="primary" onClick={init}>
            {t('Inicializar Git Flow')}
          </button>
        </>
      ) : (
        <>
          <dl className="flow-config">
            <dt>main</dt>
            <dd>{config.mainBranch}</dd>
            <dt>develop</dt>
            <dd>{config.developBranch}</dd>
            <dt>{t('actual')}</dt>
            <dd>
              {flow.currentBranch ?? '—'} <em>({flow.currentType})</em>
            </dd>
          </dl>

          <div className="field-row">
            <input
              type="text"
              placeholder={t('nombre de la feature')}
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') startFeature();
              }}
            />
            <button type="button" className="primary" onClick={startFeature}>
              {t('Nueva feature')}
            </button>
          </div>

          <div className="field-row">
            <input
              type="text"
              placeholder={t('version de la release')}
              value={version}
              onChange={(e) => setVersion(e.target.value)}
            />
            <button
              type="button"
              onClick={() =>
                void run(t('Iniciar release'), () => ipc.flowReleaseStart(repoId, version, true))
              }
            >
              {t('Release')} {version}
            </button>
            <button
              type="button"
              onClick={() =>
                void run(t('Iniciar hotfix'), () => ipc.flowHotfixStart(repoId, version, true))
              }
            >
              {t('Hotfix')} {version}
            </button>
          </div>

          {flow.activeFeatures.length > 0 && (
            <>
              <h3>{t('Features activas')}</h3>
              <ul className="flow-list">
                {flow.activeFeatures.map((b) => (
                  <li key={b}>
                    <span>{b}</span>
                    <button
                      type="button"
                      className="link"
                      onClick={() => finish('feature', withoutPrefix(b, config.featurePrefix))}
                    >
                      {t('finalizar')}
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}

          {flow.activeReleases.length > 0 && (
            <>
              <h3>{t('Releases activas')}</h3>
              <ul className="flow-list">
                {flow.activeReleases.map((b) => (
                  <li key={b}>
                    <span>{b}</span>
                    <button
                      type="button"
                      className="link"
                      onClick={() => finish('release', withoutPrefix(b, config.releasePrefix))}
                    >
                      {t('finalizar')}
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}

          {flow.activeHotfixes.length > 0 && (
            <>
              <h3>{t('Hotfixes activos')}</h3>
              <ul className="flow-list">
                {flow.activeHotfixes.map((b) => (
                  <li key={b}>
                    <span>{b}</span>
                    <button
                      type="button"
                      className="link"
                      onClick={() => finish('hotfix', withoutPrefix(b, config.hotfixPrefix))}
                    >
                      {t('finalizar')}
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}

          <button
            type="button"
            className="danger-outline"
            onClick={() => {
              if (!window.confirm(t('¿Desactivar Git Flow en este repositorio?'))) return;
              notify('info', t('Desactivando…'));
              void run(t('Desactivar Git Flow'), () => ipc.flowDisable(repoId));
            }}
          >
            {t('Desactivar Git Flow')}
          </button>
        </>
      )}
    </div>
  );
}

/** Panel de reflog. */
export function ReflogPanel() {
  const { locale, t } = useI18n();
  const reflog = useStore((s) => s.reflog);
  const openDetail = useStore((s) => s.openDetail);

  if (reflog.length === 0) return <p className="empty">{t('Sin entradas de reflog.')}</p>;

  return (
    <div className="panel-body reflog">
      <ul className="reflog-list">
        {reflog.map((entry) => (
          <li key={`${entry.oid}-${entry.index}`}>
            <button type="button" className="reflog-entry" onClick={() => openDetail(entry.oid)}>
              <span className="reflog-msg">{entry.message}</span>
              <span className="reflog-meta">
                <code>{entry.shortOid}</code>
                <span>{entry.committer}</span>
                <span>{relativeTime(entry.timestamp, locale)}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}