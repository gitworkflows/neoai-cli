import { buildProjectGraphAndSourceMapsWithoutDaemon } from '../src/project-graph/project-graph';
import { workspaceRoot } from '../src/utils/workspace-root';
import { fileExists } from '../src/utils/fileutils';
import { join } from 'path';
import { daemonClient } from '../src/daemon/client/client';
import { assertSupportedPlatform } from '../src/native/assert-supported-platform';
import { verifyOrUpdateNeoaiCloudClient } from '../src/neoai-cloud/update-manager';
import { getCloudOptions } from '../src/neoai-cloud/utilities/get-cloud-options';
import { isNeoaiCloudUsed } from '../src/utils/neoai-cloud-utils';
import { readNeoaiJson } from '../src/config/neoai-json';
import { logger } from '../src/utils/logger';
import { setupWorkspaceContext } from '../src/utils/workspace-context';

// The post install is not critical, to avoid any chance that it may hang
// we will kill this process after 30 seconds.
const postinstallTimeout = setTimeout(() => {
  logger.verbose('Neoai post-install timed out.');
  process.exit(0);
}, 30_000);

(async () => {
  const start = new Date();
  try {
    if (isMainNeoaiPackage() && fileExists(join(workspaceRoot, 'neoai.json'))) {
      assertSupportedPlatform();

      if (isNeoaiCloudUsed(readNeoaiJson())) {
        await verifyOrUpdateNeoaiCloudClient(getCloudOptions());
      }
    }
  } catch (e) {
    logger.verbose(e);
  } finally {
    const end = new Date();
    logger.verbose(
      `Neoai postinstall steps took ${end.getTime() - start.getTime()}ms`
    );

    clearTimeout(postinstallTimeout);
    process.exit(0);
  }
})();

function isMainNeoaiPackage() {
  const mainNeoaiPath = require.resolve('neoai', {
    paths: [workspaceRoot],
  });
  const thisNeoaiPath = require.resolve('neoai');
  return mainNeoaiPath === thisNeoaiPath;
}

process.on('uncaughtException', (e) => {
  logger.verbose(e);
  process.exit(0);
});

process.on('unhandledRejection', (e) => {
  logger.verbose(e);
  process.exit(0);
});
