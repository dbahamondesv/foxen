/**
 * Herramienta de inspeccion visual (grafo, panel de remotos, ajustes).
 *
 * No forma parte de la aplicacion: vive en `preview.html` y se usa para
 * revisar estilos y layout sin levantar Tauri. Arranca con:
 *   npx vite --open /preview.html
 * Parametros utiles: `?panel=remotes`, `?settings`, `?theme=light`.
 */
import { createRoot } from 'react-dom/client';
import { mockIPC } from '@tauri-apps/api/mocks';
import { CommitGraphView } from './components/CommitGraph';
import { RemotesPanel } from './components/RemotesPanel';
import { SettingsPanel } from './components/SettingsPanel';
import { PanelTabs } from './components/TopBar';
import { useStore } from './store/useAppStore';
import { applyTheme, type Theme } from './lib/theme';
import './styles.css';
import type { CommitNode, GraphEdge, RefLabel } from './lib/types';

const theme = (new URLSearchParams(location.search).get('theme') as Theme) ?? 'dark';
applyTheme(theme);

function label(name: string, kind: RefLabel['kind'], isHead = false): RefLabel {
  return {
    name,
    fullName: `refs/heads/${name}`,
    kind,
    isHead,
    isDetached: false,
  };
}

function node(
  i: number,
  lane: number,
  subject: string,
  labels: RefLabel[] = [],
  isMerge = false,
  isHead = false,
): CommitNode {
  return {
    oid: `oid${i}${lane}`,
    shortOid: `a1b2c3${i}`,
    row: i,
    lane,
    parents: [i > 0 ? `oid${i - 1}` : ''].filter(Boolean),
    subject,
    body: null,
    authorName: 'Ana Perez',
    authorEmail: 'ana@ejemplo.cl',
    authorTime: 1767225600 + i * 3600,
    authorTimeIso: '2026-01-01T10:00:00Z',
    commitTimeIso: '2026-01-01T10:00:00Z',
    labels,
    isMerge,
    isHead,
    isRoot: i === 0,
  };
}

const nodes: CommitNode[] = [
  node(0, 0, 'feat: commit inicial del proyecto'),
  node(1, 0, 'feat: modulo de autenticacion', [label('main', 'branch')]),
  node(2, 1, 'feat: sidebar selector de repositorios', [label('feature/sidebar', 'branch')]),
  node(3, 2, 'fix: contraste del grafo en tema claro', [label('fix/contraste', 'branch')]),
  node(4, 3, 'docs: guia de contribucion', [label('docs/contribuir', 'branch')]),
  node(5, 0, 'Merge de la rama de la sidebar', [], true),
  node(6, 0, 'feat: grafo de commits con carriles'),
  node(7, 1, 'refactor: panel de diffs', [label('feature/grafo', 'branch')]),
  node(8, 0, 'Merge de contraste y docs', [], true),
  node(9, 0, 'test: cobertura del store', []),
  node(10, 0, 'chore: actualizar dependencias'),
  node(11, 0, 'perf: virtualizar la lista de commits'),
  node(12, 0, 'fix: tooltip fuera del viewport', []),
  node(13, 0, 'feat: tema claro y oscuro', [label('v1.0.0', 'tag')]),
  node(14, 1, 'docs: preparar release notes', [label('release/1.1', 'branch')]),
  node(15, 0, 'chore: ajustes de tipografia', [label('main', 'branch', true)], false, true),
];

/**
 * Padres reales de cada commit.
 *
 * Antes cada nodo apuntaba al anterior, asi que una rama en carril 1 o 2
 * empezaba en el vacio: una linea vertical sin nodo del que nacer. Con los
 * padres declarados la curva arranca siempre en el commit origen.
 */
const parentsOf: Record<number, number[]> = {
  0: [],
  1: [0],
  2: [1],
  3: [1],
  4: [1],
  5: [1, 2],
  6: [5],
  7: [6],
  8: [6, 3, 4],
  9: [8],
  10: [9],
  11: [10],
  12: [11],
  13: [12],
  14: [13],
  15: [13],
};

for (const commit of nodes) {
  commit.parents = (parentsOf[commit.row] ?? [])
    .map((row) => nodes[row]?.oid)
    .filter((oid): oid is string => Boolean(oid));
}

const edges: GraphEdge[] = [];
for (const commit of nodes) {
  commit.parents.forEach((parentOid, index) => {
    const parent = nodes.find((n) => n.oid === parentOid);
    if (!parent) return;
    edges.push({
      fromRow: commit.row,
      fromLane: commit.lane,
      toRow: parent.row,
      toLane: parent.lane,
      isMergeEdge: index > 0,
    });
  });
}

const params = new URLSearchParams(location.search);
const withSettings = params.has('settings');

if (withSettings) useStore.getState().openSettings();

/** Lee un argumento string del payload de un IPC simulado. */
const arg = (payload: unknown, key: string): string => {
  const value = (payload as Record<string, unknown> | undefined)?.[key];
  return typeof value === 'string' ? value : '';
};

/** Usuario dentro de la credencial de un IPC simulado. */
const credentialArg = (payload: unknown): string => {
  const credential = (payload as Record<string, unknown> | undefined)?.credential as
    Record<string, unknown> | undefined;
  return typeof credential?.username === 'string' ? credential.username : '';
};

/**
 * Vista previa del panel de remotos.
 *
 * Fuera de Tauri no hay `invoke`, asi que el IPC se simula: si no, la consulta
 * de credenciales queda colgada y el panel solo sirve para mirarlo.
 */
function renderRemotesPreview() {
  const statuses: Record<string, { host: string; saved: boolean; username: string | null }> = {
    origin: { host: 'github.com', saved: false, username: null },
  };

  mockIPC((cmd, payload) => {
    const name = arg(payload, 'remoteName');
    if (cmd === 'credential_status') {
      return statuses[name] ?? { host: 'sin host', saved: false, username: null };
    }
    if (cmd === 'store_credential') {
      statuses[name] = {
        host: 'github.com',
        saved: true,
        username: credentialArg(payload),
      };
      return null;
    }
    if (cmd === 'forget_credential') {
      statuses[name] = { host: 'github.com', saved: false, username: null };
      return null;
    }
    if (cmd === 'github_get_user') {
      return {
        login: 'foxbuntu',
        name: 'Foxbuntu Developer',
        avatarUrl: 'https://avatars.githubusercontent.com/u/9919?v=4',
        htmlUrl: 'https://github.com/foxbuntu',
        email: 'dev@foxen.local',
        publicRepos: 12,
        totalPrivateRepos: 4,
      };
    }
    if (cmd === 'github_start_login') {
      return {
        deviceCode: 'mock-device-code',
        userCode: 'WDWN-6524',
        verificationUri: 'https://github.com/login/device',
        verificationUriComplete: 'https://github.com/login/device?user_code=WDWN-6524',
        expiresIn: 900,
        interval: 5,
        intervalMs: 5000,
        pollIntervalMs: 5000,
      };
    }
    if (cmd === 'github_poll_login') {
      return {
        success: true,
        token: 'gho_mock_token_12345',
        username: 'foxbuntu',
        user: {
          login: 'foxbuntu',
          name: 'Foxbuntu Developer',
          avatarUrl: 'https://avatars.githubusercontent.com/u/9919?v=4',
          htmlUrl: 'https://github.com/foxbuntu',
        },
        error: null,
        errorDescription: null,
      };
    }
    if (cmd === 'github_login_with_gh') {
      return {
        success: true,
        token: 'gho_mock_token_12345',
        username: 'foxbuntu',
        user: {
          login: 'foxbuntu',
          name: 'Foxbuntu Developer',
          avatarUrl: 'https://avatars.githubusercontent.com/u/9919?v=4',
          htmlUrl: 'https://github.com/foxbuntu',
        },
        error: null,
        errorDescription: null,
      };
    }
    if (cmd === 'github_device_flow_configured') {
      return false;
    }
    if (cmd === 'github_list_repos') {
      return [
        {
          id: 1,
          name: 'foxen',
          fullName: 'foxbuntu/foxen',
          private: false,
          htmlUrl: 'https://github.com/foxbuntu/foxen',
          cloneUrl: 'https://github.com/foxbuntu/foxen.git',
          defaultBranch: 'main',
          description: 'Potente gestor de ramas y repositorios git para escritorio',
          updatedAt: new Date().toISOString(),
          stargazersCount: 42,
        },
        {
          id: 2,
          name: 'secret-backend',
          fullName: 'foxbuntu/secret-backend',
          private: true,
          htmlUrl: 'https://github.com/foxbuntu/secret-backend',
          cloneUrl: 'https://github.com/foxbuntu/secret-backend.git',
          defaultBranch: 'main',
          description: 'API privada y microservicios',
          updatedAt: new Date(Date.now() - 86400000).toISOString(),
          stargazersCount: 5,
        },
      ];
    }
    if (cmd === 'github_logout') {
      return null;
    }
    return null;
  });

  useStore.setState({
    repoId: 'preview',
    panel: 'remotes',
    remotes: [
      {
        name: 'origin',
        url: 'https://github.com/foxen/foxen.git',
        host: 'github.com',
        pushUrl: null,
        fetchRefspecs: [],
        pushRefspecs: [],
        reachable: true,
      },
      {
        name: 'upstream',
        url: 'git@github.com:foxen/foxen.git',
        host: 'github.com',
        pushUrl: null,
        fetchRefspecs: [],
        pushRefspecs: [],
        reachable: true,
      },
    ],
  });

  createRoot(document.getElementById('root')!).render(
    <div className="app">
      {/* Rejilla real: sidebar + grafo (el detalle va en un popup). */}
      <div className="layout">
        <aside className="sidebar">
          <PanelTabs />
          <div className="sidebar-content">
            <RemotesPanel />
          </div>
        </aside>
        <main className="main" />
      </div>
    </div>,
  );
}

if (params.get('panel') === 'remotes') {
  renderRemotesPreview();
} else {
  createRoot(document.getElementById('root')!).render(
    <div className="app">
      {/* Sin asides laterales: la rejilla real es de dos columnas. */}
      <div className="layout" style={{ gridTemplateColumns: '1fr' }}>
        <main className="main" style={{ height: '100vh' }}>
          <CommitGraphView
            nodes={nodes}
            edges={edges}
            laneCount={4}
            truncated={false}
            totalReachable={128}
          />
        </main>
      </div>
      {withSettings && <SettingsPanel />}
    </div>,
  );
}
