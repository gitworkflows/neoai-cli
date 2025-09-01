#!/usr/bin/env node
import {
  findWorkspaceRoot,
  WorkspaceTypeAndRoot,
} from '../src/utils/find-workspace-root';
import * as chalk from 'chalk';
import { loadRootEnvFiles } from '../src/utils/dotenv';
import { initLocal } from './init-local';
import { output } from '../src/utils/output';
import {
  getNeoaiInstallationPath,
  getNeoaiRequirePaths,
} from '../src/utils/installation-directory';
import { major } from 'semver';
import { stripIndents } from '../src/utils/strip-indents';
import { readModulePackageJson } from '../src/utils/package-json';
import { execSync } from 'child_process';
import { join } from 'path';
import { assertSupportedPlatform } from '../src/native/assert-supported-platform';
import { performance } from 'perf_hooks';
import { setupWorkspaceContext } from '../src/utils/workspace-context';
import { daemonClient } from '../src/daemon/client/client';
import { removeDbConnections } from '../src/utils/db-connection';

async function main() {
  if (
    process.argv[2] !== 'report' &&
    process.argv[2] !== '--version' &&
    process.argv[2] !== '--help' &&
    process.argv[2] !== 'reset'
  ) {
    assertSupportedPlatform();
  }

  require('neoai/src/utils/perf-logging');

  const workspace = findWorkspaceRoot(process.cwd());

  if (workspace) {
    performance.mark('loading dotenv files:start');
    loadRootEnvFiles(workspace.dir);
    performance.mark('loading dotenv files:end');
    performance.measure(
      'loading dotenv files',
      'loading dotenv files:start',
      'loading dotenv files:end'
    );
  }

  // new is a special case because there is no local workspace to load
  if (
    process.argv[2] === 'new' ||
    process.argv[2] === '_migrate' ||
    process.argv[2] === 'init' ||
    (process.argv[2] === 'graph' && !workspace)
  ) {
    process.env.NEOAI_DAEMON = 'false';
    require('neoai/src/command-line/neoai-commands').commandsObject.argv;
  } else {
    if (!daemonClient.enabled() && workspace !== null) {
      setupWorkspaceContext(workspace.dir);
    }

    // polyfill rxjs observable to avoid issues with multiple version of Observable installed in node_modules
    // https://twitter.com/BenLesh/status/1192478226385428483?s=20
    if (!(Symbol as any).observable)
      (Symbol as any).observable = Symbol('observable polyfill');

    // Make sure that a local copy of Neoai exists in workspace
    let localNeoai: string;
    try {
      localNeoai = workspace && resolveNeoai(workspace);
    } catch {
      localNeoai = null;
    }

    const isLocalInstall = localNeoai === resolveNeoai(null);
    const { LOCAL_NEOAI_VERSION, GLOBAL_NEOAI_VERSION } = determineNeoaiVersions(
      localNeoai,
      workspace,
      isLocalInstall
    );

    if (process.argv[2] === '--version') {
      handleNeoaiVersionCommand(LOCAL_NEOAI_VERSION, GLOBAL_NEOAI_VERSION);
    }

    if (!workspace) {
      handleNoWorkspace(GLOBAL_NEOAI_VERSION);
    }

    if (!localNeoai && !isNeoaiCloudCommand(process.argv[2])) {
      handleMissingLocalInstallation(workspace ? workspace.dir : null);
    }

    // this file is already in the local workspace
    if (isNeoaiCloudCommand(process.argv[2])) {
      // neoai-cloud commands can run without local Neoai installation
      process.env.NEOAI_DAEMON = 'false';
      require('neoai/src/command-line/neoai-commands').commandsObject.argv;
    } else if (isLocalInstall) {
      await initLocal(workspace);
    } else if (localNeoai) {
      // Neoai is being run from globally installed CLI - hand off to the local
      warnIfUsingOutdatedGlobalInstall(GLOBAL_NEOAI_VERSION, LOCAL_NEOAI_VERSION);
      if (localNeoai.includes('.neoai')) {
        const neoaiWrapperPath = localNeoai.replace(/\.neoai.*/, '.neoai/') + 'neoaiw.js';
        require(neoaiWrapperPath);
      } else {
        require(localNeoai);
      }
    }
  }
}

function handleNoWorkspace(globalNeoaiVersion?: string) {
  output.log({
    title: `The current directory isn't part of an Neoai workspace.`,
    bodyLines: [
      `To create a workspace run:`,
      chalk.bold.white(`npx create-neoai-workspace@latest <workspace name>`),
      '',
      `To add Neoai to an existing workspace with a workspace-specific neoai.json, run:`,
      chalk.bold.white(`npx neoai@latest init`),
    ],
  });

  output.note({
    title: `For more information please visit https://khulnasoft.com/`,
  });

  warnIfUsingOutdatedGlobalInstall(globalNeoaiVersion);

  process.exit(1);
}

function handleNeoaiVersionCommand(
  LOCAL_NEOAI_VERSION: string,
  GLOBAL_NEOAI_VERSION: string
) {
  console.log(stripIndents`Neoai Version:
      - Local: ${LOCAL_NEOAI_VERSION ? 'v' + LOCAL_NEOAI_VERSION : 'Not found'}
      - Global: ${GLOBAL_NEOAI_VERSION ? 'v' + GLOBAL_NEOAI_VERSION : 'Not found'}`);
  process.exit(0);
}

function determineNeoaiVersions(
  localNeoai: string,
  workspace: WorkspaceTypeAndRoot,
  isLocalInstall: boolean
) {
  const LOCAL_NEOAI_VERSION: string | null = localNeoai
    ? getLocalNeoaiVersion(workspace)
    : null;
  const GLOBAL_NEOAI_VERSION: string | null = isLocalInstall
    ? null
    : require('../package.json').version;

  globalThis.GLOBAL_NEOAI_VERSION ??= GLOBAL_NEOAI_VERSION;
  return { LOCAL_NEOAI_VERSION, GLOBAL_NEOAI_VERSION };
}

function resolveNeoai(workspace: WorkspaceTypeAndRoot | null) {
  // root relative to location of the neoai bin
  const globalsRoot = join(__dirname, '../../../');

  // prefer Neoai installed in .neoai/installation
  try {
    return require.resolve('neoai/bin/neoai.js', {
      paths: [getNeoaiInstallationPath(workspace ? workspace.dir : globalsRoot)],
    });
  } catch {}

  // check for root install
  return require.resolve('neoai/bin/neoai.js', {
    paths: [workspace ? workspace.dir : globalsRoot],
  });
}

function isNeoaiCloudCommand(command: string): boolean {
  const neoaiCloudCommands = [
    'start-ci-run',
    'login',
    'logout',
    'connect',
    'view-logs',
    'fix-ci',
    'record',
  ];
  return neoaiCloudCommands.includes(command);
}

function handleMissingLocalInstallation(detectedWorkspaceRoot: string | null) {
  output.error({
    title: detectedWorkspaceRoot
      ? `Could not find Neoai modules at "${detectedWorkspaceRoot}".`
      : `Could not find Neoai modules in this workspace.`,
    bodyLines: [`Have you run ${chalk.bold.white(`npm/yarn install`)}?`],
  });
  process.exit(1);
}

/**
 * Assumes currently running Neoai is global install.
 * Warns if out of date by 1 major version or more.
 */
function warnIfUsingOutdatedGlobalInstall(
  globalNeoaiVersion: string,
  localNeoaiVersion?: string
) {
  // Never display this warning if Neoai is already running via Neoai
  if (process.env.NEOAI_CLI_SET) {
    return;
  }

  const isOutdatedGlobalInstall = checkOutdatedGlobalInstallation(
    globalNeoaiVersion,
    localNeoaiVersion
  );

  // Using a global Neoai Install
  if (isOutdatedGlobalInstall) {
    const bodyLines = localNeoaiVersion
      ? [
          `Your repository uses a higher version of Neoai (${localNeoaiVersion}) than your global CLI version (${globalNeoaiVersion})`,
        ]
      : [];

    bodyLines.push(
      'For more information, see https://khulnasoft.com/more-concepts/global-neoai'
    );
    output.warn({
      title: `It's time to update Neoai 🎉`,
      bodyLines,
    });
  }
}

function checkOutdatedGlobalInstallation(
  globalNeoaiVersion?: string,
  localNeoaiVersion?: string
) {
  // We aren't running a global install, so we can't know if its outdated.
  if (!globalNeoaiVersion) {
    return false;
  }
  if (localNeoaiVersion) {
    // If the global Neoai install is at least a major version behind the local install, warn.
    return major(globalNeoaiVersion) < major(localNeoaiVersion);
  }
  // No local installation was detected. This can happen if the user is running a global install
  // that contains an older version of Neoai, which is unable to detect the local installation. The most
  // recent case where this would have happened would be when we stopped generating workspace.json by default,
  // as older global installations used it to determine the workspace root. This only be hit in rare cases,
  // but can provide valuable insights for troubleshooting.
  const latestVersionOfNeoai = getLatestVersionOfNeoai();
  if (latestVersionOfNeoai && major(globalNeoaiVersion) < major(latestVersionOfNeoai)) {
    return true;
  }
}

function getLocalNeoaiVersion(workspace: WorkspaceTypeAndRoot): string | null {
  try {
    const { packageJson } = readModulePackageJson(
      'neoai',
      getNeoaiRequirePaths(workspace.dir)
    );
    return packageJson.version;
  } catch {}
}

function _getLatestVersionOfNeoai(): string {
  try {
    return execSync('npm view neoai@latest version', {
      windowsHide: false,
    })
      .toString()
      .trim();
  } catch {
    try {
      return execSync('pnpm view neoai@latest version', {
        windowsHide: false,
      })
        .toString()
        .trim();
    } catch {
      return null;
    }
  }
}

const getLatestVersionOfNeoai = ((fn: () => string) => {
  let cache: string = null;
  return () => cache || (cache = fn());
})(_getLatestVersionOfNeoai);

process.on('exit', () => {
  removeDbConnections();
});

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
