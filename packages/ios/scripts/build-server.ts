/**
 * Builds the Swift engine server, a UI test bundle and its host app, for
 * the iOS simulator with `xcodebuild build-for-testing`. Output:
 * build/DerivedData/Build/Products/*.xctestrun, which the transport runs.
 */

import { execFileSync } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
execFileSync(
  'xcodebuild',
  [
    'build-for-testing',
    '-project', path.join(root, 'server', 'E2EServer.xcodeproj'),
    '-scheme', 'E2EServer',
    '-configuration', 'Release',
    '-destination', 'generic/platform=iOS Simulator',
    '-derivedDataPath', path.join(root, 'build', 'DerivedData'),
  ],
  { stdio: 'inherit' },
);
