import { createHash, randomUUID } from 'node:crypto';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { createConnection } from 'node:net';
import { mkdir, mkdtemp, writeFile, readFile, readdir, rename, lstat, realpath, link, rm, rmdir } from 'node:fs/promises';
import { basename, dirname, join, resolve, isAbsolute, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { ConfigurationError, EngineError, parseKey, type EngineCleanupContext } from 'e2e/engine';
import type { TernLease, TernProvider, TernRequest } from '@e2e-dev/tern';
import { requireNativeGate } from '@e2e-dev/tern';
import { processIdentity, stillOwned, ownedDirectory, childPids, type ProcessIdentity } from './ownership.ts';
export { processIdentity, stillOwned, ownedDirectory, ownedDescendant, type ProcessIdentity } from './ownership.ts';
const exec = promisify(execFile);

export type ParentLaunchRecovery = {readonly kind:'PROCESS';readonly identity:ProcessIdentity}|{readonly kind:'NEVER_LAUNCHED'}|{readonly kind:'UNKNOWN'};
export interface OwnedWaylandParent {
  readonly runtimeDir: string;
  readonly waylandDisplay: string;
  /** Concrete owned guest context; input helper pins namespace/root FDs before entry. */
  readonly guest?:{readonly target:ProcessIdentity;readonly nsenter:string};
  /** The parent owns silent placement policy; no uncontained direct host spawn. */
  launch(binary: string, args: readonly string[], env: Readonly<Record<string, string>>, identityFile: string, signal: AbortSignal): Promise<ProcessIdentity>;
  /** NEVER_LAUNCHED requires a closed host-private dispatch fence, not a missing guest receipt. */
  recover?(identityFile:string,signal:AbortSignal):Promise<ParentLaunchRecovery>;
  guard?(signal: AbortSignal): Promise<() => Promise<void>>;
}
export interface SwayOptions {
  readonly binaries: { readonly sway: string; readonly swaymsg: string; readonly tern: string; readonly grim: string; readonly input: string };
  readonly size?: { readonly width: number; readonly height: number };
  readonly env?: Readonly<Record<string, string>>;
  readonly root?: string;
  /** Host-private cleanup authority; never bind this directory or an ancestor into a guest. */
  readonly journalRoot?: string;
  /** Host-created Sway configuration, exposed read-only to a guest if present. */
  readonly configurationRoot?:string;
  readonly parent?: OwnedWaylandParent;
}
export interface SwayDisplay {
  readonly id: string;
  readonly seat: string;
  readonly output: string;
  readonly env: Readonly<Record<string, string>>;
  readonly directory: string;
  readonly controlBinary:string;
  readonly nativeClient: ProcessIdentity | undefined;
  tap(x: number, y: number, signal: AbortSignal): Promise<void>;
  spawn(binary: string, args: readonly string[], signal: AbortSignal): Promise<ProcessIdentity>;
  focusClient(pid: number, signal: AbortSignal): Promise<void>;
  type(text: string, signal: AbortSignal): Promise<void>;
  press(key: string, signal: AbortSignal): Promise<void>;
  pointer(x: number, y: number, button: boolean, signal: AbortSignal): Promise<void>;
  capture(signal: AbortSignal): Promise<Buffer>;
  release(context: EngineCleanupContext): Promise<void>;
}
interface LeaseRecord { version: 2; runId: string; targetName: string; directory: string; journalDirectory: string; processes: ProcessIdentity[]; parentPending?:string; configPath?:string; runtimeIdentity?:{dev:number;ino:number} }
interface RuntimeRootRecord {version:1;runId:string;targetName:string;directory:string;stage:string;dev:number;ino:number}
interface Container { id: number; pid?: number | null; rect: { x: number; y: number; width: number; height: number }; nodes?: Container[]; floating_nodes?: Container[] }
interface Seat { name: string; focus: number }
const keyNames: Readonly<Record<string, string>> = { Enter: 'Return', Escape: 'Escape', Tab: 'Tab', Backspace: 'BackSpace', Delete: 'Delete', Insert: 'Insert', Space: 'space', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Home: 'Home', End: 'End', PageUp: 'Prior', PageDown: 'Next', F1: 'F1', F2: 'F2', F3: 'F3', F4: 'F4', F5: 'F5', F6: 'F6', F7: 'F7', F8: 'F8', F9: 'F9', F10: 'F10', F11: 'F11', F12: 'F12' };
const modifiers: Readonly<Record<string, number>> = { Shift: 1, Control: 2, ControlOrMeta: 2, Alt: 4, Meta: 8 };
const runtimePrefix=(options:SwayOptions)=>resolve(options.root??join(tmpdir(),`e2e-sway-${process.getuid?.()}`));
const journalPrefix=(options:SwayOptions)=>resolve(options.journalRoot??`${runtimePrefix(options)}-j`);
const scopeHash=(runId:string,target:string)=>createHash('sha256').update(runId).update('\0').update(target).digest('hex').slice(0,24);
const runDirectory=(options:SwayOptions,runId:string,target:string)=>join(runtimePrefix(options),scopeHash(runId,target));
const journalRunDirectory=(options:SwayOptions,runId:string,target:string)=>join(journalPrefix(options),scopeHash(runId,target));
async function canonicalPrefix(path:string):Promise<string>{const suffix:string[]=[];for(;;){try{return join(await realpath(path),...suffix);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;suffix.unshift(basename(path));path=dirname(path);}}}
async function journalBoundary(options:SwayOptions):Promise<void>{
  if((options.root!==undefined&&!isAbsolute(options.root))||(options.journalRoot!==undefined&&!isAbsolute(options.journalRoot)))throw new ConfigurationError('INVALID_CONFIG','Runtime and journal prefixes must be absolute');
  const runtime=runtimePrefix(options),journal=journalPrefix(options);
  if(journal===runtime||journal.startsWith(runtime+sep))throw new ConfigurationError('INVALID_CONFIG','Cleanup journals must be separate from runtime writes');
  const actualRuntime=await canonicalPrefix(runtime),actualJournal=await canonicalPrefix(journal);
  if(actualJournal===actualRuntime||actualJournal.startsWith(actualRuntime+sep))throw new ConfigurationError('INVALID_CONFIG','Cleanup journals resolve beneath runtime writes');
}
async function directoryInfo(path:string){try{return await lstat(path);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw error;}}
const sameDirectory=(info:Awaited<ReturnType<typeof directoryInfo>>,identity:{dev:number;ino:number})=>info?.isDirectory()===true&&info.dev===identity.dev&&info.ino===identity.ino&&info.uid===process.getuid?.()&&(info.mode&0o077)===0;
async function rootRecord(journal:string,runtime:string,runId:string,target:string):Promise<RuntimeRootRecord|undefined>{
  let record:RuntimeRootRecord;try{record=JSON.parse(await readFile(join(journal,'runtime-root.json'),'utf8')) as RuntimeRootRecord;}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw error;}
  if(record.version!==1||record.runId!==runId||record.targetName!==target||record.directory!==runtime||dirname(record.stage)!==journal||!/^run-stage-[A-Za-z0-9]{6}$/.test(basename(record.stage)))throw new EngineError('INVALID_STATE','Unowned runtime-root allocation record',{retryable:false});
  return record;
}
async function prepareRuntimeRoot(options:SwayOptions,request:TernRequest,journal:string,runtime:string):Promise<void>{
  let record=await rootRecord(journal,runtime,request.runId,request.targetName);
  if(!record){
    const stage=await mkdtemp(join(journal,'run-stage-')),info=await lstat(stage),proposal=join(journal,`root-proposal-${randomUUID()}.json`);
    const candidate:RuntimeRootRecord={version:1,runId:request.runId,targetName:request.targetName,directory:runtime,stage,dev:info.dev,ino:info.ino};
    await writeFile(proposal,JSON.stringify(candidate),{mode:0o600,flag:'wx'});
    try{await link(proposal,join(journal,'runtime-root.json'));record=candidate;}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;await rm(stage,{recursive:true});record=await rootRecord(journal,runtime,request.runId,request.targetName);}finally{await rm(proposal,{force:true});}
  }
  if(!record)throw new EngineError('INVALID_STATE','Runtime-root allocation lost private authority',{retryable:false});
  if(!options.parent?.guest){await mkdir(dirname(runtime),{recursive:true,mode:0o700});await ownedDirectory(dirname(runtime));}
  if(!sameDirectory(await directoryInfo(runtime),record)){
    try{await exec(options.binaries.input,['publish-root',record.stage,runtime,join(journal,'group.json')],{signal:request.signal,timeout:5000});}
    catch(error){if(request.signal.aborted||!sameDirectory(await directoryInfo(runtime),record))throw error;}
  }
  if(!sameDirectory(await directoryInfo(runtime),record))throw new EngineError('INVALID_STATE','Runtime root no longer matches its private staged identity',{retryable:false});
}
async function closePublication(directory:string,binary:string,context:EngineCleanupContext):Promise<void>{await exec(binary,['close',join(directory,'lease.json')],{env:{PATH:'/usr/bin:/bin'},signal:context.signal,timeout:Math.max(1,context.timeoutMs)});}
async function removeRuntime(record:LeaseRecord,options:SwayOptions,context:EngineCleanupContext):Promise<void>{
  if(!record.runtimeIdentity)return;const identity=record.runtimeIdentity,claim=join(record.journalDirectory,'claimed-runtime');
  if(!await directoryInfo(claim)){
    if(sameDirectory(await directoryInfo(join(record.journalDirectory,'runtime')),identity))return;
    const source=await directoryInfo(record.directory);if(!source)return;
    if(!sameDirectory(source,identity))throw new EngineError('INVALID_STATE','Runtime was replaced; retain cleanup evidence',{retryable:false});
    await exec(options.binaries.input,['claim-root',record.directory,claim,String(identity.dev),String(identity.ino)],{signal:context.signal,timeout:context.timeoutMs});
  }
  if(!sameDirectory(await directoryInfo(claim),identity))throw new EngineError('INVALID_STATE','Private runtime claim does not match owned inode; preserve it',{retryable:false});
  await rm(claim,{recursive:true});
}
async function removeRuntimeRoot(record:RuntimeRootRecord,options:SwayOptions,journal:string,context:EngineCleanupContext):Promise<void>{
  const claim=join(journal,'claimed-run-root');
  if(!await directoryInfo(claim)){
    if(sameDirectory(await directoryInfo(record.stage),record))return;
    const source=await directoryInfo(record.directory);if(!source)return;
    if(!sameDirectory(source,record))throw new EngineError('INVALID_STATE','Runtime run-root was replaced; retain evidence',{retryable:false});
    await exec(options.binaries.input,['claim-root',record.directory,claim,String(record.dev),String(record.ino)],{signal:context.signal,timeout:context.timeoutMs});
  }
  if(!sameDirectory(await directoryInfo(claim),record))throw new EngineError('INVALID_STATE','Private run-root claim does not match owned inode; preserve it',{retryable:false});
  try{await rmdir(claim);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOTEMPTY')await exec(options.binaries.input,['publish-root',claim,record.directory],{signal:context.signal,timeout:context.timeoutMs});throw error;}
}

async function stop(identity: ProcessIdentity, context: Pick<EngineCleanupContext, 'signal' | 'timeoutMs'>, binary: string): Promise<void> {
  if (!await stillOwned(identity)) return;
  await exec(binary, ['stop', String(identity.pid), identity.start], { env: { PATH: '/usr/bin:/bin' }, signal: context.signal, timeout: Math.max(1, context.timeoutMs) });
  const deadline = Date.now() + context.timeoutMs;
  while (await stillOwned(identity)) {
    context.signal.throwIfAborted();
    if (Date.now() >= deadline) throw new EngineError('ENGINE_FAILURE', 'Owned native supervisor did not release its descendants', { retryable: false });
    await delay(25, undefined, { signal: context.signal });
  }
}
async function recordedProcesses(directory: string, processes: readonly ProcessIdentity[]): Promise<ProcessIdentity[]> {
  const files = (await readdir(directory)).filter(file => /^process-[a-f0-9-]+\.json$/.test(file));
  const identities = [...processes, ...await Promise.all(files.map(async file => JSON.parse(await readFile(join(directory, file), 'utf8')) as ProcessIdentity))];
  for (const identity of identities) if (!Number.isSafeInteger(identity.pid) || identity.pid <= 0 || !/^\d+$/.test(identity.start)) throw new EngineError('INVALID_STATE', 'Invalid owned process identity', { retryable: false });
  return [...new Map(identities.map(identity => [`${identity.pid}:${identity.start}`, identity])).values()];
}
async function recoverParent(record:LeaseRecord,parent:OwnedWaylandParent|undefined,signal:AbortSignal):Promise<void>{
  if(!record.parentPending)return;
  const result=await parent?.recover?.(record.parentPending,signal);
  if(result?.kind==='PROCESS')record.processes.push(result.identity);
  else if(result?.kind!=='NEVER_LAUNCHED')throw new EngineError('INVALID_STATE','Pending parent launch lacks authenticated cleanup authority; retain runtime and receipt',{retryable:false});
  delete record.parentPending;
}

/** Fresh rootless compositor and input namespace; never discovers a host socket. */
export async function swayDisplay(options: SwayOptions, request: TernRequest): Promise<SwayDisplay> {
  if (process.platform !== 'linux') throw new ConfigurationError('INVALID_CONFIG', 'Sway requires Linux');
  for (const binary of Object.values(options.binaries)) if (!isAbsolute(binary)) throw new ConfigurationError('INVALID_CONFIG', 'Native binaries must be explicit absolute pinned paths');
  if(options.parent?.guest&&(!isAbsolute(options.parent.guest.nsenter)||!options.journalRoot||!options.configurationRoot||!isAbsolute(options.configurationRoot)))throw new ConfigurationError('INVALID_CONFIG','Guest execution requires explicit absolute nsenter, host-private journals and read-only configuration root');
  await journalBoundary(options);
  const size = options.size ?? { width: 1280, height: 900 };
  if (![size.width, size.height].every(value => Number.isInteger(value) && value >= 320 && value <= 8192)) throw new ConfigurationError('INVALID_CONFIG', 'Invalid isolated display size');
  const root = runDirectory(options, request.runId, request.targetName);
  if (!isAbsolute(root) || Buffer.byteLength(root) > 48) throw new ConfigurationError('INVALID_CONFIG', 'Native lease root exceeds Unix socket path limits');
  const journalRoot=journalRunDirectory(options,request.runId,request.targetName);
  await mkdir(journalRoot,{recursive:true,mode:0o700});await ownedDirectory(journalRoot);
  await prepareRuntimeRoot(options,request,journalRoot,root);
  const journalDirectory=await mkdtemp(join(journalRoot,'attempt-'));
  const directory=join(root,basename(journalDirectory));
  const record: LeaseRecord = { version: 2, runId: request.runId, targetName: request.targetName, directory, journalDirectory, processes: [] };
  const save = async () => {await writeFile(join(journalDirectory,'lease.next'),JSON.stringify(record),{mode:0o600});await rename(join(journalDirectory,'lease.next'),join(journalDirectory,'lease.json'));};
  await save();
  const stage=join(journalDirectory,'runtime');
  try{await mkdir(stage,{mode:0o700});for(const name of ['run','home','config','cache','state'])await mkdir(join(stage,name),{mode:0o700});const info=await lstat(stage);record.runtimeIdentity={dev:info.dev,ino:info.ino};await save();}
  catch(error){await rm(journalDirectory,{recursive:true});throw error;}
  const ownsRuntime=async()=>{try{const info=await lstat(directory);return info.isDirectory()&&info.dev===record.runtimeIdentity?.dev&&info.ino===record.runtimeIdentity?.ino;}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw error;}};
  const seat = `agent-${createHash('sha256').update(directory).digest('hex').slice(0, 12)}`;
  const output = options.parent ? 'WL-1' : 'HEADLESS-1';
  const env: Record<string, string> = { PATH: request.env.PATH ?? '/usr/bin:/bin', LANG: 'C.UTF-8', ...options.env,
    HOME: join(directory, 'home'), XDG_CONFIG_HOME: join(directory, 'config'), XDG_CACHE_HOME: join(directory, 'cache'), XDG_STATE_HOME: join(directory, 'state'), XDG_RUNTIME_DIR: join(directory, 'run'),
    WLR_BACKENDS: options.parent ? 'wayland' : 'headless', WLR_RENDERER: 'pixman', WLR_HEADLESS_OUTPUTS: '1', WLR_WL_OUTPUTS: '1',
    TERN_CONFIG_DIR: join(directory, 'config', 'tern'), SHELL: '/bin/bash' };
  const configRoot=options.configurationRoot??journalDirectory;await ownedDirectory(configRoot);
  const config=join(configRoot,`sway-${randomUUID()}.conf`);record.configPath=config;await save();
  try{await writeFile(config,`output ${output} mode ${size.width}x${size.height}\noutput ${output} scale 1\ndefault_border none\nxwayland disable\nseat ${seat} fallback true\nseat ${seat} attach "*"\nfocus_follows_mouse yes\n`,{mode:0o600,flag:'wx'});}
  catch(error){await rm(journalDirectory,{recursive:true});throw error;}
  const guest=options.parent?.guest,ns=guest?[String(guest.target.pid),guest.target.start,guest.nsenter]:undefined;
  const quote=(value:string)=>`'${value.replaceAll("'","'\\''")}'`;
  const controlBinary=ns?join(journalDirectory,'native-ctl'):options.binaries.tern;
  if(ns)await writeFile(controlBinary,`#!/bin/sh\nexec ${[options.binaries.input,'enter-ns',...ns,options.binaries.tern].map(quote).join(' ')} "$@"\n`,{mode:0o700,flag:'wx'});
  const routed=(binary:string,args:readonly string[])=>ns?{binary:options.binaries.input,args:['enter-ns',...ns,binary,...args]}:{binary,args:[...args]};
  const children: ChildProcess[] = [];
  const launch = async (binary: string, args: readonly string[], signal: AbortSignal): Promise<ProcessIdentity> => {
    signal.throwIfAborted();
    const identityFile = join(journalDirectory, `process-${randomUUID()}.json`);
    const command=ns?['supervise-ns',identityFile,...ns,binary,...args]:['supervise',identityFile,binary,...args];
    const child=spawn(options.binaries.input,command,{env,detached:true,stdio:'ignore'});
    children.push(child);
    const identity = await new Promise<ProcessIdentity>((accept, reject) => {
      child.once('error', reject);
      child.once('spawn', () => { if (!child.pid) reject(new Error('Native supervisor has no PID')); else processIdentity(child.pid).then(accept, reject); });
    });
    record.processes.push(identity);
    await save();
    return identity;
  };
  let released = false;
  const release = async (context: EngineCleanupContext): Promise<void> => {
    if (released) return;
    await closePublication(journalDirectory,options.binaries.input,context);
    const runtimeOwned=await ownsRuntime();
    if(directory!==journalDirectory&&runtimeOwned){const command=routed(options.binaries.input,['close',join(directory,'lease.json')]);await exec(command.binary,command.args,{signal:context.signal,timeout:context.timeoutMs});}
    if(record.parentPending){await recoverParent(record,options.parent,context.signal);await save();}
    for (const identity of (await recordedProcesses(journalDirectory, record.processes)).toReversed()) await stop(identity, context, options.binaries.input);
    for (const child of children) child.unref();
    await removeRuntime(record,options,context);
    if(record.configPath)await rm(record.configPath,{force:true});await rm(journalDirectory,{recursive:true,force:true});
    released = true;
  };
  try {
    await exec(options.binaries.input,['publish-root',stage,directory,join(journalDirectory,'lease.json')],{signal:request.signal,timeout:5000});
    if (options.parent) {
      const parentEnv = { ...env, WAYLAND_DISPLAY: join(options.parent.runtimeDir, options.parent.waylandDisplay) };
      const identityFile = join(directory, `launch-${randomUUID()}.json`);
      record.parentPending=identityFile;await save();
      const identity = await options.parent.launch(options.binaries.input, ['supervise', identityFile, options.binaries.sway, '--config', config], parentEnv, identityFile, request.signal);
      record.processes.push(identity);delete record.parentPending;await save();
    } else await launch(options.binaries.sway, ['--config', config], request.signal);
    let socket = '';
    const deadline = Date.now() + 15000;
    while (!socket) {
      request.signal.throwIfAborted();
      if (Date.now() >= deadline) throw new EngineError('ENGINE_FAILURE', 'Isolated Sway IPC did not become ready', { retryable: false });
      const names = await readdir(env.XDG_RUNTIME_DIR!);
      socket = names.find(name => name.startsWith('sway-ipc.') && name.endsWith('.sock')) ?? '';
      if (!socket) await delay(50, undefined, { signal: request.signal });
    }
    env.SWAYSOCK = join(env.XDG_RUNTIME_DIR!, socket);
    const ipc = async <T>(type: string, signal: AbortSignal): Promise<T> => {
      const command=routed(options.binaries.swaymsg,['--socket',env.SWAYSOCK!,'--type',type,'--raw']);
      const {stdout}=await exec(command.binary,command.args,{env,signal,timeout:5000,maxBuffer:8*1024*1024});
      return JSON.parse(stdout) as T;
    };
    const outputs = await ipc<Array<{ name: string; active: boolean; rect: { width: number; height: number }; scale: number }>>('get_outputs', request.signal);
    if (outputs.length !== 1 || outputs[0]?.name !== output || !outputs[0].active || outputs[0].rect.width !== size.width || outputs[0].rect.height !== size.height || outputs[0].scale !== 1) throw new EngineError('NOT_ACTIONABLE', 'Isolated output identity or measured geometry differs from the lease', { retryable: false });
    const seats = await ipc<Seat[]>('get_seats', request.signal);
    if (seats.filter(item => item.name === seat).length !== 1) throw new EngineError('NOT_ACTIONABLE', 'Named isolated input seat is unavailable', { retryable: false });
    const names = await readdir(env.XDG_RUNTIME_DIR!);
    const displays = names.filter(name => /^wayland-\d+$/.test(name));
    if (displays.length !== 1) throw new EngineError('NOT_ACTIONABLE', 'Isolated Wayland socket is not unique', { retryable: false });
    env.WAYLAND_DISPLAY = displays[0]!;
    delete env.WLR_BACKENDS; delete env.WLR_RENDERER; delete env.WLR_HEADLESS_OUTPUTS; delete env.WLR_WL_OUTPUTS;
    delete env.DISPLAY; delete env.DBUS_SESSION_BUS_ADDRESS; delete env.HYPRLAND_INSTANCE_SIGNATURE;
    const inputSocket = join(directory, 'input.sock');
    await launch(options.binaries.input, ['serve', seat, inputSocket], request.signal);
    const inputDeadline = Date.now() + 5000;
    for (;;) {
      try { if ((await lstat(inputSocket)).isSocket()) break; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (Date.now() >= inputDeadline) throw new EngineError('NOT_ACTIONABLE', 'Persistent named-seat keyboard and pointer capabilities did not become ready', { retryable: false });
      await delay(20, undefined, { signal: request.signal });
    }
    const input = async (header: string, payload: string, signal: AbortSignal): Promise<void> => {
      signal.throwIfAborted();const after=await options.parent?.guard?.(signal);signal.throwIfAborted();
      try{await new Promise<void>((accept, reject) => {
        const connection = createConnection({ path: inputSocket });
        const abort = () => connection.destroy(new Error('Native input cancelled'));
        let settled = false;
        const finish = (error?: Error) => {
          if (settled) return;settled = true;
          signal.removeEventListener('abort', abort); connection.destroy();
          if (error) reject(error); else accept();
        };
        signal.addEventListener('abort', abort, { once: true });if(signal.aborted){finish(new EngineError('ACTION_MAY_HAVE_COMMITTED','Native input cancelled',{retryable:false}));return;}
        connection.setTimeout(10000, () => connection.destroy(new Error('Native input timed out')));
        let reply = '';
        connection.once('connect', () => { if(signal.aborted){abort();return;}connection.write(header); if (payload) connection.write(payload); });
        connection.on('data', data => {
          reply += data.toString();
          if (reply.includes('\n')) finish(reply === 'OK\n' ? undefined : new EngineError('ACTION_MAY_HAVE_COMMITTED', 'Persistent input was not acknowledged', { retryable: false }));
        });
        connection.once('error', () => finish(new EngineError('ACTION_MAY_HAVE_COMMITTED', 'Persistent input transport failed', { retryable: false })));
        connection.once('close', () => { if (!settled) finish(new EngineError('ACTION_MAY_HAVE_COMMITTED', 'Persistent input ended without acknowledgment', { retryable: false })); });
      });}finally{await after?.();}
    };
    let client: Container | undefined;
    let clientIdentity: ProcessIdentity | undefined;
    const assertFocus = async (signal: AbortSignal): Promise<void> => {
      if (!client || !clientIdentity || !await stillOwned(clientIdentity) || (await ipc<Seat[]>('get_seats', signal)).find(item => item.name === seat)?.focus !== client.id) throw new EngineError('NOT_ACTIONABLE', 'Named seat does not focus the leased native client generation', { retryable: false });
      const pending=[await ipc<Container>('get_tree',signal)], matching: Container[]=[];
      while(pending.length){const node=pending.pop()!;if(node.id===client.id&&node.pid===clientIdentity.pid)matching.push(node);pending.push(...node.nodes??[],...node.floating_nodes??[]);}
      if(matching.length!==1) throw new EngineError('NOT_ACTIONABLE','Owned native window geometry is not unique',{retryable:false});
      client=matching[0]!;
    };
    const pointer = async (x: number, y: number, button: boolean, signal: AbortSignal): Promise<void> => {
      if (![x, y].every(Number.isFinite) || x < 0 || y < 0 || x >= size.width || y >= size.height) throw new EngineError('NOT_ACTIONABLE', 'Pointer is outside the isolated output', { retryable: false });
      await input(`P ${Math.floor(x)} ${Math.floor(y)} ${size.width} ${size.height} ${button ? 1 : 0}\n`, '', signal);
    };
    return { id: directory, directory, controlBinary, seat, output, env, spawn: launch, release, pointer,
      get nativeClient() { return clientIdentity; },
      async tap(x, y, signal) { await assertFocus(signal); await pointer(client!.rect.x+x, client!.rect.y+y, true, signal); },
      async focusClient(pid, signal) {
        const tree = await ipc<Container>('get_tree', signal);
        const pending = [tree]; const matching: Container[] = [];
        while (pending.length) { const node = pending.pop()!; if (node.pid === pid) matching.push(node); pending.push(...node.nodes ?? [], ...node.floating_nodes ?? []); }
        if (!matching.length) throw new EngineError('NODE_STALE', 'This owned process has no current native client', { retryable: true });
        if (matching.length !== 1) throw new EngineError('NOT_ACTIONABLE', 'Native client identity is not unique in the owned display', { retryable: false });
        client = matching[0]!;
        clientIdentity = await processIdentity(pid);
        const r = client.rect;
        await pointer(r.x + r.width / 2, r.y + r.height / 2, true, signal);
        await assertFocus(signal);
      },
      async type(text, signal) { await assertFocus(signal); await input(`T ${Buffer.byteLength(text)}\n`, text, signal); },
      async press(key, signal) {
        await assertFocus(signal);
        const parsed = parseKey(key);
        if (!parsed) throw new EngineError('UNSUPPORTED_CAPABILITY', 'Invalid native key', { retryable: false });
        const symbol = parsed.key.kind === 'char' ? `U${parsed.key.char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}` : keyNames[parsed.key.name];
        if (!symbol) throw new EngineError('UNSUPPORTED_CAPABILITY', 'Unknown native key', { retryable: false });
        const mask = parsed.modifiers.reduce((value, name) => value | modifiers[name]!, 0);
        await input(`K ${mask} ${symbol}\n`, '', signal);
      },
      async capture(signal){const command=routed(options.binaries.grim,['-o',output,'-']);const result=await exec(command.binary,command.args,{env,signal,timeout:5000,encoding:'buffer',maxBuffer:64*1024*1024});return result.stdout;},
    };
  } catch (error) {
    await release({ signal: AbortSignal.timeout(15000), timeoutMs: 15000 } as EngineCleanupContext);
    throw error;
  }
}

/** Attempt-scoped native Tern, private seat and fresh inert profile. */
export function sway(options: SwayOptions): TernProvider {
  const displays = new Map<string, SwayDisplay>();
  return { name: 'sway', mode: 'native',
    async acquire(request) {
      const display = await swayDisplay(options, request);
      displays.set(display.id, display);
      try {
        const control = join(display.directory, 'control.sock');
        const checkGate=async(signal:AbortSignal)=>{signal.throwIfAborted();const result=await exec(display.controlBinary,['ctl','--control',control,'state'],{env:display.env,signal,timeout:5000,maxBuffer:8*1024*1024});const gateState=JSON.parse(result.stdout) as Record<string,unknown>;if(gateState.ok!==true)throw new EngineError('ENGINE_FAILURE','Native gate inspection failed',{retryable:false});requireNativeGate(gateState);};
        const supervisor = await display.spawn(options.binaries.tern, ['--control', control], request.signal);
        const deadline = Date.now() + 15000;
        let state: { ok: boolean; panes: unknown[]; focused: { id: string } } | undefined;
        while (!state) {
          request.signal.throwIfAborted();
          if (Date.now() >= deadline) throw new EngineError('ENGINE_FAILURE', 'Owned native Tern did not become ready', { retryable: false });
          try { const result = await exec(display.controlBinary, ['ctl', '--control', control, 'state'], { env: display.env, signal: request.signal, timeout: 1000 }); state = JSON.parse(result.stdout) as typeof state; }
          catch { await delay(50, undefined, { signal: request.signal }); }
        }
        if (!state.ok || state.panes.length !== 1 || !['number', 'string'].includes(typeof state.focused?.id)) throw new EngineError('NOT_ACTIONABLE', 'Owned Tern must expose exactly one native pane', { retryable: false });
        requireNativeGate(state as unknown as Record<string,unknown>);
        const descendants = await childPids(supervisor.pid);
        for (let index = 0; index < descendants.length; index++) descendants.push(...await childPids(descendants[index]!));
        let focused = false;
        for (const pid of descendants) {
          try {await checkGate(request.signal);await display.focusClient(pid,request.signal);await checkGate(request.signal);focused=true;break;}
          catch (error) { if (!(error instanceof EngineError) || error.code !== 'NODE_STALE') throw error; }
        }
        if (!focused) throw new EngineError('NOT_ACTIONABLE', 'Owned Tern native client is not a supervisor child', { retryable: false });
        if (!request.app.appPath) throw new ConfigurationError('INVALID_CONFIG', 'Owned Tern needs app.appPath');
        try {
          const ready = await exec(display.controlBinary, ['ctl', '--control', control, 'ready'], { env: display.env, signal: request.signal, timeout: 25000 });
          if (!(JSON.parse(ready.stdout) as { ok?: boolean }).ok) throw new Error('Shell not ready');
        } catch { throw new EngineError('ENGINE_FAILURE', 'Owned native shell did not become ready', { retryable: false }); }
        await checkGate(request.signal);
        const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
        const command = [resolve(request.projectRoot, request.app.appPath), ...request.app.launchArguments ?? []].map(quote).join(' ');
        try {
          const result = await exec(display.controlBinary, ['ctl', '--control', control, `run ${JSON.stringify(command)}`], { env: display.env, signal: request.signal, timeout: 25000 });
          if (!(JSON.parse(result.stdout) as { ok?: boolean }).ok) throw new Error('Launch not acknowledged');
        } catch { throw new EngineError('ACTION_MAY_HAVE_COMMITTED', 'Owned app launch did not settle', { retryable: false }); }
        await checkGate(request.signal);
        if (!display.nativeClient) throw new EngineError('INVALID_STATE', 'Owned native client identity was not established', { retryable: false });
        await mkdir(request.artifactsDir, { recursive: true, mode: 0o700 });
        await writeFile(join(request.artifactsDir, 'native-client.json'), JSON.stringify({ client: display.nativeClient, seat: display.seat, output: display.output, lease: display.id }), { mode: 0o600 });
        const guard=async(signal:AbortSignal)=>{
          await checkGate(signal);const client=display.nativeClient;
          if(!client||!await stillOwned(client))throw new EngineError('NOT_ACTIONABLE','Owned native client generation changed',{retryable:false});
          const after=await options.parent?.guard?.(signal);await checkGate(signal);
          return async()=>{if(!await stillOwned(client))throw new EngineError('ACTION_MAY_HAVE_COMMITTED','Owned native client exited across the operation',{retryable:false});await checkGate(signal);await after?.();};
        };
        const guarded=async<T>(signal:AbortSignal,operation:()=>Promise<T>)=>{const after=await guard(signal);try{return await operation();}finally{await after();}};
        return{id:display.id,pane:String(state.focused.id),mode:'native',control,binary:display.controlBinary,env:display.env,client:display.nativeClient,
          capture:signal=>guarded(signal,()=>display.capture(signal)),guard,input:{
            type:(text,signal)=>guarded(signal,()=>display.type(text,signal)),
            press:(key,signal)=>guarded(signal,()=>display.press(key,signal)),
            tap:(x,y,signal)=>guarded(signal,()=>display.tap(x,y,signal)),
          }} satisfies TernLease;
      } catch (error) { await display.release({ signal: AbortSignal.timeout(15000), timeoutMs: 15000 } as EngineCleanupContext); displays.delete(display.id); throw error; }
    },
    async release(lease, context) { const display = displays.get(lease.id); if (!display) return; await display.release(context); displays.delete(lease.id); },
    async sweep(request, context) {
      await journalBoundary(options);
      const root = journalRunDirectory(options, request.runId, request.targetName);
      let entries: string[];
      try { await ownedDirectory(root); entries = await readdir(root); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
      await closePublication(root,options.binaries.input,context);
      for (const name of entries) {
        if (!name.startsWith('attempt-')) continue;
        const journalDirectory = join(root, name); await ownedDirectory(journalDirectory);
        await closePublication(journalDirectory,options.binaries.input,context);
        let record:LeaseRecord;
        try{record=JSON.parse(await readFile(join(journalDirectory,'lease.json'),'utf8')) as LeaseRecord;}
        catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;await rm(journalDirectory,{recursive:true});continue;}
        const runtimeDirectory=join(runDirectory(options,request.runId,request.targetName),name);
        if (record.version !== 2 || record.runId !== request.runId || record.targetName !== request.targetName || record.journalDirectory !== journalDirectory||record.directory!==runtimeDirectory) throw new EngineError('INVALID_STATE', 'Refusing unowned native cleanup record', { retryable: false });
        const guest=options.parent?.guest,ns=guest?[String(guest.target.pid),guest.target.start,guest.nsenter]:undefined;
        const routed=(binary:string,args:string[])=>ns?{binary:options.binaries.input,args:['enter-ns',...ns,binary,...args]}:{binary,args};
        let runtimeOwned=false;try{const info=await lstat(record.directory);runtimeOwned=info.isDirectory()&&info.dev===record.runtimeIdentity?.dev&&info.ino===record.runtimeIdentity?.ino;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
        if(record.directory!==journalDirectory&&runtimeOwned){const command=routed(options.binaries.input,['close',join(record.directory,'lease.json')]);await exec(command.binary,command.args,{signal:context.signal,timeout:context.timeoutMs});}
        if(record.parentPending){await recoverParent(record,options.parent,context.signal);await writeFile(join(journalDirectory,'lease.next'),JSON.stringify(record),{mode:0o600});await rename(join(journalDirectory,'lease.next'),join(journalDirectory,'lease.json'));}
        for(const identity of(await recordedProcesses(journalDirectory,record.processes)).toReversed())await stop(identity,context,options.binaries.input);
        await removeRuntime(record,options,context);
        if(record.configPath){const configRoot=options.configurationRoot??journalDirectory;if(dirname(record.configPath)!==configRoot||!/^sway-[a-f0-9-]+\.conf$/.test(basename(record.configPath)))throw new EngineError('INVALID_STATE','Unowned native configuration path',{retryable:false});await rm(record.configPath,{force:true});}
        await rm(journalDirectory,{recursive:true});
      }
      const runtimeRoot=runDirectory(options,request.runId,request.targetName),allocation=await rootRecord(root,runtimeRoot,request.runId,request.targetName);
      if(allocation)await removeRuntimeRoot(allocation,options,root,context);
      for(const name of await readdir(root)){if(name.startsWith('run-stage-')){const path=join(root,name);await ownedDirectory(path);await rm(path,{recursive:true});}else if(/^root-proposal-[a-f0-9-]+\.json$/.test(name))await rm(join(root,name));}
      await rm(join(root,'runtime-root.json'),{force:true});await rm(join(root,'.closing'),{force:true});await rm(join(root,'.lifecycle.lock'),{force:true});await rmdir(root);
      if(options.journalRoot===undefined){try{await ownedDirectory(journalPrefix(options));await rmdir(journalPrefix(options));}catch(error){if(!['ENOENT','ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code??''))throw error;}}
    },
  };
}
