/** Contenido bilingue del manual integrado de Foxen. */

import type { Locale } from './i18n';

export interface Bilingual {
  es: string;
  en: string;
}

export type HelpBlock =
  | { type: 'p'; text: Bilingual }
  | { type: 'steps'; items: Bilingual[] }
  | { type: 'list'; items: Bilingual[] }
  | { type: 'keys'; items: { keys: string; text: Bilingual }[] }
  | { type: 'tip'; text: Bilingual };

export interface HelpSection {
  id: string;
  title: Bilingual;
  summary: Bilingual;
  blocks: HelpBlock[];
}

export const HELP_SECTIONS: HelpSection[] = [
  {
    id: 'intro',
    title: { es: 'Primeros pasos', en: 'Getting started' },
    summary: {
      es: 'Abre un repositorio y conoce las zonas de la ventana.',
      en: 'Open a repository and learn the areas of the window.',
    },
    blocks: [
      {
        type: 'p',
        text: {
          es: 'Foxen es un cliente de Git para escritorio. Trabaja directamente sobre tus repositorios locales y solo usa la red cuando consultas o sincronizas un remoto.',
          en: 'Foxen is a desktop Git client. It works directly on your local repositories and only uses the network when you query or sync a remote.',
        },
      },
      {
        type: 'steps',
        items: [
          {
            es: 'Abre una carpeta con un repositorio desde **Foxen ▾ → Abrir repositorio…**, o usa el botón de la pantalla de bienvenida.',
            en: 'Open a folder containing a repository from **Foxen ▾ → Open repository…**, or use the button on the welcome screen.',
          },
          {
            es: 'El grafo central muestra el historial. Haz clic en un commit para seleccionarlo y en **Ver detalle** para inspeccionarlo.',
            en: 'The central graph shows the history. Click a commit to select it and **View details** to inspect it.',
          },
          {
            es: 'El panel lateral agrupa **Cambios, Ramas, Stashes, Remotos, Flow y Reflog**. Cambia con el rail de iconos.',
            en: 'The side panel groups **Changes, Branches, Stashes, Remotes, Flow and Reflog**. Switch with the icon rail.',
          },
          {
            es: 'Pulsa **F1** o **?** para abrir este manual en cualquier momento.',
            en: 'Press **F1** or **?** to open this manual at any time.',
          },
        ],
      },
      {
        type: 'tip',
        text: {
          es: 'Foxen reabre los repositorios que dejaste abiertos en la última sesión. Los ajustes y la sesión se guardan en el directorio de configuración del usuario.',
          en: 'Foxen reopens the repositories you left open in the last session. Settings and session are stored in the user configuration directory.',
        },
      },
    ],
  },
  {
    id: 'repos',
    title: { es: 'Abrir, clonar y publicar', en: 'Open, clone and publish' },
    summary: {
      es: 'Repositorios locales, clones de GitHub y publicación de proyectos.',
      en: 'Local repositories, GitHub clones and project publishing.',
    },
    blocks: [
      {
        type: 'steps',
        items: [
          {
            es: 'Usa **Foxen ▾ → Abrir repositorio…** para elegir una carpeta local. Foxen valida que sea un repositorio Git.',
            en: 'Use **Foxen ▾ → Open repository…** to choose a local folder. Foxen validates that it is a Git repository.',
          },
          {
            es: 'Con una cuenta de GitHub conectada, **Clonar desde GitHub…** lista tus repositorios y te permite elegir la carpeta de destino.',
            en: 'With a GitHub account connected, **Clone from GitHub…** lists your repositories and lets you choose the destination folder.',
          },
          {
            es: 'Desde **Foxen ▾ → Publicar en GitHub…** puedes crear un repositorio remoto, configurar `origin` y subir la rama actual.',
            en: 'From **Foxen ▾ → Publish to GitHub…** you can create a remote repository, configure `origin` and push the current branch.',
          },
        ],
      },
      {
        type: 'list',
        items: [
          {
            es: 'La lista **Abiertos recientemente** cambia de repositorio sin volver a elegir la carpeta.',
            en: 'The **Recently opened** list switches repositories without choosing the folder again.',
          },
          {
            es: 'El selector de carpetas usa el portal del sistema; en Flatpak solo se concede acceso a la carpeta elegida.',
            en: 'The folder picker uses the system portal; in Flatpak, access is granted only to the chosen folder.',
          },
          {
            es: 'Puedes tener varios repositorios abiertos y cambiar entre ellos desde el menú Foxen.',
            en: 'You can have several repositories open and switch between them from the Foxen menu.',
          },
        ],
      },
      {
        type: 'tip',
        text: {
          es: 'Cerrar un repositorio en Foxen no borra nada del disco: solo lo quita de la sesión y de la lista reciente.',
          en: 'Closing a repository in Foxen does not delete anything from disk: it only removes it from the session and recent list.',
        },
      },
    ],
  },
  {
    id: 'graph',
    title: { es: 'Grafo e historial', en: 'Graph and history' },
    summary: {
      es: 'Lee el historial, busca commits y abre el detalle.',
      en: 'Read the history, search commits and open details.',
    },
    blocks: [
      {
        type: 'p',
        text: {
          es: 'Cada fila es un commit y cada carril representa una rama. El color del nodo indica el tipo de commit (feature, fix, docs, etc.) y las etiquetas muestran ramas y tags.',
          en: 'Each row is a commit and each lane represents a branch. The node color indicates the commit type (feature, fix, docs, etc.) and labels show branches and tags.',
        },
      },
      {
        type: 'list',
        items: [
          {
            es: 'Haz clic en una fila para seleccionar el commit; pulsa **Ver detalle** para inspeccionarlo.',
            en: 'Click a row to select the commit; press **View details** to inspect it.',
          },
          {
            es: 'El campo **Resaltar commit…** filtra visualmente por mensaje, autor o SHA.',
            en: 'The **Highlight commit…** field filters visually by message, author or SHA.',
          },
          {
            es: 'La cabecera permite arrastrar los anchos de las columnas. El zoom se conserva entre refrescos.',
            en: 'The header lets you drag column widths. Zoom is preserved between refreshes.',
          },
        ],
      },
      {
        type: 'tip',
        text: {
          es: 'El detalle muestra autor, fecha, padres, ramas y archivos. Desde ahí puedes abrir el diff de cada archivo del commit.',
          en: 'Details show author, date, parents, branches and files. From there you can open the diff of each file in the commit.',
        },
      },
    ],
  },
  {
    id: 'changes',
    title: { es: 'Cambios y commits', en: 'Changes and commits' },
    summary: {
      es: 'Prepara archivos, revisa diffs y crea commits.',
      en: 'Stage files, review diffs and create commits.',
    },
    blocks: [
      {
        type: 'steps',
        items: [
          {
            es: 'En **Cambios**, selecciona un archivo para ver su diff. Usa **Preparar** para añadirlo al stage.',
            en: 'In **Changes**, select a file to see its diff. Use **Stage** to add it to the index.',
          },
          {
            es: 'Escribe el mensaje en el cuadro inferior. El botón **Commit** solo incluye lo que está en stage.',
            en: 'Write the message in the box below. The **Commit** button only includes what is staged.',
          },
          {
            es: 'Puedes preparar o quitar del stage todos los archivos con las acciones de la cabecera.',
            en: 'You can stage or unstage all files with the header actions.',
          },
        ],
      },
      {
        type: 'list',
        items: [
          {
            es: '**Descartar** revierte los cambios del árbol de trabajo; no se puede deshacer.',
            en: '**Discard** reverts working tree changes; it cannot be undone.',
          },
          {
            es: '**Guardar en stash** aparta los cambios para recuperarlos después desde el panel Stashes.',
            en: '**Save to stash** sets changes aside so you can restore them later from the Stashes panel.',
          },
          {
            es: 'Los archivos en conflicto se marcan en rojo y ofrecen las versiones **mío**, **suyo** y **base**.',
            en: 'Conflicted files are marked in red and offer the **mine**, **theirs** and **base** versions.',
          },
        ],
      },
      {
        type: 'tip',
        text: {
          es: 'Un commit vacío no está permitido desde la interfaz. Si no hay archivos en stage, el botón permanece desactivado.',
          en: 'An empty commit is not allowed from the interface. If nothing is staged, the button stays disabled.',
        },
      },
    ],
  },
  {
    id: 'branches',
    title: { es: 'Ramas y fusiones', en: 'Branches and merges' },
    summary: {
      es: 'Crea, cambia y fusiona ramas; resuelve conflictos.',
      en: 'Create, switch and merge branches; resolve conflicts.',
    },
    blocks: [
      {
        type: 'steps',
        items: [
          {
            es: 'En **Ramas**, crea una rama nueva desde la actual o cambia a otra con un clic.',
            en: 'In **Branches**, create a new branch from the current one or switch to another with one click.',
          },
          {
            es: 'Pulsa **Fusionar** junto a una rama local para elegir la rama destino. Foxen cambia de rama si es necesario.',
            en: 'Press **Merge** next to a local branch to choose the destination branch. Foxen switches branches if needed.',
          },
          {
            es: 'Si hay conflictos, el banner superior ofrece **Continuar** y **Abortar**. Resuelve primero los archivos en **Cambios**.',
            en: 'If there are conflicts, the top banner offers **Continue** and **Abort**. First resolve the files in **Changes**.',
          },
        ],
      },
      {
        type: 'list',
        items: [
          {
            es: '**Automática**: fast-forward si es posible; merge commit si las ramas divergen.',
            en: '**Automatic**: fast-forward when possible; merge commit if the branches diverged.',
          },
          {
            es: '**Merge commit (--no-ff)**: crea siempre un commit de fusión.',
            en: '**Merge commit (--no-ff)**: always creates a merge commit.',
          },
          {
            es: '**Solo fast-forward (--ff-only)**: falla si las ramas han divergido.',
            en: '**Fast-forward only (--ff-only)**: fails if the branches have diverged.',
          },
          {
            es: '**Squash**: aplica todos los cambios y crea un commit único; el historial de la rama no se fusiona.',
            en: '**Squash**: applies all changes and creates a single commit; the branch history is not merged.',
          },
        ],
      },
      {
        type: 'tip',
        text: {
          es: 'Solo se pueden fusionar ramas locales que no sean la rama actual. Para una rama remota, créala primero en local.',
          en: 'Only local branches other than the current branch can be merged. For a remote branch, create it locally first.',
        },
      },
    ],
  },
  {
    id: 'stashes',
    title: { es: 'Stashes', en: 'Stashes' },
    summary: {
      es: 'Guarda cambios temporalmente y recupéralos después.',
      en: 'Save changes temporarily and restore them later.',
    },
    blocks: [
      {
        type: 'steps',
        items: [
          {
            es: 'Con cambios pendientes, usa **Guardar en stash** y escribe una descripción opcional.',
            en: 'With pending changes, use **Save to stash** and write an optional description.',
          },
          {
            es: 'En el panel **Stashes**, aplica un stash para recuperar los cambios sin eliminarlo.',
            en: 'In the **Stashes** panel, apply a stash to restore the changes without deleting it.',
          },
          {
            es: 'Usa **Aplicar y eliminar** para recuperarlo y borrarlo del listado en un solo paso.',
            en: 'Use **Apply and drop** to restore it and remove it from the list in one step.',
          },
        ],
      },
      {
        type: 'tip',
        text: {
          es: 'Los stashes viven en el repositorio local; no se suben al remoto y no afectan a otras personas.',
          en: 'Stashes live in the local repository; they are not pushed to the remote and do not affect other people.',
        },
      },
    ],
  },
  {
    id: 'remotes',
    title: { es: 'Remotos y sincronización', en: 'Remotes and sync' },
    summary: {
      es: 'Fetch, pull, push y credenciales HTTPS/SSH.',
      en: 'Fetch, pull, push and HTTPS/SSH credentials.',
    },
    blocks: [
      {
        type: 'steps',
        items: [
          {
            es: 'Añade un remoto con nombre y URL desde el panel **Remotos**, o publica el repositorio en GitHub.',
            en: 'Add a remote with a name and URL from the **Remotes** panel, or publish the repository to GitHub.',
          },
          {
            es: '**Fetch** consulta los cambios sin modificar tu rama. **Pull** los descarga y los integra en la rama actual.',
            en: '**Fetch** checks for changes without modifying your branch. **Pull** downloads and integrates them into the current branch.',
          },
          {
            es: '**Push** sube la rama actual. Si no tiene upstream, Foxen lo configura en el primer envío.',
            en: '**Push** uploads the current branch. If it has no upstream, Foxen configures it on the first push.',
          },
        ],
      },
      {
        type: 'list',
        items: [
          {
            es: 'Los remotos HTTPS pueden usar usuario y token guardados en el llavero del sistema.',
            en: 'HTTPS remotes can use a username and token stored in the system keyring.',
          },
          {
            es: 'Los remotos SSH (`git@…`) usan `ssh-agent` y tus claves; no necesitan contraseña en Foxen.',
            en: 'SSH remotes (`git@…`) use `ssh-agent` and your keys; they do not need a password in Foxen.',
          },
          {
            es: 'El panel **Reflog** permite recuperar commits que ya no apuntan desde una rama.',
            en: 'The **Reflog** panel lets you recover commits no longer pointed to by a branch.',
          },
        ],
      },
      {
        type: 'tip',
        text: {
          es: 'Si un push es rechazado por cambios remotos, haz primero **Pull** y resuelve los posibles conflictos.',
          en: 'If a push is rejected because of remote changes, do a **Pull** first and resolve any conflicts.',
        },
      },
    ],
  },
  {
    id: 'flow',
    title: { es: 'Git Flow', en: 'Git Flow' },
    summary: {
      es: 'Flujo con develop, main, features, releases y hotfixes.',
      en: 'Workflow with develop, main, features, releases and hotfixes.',
    },
    blocks: [
      {
        type: 'p',
        text: {
          es: 'El panel **Flow** implementa las ramas de Git Flow. Antes de usarlo, inicializa el flujo indicando las ramas base y los prefijos.',
          en: 'The **Flow** panel implements Git Flow branches. Before using it, initialize the workflow with the base branches and prefixes.',
        },
      },
      {
        type: 'steps',
        items: [
          {
            es: 'Inicializa Git Flow con las ramas `develop` y `main` (o las que uses).',
            en: 'Initialize Git Flow with the `develop` and `main` branches (or the ones you use).',
          },
          {
            es: 'Inicia una feature, release o hotfix desde su acción correspondiente. Foxen crea y cambia a la rama.',
            en: 'Start a feature, release or hotfix from its action. Foxen creates and switches to the branch.',
          },
          {
            es: 'Al finalizar, Foxen integra la rama en las ramas configuradas y puede crear la etiqueta de versión.',
            en: 'When finishing, Foxen integrates the branch into the configured branches and can create the version tag.',
          },
        ],
      },
      {
        type: 'tip',
        text: {
          es: 'Finalizar una rama requiere el árbol de trabajo limpio. Commitea o guarda los cambios en stash antes de continuar.',
          en: 'Finishing a branch requires a clean working tree. Commit or stash changes before continuing.',
        },
      },
    ],
  },
  {
    id: 'terminal',
    title: { es: 'Terminal y reflog', en: 'Terminal and reflog' },
    summary: {
      es: 'Una shell en el repositorio y el historial de referencias.',
      en: 'A shell inside the repository and the reference history.',
    },
    blocks: [
      {
        type: 'list',
        items: [
          {
            es: 'El botón **Terminal** abre una terminal integrada en la raíz del repositorio abierto.',
            en: 'The **Terminal** button opens an integrated terminal at the root of the open repository.',
          },
          {
            es: 'La terminal es útil para comandos que aún no tienen interfaz; los cambios se reflejan en Foxen automáticamente.',
            en: 'The terminal is useful for commands that do not have a UI yet; changes are reflected in Foxen automatically.',
          },
          {
            es: '**Reflog** muestra los movimientos de las referencias. Selecciona una entrada para inspeccionarla o volver a ese commit.',
            en: '**Reflog** shows reference movements. Select an entry to inspect it or return to that commit.',
          },
        ],
      },
      {
        type: 'tip',
        text: {
          es: 'Los comandos destructivos de la terminal no se pueden deshacer desde Foxen. Revisa siempre el comando antes de ejecutarlo.',
          en: 'Destructive terminal commands cannot be undone from Foxen. Always review the command before running it.',
        },
      },
    ],
  },
  {
    id: 'settings',
    title: { es: 'Ajustes, tema e idioma', en: 'Settings, theme and language' },
    summary: {
      es: 'Personaliza la apariencia, el idioma y las cuentas.',
      en: 'Customize appearance, language and accounts.',
    },
    blocks: [
      {
        type: 'list',
        items: [
          {
            es: '**Tema**: elige claro, oscuro o seguir al sistema. El cambio es inmediato.',
            en: '**Theme**: choose light, dark or follow system. The change is immediate.',
          },
          {
            es: '**Idioma**: cambia entre español e inglés. La interfaz se actualiza al instante.',
            en: '**Language**: switch between Spanish and English. The interface updates immediately.',
          },
          {
            es: '**Cuenta de GitHub**: conecta o cierra la sesión y consulta tus repositorios.',
            en: '**GitHub account**: connect or sign out and browse your repositories.',
          },
          {
            es: '**Credenciales**: guarda usuario y token para remotos HTTPS de GitHub en el llavero del sistema.',
            en: '**Credentials**: store a username and token for GitHub HTTPS remotes in the system keyring.',
          },
        ],
      },
      {
        type: 'tip',
        text: {
          es: 'Los ajustes se guardan en `settings.json` dentro del directorio de configuración. La caché local solo acelera el primer pintado.',
          en: 'Settings are stored in `settings.json` inside the configuration directory. The local cache only speeds up the first paint.',
        },
      },
    ],
  },
  {
    id: 'shortcuts',
    title: { es: 'Atajos de teclado', en: 'Keyboard shortcuts' },
    summary: {
      es: 'Las combinaciones más útiles.',
      en: 'The most useful key combinations.',
    },
    blocks: [
      {
        type: 'keys',
        items: [
          { keys: 'F1 / ?', text: { es: 'Abrir o cerrar este manual.', en: 'Open or close this manual.' } },
          {
            keys: 'F5 / Ctrl+R',
            text: { es: 'Refrescar el repositorio abierto.', en: 'Refresh the open repository.' },
          },
          { keys: 'Esc', text: { es: 'Cerrar el diálogo activo.', en: 'Close the active dialog.' } },
          {
            keys: 'Ctrl+C',
            text: { es: 'Copiar el texto seleccionado; el SHA se copia con un clic en el detalle.', en: 'Copy the selected text; the SHA is copied by clicking it in the details.' },
          },
        ],
      },
      {
        type: 'tip',
        text: {
          es: 'Los atajos con `?` no se activan mientras escribes en un campo de texto.',
          en: 'Shortcuts involving `?` do not trigger while you are typing in a text field.',
        },
      },
    ],
  },
  {
    id: 'troubleshooting',
    title: { es: 'Solución de problemas', en: 'Troubleshooting' },
    summary: {
      es: 'Errores habituales y cómo resolverlos.',
      en: 'Common errors and how to resolve them.',
    },
    blocks: [
      {
        type: 'list',
        items: [
          {
            es: '**No puedo hacer push**: el remoto tiene commits nuevos. Haz **Pull**, resuelve conflictos y vuelve a intentarlo.',
            en: '**I cannot push**: the remote has new commits. Do a **Pull**, resolve conflicts and try again.',
          },
          {
            es: '**Conflicto de fusión**: resuelve cada archivo en **Cambios** y pulsa **Continuar** en el banner; o **Abortar** para volver atrás.',
            en: '**Merge conflict**: resolve each file in **Changes** and press **Continue** in the banner; or **Abort** to go back.',
          },
          {
            es: '**Error de autenticación**: revisa el token de GitHub en **Credenciales**; para SSH, comprueba que la clave está en `ssh-agent`.',
            en: '**Authentication error**: check the GitHub token in **Credentials**; for SSH, make sure the key is loaded in `ssh-agent`.',
          },
          {
            es: '**No aparece un repositorio**: confirma que la carpeta contiene `.git` y que tienes permisos de lectura.',
            en: '**A repository is missing**: confirm the folder contains `.git` and that you have read permission.',
          },
          {
            es: '**La app no responde tras una operación**: espera a que termine el refresco; si persiste, abre el panel Reflog y revisa el último estado.',
            en: '**The app does not respond after an operation**: wait for the refresh to finish; if it persists, open the Reflog panel and check the latest state.',
          },
        ],
      },
      {
        type: 'tip',
        text: {
          es: 'Puedes inspeccionar el estado real del repositorio y ejecutar comandos desde la terminal integrada.',
          en: 'You can inspect the real repository state and run commands from the integrated terminal.',
        },
      },
    ],
  },
];

/** Texto bilingue segun el idioma activo. */
export function helpText(value: Bilingual, locale: Locale): string {
  return locale === 'en' ? value.en : value.es;
}

/** Texto plano de una seccion, para el buscador. */
export function helpSearchText(section: HelpSection): string {
  const parts = [section.title.es, section.title.en, section.summary.es, section.summary.en];
  for (const block of section.blocks) {
    if (block.type === 'p' || block.type === 'tip') {
      parts.push(block.text.es, block.text.en);
    } else if (block.type === 'keys') {
      for (const item of block.items) parts.push(item.keys, item.text.es, item.text.en);
    } else {
      for (const item of block.items) parts.push(item.es, item.en);
    }
  }
  return parts.join(' ').toLowerCase();
}
