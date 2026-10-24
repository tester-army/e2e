import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { parseSync } from 'oxc-parser';
import { z } from 'zod';
import { connectedFixtures, type ConnectedFixture } from './connected-fixtures.ts';
import { bundle, command, copy, encode, freeze, hash, json, repo, tree } from './files.ts';

const text = z.string().min(1);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const opaque = z.string().regex(/^[a-f0-9]{24}$/);
const count = z.number().int().nonnegative().safe();
const positive = z.number().int().positive().safe();
const finite = z.number().finite().nonnegative();
const fixtureIds = ['addresses', 'promotions', 'expenses', 'catalog', 'orders', 'wishlist'] as const;
const phaseSchema = z.enum(['calibration', 'baseline']);
const budgetSchema = z.object({ maxTurns: positive, maxTokens: positive, wallTimeSeconds: positive }).strict();
const usageSchema = z.object({ turns: count.nullable(), tokens: count.nullable(), wallTimeSeconds: finite.nullable() }).strict();
const authorSchema = z.object({ model: text, effort: text, settings: z.record(z.string(), z.json()), tools: z.array(text).min(1), unsupportedSamplingControls: z.array(text), isolation: z.literal('externally-enforced') }).strict();
const operatorSchema = z.object({ name: text, version: text, sourceHash: digest }).strict();
const settingsSchema = z.object({ schemaVersion: z.literal(1), purpose: z.literal('connected-baseline-feasibility'), allocationSeed: z.number().int().min(1).max(0xffffffff), author: authorSchema, operator: operatorSchema, calibrationRule: text }).strict();
const hashes = z.record(z.string(), digest);
const nonemptyHashes = hashes.refine(value => Object.keys(value).length > 0, 'Evidence must not be empty');
const sourceSchema = z.object({ repository: text, revision: z.string().regex(/^[a-f0-9]{40,64}$/), cleanWorktree: z.boolean(), contentHash: digest, lockHash: digest, node: text, chromium: text }).strict();
const slotSchema = z.object({ id: opaque, fixture: z.enum(fixtureIds), order: count }).strict();
const projectSchema = z.object({ schemaVersion: z.literal(1), kind: z.literal('connected-public-project'), id: opaque, phase: phaseSchema, project: text, projectHash: digest, protectedFiles: nonemptyHashes, runtimeHash: digest, settingsHash: digest, sourceHash: digest }).strict();
const bankSchema = z.object({ version: z.literal(3), study: z.literal('connected-baseline-feasibility'), comparisonAuthorized: z.literal(false), settingsHash: digest, corpusHash: digest, calibrationRuleHash: digest, runtimeHash: digest, controlsHash: digest, lowerHash: digest, source: sourceSchema, operator: operatorSchema, calibration: z.array(slotSchema).length(6), prospectiveBaseline: z.array(slotSchema).length(12), projects: z.record(opaque, text), repeats: z.literal(2), authorConcurrency: z.literal(1), controlLaunches: z.literal(108) }).strict();
const cleanupSchema = z.object({ natural: z.enum(['passed', 'failed', 'unknown']), finalizer: z.enum(['passed', 'failed', 'not-run']), evidence: nonemptyHashes }).strict();
const admissionSchema = z.object({ schemaVersion: z.literal(1), kind: z.literal('connected-operator-admission'), bankHash: digest, operatorHash: digest, sourceHash: digest, runtimeHash: digest, projectManifestHash: digest, status: z.literal('pass'), checks: z.object({ nativeMcp: z.literal(true), attachedShell: z.literal('pending-calibration'), privateReadDenied: z.literal(true), outsideWriteDenied: z.literal(true), wanDenied: z.literal(true), ptyAndTemp: z.literal(true), receiptFailureRetained: z.literal(true), copyIsolation: z.literal(true), diskCapacity: z.literal(true) }).strict(), evidence: nonemptyHashes, evidenceHash: digest, cleanup: cleanupSchema }).strict();
const workflowSchema = z.object({ schemaVersion: z.literal(1), kind: z.literal('connected-attached-workflow-proof'), bankHash: digest, admissionHash: digest, operatorHash: digest, sourceHash: digest, runtimeHash: digest, calibrationId: opaque, terminalHash: digest, attachedShell: z.literal(true), evidence: nonemptyHashes, evidenceHash: digest }).strict();
const provenanceFields = { phase: phaseSchema, id: opaque, bankHash: digest, planHash: digest.nullable(), settingsHash: digest, projectManifestHash: digest, operatorHash: digest, admissionHash: digest, sourceHash: digest, runtimeHash: digest };
const startedSchema = z.object({ schemaVersion: z.literal(1), kind: z.literal('connected-attempt-started'), ...provenanceFields, budget: budgetSchema, author: authorSchema, startedAt: z.iso.datetime() }).strict();
const terminalSchema = z.object({ schemaVersion: z.literal(1), kind: z.literal('connected-attempt-terminal'), ...provenanceFields, startedHash: digest, threadId: text.nullable(), sessionId: text.nullable(), model: text, effort: text, status: z.enum(['completed', 'cutoff', 'missing-output', 'invalid-output', 'launch-failed', 'export-failed', 'receipt-failed', 'cleanup-failed', 'resource-failed']), stopReason: z.enum(['completed', 'budget-cutoff', 'wall-time-cutoff', 'model-error', 'tool-error', 'missing-output', 'invalid-output', 'launch-error', 'export-error', 'receipt-error', 'cleanup-error', 'resource-error']), failure: text.nullable(), startedAt: z.iso.datetime(), finishedAt: z.iso.datetime(), usage: usageSchema, usageComplete: z.boolean(), maxResponseTokens: count.nullable(), rawReportedUsage: z.json(), responses: z.array(z.object({ responseId: text, totalTokens: count.nullable() }).strict()), rawEvents: hashes, outputs: hashes, protectedInputs: z.object({ beforeHash: digest, afterHash: digest.nullable(), unchanged: z.boolean() }).strict(), export: z.object({ path: text, testHash: digest, filesHash: digest }).strict().nullable(), cleanup: cleanupSchema }).strict();
const executedSchema = z.object({ kind: z.enum(['passed', 'failed']), evidence: text, evidenceHash: digest, report: text, selected: positive, selectionHash: digest }).strict();
const executionSchema = z.union([executedSchema, z.object({ kind: z.literal('unusable'), reason: text, evidence: text, evidenceHash: digest }).strict(), z.object({ kind: z.literal('not-executed'), reason: text }).strict()]);
const repeatsSchema = z.tuple([executionSchema, executionSchema]);
const calibrationSchema = z.object({ version: z.literal(3), kind: z.literal('connected-calibration-result'), id: opaque, bankHash: digest, terminalHash: digest, submissionHash: digest.nullable(), testHash: digest.nullable(), usage: usageSchema, maxResponseTokens: count.nullable(), correct: repeatsSchema, valid: z.boolean() }).strict();
const calibrationSourceSchema = z.object({ id: opaque, terminalHash: digest, resultHash: digest, tokens: count, maxResponseTokens: count, turns: positive, wallTimeSeconds: finite }).strict();
const planSchema = z.object({ version: z.literal(3), study: z.literal('connected-baseline-feasibility'), comparisonAuthorized: z.literal(false), bankHash: digest, admissionHash: digest, workflowProofHash: digest, settingsHash: digest, calibrationRuleHash: digest, calibration: z.array(calibrationSourceSchema).length(6), budget: budgetSchema, runs: z.array(slotSchema).length(12), authorConcurrency: z.literal(1) }).strict();
const packetRefSchema = z.object({ packetId: opaque, evidenceHash: digest }).strict();
const gradeSchema = z.object({ version: z.literal(3), kind: z.literal('connected-baseline-grade'), id: opaque, bankHash: digest, planHash: digest, terminalHash: digest.nullable(), submissionHash: digest.nullable(), testHash: digest.nullable(), admission: z.enum(['admitted', 'cutoff', 'rejected', 'missing', 'usage-unknown', 'budget-exceeded']), reason: text.nullable(), correct: repeatsSchema, members: z.tuple([z.object({ id: text, changed: repeatsSchema, packet: packetRefSchema.nullable() }).strict(), z.object({ id: text, changed: repeatsSchema, packet: packetRefSchema.nullable() }).strict()]) }).strict();
const humanSchema = z.object({ version: z.literal(1), kind: z.literal('human'), packetId: opaque, evidenceHash: digest, reviewer: text, verdict: z.enum(['intended-bug', 'unrelated-failure', 'qualifying-miss', 'nonqualifying-miss', 'uncertain']), reason: text }).strict();
const aiSchema = z.object({ version: z.literal(1), kind: z.literal('exploratory-ai'), packetId: opaque, evidenceHash: digest, model: text, verdict: text, reason: text }).strict();
const variantSchema = z.object({ id: text, mutationFile: text, mutation: z.tuple([text, z.string()]), ruleIds: z.array(text).min(1), weight: z.literal(1), expected: text }).strict();
const fixtureSchema = z.object({ id: z.enum(fixtureIds), name: z.string().regex(/^[a-z][a-z0-9-]*$/), classification: z.enum(['informative', 'safeguard']), files: z.record(z.string(), z.string()), lowerTests: z.array(text).min(1), lowerCount: positive, variants: z.tuple([variantSchema, variantSchema]), controls: z.object({ strong: text, weak: text, wrong: text, unrelated: text }).strict() }).strict();
type Bank = z.infer<typeof bankSchema>;
type Slot = z.infer<typeof slotSchema>;
type Plan = z.infer<typeof planSchema>;
type Terminal = z.infer<typeof terminalSchema>;
type Execution = z.infer<typeof executionSchema>;
type Repeats = z.infer<typeof repeatsSchema>;
type Grade = z.infer<typeof gradeSchema>;
type Calibration = z.infer<typeof calibrationSchema>;
type Budget = z.infer<typeof budgetSchema>;
type Human = z.infer<typeof humanSchema>;
const calibrationCeiling: Budget = { maxTurns: 64, maxTokens: 2000000, wallTimeSeconds: 1200 };
const controlSchema = z.object({ fixture: z.enum(fixtureIds), control: z.enum(['strong', 'weak', 'wrong', 'unrelated', 'startup']), target: text, repeat: z.union([z.literal(1), z.literal(2)]), execution: executionSchema, expected: text, valid: z.boolean() }).strict();
const lowerSchema = z.object({ fixture: z.enum(fixtureIds), target: text, repeat: z.union([z.literal(1), z.literal(2)]), files: z.array(text).min(1), count: positive, evidence: text, evidenceHash: digest, valid: z.boolean() }).strict();
const processIdentitySchema = z.object({ pid: positive, ppid: count, start: text, state: text }).strict();
type ProcessIdentity = z.infer<typeof processIdentitySchema>;
const listeningPortSchema = z.object({ pid: positive, start: text, address: text }).strict();
const processReceiptSchema = z.object({ version: z.literal(1), kind: z.literal('connected-cli-process'), pid: positive.nullable(), exitCode: z.number().int().nullable(), signal: text.nullable(), error: text.nullable(), timedOut: z.boolean(), deadlineMs: positive, owned: z.array(processIdentitySchema), cleanup: z.object({ natural: z.enum(['passed', 'failed', 'unknown']), finalizer: z.enum(['passed', 'failed']), remaining: z.array(processIdentitySchema), signals: z.array(z.object({ pid: positive, start: text, signal: text, result: text }).strict()), portsObserved: z.array(listeningPortSchema), portsRemaining: z.array(listeningPortSchema), errors: z.array(text) }).strict() }).strict();

/** Reads only process identity metadata and fails before launch if it cannot be established. */
function processInventory(): ProcessIdentity[] {
  const result = process.platform === 'win32'
    ? spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -gt 0 -and $_.CreationDate } | ForEach-Object { [pscustomobject]@{pid=[int]$_.ProcessId;ppid=[int]$_.ParentProcessId;start=$_.CreationDate.ToFileTimeUtc().ToString();state='live'} } | ConvertTo-Json -Compress"], { encoding: 'utf8', timeout: 10000, maxBuffer: 4 * 1024 * 1024 })
    : spawnSync('ps', ['-axo', 'pid=,ppid=,stat=,lstart='], { encoding: 'utf8', timeout: 10000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } });
  if (result.error || result.status !== 0) throw new Error(`Process identity census failed: ${result.error?.message ?? result.stderr}`);
  if (process.platform === 'win32') {
    const value: unknown = JSON.parse(result.stdout);
    return z.array(processIdentitySchema).parse(Array.isArray(value) ? value : [value]);
  }
  return result.stdout.split('\n').filter(line => line.trim()).map(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
    if (!match) throw new Error('Malformed process identity census');
    return processIdentitySchema.parse({ pid: Number(match[1]), ppid: Number(match[2]), state: match[3], start: match[4] });
  });
}

/** Records listening endpoints only for start-verified owned processes. */
function listeningPorts(identities: ProcessIdentity[]): z.infer<typeof listeningPortSchema>[] {
  const owners = new Map(identities.map(identity => [identity.pid, identity]));
  if (!owners.size) return [];
  const result = process.platform === 'win32'
    ? spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$ownerIds=@(${[...owners.keys()].join(',')}); Get-NetTCPConnection -State Listen | Where-Object { $ownerIds -contains $_.OwningProcess } | ForEach-Object { [pscustomobject]@{pid=[int]$_.OwningProcess;address=($_.LocalAddress+':'+$_.LocalPort)} } | ConvertTo-Json -Compress`], { encoding: 'utf8', timeout: 10000 })
    : spawnSync('lsof', ['-nP', '-a', '-p', [...owners.keys()].join(','), '-iTCP', '-sTCP:LISTEN', '-Fpn'], { encoding: 'utf8', timeout: 10000 });
  if (result.error || result.stderr.trim() || (result.status !== 0 && !(process.platform !== 'win32' && result.status === 1))) throw new Error(`Owned port census failed (exit ${result.status}): ${result.error?.message ?? result.stderr}`);
  const ports: { pid: number; address: string }[] = [];
  if (process.platform === 'win32' && result.stdout.trim()) {
    const value: unknown = JSON.parse(result.stdout);
    ports.push(...z.array(z.object({ pid: positive, address: text }).strict()).parse(Array.isArray(value) ? value : [value]));
  } else {
    let pid = 0;
    let descriptor = false;
    for (const line of result.stdout.split('\n').filter(Boolean)) {
      if (/^p\d+$/.test(line)) {
        pid = Number(line.slice(1));
        descriptor = false;
        if (!owners.has(pid)) throw new Error('Port census included an unowned process');
      } else if (/^f\d+$/.test(line) && owners.has(pid)) descriptor = true;
      else if (/^n\S+:\d+$/.test(line) && descriptor && Number(line.slice(line.lastIndexOf(':') + 1)) <= 65535) ports.push({ pid, address: line.slice(1) });
      else throw new Error('Malformed owned port census');
    }
  }
  const current = new Map(processInventory().map(identity => [identity.pid, identity]));
  return ports.flatMap(port => owners.has(port.pid) && current.get(port.pid)?.start === owners.get(port.pid)!.start ? [{ ...port, start: owners.get(port.pid)!.start }] : []);
}

/** Supervises one real copied CLI and finalizes only its observed PID/start identities. */
export async function superviseConnectedCell(project: string, deadlineMs = 240000): Promise<z.infer<typeof processReceiptSchema>> {
  project = realpathSync(project);
  positive.max(240000).parse(deadlineMs);
  const owned = new Map<number, ProcessIdentity>();
  const ports = new Map<string, z.infer<typeof listeningPortSchema>>();
  const signals: z.infer<typeof processReceiptSchema>['cleanup']['signals'] = [];
  const errors: string[] = [];
  const descriptors: number[] = [];
  let pid: number | null = null;
  let exitCode: number | null = null;
  let exitSignal: string | null = null;
  let failure: string | null = null;
  let timedOut = false;
  let interrupted = false;
  let natural: 'passed' | 'failed' | 'unknown' = 'unknown';
  let remaining: ProcessIdentity[] = [];
  let poll: ReturnType<typeof setInterval> | null = null;
  const alive = (inventory: ProcessIdentity[]): ProcessIdentity[] => inventory.filter(identity => owned.get(identity.pid)?.start === identity.start && !identity.state.startsWith('Z'));
  const capture = (): ProcessIdentity[] => {
    const inventory = processInventory();
    const known = new Set(alive(inventory).map(identity => identity.pid));
    if (pid !== null && inventory.some(identity => identity.pid === pid && identity.ppid === process.pid)) known.add(pid);
    let changed = true;
    while (changed) {
      changed = false;
      for (const identity of inventory) if ((known.has(identity.pid) || known.has(identity.ppid)) && !known.has(identity.pid)) { known.add(identity.pid); changed = true; }
    }
    for (const identity of inventory) if (known.has(identity.pid)) {
      const previous = owned.get(identity.pid);
      if (!previous || previous.start === identity.start) owned.set(identity.pid, identity);
    }
    return alive(inventory);
  };
  const signalOwned = (identity: ProcessIdentity, signal: NodeJS.Signals): void => {
    try {
      const current = processInventory().find(item => item.pid === identity.pid);
      if (!current || current.state.startsWith('Z')) { signals.push({ pid: identity.pid, start: identity.start, signal, result: 'already-exited' }); return; }
      if (current.start !== identity.start) { signals.push({ pid: identity.pid, start: identity.start, signal, result: 'identity-changed-not-signaled' }); return; }
      process.kill(identity.pid, signal);
      signals.push({ pid: identity.pid, start: identity.start, signal, result: 'sent' });
    } catch (error) { errors.push(`Signal ${signal} failed for owned PID ${identity.pid}: ${error instanceof Error ? error.message : error}`); }
  };
  const stop = (): void => { interrupted = true; const root = pid === null ? undefined : owned.get(pid); if (root) signalOwned(root, 'SIGINT'); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  try {
    processInventory();
    mkdirSync(join(project, '.home'), { recursive: true });
    descriptors.push(openSync(join(project, 'stdout.txt'), 'wx'));
    descriptors.push(openSync(join(project, 'stderr.txt'), 'wx'));
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: join(project, '.home'), TMPDIR: process.env.TMPDIR, SystemRoot: process.env.SystemRoot, CI: '1', E2E_TELEMETRY_DISABLED: '1', DO_NOT_TRACK: '1', PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH ?? join(homedir(), process.platform === 'darwin' ? 'Library/Caches/ms-playwright' : process.platform === 'win32' ? 'AppData/Local/ms-playwright' : '.cache/ms-playwright') };
    const child = spawn(process.execPath, ['node_modules/e2e/dist/cli/bin.js', 'run', '--workers', '1', '--retries', '0', '--no-cache', '--max-duration', '180000', '--output', '.e2e', '--reporter', 'json'], { cwd: project, env, stdio: ['ignore', descriptors[0]!, descriptors[1]!] });
    pid = child.pid ?? null;
    let exited = false;
    const closed = new Promise<void>(resolveClosed => {
      child.once('error', error => { failure = error.message; exited = true; resolveClosed(); });
      child.once('close', (code, signal) => { exitCode = code; exitSignal = signal; exited = true; resolveClosed(); });
    });
    let lastPortCensus = 0;
    const observe = (): void => {
      try {
        const identities = capture();
        if (Date.now() - lastPortCensus >= 1000) {
          for (const port of listeningPorts(identities)) ports.set(`${port.pid}/${port.start}/${port.address}`, port);
          lastPortCensus = Date.now();
        }
      } catch (error) { failure ??= error instanceof Error ? error.message : String(error); interrupted = true; }
    };
    observe();
    poll = setInterval(observe, 100);
    const started = Date.now();
    while (Date.now() - started < deadlineMs) {
      if (exited || interrupted) break;
      await delay(25);
    }
    if (!exited) {
      timedOut = !interrupted;
      const root = pid === null ? undefined : owned.get(pid);
      if (root) signalOwned(root, 'SIGINT');
      await Promise.race([closed, delay(10000)]);
    }
    if (interrupted) failure ??= 'supervisor-interrupted';
    const settleStarted = Date.now();
    let active = capture();
    while (active.length && Date.now() - settleStarted < 1000) { await delay(50); active = capture(); }
    natural = active.length === 0 ? 'passed' : 'failed';
  } catch (error) { failure = error instanceof Error ? error.message : String(error); }
  finally {
    if (poll) clearInterval(poll);
    try {
      let active = capture();
      for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
        for (const identity of active.toSorted((a, b) => Number(a.pid === pid) - Number(b.pid === pid))) signalOwned(identity, signal);
        if (active.length) await delay(signal === 'SIGTERM' ? 1000 : 100);
        active = capture();
      }
      remaining = active;
    } catch (error) { errors.push(`Final ownership census failed: ${error instanceof Error ? error.message : error}`); remaining = [...owned.values()]; }
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    for (const descriptor of descriptors) try { closeSync(descriptor); } catch (error) { errors.push(`Output close failed: ${error instanceof Error ? error.message : error}`); }
  }
  let portsRemaining: z.infer<typeof listeningPortSchema>[] = [];
  try { portsRemaining = listeningPorts(remaining); } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
  const receipt = processReceiptSchema.parse({ version: 1, kind: 'connected-cli-process', pid, exitCode, signal: exitSignal, error: failure, timedOut, deadlineMs, owned: [...owned.values()].toSorted((a, b) => a.pid - b.pid), cleanup: { natural, finalizer: remaining.length || errors.length ? 'failed' : 'passed', remaining, signals, portsObserved: [...ports.values()], portsRemaining, errors } });
  seal(join(project, 'process.json'), receipt);
  return receipt;
}

/** Rejects paths that have different filesystem meanings on supported platforms. */
function safePath(path: string): string {
  if (!path || isAbsolute(path) || path.includes('\\') || /[<>:"|?*]/.test(path) || [...path].some(character => character.charCodeAt(0) < 32) || path.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new Error(`Unsafe relative path ${path}`);
  return path;
}

/** Keeps file-boundary reads inside their declared root, including symlinks. */
function inside(root: string, path: string): string {
  const candidate = join(root, safePath(path));
  if (existsSync(candidate)) {
    const rel = relative(realpathSync(root), realpathSync(candidate));
    if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) throw new Error(`External path ${path}`);
  }
  return candidate;
}

/** Produces the sorted map encoding shared with the operator. */
function sortedHashes(value: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(value).toSorted(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
}

/** Normalizes filesystem separators before hashes enter the portable JSON boundary. */
function fileHashes(root: string): Record<string, string> {
  return sortedHashes(Object.fromEntries(Object.entries(tree(root)).map(([path, value]) => [path.split(sep).join('/'), value])));
}

/** Seals exact JSON bytes and refuses conflicting reruns. */
function seal(path: string, value: unknown): string {
  const bytes = encode(value);
  freeze(path, bytes);
  const byteHash = hash(bytes);
  freeze(path.replace(/\.json$/, '.sha256'), byteHash + '\n');
  return byteHash;
}

/** Validates an immutable record at its file boundary. */
function sealed<T>(path: string, schema: z.ZodType<T>): { value: T; hash: string } {
  const bytes = readFileSync(path);
  const byteHash = hash(bytes);
  if (readFileSync(path.replace(/\.json$/, '.sha256'), 'utf8') !== byteHash + '\n') throw new Error(`Changed sealed record ${path}`);
  return { value: schema.parse(JSON.parse(bytes.toString('utf8'))), hash: byteHash };
}

/** Validates every retained evidence file rather than trusting its manifest. */
function verifyEvidence(directory: string, files: Record<string, string>, expected?: string): void {
  for (const [path, expectedHash] of Object.entries(files)) {
    const file = inside(directory, path);
    if (!lstatSync(file).isFile() || hash(readFileSync(file)) !== expectedHash) throw new Error(`Evidence changed ${path}`);
  }
  if (expected && hash(encode(sortedHashes(files))) !== expected) throw new Error('Evidence manifest changed');
}

/** Validates the frozen corpus independently of the current source registry. */
function parseCorpus(value: unknown): ConnectedFixture[] {
  const fixtures = z.array(fixtureSchema).length(6).parse(value);
  if (new Set(fixtures.map(item => item.id)).size !== 6) throw new Error('Connected corpus requires six distinct fixture identities');
  const variantIds = fixtures.flatMap(item => item.variants.map(variant => variant.id));
  if (new Set(variantIds).size !== 12) throw new Error('Connected corpus requires twelve distinct variants');
  for (const fixture of fixtures) {
    if (fixture.classification !== (['orders', 'wishlist'].includes(fixture.id) ? 'safeguard' : 'informative')) throw new Error('Fixture classification changed');
    for (const path of Object.keys(fixture.files)) {
      safePath(path);
      if (/^(?:node_modules|\.agents|\.home|\.tmp|\.e2e|tests)(?:\/|$)/.test(path) || /(?:^|\/)(?:bank|plan|corpus|operator-wire)\.(?:json|md)$/.test(path)) throw new Error('Private or reserved public fixture file');
    }
    for (const path of ['PRODUCT.md', 'TASK.md', 'README.md', 'package.json', 'e2e.config.ts', 'server.mjs']) if (!fixture.files[path]) throw new Error(`Missing public file ${path}`);
    const discovered = Object.keys(fixture.files).filter(path => /(?:^|\/)[^/]+\.test\.mjs$/.test(path)).toSorted();
    if (!isDeepStrictEqual(discovered, [...fixture.lowerTests].toSorted()) || new Set(fixture.lowerTests).size !== fixture.lowerTests.length) throw new Error('Lower-test discovery differs from declaration');
    for (const variant of fixture.variants) {
      safePath(variant.mutationFile);
      if (!fixture.files[variant.mutationFile] || fixture.files[variant.mutationFile]!.split(variant.mutation[0]).length !== 2 || variant.mutation[0] === variant.mutation[1] || fixture.lowerTests.includes(variant.mutationFile) || !/\.[cm]?js$/.test(variant.mutationFile)) throw new Error('Each variant requires one distinct source replacement');
    }
  }
  return fixtures;
}

/** Accepts only the predeclared usage rule and retains its complete original bytes. */
function validateRule(value: unknown): void {
  z.object({ schemaVersion: z.literal(1), kind: z.literal('connected-usage-only-budget-rule'), calibrationAttempts: z.literal(6), baselineAttempts: z.literal(12), authorConcurrency: z.literal(1), calibrationCeiling: z.object({ maxTurns: z.literal(64), maxTokens: z.literal(2000000), wallTimeSeconds: z.literal(1200) }).strict(), eligibility: text, inputs: z.object({ T: text, P: text, R: text, W: text }).strict(), formula: z.object({ maxTokens: z.literal('100000 * ceil((2*T + P)/100000)'), maxTurns: z.literal('max(32, 2*R + 2)'), wallTimeSeconds: z.literal('60 * ceil(max(600, 2*W + 60)/60)') }).strict(), allowedEvidence: z.tuple([z.literal('resource usage'), z.literal('correct-app validity'), z.literal('tool friction')]), forbiddenEvidence: z.tuple([z.literal('calibration mutation outcomes'), z.literal('baseline outcomes'), z.literal('selective removal of calibration attempts')]), calibrationMutationGrading: z.literal(false), comparisonAuthorized: z.literal(false), interpretation: text, onUnusableCalibration: text }).strict().parse(value);
}

/** Reads the source and built runtime that identify this study version. */
function sourceSnapshot(directory: string, chromium: string): z.infer<typeof sourceSchema> {
  const git = (args: string[]): string => {
    const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr || 'git failed');
    return result.stdout;
  };
  const files: Record<string, { kind: 'file' | 'link'; hash: string }> = {};
  for (const path of git(['ls-files', '-co', '--exclude-standard', '-z']).split('\0').filter(Boolean).toSorted()) {
    safePath(path);
    const source = join(repo, path);
    const link = lstatSync(source).isSymbolicLink();
    const bytes = link ? Buffer.from(readlinkSync(source)) : readFileSync(source);
    const blobHash = hash(bytes);
    files[path] = { kind: link ? 'link' : 'file', hash: blobHash };
    freeze(join(directory, 'source/blobs', blobHash), bytes);
  }
  seal(join(directory, 'source/files.json'), files);
  return { repository: repo, revision: git(['rev-parse', 'HEAD']).trim(), cleanWorktree: git(['status', '--porcelain']).trim() === '', contentHash: hash(encode(files)), lockHash: hash(readFileSync(join(repo, 'pnpm-lock.yaml'))), node: process.version, chromium };
}

/** Checks all frozen inputs without consulting live fixture implementations. */
function loadBank(directory: string): { bank: Bank; bankHash: string; corpus: ConnectedFixture[]; settings: z.infer<typeof settingsSchema> } {
  const record = sealed(join(directory, 'bank.json'), bankSchema);
  const bank = record.value;
  const settings = settingsSchema.parse(json(join(directory, 'settings.json')));
  for (const [file, expectedHash] of [['settings.json', bank.settingsHash], ['corpus.json', bank.corpusHash], ['calibration-rule.json', bank.calibrationRuleHash], ['controls/results.json', bank.controlsHash], ['lower/results.json', bank.lowerHash]] as const) if (hash(readFileSync(join(directory, file))) !== expectedHash) throw new Error(`Frozen input changed ${file}`);
  if (hash(encode(sortedHashes(fileHashes(join(directory, 'runtime'))))) !== bank.runtimeHash || bank.source.node !== process.version) throw new Error('Frozen runtime changed');
  validateRule(json(join(directory, 'calibration-rule.json')));
  const corpus = parseCorpus(json(join(directory, 'corpus.json')));
  const all = [...bank.calibration, ...bank.prospectiveBaseline];
  if (new Set(all.map(slot => slot.id)).size !== 18 || Object.keys(bank.projects).length !== 18 || all.some(slot => !bank.projects[slot.id])) throw new Error('Frozen slot identities changed');
  for (const [slots, perFixture] of [[bank.calibration, 1], [bank.prospectiveBaseline, 2]] as const) if (slots.some((slot, i) => slot.order !== i) || fixtureIds.some(id => slots.filter(slot => slot.fixture === id).length !== perFixture)) throw new Error('Frozen schedule changed');
  const sourceFiles = sealed(join(directory, 'source/files.json'), z.record(z.string(), z.object({ kind: z.enum(['file', 'link']), hash: digest }).strict()));
  if (hash(encode(sourceFiles.value)) !== bank.source.contentHash || !isDeepStrictEqual(settings.operator, bank.operator)) throw new Error('Source or operator identity changed');
  for (const entry of Object.values(sourceFiles.value)) if (hash(readFileSync(join(directory, 'source/blobs', entry.hash))) !== entry.hash) throw new Error('Source reconstruction changed');
  for (const fixture of corpus) {
    const expected = Object.fromEntries(Object.entries(fixture.files).map(([path, bytes]) => [path, hash(bytes)]));
    for (const [path, entry] of Object.entries(sourceFiles.value)) if (path.startsWith('skills/e2e/')) expected['.agents/' + path] = entry.kind === 'file' ? entry.hash : hash('link:' + readFileSync(join(directory, 'source/blobs', entry.hash), 'utf8'));
    if (!isDeepStrictEqual(sortedHashes(fileHashes(join(directory, 'snapshots', fixture.id))), sortedHashes(expected))) throw new Error('Frozen public snapshot or consumer skill changed');
  }
  const controls = z.array(controlSchema).length(108).parse(json(join(directory, 'controls/results.json')));
  const lower = z.array(lowerSchema).length(36).parse(json(join(directory, 'lower/results.json')));
  if (controls.some(result => !result.valid) || lower.some(result => !result.valid)) throw new Error('Frozen design controls are invalid');
  verifyExecutions(directory, controls.map(result => result.execution));
  for (const result of lower) if (hash(encode(sortedHashes(fileHashes(inside(directory, result.evidence))))) !== result.evidenceHash) throw new Error('Frozen lower-test evidence changed');
  return { bank, bankHash: record.hash, corpus, settings };
}

/** Resolves one sealed public project without exposing its private schedule. */
function readProject(directory: string, bank: Bank, slot: Slot, expectedPhase: 'calibration' | 'baseline') {
  const manifest = sealed(inside(directory, bank.projects[slot.id]!), projectSchema);
  const project = manifest.value;
  if (project.id !== slot.id || project.phase !== expectedPhase || project.runtimeHash !== bank.runtimeHash || project.settingsHash !== bank.settingsHash || project.sourceHash !== bank.source.contentHash || hash(encode(sortedHashes(project.protectedFiles))) !== project.projectHash || !project.project.startsWith(`author/${slot.id}/`)) throw new Error('Public project binding changed');
  inside(directory, project.project);
  return manifest;
}

/** Applies the bounded submission syntax contract without claiming isolation. */
function submissionContract(source: string): void {
  if (!source.trim()) throw new Error('Submission must be nonempty UTF-8 TypeScript');
  const parsed = parseSync('requirement.e2e.ts', source);
  if (parsed.errors.length) throw new Error('Submission is not valid TypeScript');
  const forbidden = new Set(['process', 'globalThis', 'global', 'require', 'module', 'exports', 'eval', 'Function', 'fetch', 'WebSocket', 'XMLHttpRequest', 'Bun', 'Deno', 'agent', 'window', 'document', 'navigator']);
  const properties = new Set(['constructor', '__proto__', 'prototype', 'skip', 'only', 'todo', 'fixme', 'extend', 'use', 'setup', 'configure', 'evaluate', 'route', 'request', 'initScripts']);
  const imports = new Set<string>();
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach(visit); return; }
    const node = value as Record<string, unknown>;
    if (node.type === 'ImportDeclaration') {
      const imported = (node.source as { value: string }).value;
      if (!['e2e', '@e2e-dev/web'].includes(imported)) throw new Error('Only public E2E imports are allowed');
      for (const specifier of node.specifiers as { type: string; imported?: { name: string }; local: { name: string } }[]) {
        if (specifier.type !== 'ImportSpecifier' || specifier.imported?.name !== (imported === 'e2e' ? 'expect' : 'test') || specifier.local.name !== specifier.imported?.name) throw new Error('Only unaliased test from web and expect from e2e are allowed');
        imports.add(specifier.local.name);
      }
    }
    if (['ImportExpression', 'MetaProperty', 'WithStatement', 'ExportAllDeclaration', 'ExportNamedDeclaration'].includes(String(node.type))) throw new Error('Dynamic loading and reexports are excluded');
    if (node.type === 'Identifier' && forbidden.has(String(node.name))) throw new Error(`Excluded identifier ${node.name}`);
    if (node.type === 'MemberExpression') {
      const property = node.property as { name?: string; value?: string };
      if (node.computed || properties.has(property.name ?? property.value ?? '')) throw new Error('Excluded member access');
    }
    Object.values(node).forEach(visit);
  };
  visit(parsed.program);
  if (imports.size !== 2) throw new Error('Import public test and expect');
}

const errorSchema = z.object({ category: text, code: text, phase: text.optional() }).passthrough();
const reportSchema = z.object({ schemaVersion: z.literal('report-1'), run: z.object({ status: text, exitCode: z.number().int(), errors: z.array(errorSchema), summary: z.object({ selected: count, executed: count, skipped: count }).passthrough(), usage: z.object({ modelTokens: count, maxModelCallsInStep: count }).passthrough(), results: z.array(z.object({ id: digest, titlePath: z.array(text).min(1), kind: text, status: text, selected: z.boolean().optional(), attempts: z.array(z.object({ status: text, steps: z.array(z.object({ kind: text, status: text }).passthrough()), cleanup: text, secondaryErrors: z.array(errorSchema), error: errorSchema.optional() }).passthrough()) }).passthrough()) }).passthrough() }).passthrough();

/** Runs one exact suite on one fresh process and preserves complete CLI evidence. */
function execute(directory: string, fixture: ConnectedFixture, source: Buffer, target: string, runtimeHash: string, brokenServer = false): Execution {
  const workId = randomBytes(12).toString('hex');
  const work = join(directory, 'work', workId);
  copy(join(directory, 'snapshots', fixture.id), work);
  freeze(join(work, 'tests/requirement.e2e.ts'), source);
  if (target !== 'correct') {
    const variant = fixture.variants.find(item => item.id === target)!;
    const path = join(work, variant.mutationFile);
    const original = readFileSync(path, 'utf8');
    if (original.split(variant.mutation[0]).length !== 2) throw new Error('Frozen patch no longer has exactly one target');
    writeFileSync(path, original.replace(variant.mutation[0], variant.mutation[1]));
  }
  if (brokenServer) writeFileSync(join(work, 'server.mjs'), "throw new Error('deliberate startup control');\n");
  seal(join(work, 'reconstruction.json'), { version: 1, snapshot: fixture.id, target, sourceHash: hash(source), runtimeHash, inputFiles: sortedHashes(fileHashes(work)) });
  copy(join(directory, 'runtime'), join(work, 'node_modules'));
  const result = command(work, process.execPath, [join(repo, 'apps/test-authoring/connected-cli.ts'), 'supervise-cell', '--project', work, '--deadline-ms', '240000'], 300000);
  freeze(join(work, 'supervisor-stdout.txt'), result.stdout ?? '');
  freeze(join(work, 'supervisor-stderr.txt'), result.stderr ?? '');
  seal(join(work, 'supervisor-process.json'), { exitCode: result.status, signal: result.signal, error: result.error?.message ?? null });
  let supervised: z.infer<typeof processReceiptSchema> | null = null;
  try { supervised = sealed(join(work, 'process.json'), processReceiptSchema).value; } catch { supervised = null; }
  const reportFile = join(work, '.e2e/report.json');
  let checked: Omit<z.infer<typeof executedSchema>, 'evidence' | 'evidenceHash'> | { kind: 'unusable'; reason: string };
  if (result.error) checked = { kind: 'unusable', reason: `execution-error: ${result.error.message}` };
  else if (!supervised) checked = { kind: 'unusable', reason: 'missing-or-invalid-owned-process-proof' };
  else if (supervised.timedOut || supervised.error || supervised.cleanup.natural !== 'passed' || supervised.cleanup.finalizer !== 'passed' || supervised.cleanup.portsRemaining.length) checked = { kind: 'unusable', reason: 'execution-deadline-or-owned-cleanup-failure' };
  else if (supervised.exitCode !== result.status) checked = { kind: 'unusable', reason: 'supervisor-cli-exit-mismatch' };
  else if (!existsSync(reportFile)) checked = { kind: 'unusable', reason: 'missing-report' };
  else {
    try {
      const raw = json(reportFile);
      const validate = new Ajv2020({ strict: false, validateFormats: false }).compile(json(join(work, 'node_modules/e2e/schema/report-v1.schema.json')) as Record<string, unknown>);
      if (!validate(raw)) throw new Error('Report schema failed');
      const run = reportSchema.parse(raw).run;
      const selected = run.results.filter(entry => entry.selected !== false);
      const selectionHash = hash(encode(selected.map(entry => entry.id).toSorted()));
      if (!selected.length || run.summary.selected !== selected.length || run.summary.executed !== selected.length || new Set(selected.map(entry => entry.id)).size !== selected.length) checked = { kind: 'unusable', reason: 'empty-or-incomplete-selection' };
      else if (run.usage.modelTokens || run.usage.maxModelCallsInStep) checked = { kind: 'unusable', reason: 'runtime-model-usage' };
      else if (run.errors.length || run.summary.skipped || selected.some(entry => entry.kind !== 'test' || !['passed', 'failed'].includes(entry.status) || entry.attempts.length !== 1 || entry.attempts.some(attempt => attempt.cleanup !== 'complete' || attempt.secondaryErrors.length || !['passed', 'failed'].includes(attempt.status) || (attempt.error && (attempt.error.category !== 'test' || attempt.error.phase !== 'body' || /TIMEOUT|DEADLINE/.test(attempt.error.code)))))) checked = { kind: 'unusable', reason: 'run-setup-cleanup-skip-or-timeout' };
      else if (run.status === 'passed' && result.status === 0 && run.exitCode === 0 && selected.every(entry => entry.status === 'passed')) checked = { kind: 'passed', report: `work/${workId}/.e2e/report.json`, selected: selected.length, selectionHash };
      else if (run.status === 'failed' && result.status === 1 && run.exitCode === 1 && selected.some(entry => entry.status === 'failed')) checked = { kind: 'failed', report: `work/${workId}/.e2e/report.json`, selected: selected.length, selectionHash };
      else checked = { kind: 'unusable', reason: 'inconsistent-cli-report-exit' };
    } catch (error) { checked = { kind: 'unusable', reason: `invalid-report: ${error instanceof Error ? error.message : error}` }; }
  }
  const copiedRuntimeHash = hash(encode(sortedHashes(fileHashes(join(work, 'node_modules')))));
  if (copiedRuntimeHash !== runtimeHash) throw new Error('Disposable dependency copy changed');
  const releaseIntentHash = seal(join(work, 'dependency-release-intent.json'), { version: 1, runtimeHash, copiedRuntimeHash, requested: ['node_modules'], reconstructionHash: hash(readFileSync(join(work, 'reconstruction.json'))) });
  rmSync(join(work, 'node_modules'), { recursive: true });
  if (existsSync(join(work, 'node_modules'))) throw new Error('Disposable dependency release did not complete');
  seal(join(work, 'dependency-release.json'), { version: 1, runtimeHash, copiedRuntimeHash, removed: ['node_modules'], releaseIntentHash });
  const evidenceHash = hash(encode(sortedHashes(fileHashes(work))));
  return { ...checked, evidence: `work/${workId}`, evidenceHash };
}

/** Checks repeat agreement without treating repeated suite members as independent authors. */
function sameSelection(cells: Execution[]): boolean {
  return cells.every(cell => cell.kind === 'passed' || cell.kind === 'failed') && new Set(cells.map(cell => 'selectionHash' in cell ? cell.selectionHash : null)).size === 1;
}

/** Retains both predefined correct and variant lower-test launches with exact discovery counts. */
function runLower(directory: string, fixtures: ConnectedFixture[]): z.infer<typeof lowerSchema>[] {
  const rows: z.infer<typeof lowerSchema>[] = [];
  for (const fixture of fixtures) for (const target of ['correct', ...fixture.variants.map(item => item.id)]) for (const repeat of [1, 2] as const) {
    const project = join(directory, 'lower', randomBytes(12).toString('hex'));
    copy(join(directory, 'snapshots', fixture.id), project);
    if (target !== 'correct') {
      const variant = fixture.variants.find(item => item.id === target)!;
      const path = join(project, variant.mutationFile);
      writeFileSync(path, readFileSync(path, 'utf8').replace(variant.mutation[0], variant.mutation[1]));
    }
    const discovered = Object.keys(fileHashes(project)).filter(path => /(?:^|\/)[^/]+\.test\.mjs$/.test(path)).toSorted();
    const result = command(project, process.execPath, ['--test', '--test-reporter=tap', ...discovered], 120000);
    freeze(join(project, 'stdout.txt'), result.stdout ?? '');
    freeze(join(project, 'stderr.txt'), result.stderr ?? '');
    const tests = [...(result.stdout ?? '').matchAll(/^# tests (\d+)\s*$/gm)];
    const passes = [...(result.stdout ?? '').matchAll(/^# pass (\d+)\s*$/gm)];
    const failures = [...(result.stdout ?? '').matchAll(/^# (?:fail|cancelled|skipped|todo) (\d+)\s*$/gm)];
    const valid = !result.error && result.status === 0 && isDeepStrictEqual(discovered, [...fixture.lowerTests].toSorted()) && tests.length === 1 && Number(tests[0]![1]) === fixture.lowerCount && passes.length === 1 && Number(passes[0]![1]) === fixture.lowerCount && failures.length === 4 && failures.every(match => Number(match[1]) === 0);
    rows.push({ fixture: fixture.id as typeof fixtureIds[number], target, repeat, files: discovered, count: fixture.lowerCount, evidence: relative(directory, project).split(sep).join('/'), evidenceHash: hash(encode(sortedHashes(fileHashes(project)))), valid });
  }
  seal(join(directory, 'lower/results.json'), rows);
  return rows;
}

/** Exercises the 108 frozen control launches through the actual copied built CLI. */
function runControls(directory: string, fixtures: ConnectedFixture[], runtimeHash: string): z.infer<typeof controlSchema>[] {
  const rows: z.infer<typeof controlSchema>[] = [];
  for (const fixture of fixtures) {
    const fixtureRows: z.infer<typeof controlSchema>[] = [];
    for (const control of ['strong', 'weak', 'wrong', 'unrelated', 'startup'] as const) {
      const targets = control === 'strong' || control === 'weak' ? ['correct', ...fixture.variants.map(item => item.id)] : ['correct'];
      for (const target of targets) for (const repeat of [1, 2] as const) {
        const source = Buffer.from(fixture.controls[control === 'startup' ? 'weak' : control]);
        submissionContract(source.toString('utf8'));
        const execution = execute(directory, fixture, source, target, runtimeHash, control === 'startup');
        const expected = control === 'startup' ? 'unusable' : control === 'strong' ? target === 'correct' ? 'passed' : 'failed' : control === 'weak' ? 'passed' : 'failed';
        let valid = execution.kind === expected;
        if (control === 'strong' && target !== 'correct' && execution.kind === 'failed') {
          const report = reportSchema.parse(json(join(directory, execution.report)));
          const expectedTitle = fixture.variants.find(item => item.id === target)!.expected;
          const mapped = report.run.results.filter(result => result.titlePath.at(-1) === expectedTitle);
          valid &&= mapped.length === 1 && mapped[0]!.status === 'failed' && mapped[0]!.attempts.length === 1 && mapped[0]!.attempts[0]!.error?.category === 'test' && mapped[0]!.attempts[0]!.error?.phase === 'body' && mapped[0]!.attempts[0]!.steps.some(step => step.kind === 'assertion' && step.status === 'failed');
        }
        fixtureRows.push({ fixture: fixture.id as typeof fixtureIds[number], control, target, repeat, execution, expected, valid });
      }
    }
    for (const control of ['strong', 'weak'] as const) {
      const members = fixtureRows.filter(row => row.control === control);
      if (!sameSelection(members.map(row => row.execution))) for (const row of members) row.valid = false;
    }
    for (const control of ['wrong', 'unrelated'] as const) {
      const members = fixtureRows.filter(row => row.control === control);
      if (!sameSelection(members.map(row => row.execution))) for (const row of members) row.valid = false;
    }
    rows.push(...fixtureRows);
    freeze(join(directory, 'controls', `${fixture.id}.json`), encode(fixtureRows));
  }
  if (rows.length !== 108) throw new Error('Control matrix must contain exactly 108 predefined launches');
  seal(join(directory, 'controls/results.json'), rows);
  return rows;
}

/** Freezes six public snapshots, the complete private bank and all eighteen prospective identities. */
export async function prepareConnected(directory: string, settingsFile: string): Promise<Bank> {
  directory = resolve(directory);
  const rel = relative(repo, directory);
  if (!rel || (!rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel))) throw new Error('Prepare outside the repository');
  const settingsBytes = readFileSync(settingsFile);
  const settings = settingsSchema.parse(JSON.parse(settingsBytes.toString('utf8')));
  const ruleBytes = readFileSync(settings.calibrationRule);
  validateRule(JSON.parse(ruleBytes.toString('utf8')));
  const fixtures = parseCorpus(connectedFixtures);
  if (existsSync(join(directory, 'bank.json'))) {
    const previous = loadBank(directory);
    if (previous.bank.settingsHash !== hash(settingsBytes) || previous.bank.corpusHash !== hash(encode(fixtures)) || previous.bank.calibrationRuleHash !== hash(ruleBytes)) throw new Error('Conflicting preparation inputs require a new retained directory');
    return previous.bank;
  }
  if (existsSync(directory) && readdirSync(directory).length) throw new Error('Bank directory must be empty');
  mkdirSync(directory, { recursive: true });
  freeze(join(directory, 'settings.json'), settingsBytes);
  freeze(join(directory, 'calibration-rule.json'), ruleBytes);
  freeze(join(directory, 'corpus.json'), encode(fixtures));
  bundle(join(directory, 'runtime'));
  const playwright = await import(pathToFileURL(join(directory, 'runtime/@e2e-dev/web/node_modules/playwright-core/index.mjs')).href);
  const browser = await playwright.chromium.launch({ headless: true });
  let chromium: string;
  try { chromium = browser.version(); } finally { await browser.close(); }
  const source = sourceSnapshot(directory, chromium);
  const runtimeHash = hash(encode(sortedHashes(fileHashes(join(directory, 'runtime')))));
  for (const fixture of fixtures) {
    const project = join(directory, 'snapshots', fixture.id);
    for (const [path, bytes] of Object.entries(fixture.files)) freeze(join(project, path), bytes);
    copy(join(repo, 'skills/e2e'), join(project, '.agents/skills/e2e'));
    const paths = sortedHashes(fileHashes(project));
    seal(join(directory, 'source', `snapshot-${fixture.id}.json`), paths);
    for (const variant of fixture.variants) {
      const before = Buffer.from(fixture.files[variant.mutationFile]!);
      const after = Buffer.from(before.toString('utf8').replace(variant.mutation[0], variant.mutation[1]));
      seal(join(directory, 'source', `patch-${variant.id}.json`), { id: variant.id, file: variant.mutationFile, beforeHash: hash(before), afterHash: hash(after), replacementHash: hash(encode(variant.mutation)), ruleIds: variant.ruleIds, weight: 1 });
    }
  }
  const lower = runLower(directory, fixtures);
  const controls = runControls(directory, fixtures, runtimeHash);
  if (lower.some(row => !row.valid) || controls.some(row => !row.valid)) throw new Error('Connected design validation failed. Retained every predefined control and lower-test launch; use a new version after repair');
  let state = settings.allocationSeed;
  const shuffled = (items: string[]): string[] => {
    const result = [...items];
    for (let index = result.length - 1; index > 0; index--) {
      state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
      const swap = (state >>> 0) % (index + 1);
      [result[index], result[swap]] = [result[swap]!, result[index]!];
    }
    return result;
  };
  const schedule = (ids: string[]): Slot[] => shuffled(ids).map((fixture, order) => ({ id: randomBytes(12).toString('hex'), fixture: fixture as typeof fixtureIds[number], order }));
  const calibration = schedule([...fixtureIds]);
  const prospectiveBaseline = schedule(fixtureIds.flatMap(id => [id, id]));
  const projects: Record<string, string> = {};
  for (const [slots, phase] of [[calibration, 'calibration'], [prospectiveBaseline, 'baseline']] as const) for (const slot of slots) {
    const fixture = fixtures.find(item => item.id === slot.fixture)!;
    const relativeProject = `author/${slot.id}/${fixture.name}`;
    const project = join(directory, relativeProject);
    copy(join(directory, 'snapshots', fixture.id), project);
    copy(join(directory, 'runtime'), join(project, 'node_modules'));
    const protectedFiles = sortedHashes(fileHashes(project));
    const manifest = projectSchema.parse({ schemaVersion: 1, kind: 'connected-public-project', id: slot.id, phase, project: relativeProject, projectHash: hash(encode(protectedFiles)), protectedFiles, runtimeHash, settingsHash: hash(settingsBytes), sourceHash: source.contentHash });
    const file = `projects/${slot.id}.json`;
    seal(join(directory, file), manifest);
    projects[slot.id] = file;
  }
  const bank = bankSchema.parse({ version: 3, study: 'connected-baseline-feasibility', comparisonAuthorized: false, settingsHash: hash(settingsBytes), corpusHash: hash(encode(fixtures)), calibrationRuleHash: hash(ruleBytes), runtimeHash, controlsHash: hash(readFileSync(join(directory, 'controls/results.json'))), lowerHash: hash(readFileSync(join(directory, 'lower/results.json'))), source, operator: settings.operator, calibration, prospectiveBaseline, projects, repeats: 2, authorConcurrency: 1, controlLaunches: 108 });
  seal(join(directory, 'bank.json'), bank);
  return bank;
}

/** Identifies immutable operator failures before canonical pass records can be consumed. */
function operatorVeto(directory: string, attemptPhase: 'calibration' | 'baseline', runId: string): { state: 'admission-failed' | 'phase-evidence-failed' | 'receipt-failed'; reason: string; path: string } | null {
  const markers = [
    { state: 'admission-failed' as const, path: 'operator/admission-failure.json' },
    { state: 'phase-evidence-failed' as const, path: `attempts/${attemptPhase}/evidence-failure.json` },
    { state: 'receipt-failed' as const, path: `attempts/${attemptPhase}/${runId}/receipt-failure.json` },
  ];
  const marker = markers.find(item => existsSync(join(directory, item.path)));
  return marker ? { ...marker, reason: `Operator ${marker.path} marker vetoes canonical pass records` } : null;
}

/** Preserves observations from vetoed receipts without admitting their canonical pass status. */
function vetoedObservations(path: string): Pick<Terminal, 'usage' | 'usageComplete' | 'stopReason' | 'cleanup'> | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = terminalSchema.safeParse(json(path));
    if (!parsed.success) return null;
    const { usage, usageComplete, stopReason, cleanup } = parsed.data;
    return { usage, usageComplete, stopReason, cleanup };
  } catch { return null; }
}

/** Requires the new prepared-project boundary proof while native author shell proof stays pending. */
function readAdmission(directory: string, bank: Bank, bankHash: string, purpose: 'consume' | 'report' = 'consume') {
  if (purpose === 'consume' && existsSync(join(directory, 'operator/admission-failure.json'))) throw new Error('Operator admission-failure marker vetoes canonical admission');
  const admission = sealed(join(directory, 'operator/admission.json'), admissionSchema);
  const value = admission.value;
  if (!bank.source.cleanWorktree || value.bankHash !== bankHash || value.operatorHash !== bank.operator.sourceHash || value.sourceHash !== bank.source.contentHash || value.runtimeHash !== bank.runtimeHash || value.cleanup.finalizer !== 'passed' || !Object.values(bank.projects).some(path => hash(readFileSync(inside(directory, path))) === value.projectManifestHash)) throw new Error('Operator admission does not bind this clean prepared bank');
  verifyEvidence(directory, value.evidence, value.evidenceHash);
  verifyEvidence(directory, value.cleanup.evidence);
  return admission;
}

/** Verifies the normalized totals without discarding full raw provider usage. */
function completeUsage(terminal: Terminal): boolean {
  const { usage, responses } = terminal;
  if (!terminal.usageComplete || usage.turns === null || usage.tokens === null || usage.wallTimeSeconds === null || terminal.maxResponseTokens === null || !responses.length || responses.some(response => response.totalTokens === null) || new Set(responses.map(response => response.responseId)).size !== responses.length) return false;
  return usage.turns === responses.length && usage.tokens === responses.reduce((sum, response) => sum + response.totalTokens!, 0) && terminal.maxResponseTokens === Math.max(...responses.map(response => response.totalTokens!));
}

/** Distinguishes known overrun, unknown measurement and authoritative cutoff. */
function usageState(terminal: Terminal, budget: Budget): 'within' | 'exceeded' | 'unknown' | 'cutoff' {
  if (terminal.status === 'cutoff' || ['budget-cutoff', 'wall-time-cutoff'].includes(terminal.stopReason)) return 'cutoff';
  if ((terminal.usage.turns !== null && terminal.usage.turns > budget.maxTurns) || (terminal.usage.tokens !== null && terminal.usage.tokens > budget.maxTokens) || (terminal.usage.wallTimeSeconds !== null && terminal.usage.wallTimeSeconds > budget.wallTimeSeconds)) return 'exceeded';
  return completeUsage(terminal) ? 'within' : 'unknown';
}

/** Reads one operator-owned first attempt and validates every cross-record provenance binding. */
function readTerminal(directory: string, bank: Bank, bankHash: string, slot: Slot, expectedPhase: 'calibration' | 'baseline', plan: { value: Plan; hash: string } | null) {
  const veto = operatorVeto(directory, expectedPhase, slot.id);
  if (veto) throw new Error(veto.reason);
  const project = readProject(directory, bank, slot, expectedPhase);
  const admission = readAdmission(directory, bank, bankHash);
  const path = join(directory, 'attempts', expectedPhase, slot.id);
  const started = sealed(join(path, 'started.json'), startedSchema);
  const terminal = sealed(join(path, 'terminal.json'), terminalSchema);
  const settings = settingsSchema.parse(json(join(directory, 'settings.json')));
  const expected = { phase: expectedPhase, id: slot.id, bankHash, planHash: plan?.hash ?? null, settingsHash: bank.settingsHash, projectManifestHash: project.hash, operatorHash: bank.operator.sourceHash, admissionHash: admission.hash, sourceHash: bank.source.contentHash, runtimeHash: bank.runtimeHash };
  for (const [key, value] of Object.entries(expected)) if (started.value[key as keyof typeof expected] !== value || terminal.value[key as keyof typeof expected] !== value) throw new Error(`Attempt ${key} binding changed`);
  if (!isDeepStrictEqual(started.value.author, settings.author) || !isDeepStrictEqual(started.value.budget, plan?.value.budget ?? calibrationCeiling) || terminal.value.model !== settings.author.model || terminal.value.effort !== settings.author.effort || terminal.value.startedHash !== started.hash || terminal.value.startedAt !== started.value.startedAt || Date.parse(terminal.value.finishedAt) < Date.parse(terminal.value.startedAt)) throw new Error('Attempt settings or interval changed');
  verifyEvidence(directory, terminal.value.rawEvents);
  verifyEvidence(directory, terminal.value.outputs);
  verifyEvidence(directory, terminal.value.cleanup.evidence);
  if (terminal.value.status === 'completed' && (terminal.value.stopReason !== 'completed' || terminal.value.failure !== null || !terminal.value.threadId || !terminal.value.sessionId || !Object.keys(terminal.value.rawEvents).length || !Object.keys(terminal.value.outputs).length || !terminal.value.protectedInputs.unchanged || terminal.value.protectedInputs.beforeHash !== project.value.projectHash || terminal.value.protectedInputs.afterHash !== project.value.projectHash)) throw new Error('Incomplete successful terminal');
  if (terminal.value.status === 'cutoff' && (!['budget-cutoff', 'wall-time-cutoff'].includes(terminal.value.stopReason) || terminal.value.failure !== null)) throw new Error('Cutoff receipt must retain its authoritative cutoff reason');
  if (!['completed', 'cutoff'].includes(terminal.value.status) && !terminal.value.failure) throw new Error('Terminal failure must preserve its cause');
  for (const other of [...bank.calibration, ...bank.prospectiveBaseline]) {
    if (other.id === slot.id) continue;
    const otherPhase = bank.calibration.some(item => item.id === other.id) ? 'calibration' : 'baseline';
    const otherPath = join(directory, 'attempts', otherPhase, other.id, 'terminal.json');
    if (!existsSync(otherPath)) continue;
    const parsed = terminalSchema.safeParse(json(otherPath));
    if (parsed.success && ((terminal.value.threadId && terminal.value.threadId === parsed.data.threadId) || (terminal.value.sessionId && terminal.value.sessionId === parsed.data.sessionId))) throw new Error('Reused thread or session identity');
  }
  return { ...terminal, started, project, budget: started.value.budget };
}

/** Retains the exact returned suite after operator export and protected-input verification. */
function importSubmission(directory: string, slot: Slot, terminal: ReturnType<typeof readTerminal>, supplied: string): { source: Buffer; submissionHash: string; testHash: string } {
  const value = terminal.value;
  if (!value.export || resolve(supplied) !== resolve(inside(directory, value.export.path)) || value.export.path !== `exports/${value.phase}/${slot.id}`) throw new Error('Submission does not match the first-attempt export');
  const files = sortedHashes(fileHashes(supplied));
  if (!isDeepStrictEqual(Object.keys(files), ['tests/requirement.e2e.ts']) || hash(encode(files)) !== value.export.filesHash) throw new Error('Export must contain exactly the sealed returned suite');
  const source = readFileSync(join(supplied, 'tests/requirement.e2e.ts'));
  if (hash(source) !== value.export.testHash || Buffer.from(source.toString('utf8')).compare(source) !== 0) throw new Error('Returned test bytes or UTF-8 changed');
  const manifest = terminal.project.value;
  const projectPath = inside(directory, manifest.project);
  const protectedNow = sortedHashes(Object.fromEntries(Object.entries(fileHashes(projectPath)).filter(([path]) => !/^(?:\.e2e|\.home|\.tmp|\.data)(?:\/|$)/.test(path) && path !== 'tests/requirement.e2e.ts')));
  if (!value.protectedInputs.unchanged || value.protectedInputs.beforeHash !== manifest.projectHash || value.protectedInputs.afterHash !== manifest.projectHash || !isDeepStrictEqual(protectedNow, manifest.protectedFiles)) throw new Error('Author changed protected project inputs');
  const output = join(directory, 'submissions', slot.id);
  freeze(join(output, 'tests/requirement.e2e.ts'), source);
  return { source, submissionHash: hash(encode(sortedHashes(fileHashes(output)))), testHash: hash(source) };
}

/** Preserves a complete nonexecution pair for unavailable or rejected attempts. */
function notExecuted(reason: string): Repeats {
  return [{ kind: 'not-executed', reason }, { kind: 'not-executed', reason }];
}

/** Runs only two correct-app launches for a separately identified calibration attempt. */
export function validateCalibration(directory: string, runId: string, submission: string): Calibration {
  directory = resolve(directory);
  const { bank, bankHash, corpus } = loadBank(directory);
  const slot = bank.calibration.find(item => item.id === runId);
  if (!slot) throw new Error('Calibration accepts only a frozen calibration identity');
  const terminal = readTerminal(directory, bank, bankHash, slot, 'calibration', null);
  const existing = join(directory, 'calibration', `${slot.id}.json`);
  if (existsSync(existing)) {
    const previous = sealed(existing, calibrationSchema).value;
    if (previous.terminalHash !== terminal.hash) throw new Error('Calibration first attempt changed');
    if (terminal.value.export && hash(readFileSync(join(submission, 'tests/requirement.e2e.ts'))) !== previous.testHash) throw new Error('Calibration submitted bytes changed');
    verifyExecutions(directory, previous.correct);
    return previous;
  }
  const fixture = corpus.find(item => item.id === slot.fixture)!;
  let correct: Repeats | null = null;
  let imported: ReturnType<typeof importSubmission> | null = null;
  const state = usageState(terminal.value, terminal.budget);
  const validTerminal = terminal.value.status === 'completed' && terminal.value.stopReason === 'completed' && terminal.value.cleanup.finalizer === 'passed' && state === 'within';
  if (!validTerminal) correct = notExecuted(`calibration-terminal-${terminal.value.status}-${state}`);
  else {
    try {
      imported = importSubmission(directory, slot, terminal, submission);
      submissionContract(imported.source.toString('utf8'));
    } catch (error) { correct = notExecuted(`submission-contract: ${error instanceof Error ? error.message : error}`); }
    if (imported && !correct) correct = [executionCell(directory, `calibration/${slot.id}/cells/correct-1.json`, fixture, imported.source, 'correct', bank.runtimeHash), executionCell(directory, `calibration/${slot.id}/cells/correct-2.json`, fixture, imported.source, 'correct', bank.runtimeHash)];
  }
  const result = calibrationSchema.parse({ version: 3, kind: 'connected-calibration-result', id: slot.id, bankHash, terminalHash: terminal.hash, submissionHash: imported?.submissionHash ?? null, testHash: imported?.testHash ?? null, usage: terminal.value.usage, maxResponseTokens: terminal.value.maxResponseTokens, correct: correct!, valid: validTerminal && correct!.every(cell => cell.kind === 'passed') && sameSelection(correct!) });
  seal(existing, result);
  return result;
}

/** Checks retained execution bytes before any result is reused or reported. */
function verifyExecutions(directory: string, cells: Execution[]): void {
  for (const cell of cells) if (cell.kind !== 'not-executed') {
    if (hash(encode(sortedHashes(fileHashes(inside(directory, cell.evidence))))) !== cell.evidenceHash) throw new Error('Execution evidence changed');
    if ('report' in cell) inside(directory, cell.report);
  }
}

/** Reuses a completed predefined cell after a crash and never picks a preferred repeat. */
function executionCell(directory: string, path: string, fixture: ConnectedFixture, source: Buffer, target: string, runtimeHash: string): Execution {
  const file = inside(directory, path);
  const inputFile = file.replace(/\.json$/, '-input.json');
  const inputs = { testHash: hash(source), fixtureHash: hash(encode(fixture)), target };
  seal(inputFile, inputs);
  if (existsSync(file)) {
    const previous = sealed(file, executionSchema).value;
    verifyExecutions(directory, [previous]);
    return previous;
  }
  const started = file.replace(/\.json$/, '-started.json');
  if (existsSync(started)) {
    const result: Execution = { kind: 'not-executed', reason: 'predefined-launch-interrupted-no-retry' };
    seal(file, result);
    return result;
  }
  seal(started, { testHash: hash(source), startedAt: new Date().toISOString() });
  const result = execute(directory, fixture, source, target, runtimeHash);
  seal(file, result);
  return result;
}

/** Computes the fixed six-source operational reserve without consulting any changed-app result. */
function calibratedBudget(sources: z.infer<typeof calibrationSourceSchema>[]): Budget {
  if (sources.length !== 6 || new Set(sources.map(source => source.id)).size !== 6) throw new Error('Budget requires all six distinct calibration attempts');
  const T = Math.max(...sources.map(source => source.tokens));
  const P = Math.max(...sources.map(source => source.maxResponseTokens));
  const R = Math.max(...sources.map(source => source.turns));
  const W = Math.max(...sources.map(source => source.wallTimeSeconds));
  return budgetSchema.parse({ maxTokens: 100000 * Math.ceil((2 * T + P) / 100000), maxTurns: Math.max(32, 2 * R + 2), wallTimeSeconds: 60 * Math.ceil(Math.max(600, 2 * W + 60) / 60) });
}

/** Seals the twelve-slot baseline only after six correct-only successes and actual native shell proof. */
export function sealBaseline(directory: string): Plan {
  directory = resolve(directory);
  const { bank, bankHash } = loadBank(directory);
  const designPath = join(directory, 'judgments/design.json');
  if (existsSync(designPath)) {
    const review = sealed(designPath, designReviewSchema).value;
    if (review.bankHash !== bankHash || review.verdict === 'rejected') throw new Error('Rejected or mismatched independent design review blocks baseline admission');
  }
  const admission = readAdmission(directory, bank, bankHash);
  for (const attemptPhase of ['calibration', 'baseline']) if (existsSync(join(directory, 'attempts', attemptPhase, 'evidence-failure.json'))) throw new Error(`Operator ${attemptPhase} evidence-failure marker vetoes baseline admission`);
  const sources: z.infer<typeof calibrationSourceSchema>[] = [];
  for (const slot of bank.calibration) {
    const terminal = readTerminal(directory, bank, bankHash, slot, 'calibration', null);
    const result = sealed(join(directory, 'calibration', `${slot.id}.json`), calibrationSchema);
    verifyExecutions(directory, result.value.correct);
    if (terminal.value.status !== 'completed' || terminal.value.stopReason !== 'completed' || terminal.value.cleanup.finalizer !== 'passed' || usageState(terminal.value, calibrationCeiling) !== 'within' || !result.value.valid || result.value.id !== slot.id || result.value.bankHash !== bankHash || result.value.terminalHash !== terminal.hash || !isDeepStrictEqual(result.value.usage, terminal.value.usage) || result.value.maxResponseTokens !== terminal.value.maxResponseTokens || !result.value.correct.every(cell => cell.kind === 'passed') || !sameSelection(result.value.correct)) throw new Error(`Calibration ${slot.id} is not a complete correct-app-valid source. No subset calculation is allowed`);
    const imported = importSubmission(directory, slot, terminal, inside(directory, terminal.value.export!.path));
    if (imported.submissionHash !== result.value.submissionHash || imported.testHash !== result.value.testHash) throw new Error('Calibration returned bytes changed');
    sources.push(calibrationSourceSchema.parse({ id: slot.id, terminalHash: terminal.hash, resultHash: result.hash, tokens: terminal.value.usage.tokens, maxResponseTokens: terminal.value.maxResponseTokens, turns: terminal.value.usage.turns, wallTimeSeconds: terminal.value.usage.wallTimeSeconds }));
  }
  const workflow = sealed(join(directory, 'operator/workflow-proof.json'), workflowSchema);
  const proof = workflow.value;
  if (proof.bankHash !== bankHash || proof.admissionHash !== admission.hash || proof.operatorHash !== bank.operator.sourceHash || proof.sourceHash !== bank.source.contentHash || proof.runtimeHash !== bank.runtimeHash || !sources.some(source => source.id === proof.calibrationId && source.terminalHash === proof.terminalHash)) throw new Error('Native attached workflow proof does not bind admitted calibration');
  verifyEvidence(directory, proof.evidence, proof.evidenceHash);
  const plan = planSchema.parse({ version: 3, study: bank.study, comparisonAuthorized: false, bankHash, admissionHash: admission.hash, workflowProofHash: workflow.hash, settingsHash: bank.settingsHash, calibrationRuleHash: bank.calibrationRuleHash, calibration: sources, budget: calibratedBudget(sources), runs: bank.prospectiveBaseline, authorConcurrency: 1 });
  seal(join(directory, 'plan.json'), plan);
  return plan;
}

/** Validates frozen baseline inputs and the exact all-six budget formula. */
function readPlan(directory: string, bank: Bank, bankHash: string, purpose: 'consume' | 'report' = 'consume') {
  const plan = sealed(join(directory, 'plan.json'), planSchema);
  const value = plan.value;
  const admission = readAdmission(directory, bank, bankHash, purpose);
  if (purpose === 'consume') for (const attemptPhase of ['calibration', 'baseline']) if (existsSync(join(directory, 'attempts', attemptPhase, 'evidence-failure.json'))) throw new Error(`Operator ${attemptPhase} evidence-failure marker vetoes plan consumption`);
  const workflow = sealed(join(directory, 'operator/workflow-proof.json'), workflowSchema);
  if (value.bankHash !== bankHash || value.admissionHash !== admission.hash || value.workflowProofHash !== workflow.hash || value.settingsHash !== bank.settingsHash || value.calibrationRuleHash !== bank.calibrationRuleHash || !isDeepStrictEqual(value.runs, bank.prospectiveBaseline) || !isDeepStrictEqual(value.budget, calibratedBudget(value.calibration)) || !isDeepStrictEqual(value.calibration.map(source => source.id), bank.calibration.map(slot => slot.id))) throw new Error('Frozen baseline plan changed');
  for (const source of value.calibration) {
    if (purpose === 'consume' && existsSync(join(directory, 'attempts/calibration', source.id, 'receipt-failure.json'))) throw new Error('Calibration receipt-failure marker vetoes the frozen plan');
    const result = sealed(join(directory, 'calibration', `${source.id}.json`), calibrationSchema);
    const terminal = sealed(join(directory, 'attempts/calibration', source.id, 'terminal.json'), terminalSchema);
    if (result.hash !== source.resultHash || terminal.hash !== source.terminalHash || !result.value.valid || !completeUsage(terminal.value) || source.tokens !== terminal.value.usage.tokens || source.turns !== terminal.value.usage.turns || source.wallTimeSeconds !== terminal.value.usage.wallTimeSeconds || source.maxResponseTokens !== terminal.value.maxResponseTokens) throw new Error('Frozen calibration source changed');
  }
  return plan;
}

/** Copies full emitted evidence with opaque names and an explicit blinding manifest. */
function reviewPacket(directory: string, bank: Bank, fixture: ConnectedFixture, source: Buffer, correct: Repeats, changed: Repeats): z.infer<typeof packetRefSchema> {
  const packetId = randomBytes(12).toString('hex');
  const destination = join(directory, 'packets', packetId);
  const privateTokens = [resolve(directory), realpathSync(directory), repo, bank.source.repository, ...bank.calibration.map(slot => slot.id), ...bank.prospectiveBaseline.map(slot => slot.id), ...fixture.variants.map(variant => variant.id)];
  const privatePaths = [...new Set(privateTokens.filter(value => value.length > 8))].toSorted((a, b) => b.length - a.length);
  const sourceText = source.toString('utf8');
  if (privatePaths.some(value => sourceText.includes(value))) throw new Error('Exact authored source contains a private identity and cannot form a blind packet');
  freeze(join(destination, 'PRODUCT.md'), fixture.files['PRODUCT.md']!);
  freeze(join(destination, 'TASK.md'), fixture.files['TASK.md']!);
  freeze(join(destination, 'tests/requirement.e2e.ts'), source);
  const included: { path: string; originalHash: string; packetHash: string; treatment: 'unchanged' | 'path-scrubbed' }[] = [];
  const omitted: { path: string; originalHash: string; reason: string }[] = [];
  for (const [label, cells] of [['correct', correct], ['changed', changed]] as const) for (let index = 0; index < cells.length; index++) {
    const cell = cells[index]!;
    if (cell.kind === 'not-executed') continue;
    const work = inside(directory, cell.evidence);
    const evidenceFiles = sortedHashes(fileHashes(work));
    for (const [path, originalHash] of Object.entries(evidenceFiles)) {
      if (!/^(?:\.e2e\/|stdout\.txt$|stderr\.txt$|process\.json$)/.test(path)) continue;
      const packetPath = `${label}/launch-${index + 1}/${path}`;
      const bytes = readFileSync(inside(work, path));
      const extension = path.split('.').at(-1)?.toLowerCase();
      const isText = ['json', 'txt', 'md', 'log', 'html', 'xml', 'csv', 'jsonl'].includes(extension ?? '');
      const safeMedia = ['png', 'jpg', 'jpeg', 'webp', 'webm', 'mp4'].includes(extension ?? '');
      if (!isText && !safeMedia) {
        if (privatePaths.some(value => bytes.includes(Buffer.from(value)))) {
          omitted.push({ path: packetPath, originalHash, reason: 'unknown attachment contains a private identity that cannot be sanitized; full original retained privately' });
          continue;
        }
        throw new Error(`Unreviewed emitted attachment format ${extension ?? 'none'}; raw evidence retained privately`);
      }
      let publicBytes = bytes;
      if (isText) {
        if (!Buffer.from(bytes.toString('utf8')).equals(bytes)) throw new Error('Emitted text evidence is not UTF-8');
        let clean = bytes.toString('utf8');
        for (const token of privatePaths) clean = clean.replaceAll(token, '[private-path]').replaceAll(token.replaceAll('\\', '\\\\'), '[private-path]');
        publicBytes = Buffer.from(clean);
      }
      if (privatePaths.some(value => publicBytes.includes(Buffer.from(value)))) throw new Error('Unsanitizable private identity in packet attachment');
      freeze(join(destination, packetPath), publicBytes);
      included.push({ path: packetPath, originalHash, packetHash: hash(publicBytes), treatment: publicBytes.equals(bytes) ? 'unchanged' : 'path-scrubbed' });
    }
  }
  const publicCell = (cell: Execution) => cell.kind === 'passed' || cell.kind === 'failed' ? { kind: cell.kind, selected: cell.selected } : { kind: cell.kind, reason: 'reason' in cell ? cell.reason : 'unavailable' };
  freeze(join(destination, 'executions.json'), encode({ correct: correct.map(publicCell), changed: changed.map(publicCell) }));
  freeze(join(destination, 'evidence-manifest.json'), encode({ version: 1, included, omitted, rawEvidenceRetainedPrivately: true }));
  const evidenceHash = hash(encode(sortedHashes(fileHashes(destination))));
  freeze(join(destination, 'packet.json'), encode({ version: 1, packetId, evidenceHash, humanVerdicts: ['intended-bug', 'unrelated-failure', 'qualifying-miss', 'nonqualifying-miss', 'uncertain'] }));
  return { packetId, evidenceHash };
}

/** Checks packet bytes while keeping the private slot and variant join outside review evidence. */
function verifyPacket(directory: string, reference: z.infer<typeof packetRefSchema>): void {
  const path = inside(directory, `packets/${reference.packetId}`);
  const index = z.object({ version: z.literal(1), packetId: opaque, evidenceHash: digest, humanVerdicts: z.array(text) }).strict().parse(json(join(path, 'packet.json')));
  const files = sortedHashes(fileHashes(path));
  delete files['packet.json'];
  if (index.packetId !== reference.packetId || index.evidenceHash !== reference.evidenceHash || hash(encode(files)) !== reference.evidenceHash) throw new Error('Blind packet bytes changed');
}

/** Imports and grades one baseline first attempt on all six predefined fresh launches. */
export function gradeConnected(directory: string, runId: string, submission?: string): Grade {
  directory = resolve(directory);
  const { bank, bankHash, corpus } = loadBank(directory);
  const plan = readPlan(directory, bank, bankHash);
  const slot = plan.value.runs.find(item => item.id === runId);
  if (!slot) throw new Error('Baseline grading accepts only a frozen baseline identity, never calibration');
  const fixture = corpus.find(item => item.id === slot.fixture)!;
  const resultPath = join(directory, 'grades', `${slot.id}.json`);
  if (existsSync(resultPath)) {
    const previous = sealed(resultPath, gradeSchema).value;
    const veto = operatorVeto(directory, 'baseline', slot.id);
    if (previous.admission === 'admitted' && veto) throw new Error(veto.reason);
    verifyGrade(directory, bank, bankHash, plan, previous);
    if (submission && previous.testHash && hash(readFileSync(join(submission, 'tests/requirement.e2e.ts'))) !== previous.testHash) throw new Error('Baseline submitted bytes changed');
    return previous;
  }
  let terminal: ReturnType<typeof readTerminal> | null = null;
  let imported: ReturnType<typeof importSubmission> | null = null;
  let admission: Grade['admission'] = 'admitted';
  let reason: string | null = null;
  try {
    terminal = readTerminal(directory, bank, bankHash, slot, 'baseline', plan);
    const state = usageState(terminal.value, plan.value.budget);
    if (state === 'cutoff') { admission = 'cutoff'; reason = terminal.value.stopReason; }
    else if (terminal.value.status !== 'completed' || terminal.value.stopReason !== 'completed' || terminal.value.cleanup.finalizer !== 'passed') { admission = 'rejected'; reason = `terminal-${terminal.value.status}`; }
    else if (state === 'exceeded') { admission = 'budget-exceeded'; reason = 'known-authoring-overrun'; }
    else if (state === 'unknown') { admission = 'usage-unknown'; reason = 'incomplete-authoring-usage'; }
    if (admission === 'admitted') {
      if (!submission) throw new Error('Missing returned export path');
      imported = importSubmission(directory, slot, terminal, submission);
      submissionContract(imported.source.toString('utf8'));
    }
  } catch (error) {
    const terminalPath = join(directory, 'attempts/baseline', slot.id, 'terminal.json');
    admission = existsSync(terminalPath) ? 'rejected' : 'missing';
    reason = error instanceof Error ? error.message : String(error);
  }
  let correct: Repeats = notExecuted(reason ?? 'not-admitted');
  const members: Grade['members'] = fixture.variants.map(variant => ({ id: variant.id, changed: notExecuted(reason ?? 'not-admitted'), packet: null })) as Grade['members'];
  if (admission === 'admitted' && imported) {
    seal(join(directory, 'grades', slot.id, 'inputs.json'), { bankHash, planHash: plan.hash, terminalHash: terminal!.hash, submissionHash: imported.submissionHash, testHash: imported.testHash });
    correct = [executionCell(directory, `grades/${slot.id}/cells/correct-1.json`, fixture, imported.source, 'correct', bank.runtimeHash), executionCell(directory, `grades/${slot.id}/cells/correct-2.json`, fixture, imported.source, 'correct', bank.runtimeHash)];
    for (const member of members) {
      const position = fixture.variants.findIndex(variant => variant.id === member.id);
      member.changed = [executionCell(directory, `grades/${slot.id}/cells/member-${position + 1}-1.json`, fixture, imported.source, member.id, bank.runtimeHash), executionCell(directory, `grades/${slot.id}/cells/member-${position + 1}-2.json`, fixture, imported.source, member.id, bank.runtimeHash)];
      try {
        const refPath = join(directory, 'grades', slot.id, `packet-${position + 1}.json`);
        member.packet = existsSync(refPath) ? sealed(refPath, packetRefSchema).value : reviewPacket(directory, bank, fixture, imported.source, correct, member.changed);
        verifyPacket(directory, member.packet);
        seal(refPath, member.packet);
        seal(join(directory, 'private-joins', `${member.packet.packetId}.json`), { version: 1, packetId: member.packet.packetId, evidenceHash: member.packet.evidenceHash, id: slot.id, variant: member.id, bankHash, planHash: plan.hash, terminalHash: terminal!.hash, submissionHash: imported.submissionHash });
      } catch (error) { reason = `packet-unavailable: ${error instanceof Error ? error.message : error}`; }
    }
  }
  const rawTerminal = join(directory, 'attempts/baseline', slot.id, 'terminal.json');
  const terminalHash = terminal?.hash ?? (existsSync(rawTerminal) ? hash(readFileSync(rawTerminal)) : null);
  const result = gradeSchema.parse({ version: 3, kind: 'connected-baseline-grade', id: slot.id, bankHash, planHash: plan.hash, terminalHash, submissionHash: imported?.submissionHash ?? null, testHash: imported?.testHash ?? null, admission, reason, correct, members });
  seal(resultPath, result);
  return result;
}

/** Validates grades, retained raw evidence, exact submission bytes and private packet joins. */
function verifyGrade(directory: string, bank: Bank, bankHash: string, plan: { value: Plan; hash: string }, grade: Grade): void {
  const slot = plan.value.runs.find(item => item.id === grade.id);
  if (!slot || grade.bankHash !== bankHash || grade.planHash !== plan.hash) throw new Error('Grade does not bind the fixed baseline plan');
  const fixture = parseCorpus(json(join(directory, 'corpus.json'))).find(item => item.id === slot.fixture)!;
  if (!isDeepStrictEqual(grade.members.map(member => member.id), fixture.variants.map(variant => variant.id))) throw new Error('Grade bank membership changed');
  verifyExecutions(directory, [...grade.correct, ...grade.members.flatMap(member => member.changed)]);
  if (grade.submissionHash && hash(encode(sortedHashes(fileHashes(join(directory, 'submissions', slot.id))))) !== grade.submissionHash) throw new Error('Frozen submission changed');
  if (grade.testHash && hash(readFileSync(join(directory, 'submissions', slot.id, 'tests/requirement.e2e.ts'))) !== grade.testHash) throw new Error('Frozen test changed');
  const terminalPath = join(directory, 'attempts/baseline', slot.id, 'terminal.json');
  if (grade.terminalHash && hash(readFileSync(terminalPath)) !== grade.terminalHash) throw new Error('Frozen operator terminal changed');
  for (const member of grade.members) if (member.packet) {
    verifyPacket(directory, member.packet);
    const joinRecord = sealed(join(directory, 'private-joins', `${member.packet.packetId}.json`), z.object({ version: z.literal(1), packetId: opaque, evidenceHash: digest, id: opaque, variant: text, bankHash: digest, planHash: digest, terminalHash: digest, submissionHash: digest }).strict()).value;
    if (joinRecord.packetId !== member.packet.packetId || joinRecord.evidenceHash !== member.packet.evidenceHash || joinRecord.id !== slot.id || joinRecord.variant !== member.id || joinRecord.bankHash !== bankHash || joinRecord.planHash !== plan.hash || joinRecord.terminalHash !== grade.terminalHash || joinRecord.submissionHash !== grade.submissionHash) throw new Error('Private review join changed');
  }
}

const memberStateSchema = z.enum(['not-executed', 'invalid-correct-app', 'unusable-execution', 'inconsistent', 'pending-human', 'detected', 'qualifying-miss', 'nonqualifying-miss', 'unrelated-failure', 'uncertain']);
const memberOutcomeSchema = z.object({ id: text, state: memberStateSchema, packetId: opaque.nullable(), reason: text.nullable() }).strict();
const slotReportSchema = z.object({ id: opaque, fixture: z.enum(fixtureIds), classification: z.enum(['informative', 'safeguard']), order: count, state: z.enum(['unstarted', 'started-without-terminal', 'terminal-invalid', 'admission-failed', 'phase-evidence-failed', 'cutoff', 'missing-output', 'invalid-output', 'launch-failed', 'export-failed', 'receipt-failed', 'cleanup-failed', 'resource-failed', 'awaiting-grade', 'submission-rejected', 'usage-unknown', 'budget-exceeded', 'missing', 'not-executed', 'unusable-execution', 'inconsistent', 'correct-app-invalid', 'pending-human', 'uncertain', 'graded']), reason: text.nullable(), terminalHash: digest.nullable(), stopReason: text.nullable(), usage: usageSchema.nullable(), usageComplete: z.boolean().nullable(), budget: z.enum(['within', 'exceeded', 'unknown', 'cutoff']).nullable(), cleanup: cleanupSchema.nullable(), members: z.array(memberOutcomeSchema).length(2), detected: count.max(2), bankSize: z.literal(2), fractionDetected: z.number().min(0).max(1).nullable() }).strict();
type MemberOutcome = z.infer<typeof memberOutcomeSchema>;
type SlotReport = z.infer<typeof slotReportSchema>;
const gateSchema = z.discriminatedUnion('order', [
  z.object({ order: z.literal(1), decision: z.literal('design-rejected'), reason: text }).strict(),
  z.object({ order: z.literal(2), decision: z.literal('unresolved-operational-feasibility'), reason: text }).strict(),
  z.object({ order: z.literal(3), decision: z.literal('observed-ceiling'), reason: text }).strict(),
  z.object({ order: z.literal(4), decision: z.literal('observed-qualifying-distributed-headroom'), reason: text }).strict(),
  z.object({ order: z.literal(5), decision: z.literal('insufficient-qualifying-distributed-headroom'), reason: text }).strict(),
]);
const summarySchema = z.object({ version: z.literal(3), study: z.literal('connected-baseline-feasibility'), bankHash: digest, planHash: digest.nullable(), comparisonAuthorized: z.literal(false), authoredSuiteIsUnit: z.literal(true), repeatedAndMemberOutcomesAreCorrelated: z.literal(true), scheduledBaseline: z.literal(12), calibrationAttempts: z.literal(6), controlLaunches: z.literal(108), scheduledBaselineExecutionCells: z.literal(72), completedBaselineExecutionCells: count.max(72), budget: budgetSchema.nullable(), budgetInterpretation: text, gate: gateSchema, operatorFailures: z.array(z.object({ path: text, hash: digest }).strict()), informativeFamiliesWithMiss: z.array(z.enum(fixtureIds)), humanAttributionPending: count.max(24), missedBankMembers: count.max(24), usableSlots: count.max(12), calibration: z.array(slotSchema.extend({ state: text, reason: text.nullable(), usage: usageSchema.nullable(), stopReason: text.nullable(), valid: z.boolean() }).strict()).length(6), rows: z.array(z.object({ fixture: z.enum(fixtureIds), classification: z.enum(['informative', 'safeguard']), scheduled: z.literal(2), usable: count.max(2), detected: count.max(4), qualifyingMisses: count.max(4), nonqualifyingMisses: count.max(4), states: z.array(slotReportSchema.shape.state).length(2) }).strict()).length(6), slots: z.array(slotReportSchema).length(12), pendingHumanPackets: z.array(packetRefSchema).max(24) }).strict();

/** Joins repeated execution with an independent human verdict on the full applicable evidence. */
function memberOutcome(grade: Grade, member: Grade['members'][number], review: Human | undefined): MemberOutcome {
  const base = { id: member.id, packetId: member.packet?.packetId ?? null };
  if (grade.admission !== 'admitted') return { ...base, state: 'not-executed', reason: grade.reason ?? grade.admission };
  if ([...grade.correct, ...member.changed].some(cell => cell.kind === 'not-executed' || cell.kind === 'unusable')) return { ...base, state: 'unusable-execution', reason: 'A predefined launch did not establish test pass or failure' };
  if (!sameSelection([...grade.correct, ...grade.members.flatMap(item => item.changed)])) return { ...base, state: 'inconsistent', reason: 'The exact suite selected different tests across its six launches' };
  if (new Set(grade.correct.map(cell => cell.kind)).size !== 1 || new Set(member.changed.map(cell => cell.kind)).size !== 1) return { ...base, state: 'inconsistent', reason: 'The two predefined launches disagree' };
  if (!grade.correct.every(cell => cell.kind === 'passed')) return { ...base, state: 'invalid-correct-app', reason: 'The authored suite fails the correct app' };
  if (!member.packet || !review) return { ...base, state: 'pending-human', reason: member.packet ? 'Blind human attribution is required' : grade.reason ?? 'Blind packet unavailable' };
  if (review.packetId !== member.packet.packetId || review.evidenceHash !== member.packet.evidenceHash) throw new Error('Human judgment does not bind this packet');
  if (review.verdict === 'uncertain') return { ...base, state: 'uncertain', reason: review.reason };
  const changedPassed = member.changed.every(cell => cell.kind === 'passed');
  if (changedPassed && !['qualifying-miss', 'nonqualifying-miss'].includes(review.verdict)) throw new Error('Passing changed executions require a human qualifying or nonqualifying miss judgment');
  if (!changedPassed && !['intended-bug', 'unrelated-failure'].includes(review.verdict)) throw new Error('Failed changed executions require a human relevance judgment');
  return { ...base, state: review.verdict === 'intended-bug' ? 'detected' : review.verdict, reason: review.reason };
}

/** Imports human and exploratory AI records through separate strict boundaries. */
function importReviews(directory: string, grades: Grade[], reviewFile?: string, aiFile?: string): Map<string, Human> {
  const known = new Map(grades.flatMap(grade => grade.members.filter(member => member.packet).map(member => [member.packet!.packetId, member.packet!] as const)));
  if (reviewFile) {
    const incoming = z.array(humanSchema).parse(json(reviewFile));
    if (new Set(incoming.map(review => review.packetId)).size !== incoming.length) throw new Error('Duplicate human packet judgments');
    for (const review of incoming) {
      if (known.get(review.packetId)?.evidenceHash !== review.evidenceHash) throw new Error('Unknown or changed human review evidence');
      seal(join(directory, 'judgments/human', `${review.packetId}.json`), review);
    }
  }
  if (aiFile) {
    const incoming = z.array(aiSchema).parse(json(aiFile));
    if (new Set(incoming.map(review => review.packetId)).size !== incoming.length) throw new Error('Duplicate exploratory AI packet judgments');
    for (const review of incoming) {
      if (known.get(review.packetId)?.evidenceHash !== review.evidenceHash) throw new Error('Unknown or changed exploratory AI review evidence');
      seal(join(directory, 'judgments/exploratory-ai', `${review.packetId}.json`), review);
    }
  }
  const reviews = new Map<string, Human>();
  const folder = join(directory, 'judgments/human');
  if (existsSync(folder)) for (const file of readdirSync(folder).filter(path => path.endsWith('.json'))) {
    const review = sealed(join(folder, file), humanSchema).value;
    if (file !== `${review.packetId}.json` || known.get(review.packetId)?.evidenceHash !== review.evidenceHash || reviews.has(review.packetId)) throw new Error('Stored human judgment does not bind exactly one current packet');
    reviews.set(review.packetId, review);
  }
  return reviews;
}

/** Accounts for every prospective baseline slot before and after its first attempt. */
function slotReport(directory: string, bank: Bank, bankHash: string, plan: { value: Plan; hash: string } | null, slot: Slot, fixture: ConnectedFixture, grade: Grade | undefined, reviews: Map<string, Human>): SlotReport {
  const base: SlotReport = { id: slot.id, fixture: slot.fixture, classification: fixture.classification, order: slot.order, state: 'unstarted', reason: plan ? null : 'Common budget and baseline plan are not sealed', terminalHash: null, stopReason: null, usage: null, usageComplete: null, budget: null, cleanup: null, members: fixture.variants.map(variant => ({ id: variant.id, state: 'not-executed', packetId: null, reason: 'First attempt has not returned' })), detected: 0, bankSize: 2, fractionDetected: null };
  const started = join(directory, 'attempts/baseline', slot.id, 'started.json');
  const terminalPath = join(directory, 'attempts/baseline', slot.id, 'terminal.json');
  const veto = operatorVeto(directory, 'baseline', slot.id);
  if (veto) return { ...base, ...vetoedObservations(terminalPath), state: existsSync(started) ? veto.state : existsSync(terminalPath) ? 'terminal-invalid' : 'unstarted', reason: veto.reason, terminalHash: existsSync(terminalPath) ? hash(readFileSync(terminalPath)) : null };
  if (!existsSync(started)) {
    if (existsSync(terminalPath) || grade) return { ...base, state: 'terminal-invalid', reason: 'Terminal or grade has no first-attempt started marker' };
    return base;
  }
  if (!existsSync(terminalPath)) return { ...base, state: 'started-without-terminal', reason: 'First attempt started but has no retained terminal receipt' };
  if (!plan) return { ...base, state: 'terminal-invalid', reason: 'Baseline started before its common budget and plan were sealed' };
  let terminal: ReturnType<typeof readTerminal>;
  try { terminal = readTerminal(directory, bank, bankHash, slot, 'baseline', plan); }
  catch (error) { return { ...base, state: 'terminal-invalid', reason: error instanceof Error ? error.message : String(error), terminalHash: hash(readFileSync(terminalPath)) }; }
  const value = terminal.value;
  const state = usageState(value, plan.value.budget);
  Object.assign(base, { terminalHash: terminal.hash, stopReason: value.stopReason, usage: value.usage, usageComplete: value.usageComplete, budget: state, cleanup: value.cleanup });
  if (state === 'cutoff') return { ...base, state: 'cutoff', reason: value.stopReason };
  if (value.status !== 'completed') return { ...base, state: value.status, reason: value.failure ?? value.stopReason };
  if (value.cleanup.finalizer !== 'passed') return { ...base, state: 'cleanup-failed', reason: 'Owned finalizer did not pass' };
  if (state === 'exceeded') return { ...base, state: 'budget-exceeded', reason: 'A known measured authoring limit was exceeded' };
  if (state === 'unknown') return { ...base, state: 'usage-unknown', reason: 'Full completed-response usage is unavailable or unreconciled' };
  if (!grade) return { ...base, state: 'awaiting-grade', reason: 'Returned first attempt has not been graded' };
  if (grade.admission !== 'admitted') return { ...base, state: grade.admission === 'rejected' ? 'submission-rejected' : grade.admission, reason: grade.reason };
  base.members = grade.members.map(member => memberOutcome(grade, member, member.packet ? reviews.get(member.packet.packetId) : undefined));
  base.detected = base.members.filter(member => member.state === 'detected').length;
  const unresolved = base.members.find(member => ['not-executed', 'unusable-execution', 'inconsistent', 'invalid-correct-app', 'pending-human', 'uncertain'].includes(member.state));
  if (unresolved) return { ...base, detected: 0, state: unresolved.state === 'invalid-correct-app' ? 'correct-app-invalid' : slotReportSchema.shape.state.parse(unresolved.state), reason: unresolved.reason };
  return { ...base, state: 'graded', reason: null, fractionDetected: base.detected / 2 };
}

const designReviewSchema = z.object({ version: z.literal(1), kind: z.literal('independent-design-review'), bankHash: digest, reviewer: text, verdict: z.enum(['accepted', 'rejected']), reason: text }).strict();

/** Derives the complete ordered feasibility gate without authorizing a comparison. */
export function summarizeConnected(directory: string, reviewFile?: string, aiFile?: string, designFile?: string) {
  directory = resolve(directory);
  const { bank, bankHash, corpus } = loadBank(directory);
  const plan = existsSync(join(directory, 'plan.json')) ? readPlan(directory, bank, bankHash, 'report') : null;
  const operatorFailures = ['operator/admission-failure.json', 'attempts/calibration/evidence-failure.json', 'attempts/baseline/evidence-failure.json', ...bank.calibration.map(slot => `attempts/calibration/${slot.id}/receipt-failure.json`), ...bank.prospectiveBaseline.map(slot => `attempts/baseline/${slot.id}/receipt-failure.json`)].filter(path => existsSync(join(directory, path))).map(path => ({ path, hash: hash(readFileSync(join(directory, path))) }));
  const grades: Grade[] = [];
  for (const slot of bank.prospectiveBaseline) {
    const path = join(directory, 'grades', `${slot.id}.json`);
    if (!existsSync(path)) continue;
    if (!plan) throw new Error('Baseline grade exists before plan freeze');
    const grade = sealed(path, gradeSchema).value;
    if (grade.id !== slot.id) throw new Error('Grade filename and identity disagree');
    verifyGrade(directory, bank, bankHash, plan, grade);
    grades.push(grade);
  }
  const reviews = importReviews(directory, grades, reviewFile, aiFile);
  if (designFile) {
    const review = designReviewSchema.parse(json(designFile));
    if (review.bankHash !== bankHash) throw new Error('Design review does not bind this bank');
    seal(join(directory, 'judgments/design.json'), review);
  }
  const design = existsSync(join(directory, 'judgments/design.json')) ? sealed(join(directory, 'judgments/design.json'), designReviewSchema).value : null;
  if (design && design.bankHash !== bankHash) throw new Error('Stored design review changed bank');
  const slots = bank.prospectiveBaseline.map(slot => slotReport(directory, bank, bankHash, plan, slot, corpus.find(fixture => fixture.id === slot.fixture)!, grades.find(grade => grade.id === slot.id), reviews));
  const calibration = bank.calibration.map(slot => {
    const started = join(directory, 'attempts/calibration', slot.id, 'started.json');
    const terminalPath = join(directory, 'attempts/calibration', slot.id, 'terminal.json');
    const resultPath = join(directory, 'calibration', `${slot.id}.json`);
    const veto = operatorVeto(directory, 'calibration', slot.id);
    if (veto) {
      const observations = vetoedObservations(terminalPath);
      return { ...slot, state: existsSync(started) ? veto.state : existsSync(terminalPath) ? 'terminal-invalid' : 'unstarted', reason: veto.reason, usage: observations?.usage ?? null, stopReason: observations?.stopReason ?? null, valid: false };
    }
    if (!existsSync(started)) return { ...slot, state: 'unstarted', reason: null, usage: null, stopReason: null, valid: false };
    if (!existsSync(terminalPath)) return { ...slot, state: 'started-without-terminal', reason: 'Terminal receipt missing', usage: null, stopReason: null, valid: false };
    try {
      const terminal = readTerminal(directory, bank, bankHash, slot, 'calibration', null);
      const state = usageState(terminal.value, calibrationCeiling);
      if (terminal.value.status !== 'completed' || state !== 'within') return { ...slot, state: state === 'cutoff' ? 'cutoff' : terminal.value.status === 'completed' ? `usage-${state}` : terminal.value.status, reason: terminal.value.failure, usage: terminal.value.usage, stopReason: terminal.value.stopReason, valid: false };
      if (!existsSync(resultPath)) return { ...slot, state: 'awaiting-correct-validation', reason: null, usage: terminal.value.usage, stopReason: terminal.value.stopReason, valid: false };
      const result = sealed(resultPath, calibrationSchema).value;
      verifyExecutions(directory, result.correct);
      if (result.id !== slot.id || result.bankHash !== bankHash || result.terminalHash !== terminal.hash) throw new Error('Calibration result binding changed');
      return { ...slot, state: result.valid ? 'valid' : 'correct-validation-invalid', reason: null, usage: terminal.value.usage, stopReason: terminal.value.stopReason, valid: result.valid };
    } catch (error) { return { ...slot, state: 'record-invalid', reason: error instanceof Error ? error.message : String(error), usage: null, stopReason: null, valid: false }; }
  });
  const informativeFamiliesWithMiss = fixtureIds.filter(id => slots.some(slot => slot.fixture === id && slot.classification === 'informative' && slot.members.some(member => member.state === 'qualifying-miss')));
  const missed = slots.flatMap(slot => slot.members).filter(member => ['qualifying-miss', 'nonqualifying-miss', 'unrelated-failure'].includes(member.state)).length;
  const humanAttributionPending = slots.flatMap(slot => slot.members).filter(member => ['pending-human', 'uncertain'].includes(member.state)).length;
  const usable = slots.every(slot => slot.state === 'graded');
  const gate = design?.verdict === 'rejected' ? { order: 1, decision: 'design-rejected', reason: design.reason } : !usable || !plan || operatorFailures.length || calibration.some(slot => !slot.valid) ? { order: 2, decision: 'unresolved-operational-feasibility', reason: 'Every fixed slot, usage record, independent launch and required human judgment must be resolved' } : missed === 0 ? { order: 3, decision: 'observed-ceiling', reason: 'All twelve usable suites detect their complete two-member bank' } : informativeFamiliesWithMiss.length >= 2 ? { order: 4, decision: 'observed-qualifying-distributed-headroom', reason: 'Qualifying misses occur in at least two informative families' } : { order: 5, decision: 'insufficient-qualifying-distributed-headroom', reason: 'The complete judged stage lacks misses in two informative families' };
  const rows = fixtureIds.map(id => {
    const assigned = slots.filter(slot => slot.fixture === id);
    return { fixture: id, classification: corpus.find(fixture => fixture.id === id)!.classification, scheduled: assigned.length, usable: assigned.filter(slot => slot.state === 'graded').length, detected: assigned.reduce((sum, slot) => sum + slot.detected, 0), qualifyingMisses: assigned.flatMap(slot => slot.members).filter(member => member.state === 'qualifying-miss').length, nonqualifyingMisses: assigned.flatMap(slot => slot.members).filter(member => ['nonqualifying-miss', 'unrelated-failure'].includes(member.state)).length, states: assigned.map(slot => slot.state) };
  });
  const report = summarySchema.parse({ version: 3, study: bank.study, bankHash, planHash: plan?.hash ?? null, comparisonAuthorized: false, authoredSuiteIsUnit: true, repeatedAndMemberOutcomesAreCorrelated: true, scheduledBaseline: 12, calibrationAttempts: 6, controlLaunches: 108, scheduledBaselineExecutionCells: 72, completedBaselineExecutionCells: grades.flatMap(grade => [...grade.correct, ...grade.members.flatMap(member => member.changed)]).filter(cell => cell.kind !== 'not-executed').length, budget: plan?.value.budget ?? null, budgetInterpretation: 'Operational reserve from all six correct-only complete calibration attempts; no cutoff guarantee or tail probability estimate', gate, operatorFailures, informativeFamiliesWithMiss, humanAttributionPending, missedBankMembers: missed, usableSlots: slots.filter(slot => slot.state === 'graded').length, calibration, rows, slots, pendingHumanPackets: grades.flatMap(grade => grade.members.flatMap(member => member.packet && slots.find(slot => slot.id === grade.id)!.members.some(outcome => outcome.id === member.id && ['pending-human', 'uncertain'].includes(outcome.state)) ? [{ packetId: member.packet.packetId, evidenceHash: member.packet.evidenceHash }] : [])) });
  const markdown = `# Connected baseline feasibility\n\nDecision is ${gate.decision}, ordered gate ${gate.order}. ${gate.reason}. Comparison authorization is false.\n\nThe stage schedules twelve first-attempt suites, two per fixture. Six separate correct-only calibration attempts select one common budget. Repeats and bank members are correlated outcomes of each authored suite.\n\nUsable slots ${report.usableSlots}/12. Pending human attributions ${humanAttributionPending}. Informative families with qualifying misses ${informativeFamiliesWithMiss.length}.\n\n| Fixture | Kind | Scheduled | Usable | Detected members | Qualifying misses | Other misses |\n| --- | --- | ---: | ---: | ---: | ---: | ---: |\n${rows.map(row => `| ${row.fixture} | ${row.classification} | ${row.scheduled} | ${row.usable} | ${row.detected} | ${row.qualifyingMisses} | ${row.nonqualifyingMisses} |`).join('\n')}\n\n| Slot | Fixture | State | Stop reason | Detected fraction |\n| --- | --- | --- | --- | --- |\n${slots.map(slot => `| ${slot.id} | ${slot.fixture} | ${slot.state} | ${slot.stopReason ?? 'unavailable'} | ${slot.fractionDetected === null ? 'unresolved' : slot.fractionDetected} |`).join('\n')}\n\nBudget is ${plan ? `${plan.value.budget.maxTurns} completed responses, ${plan.value.budget.maxTokens} full reported tokens, ${plan.value.budget.wallTimeSeconds} authoring seconds` : 'not sealed'}. Cached and repeated input remain included. Authoritative cutoffs remain cutoffs after late usage. Natural cleanup and owned finalizer results remain separate in every private slot record.\n`;
  mkdirSync(join(directory, 'reports'), { recursive: true });
  writeFileSync(join(directory, 'reports/summary.json'), encode(report));
  writeFileSync(join(directory, 'reports/summary.md'), markdown);
  return { report, markdown };
}

/** Verifies all frozen lower, control, snapshot and patch reconstruction evidence without new launches. */
export function verifyConnectedBank(directory: string) {
  directory = resolve(directory);
  const { bank, bankHash, corpus } = loadBank(directory);
  const controls = z.array(controlSchema).length(108).parse(json(join(directory, 'controls/results.json')));
  const lower = z.array(lowerSchema).length(36).parse(json(join(directory, 'lower/results.json')));
  verifyExecutions(directory, controls.map(control => control.execution));
  for (const result of lower) if (hash(encode(sortedHashes(fileHashes(inside(directory, result.evidence))))) !== result.evidenceHash) throw new Error('Lower-test evidence changed');
  for (const fixture of corpus) {
    const snapshot = sealed(join(directory, 'source', `snapshot-${fixture.id}.json`), hashes).value;
    if (!isDeepStrictEqual(sortedHashes(fileHashes(join(directory, 'snapshots', fixture.id))), snapshot)) throw new Error('Public snapshot changed');
    for (const [path, source] of Object.entries(fixture.files)) if (!readFileSync(join(directory, 'snapshots', fixture.id, path)).equals(Buffer.from(source))) throw new Error('Snapshot differs from frozen corpus');
    for (const variant of fixture.variants) {
      const patch = sealed(join(directory, 'source', `patch-${variant.id}.json`), z.object({ id: text, file: text, beforeHash: digest, afterHash: digest, replacementHash: digest, ruleIds: z.array(text), weight: z.literal(1) }).strict()).value;
      const source = fixture.files[variant.mutationFile]!;
      if (patch.id !== variant.id || patch.file !== variant.mutationFile || patch.beforeHash !== hash(source) || patch.afterHash !== hash(source.replace(variant.mutation[0], variant.mutation[1])) || patch.replacementHash !== hash(encode(variant.mutation)) || !isDeepStrictEqual(patch.ruleIds, variant.ruleIds)) throw new Error('Frozen single-location patch changed');
    }
  }
  for (const [slots, phase] of [[bank.calibration, 'calibration'], [bank.prospectiveBaseline, 'baseline']] as const) for (const slot of slots) readProject(directory, bank, slot, phase);
  return { version: 3, bankHash, lowerLaunches: lower.length, controlLaunches: controls.length, allPassed: controls.every(control => control.valid) && lower.every(result => result.valid), comparisonAuthorized: false };
}
