/**
 * Builds the on-device engine server APK with the Android SDK's command-line
 * tools alone: javac, jar, d8, aapt2, zipalign, apksigner. No Gradle, so the
 * build takes seconds and needs only an SDK and a JDK.
 *
 * Output: build/e2e-android-server.apk, with `MANIFEST` (src/manifest.ts) as
 * the asset the server answers `initialize` with.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MANIFEST } from '../src/manifest.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const build = path.join(root, 'build');
const output = path.join(build, 'e2e-android-server.apk');

const sdk = process.env['ANDROID_HOME'] ?? process.env['ANDROID_SDK_ROOT'] ?? path.join(homedir(), 'Library', 'Android', 'sdk');
if (!existsSync(sdk)) throw new Error(`Android SDK not found at ${sdk}; set ANDROID_HOME`);

/** The newest entry of an SDK directory whose name parses as a version. */
function newest(directory: string, pattern: RegExp): string {
  const entries = readdirSync(directory).filter((entry) => pattern.test(entry));
  const version = (entry: string): number[] => (entry.match(/\d+/g) ?? []).map(Number);
  entries.sort((a, b) => {
    const [left, right] = [version(a), version(b)];
    for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
      const delta = (left[index] ?? 0) - (right[index] ?? 0);
      if (delta !== 0) return delta;
    }
    return 0;
  });
  const last = entries.at(-1);
  if (last === undefined) throw new Error(`nothing matching ${String(pattern)} in ${directory}`);
  return path.join(directory, last);
}

const tools = newest(path.join(sdk, 'build-tools'), /^\d+\.\d+\.\d+$/);
const androidJar = path.join(newest(path.join(sdk, 'platforms'), /^android-\d+$/), 'android.jar');
const javaHome = process.env['JAVA_HOME'];
const javac = javaHome === undefined ? 'javac' : path.join(javaHome, 'bin', 'javac');
const keytool = javaHome === undefined ? 'keytool' : path.join(javaHome, 'bin', 'keytool');
const jar = javaHome === undefined ? 'jar' : path.join(javaHome, 'bin', 'jar');

/** Runs a tool, failing the build with its output. */
function run(command: string, args: readonly string[]): void {
  execFileSync(command, args, { stdio: 'inherit' });
}

/** Every file under `directory` with `extension`. */
function filesUnder(directory: string, extension: string): string[] {
  return readdirSync(directory, { recursive: true, encoding: 'utf8' })
    .map((entry) => path.join(directory, entry))
    .filter((file) => file.endsWith(extension) && statSync(file).isFile());
}

rmSync(path.join(build, 'classes'), { recursive: true, force: true });
rmSync(path.join(build, 'dex'), { recursive: true, force: true });
rmSync(path.join(build, 'assets'), { recursive: true, force: true });
mkdirSync(path.join(build, 'classes'), { recursive: true });
mkdirSync(path.join(build, 'dex'), { recursive: true });
mkdirSync(path.join(build, 'assets'), { recursive: true });
mkdirSync(path.dirname(output), { recursive: true });

// The platform jar is the boot class path, so a `java.*` API that the JDK
// has and Android does not fails the build instead of the device; the SDK's
// lambda stubs stand in for the JDK classes lambdas compile against.
const bootClassPath = [androidJar, path.join(tools, 'core-lambda-stubs.jar')].join(path.delimiter);
run(javac, ['-source', '8', '-target', '8', '-Xlint:-options', '-encoding', 'UTF-8', '-bootclasspath', bootClassPath, '-classpath', androidJar, '-d', path.join(build, 'classes'), ...filesUnder(path.join(root, 'server', 'java'), '.java')]);
run(path.join(tools, 'd8'), ['--release', '--min-api', '28', '--lib', androidJar, '--output', path.join(build, 'dex'), ...filesUnder(path.join(build, 'classes'), '.class')]);
writeFileSync(path.join(build, 'assets', 'manifest.json'), `${JSON.stringify(MANIFEST, null, 2)}\n`);
const unsigned = path.join(build, 'unsigned.apk');
run(path.join(tools, 'aapt2'), ['link', '--manifest', path.join(root, 'server', 'AndroidManifest.xml'), '-I', androidJar, '-A', path.join(build, 'assets'), '-o', unsigned]);
run(jar, ['--update', '--no-manifest', '--file', unsigned, '-C', path.join(build, 'dex'), 'classes.dex']);
const aligned = path.join(build, 'aligned.apk');
run(path.join(tools, 'zipalign'), ['-f', '4', unsigned, aligned]);
// The Android SDK's debug keystore, created where the SDK would: a key that
// outlives `build/`, so a rebuilt server still updates the installed one.
const keystore = path.join(homedir(), '.android', 'debug.keystore');
if (!existsSync(keystore)) {
  mkdirSync(path.dirname(keystore), { recursive: true });
  run(keytool, ['-genkeypair', '-keystore', keystore, '-storepass', 'android', '-keypass', 'android', '-alias', 'androiddebugkey', '-keyalg', 'RSA', '-keysize', '2048', '-validity', '10000', '-dname', 'CN=Android Debug,O=Android,C=US']);
}
run(path.join(tools, 'apksigner'), ['sign', '--ks', keystore, '--ks-pass', 'pass:android', '--key-pass', 'pass:android', '--out', output, aligned]);
process.stdout.write(`built ${path.relative(process.cwd(), output)}\n`);
