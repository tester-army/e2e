#!/usr/bin/env node
/**
 * `e2e-ios-build`: builds the Swift engine server into the build cache, as
 * the engine does on first use, and prints its `.xctestrun` path. Run it
 * before a CI job's tests so the first test does not wait for Xcode.
 */

import { buildServer } from './build.ts';

console.log(await buildServer({ log: (line) => console.error(line) }));
