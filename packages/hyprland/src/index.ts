import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, writeFile, appendFile, rename, readdir, lstat, realpath, rm, rmdir } from 'node:fs/promises';
import { join, dirname, basename, isAbsolute, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { EngineError, ConfigurationError, type EngineCleanupContext } from 'e2e/engine';
import { sway, ownedDirectory, processIdentity, stillOwned, ownedDescendant, type SwayOptions, type OwnedWaylandParent, type ProcessIdentity } from '@e2e-dev/sway';
import type { TernProvider, TernRequest, TernLease } from '@e2e-dev/tern';
import { humanProof, unchanged, ownedClient, type Monitor, type Client, type HumanProof } from './proof.ts';
const exec = promisify(execFile);
export interface HyprlandOptions {
  readonly host: { readonly instance: string; readonly runtimeDir: string; readonly waylandDisplay: string; readonly hyprctl: string; /** Independently pinned compositor generation for sandboxed parents. */ readonly process?: ProcessIdentity };
  readonly protectedWorkspaces: readonly (number | string)[];
  readonly protectedOutputs: readonly string[];
  /** Named workspace only. Omit for a generated per-attempt name. It must not exist, even empty. */
  readonly workspace?: string;
  readonly sway: Omit<SwayOptions, 'parent' | 'root' | 'journalRoot' | 'configurationRoot'>;
  readonly root?: string;
  /** Short private directory shared with an explicitly sandboxed parent, if used. */
  readonly nativeRoot?: string;
  /** Disposable guest only: explicit namespace entrant and host-created read-only config mount. */
  readonly guest?:{readonly nsenter:string;readonly configurationRoot:string};
}
interface Record { version: 2; runId: string; targetName: string; directory: string; output: string; tag: string; workspace: string; childRoot: string; childIdentity?:{dev:number;ino:number}; host: ProcessIdentity; existingWorkspaces: number[]; outputRequested?: boolean; workspaceId?: number; workspaceOriginalName?: string; workspaceRenamed?: boolean; identityFile?: string; child?: ProcessIdentity; outputId?: number; outputGeometry?: {x:number;y:number;width:number;height:number;scale:number}; artifactsDir: string; artifactsReady?: boolean }
interface Workspace { id: number; name: string; monitorID: number | string; windows: number; ispersistent: boolean }
const fail = (message: string) => new EngineError('INVALID_STATE', message, { retryable: false });
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const runRoot = (options: HyprlandOptions, runId: string, target: string) => join(options.root ?? join(tmpdir(), `e2e-hypr-${process.getuid?.()}`), createHash('sha256').update(runId).update('\0').update(target).digest('hex').slice(0,24));
function validate(options: HyprlandOptions): void {
  if (process.platform !== 'linux' || !isAbsolute(options.host.hyprctl) || !isAbsolute(options.host.runtimeDir) || !/^[A-Za-z0-9_-]+$/.test(options.host.instance) || !/^wayland-\d+$/.test(options.host.waylandDisplay) || !options.protectedWorkspaces.length || (options.workspace !== undefined && (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(options.workspace)))) throw new ConfigurationError('INVALID_CONFIG', 'Hyprland requires an explicit instance/display/binary and protected-workspace policy');
  if (!options.protectedOutputs.length || new Set(options.protectedOutputs).size !== options.protectedOutputs.length || options.protectedOutputs.some(name => !/^[A-Za-z0-9_.:-]+$/.test(name))) throw new ConfigurationError('INVALID_CONFIG', 'Declare each measured protected output explicitly');
  if (options.workspace !== undefined && options.protectedWorkspaces.includes(options.workspace)) throw new ConfigurationError('INVALID_CONFIG', 'Refusing a protected workspace');
  if(options.guest&&(!isAbsolute(options.guest.nsenter)||!isAbsolute(options.guest.configurationRoot)||!options.host.process))throw new ConfigurationError('INVALID_CONFIG','Guest containment requires explicit namespace/configuration paths and an independently pinned parent');
}
function controller(options: HyprlandOptions) {
  const env = { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', XDG_RUNTIME_DIR: options.host.runtimeDir, HYPRLAND_INSTANCE_SIGNATURE: options.host.instance };
  const command = async (args: string[], signal: AbortSignal, json = false): Promise<unknown> => {
    try {
      const { stdout } = await exec(options.host.hyprctl, ['-i', options.host.instance, ...(json ? ['-j'] : []), ...args], { env, signal, timeout: 5000, maxBuffer: 8*1024*1024 });
      if (json) return JSON.parse(stdout) as unknown;
      if (stdout.trim() !== 'ok') throw new Error('IPC refused');
      return undefined;
    } catch { throw fail('Explicit Hyprland IPC failed; no alternate instance or host input fallback'); }
  };
  const dispatch=async(receipt:string,input:string,args:string[],signal:AbortSignal):Promise<void>=>{
    try{const {stdout}=await exec(input,['dispatch-owned',receipt,options.host.hyprctl,'-i',options.host.instance,...args],{env,signal,timeout:5000,maxBuffer:8*1024*1024});if(stdout.trim()!=='ok')throw new Error('IPC refused');}
    catch{throw fail('Fenced Hyprland launch dispatch failed or is uncertain; no unowned retry');}
  };
  return { command, dispatch, query: async <T>(name: string, signal: AbortSignal) => await command([name], signal, true) as T };
}
async function hostIdentity(options: HyprlandOptions): Promise<ProcessIdentity> {
  await ownedDirectory(options.host.runtimeDir);
  const directory = join(options.host.runtimeDir, 'hypr', options.host.instance); await ownedDirectory(directory);
  const socket = await lstat(join(directory, '.socket.sock'));
  if (!socket.isSocket() || socket.uid !== process.getuid?.()) throw fail('Explicit Hyprland control socket is not owned');
  const lines = (await readFile(join(directory, 'hyprland.lock'), 'utf8')).trim().split('\n');
  const pid = Number(lines[0]); if (!Number.isSafeInteger(pid) || pid <= 0 || lines[1] !== options.host.waylandDisplay) throw fail('Explicit Hyprland PID/display lock does not match');
  const wayland = await lstat(join(options.host.runtimeDir, options.host.waylandDisplay));
  if (!wayland.isSocket() || wayland.uid !== process.getuid?.()) throw fail('Explicit parent Wayland endpoint is not owned');
  const identity=await processIdentity(pid), pinned=options.host.process;
  if(pinned&&(pinned.pid!==identity.pid||pinned.start!==identity.start))throw fail('Explicit parent generation does not match its independently pinned identity');
  return identity;
}
async function save(record: Record): Promise<void> { await writeFile(join(record.directory, 'lease.next'), JSON.stringify(record), { mode: 0o600 }); await rename(join(record.directory, 'lease.next'), join(record.directory, 'lease.json')); }
async function privateBoundary(hostRoot:string,guestRoots:readonly string[]):Promise<void> {
  const host=await realpath(hostRoot);
  for(const path of guestRoots){const guest=await realpath(path);if(host===guest||host.startsWith(guest+sep))throw fail('Host lease journal is reachable through a guest-writable root');}
}
async function childDirectoryInfo(path:string){try{return await lstat(path);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw error;}}
async function removeChildRoot(record:Record,options:HyprlandOptions,context:EngineCleanupContext):Promise<void>{
  if(!record.childIdentity)return;const identity=record.childIdentity,claim=join(record.directory,'claimed-child');
  const matches=(info:Awaited<ReturnType<typeof childDirectoryInfo>>)=>info?.isDirectory()===true&&info.dev===identity.dev&&info.ino===identity.ino&&info.uid===process.getuid?.()&&(info.mode&0o077)===0;
  if(!await childDirectoryInfo(claim)){
    if(matches(await childDirectoryInfo(join(record.directory,'child-stage'))))return;
    const source=await childDirectoryInfo(record.childRoot);if(!source)return;
    if(!matches(source))throw fail('Child root was replaced; retain cleanup evidence');
    await exec(options.sway.binaries.input,['claim-root',record.childRoot,claim,String(identity.dev),String(identity.ino)],{signal:context.signal,timeout:context.timeoutMs});
  }
  if(!matches(await childDirectoryInfo(claim)))throw fail('Private child-root claim does not match owned inode; preserve it');
  try{await rmdir(claim);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOTEMPTY')await exec(options.sway.binaries.input,['publish-root',claim,record.childRoot],{signal:context.signal,timeout:context.timeoutMs});throw error;}
}
function resource(options: HyprlandOptions, record: Record) {
  const ctl = controller(options), size = options.sway.size ?? { width: 1280, height: 900 };
  const proof = async (signal: AbortSignal) => {
    const monitors=await ctl.query<Monitor[]>('monitors',signal);
    if(options.protectedOutputs.some(name=>monitors.filter(m=>m.name===name&&!m.disabled).length!==1)) throw fail('A declared protected output is missing or ambiguous');
    return humanProof(monitors.filter(m=>options.protectedOutputs.includes(m.name)),await ctl.query<{address?:string}>('activewindow',signal),await ctl.query<{x:number;y:number}>('cursorpos',signal),record.output);
  };
  const log=async(phase:string,before:HumanProof,after:HumanProof)=>{const line=JSON.stringify({phase,before,after,output:record.output,workspace:record.workspace,tag:record.tag})+'\n';await appendFile(join(record.directory,'hyprland-proof.jsonl'),line,{mode:0o600});if(record.artifactsReady)await appendFile(join(record.artifactsDir,'hyprland-proof.jsonl'),line,{mode:0o600});unchanged(before,after);};
  const verify = async (signal: AbortSignal, requireChild: boolean) => {
    const currentHost=await hostIdentity(options);
    if (!await stillOwned(record.host) || currentHost.pid !== record.host.pid || currentHost.start !== record.host.start) throw fail('Hyprland host generation changed');
    const monitors = await ctl.query<Monitor[]>('monitors',signal), clients = await ctl.query<Client[]>('clients',signal);
    const matching = monitors.filter(m=>m.name===record.output);
    if(record.outputId===undefined&&record.outputRequested&&matching.length===1) { record.outputId=matching[0]!.id; await save(record); }
    if (matching.length !== 1 || matching[0]!.id !== record.outputId || matching[0]!.disabled) throw fail('Owned output identity changed');
    const output = matching[0]!;
    if (options.protectedWorkspaces.some(w=>w===output.activeWorkspace.id || w===output.activeWorkspace.name)) throw fail('Owned output activated a protected workspace');
    if(record.outputGeometry&&JSON.stringify({x:output.x,y:output.y,width:output.width,height:output.height,scale:output.scale})!==JSON.stringify(record.outputGeometry))throw fail('Owned output logical geometry changed');
    if(record.workspaceId!==undefined&&(output.activeWorkspace.id!==record.workspaceId||(record.workspaceRenamed?output.activeWorkspace.name!==record.workspace:output.activeWorkspace.name!==record.workspaceOriginalName&&output.activeWorkspace.name!==record.workspace)))throw fail('Owned workspace identity or rename phase changed');
    if(!record.child){const scoped=clients.filter(c=>c.monitor===output.id&&c.tags.some(t=>t===record.tag||t===`${record.tag}*`));if(scoped.length===1){ownedClient(scoped[0]!,scoped[0]!.pid,record.tag,output,record.workspace,size);const candidate=await processIdentity(scoped[0]!.pid);if(!await ownedDescendant(candidate,record.host))throw fail('Tagged recovery client is outside the independently pinned compositor ancestry');record.child=candidate;await save(record);}else if(record.identityFile){try{const candidate=JSON.parse(await readFile(record.identityFile,'utf8')) as ProcessIdentity;if(await stillOwned(candidate)&&!await ownedDescendant(candidate,record.host))throw fail('Guest launch receipt is not an independently verified descendant of the pinned compositor');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}}
    const tagged = clients.filter(c=>c.tags.some(t=>t===record.tag||t===`${record.tag}*`));
    const onOutput = clients.filter(c=>c.monitor===output.id);
    const child=record.child,known=child?clients.filter(c=>c.pid===child.pid):[];
    const childAlive=child!==undefined&&await stillOwned(child);
    if (tagged.length > 1 || known.length > 1 || onOutput.some(c=>!(childAlive&&c.pid===child!.pid))) throw fail('Refusing output with a foreign client');
    if (childAlive&&child) {
      if(known.length!==1||tagged.length!==1||known[0]!==tagged[0])throw fail('Live nested generation lost mapped PID/tag containment; retain cleanup evidence');
      if (!await ownedDescendant(child,record.host)) throw fail('Nested client does not belong to the independently verified parent process generation');
      ownedClient(known[0]!, child.pid, record.tag, output, record.workspace, size);
    } else if(tagged.length||known.length)throw fail('Mapped client lacks the recorded live nested generation; retain cleanup evidence');
    else if (requireChild) throw fail('Owned nested client is absent');
    return output;
  };
  const guard = async (signal: AbortSignal) => { await verify(signal,true); const before=await proof(signal); return async()=>{ await verify(signal,true); await log('operation',before,await proof(signal)); }; };
  const dispatchReceipt=join(record.directory,'dispatch.json');
  const closeDispatch=async(signal:AbortSignal,timeoutMs:number)=>{await exec(options.sway.binaries.input,['close',dispatchReceipt],{env:{PATH:'/usr/bin:/bin'},signal,timeout:timeoutMs});};
  const pendingEndpoint=(identityFile:string)=>{
    const run=join(record.childRoot,createHash('sha256').update(record.runId).update('\0').update(record.targetName).digest('hex').slice(0,24)),attempt=dirname(identityFile);
    if(dirname(attempt)!==run||!/^attempt-[A-Za-z0-9]{6}$/.test(basename(attempt))||!/^launch-[a-f0-9-]{36}\.json$/.test(basename(identityFile))||(record.identityFile!==undefined&&record.identityFile!==identityFile))throw fail('Pending parent recovery endpoint changed');
  };
  const parent:OwnedWaylandParent={runtimeDir:options.host.runtimeDir,waylandDisplay:options.host.waylandDisplay,guard,
    ...(options.guest?{guest:{target:record.host,nsenter:options.guest.nsenter}}:{}),
    async recover(identityFile,signal){
      pendingEndpoint(identityFile);await closeDispatch(signal,5000);await verify(signal,false);
      if(record.child)return {kind:'PROCESS',identity:record.child};
      try{await readFile(dispatchReceipt,'utf8');return {kind:'UNKNOWN'};}
      catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;return {kind:'NEVER_LAUNCHED'};}
    },
    async launch(binary,args,env,identityFile,signal) {
      if (args[0]!=='supervise' || args[1]!==identityFile || args[2]!==options.sway.binaries.sway) throw fail('Only the exact owned nested compositor may be launched');
      pendingEndpoint(identityFile);
      await verify(signal,false); await ownedDirectory(dirname(identityFile));
      const before=await proof(signal); record.identityFile=identityFile; await save(record);
      const environment=Object.entries(env).map(([key,value])=>{ if(!/^[A-Z_][A-Z0-9_]*$/.test(key)) throw fail('Invalid curated environment key'); return `${key}=${value}`; });
      const rules=`monitor ${record.output}; workspace name:${record.workspace} silent; tag +${record.tag}; float on; size ${size.width} ${size.height}; border_size 0; no_shadow on; no_initial_focus on; no_focus on`;
      signal.throwIfAborted();await ctl.dispatch(dispatchReceipt,options.sway.binaries.input,['dispatch','exec',`[${rules}] exec /usr/bin/env -i ${[...environment,binary,'exec-owned',identityFile,...args.slice(2)].map(quote).join(' ')}`],signal);
      const deadline=Date.now()+15000;
      let candidate:ProcessIdentity|undefined;
      for (;;) {
        signal.throwIfAborted();
        try{candidate=JSON.parse(await readFile(identityFile,'utf8')) as ProcessIdentity;if(!await ownedDescendant(candidate,record.host))throw fail('Guest launch receipt is not an independently verified descendant of the pinned compositor');break;}
        catch(error) { if ((error as NodeJS.ErrnoException).code!=='ENOENT') throw error; }
        if(Date.now()>=deadline) throw fail('Owned same-PID compositor launch did not record identity'); await delay(25,undefined,{signal});
      }
      for (;;) {
        const clients=await ctl.query<Client[]>('clients',signal);
        const matching=clients.filter(c=>c.pid===candidate!.pid);
        if(matching.length===1&&matching[0]!.mapped&&!matching[0]!.hidden&&matching[0]!.size[0]===size.width&&matching[0]!.size[1]===size.height)break;
        if(!await stillOwned(candidate!)||Date.now()>=deadline)throw fail('Owned nested compositor never mapped');await delay(25,undefined,{signal});
      }
      await verify(signal,true); await log('launch',before,await proof(signal)); return record.child!;
    }
  };
  const provider=sway({...options.sway,root:record.childRoot,journalRoot:join(record.directory,'sway-journals'),...(options.guest?{configurationRoot:options.guest.configurationRoot}:{}),parent});
  const close = async(context: EngineCleanupContext, lease?: TernLease) => {
    const signal=context.signal, before=await proof(signal);
    await closeDispatch(signal,context.timeoutMs);
    if(record.identityFile){try{await ownedDirectory(dirname(record.identityFile));const args=['close',record.identityFile];await exec(options.sway.binaries.input,options.guest?['enter-ns',String(record.host.pid),record.host.start,options.guest.nsenter,options.sway.binaries.input,...args]:args,{env:{PATH:'/usr/bin:/bin'},signal,timeout:context.timeoutMs});}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}
    const monitors=await ctl.query<Monitor[]>('monitors',signal);
    if(monitors.some(m=>m.name===record.output)) await verify(signal,false);
    else if(record.child){const child=record.child,clients=await ctl.query<Client[]>('clients',signal);if(await stillOwned(child)||clients.some(c=>c.pid===child.pid||c.tags.some(t=>t===record.tag||t===`${record.tag}*`)))throw fail('Owned output absent with live or mapped nested containment; retain cleanup evidence');}
    if(!record.child&&record.identityFile){const deadline=Date.now()+context.timeoutMs;for(;;){await verify(signal,false);if(record.child)break;let candidate:ProcessIdentity;try{candidate=JSON.parse(await readFile(record.identityFile,'utf8')) as ProcessIdentity;}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')break;throw error;}if(!await stillOwned(candidate))break;if(!await ownedDescendant(candidate,record.host))throw fail('Refusing an unverified guest cleanup receipt');if(Date.now()>=deadline)throw fail('Published nested process never established independently verified tagged containment');await delay(25,undefined,{signal});}}
    if(lease) await provider.release(lease,context);
    await provider.sweep!({runId:record.runId,targetName:record.targetName,env:{}},context);
    if(!record.child){try{await readFile(dispatchReceipt,'utf8');throw fail('Published launch dispatch lacks authenticated child authority; retain containment evidence');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}
    if(record.child&&await stillOwned(record.child)){await verify(signal,false);if(!await ownedDescendant(record.child,record.host))throw fail('Refusing changed nested process ancestry');await exec(options.sway.binaries.input,['stop',String(record.child.pid),record.child.start],{env:{PATH:'/usr/bin:/bin'},signal,timeout:context.timeoutMs});const deadline=Date.now()+context.timeoutMs;while(await stillOwned(record.child)){if(Date.now()>=deadline)throw fail('Exact nested generation survived cleanup');await delay(25,undefined,{signal});}}
    if(monitors.some(m=>m.name===record.output)) {
      await verify(signal,false);
      if((await ctl.query<Client[]>('clients',signal)).some(c=>c.monitor===record.outputId)) throw fail('Owned output still contains a client; refusing removal');
      await ctl.command(['output','remove',record.output],signal);
      if((await ctl.query<Monitor[]>('monitors',signal)).some(m=>m.name===record.output)) throw fail('Owned output removal did not read back');
    }
    await log('cleanup',before,await proof(signal));
    const deadline=Date.now()+context.timeoutMs;
    while((await ctl.query<Workspace[]>('workspaces',signal)).some(w=>w.id===record.workspaceId||w.name===record.workspace)) {
      if(Date.now()>=deadline) throw fail('Owned nonpersistent workspace survived cleanup');
      await delay(25,undefined,{signal});
    }
    await removeChildRoot(record,options,context);
    await rm(record.directory,{recursive:true});
  };
  return {provider,close,verify,proof,log,ctl};
}
/** Host containment only: all agent keyboard/pointer input goes to private Sway. */
export function hyprland(options: HyprlandOptions): TernProvider {
  validate(options); const leases=new Map<string,ReturnType<typeof resource>>();
  return {name:'hyprland',mode:'native',
    async acquire(request: TernRequest) {
      const host=await hostIdentity(options), ctl=controller(options);
      const version=await ctl.query<{version:string}>('version',request.signal);
      if(!['0.53.0','0.56.2'].includes(version.version)) throw new ConfigurationError('INVALID_CONFIG','This adapter supports the source-reviewed Hyprland 0.53.0 and 0.56.2 APIs');
      const protectedMonitors=await ctl.query<Monitor[]>('monitors',request.signal);
      if(options.protectedOutputs.some(name=>protectedMonitors.filter(m=>m.name===name&&!m.disabled).length!==1)) throw fail('A declared protected output is missing or ambiguous');
      const token=randomUUID().replaceAll('-',''), workspace=options.workspace??`e2e-${token}`;
      const workspaces=await ctl.query<Workspace[]>('workspaces',request.signal), rules=await ctl.query<{workspaceString:string}[]>('workspacerules',request.signal);
      if(workspaces.some(w=>w.name===workspace)||rules.some(r=>r.workspaceString===`name:${workspace}`||r.workspaceString===workspace)) throw fail('Refusing occupied, empty-existing or configured workspace');
      const root=runRoot(options,request.runId,request.targetName); await mkdir(dirname(root),{recursive:true,mode:0o700}); await ownedDirectory(dirname(root)); await mkdir(root,{recursive:true,mode:0o700}); await ownedDirectory(root);
      const nativeRoot=options.nativeRoot??join(tmpdir(),`hp-${process.getuid?.()}`);
      // The child suffix adds 9 bytes; Sway's run/target hash adds another 25 to its 48-byte root budget.
      if(!isAbsolute(nativeRoot)||Buffer.byteLength(nativeRoot)>14) throw new ConfigurationError('INVALID_CONFIG','Native compositor root must be an explicit absolute directory of at most 14 bytes');
      await mkdir(nativeRoot,{recursive:true,mode:0o700}); await ownedDirectory(nativeRoot);
      await privateBoundary(dirname(root),[nativeRoot,options.host.runtimeDir]);
      if(options.guest){await ownedDirectory(options.guest.configurationRoot);await privateBoundary(options.guest.configurationRoot,[nativeRoot,options.host.runtimeDir]);}
      const directory=await mkdtemp(join(root,'attempt-')), childRoot=join(nativeRoot,`s-${token.slice(0,6)}`);
      const record: Record={version:2,runId:request.runId,targetName:request.targetName,directory,childRoot,host,existingWorkspaces:workspaces.map(w=>w.id),output:`e2e-${token}`,tag:`e2e-${token}`,workspace,artifactsDir:request.artifactsDir};
      try{await save(record);}catch(error){await rm(directory,{recursive:true});throw error;}
      const owned=resource(options,record);
      try {
        const stage=join(record.directory,'child-stage');await mkdir(stage,{mode:0o700});const info=await lstat(stage);record.childIdentity={dev:info.dev,ino:info.ino};await save(record);
        await mkdir(request.artifactsDir,{recursive:true,mode:0o700});
        record.artifactsReady=true;await save(record);
        await exec(options.sway.binaries.input,['publish-root',stage,childRoot,join(record.directory,'dispatch.json')],{signal:request.signal,timeout:5000});await ownedDirectory(childRoot);
        const before=await owned.proof(request.signal);
        if((await ctl.query<Monitor[]>('monitors',request.signal)).some(m=>m.name===record.output)||(await ctl.query<Client[]>('clients',request.signal)).some(c=>c.tags.includes(record.tag))) throw fail('Generated output/tag collision');
        record.outputRequested=true; await save(record);
        await ctl.command(['output','create','headless',record.output],request.signal);
        let output: Monitor | undefined;
        const deadline=Date.now()+15000;
        while(!output) {
          output=(await ctl.query<Monitor[]>('monitors',request.signal)).find(m=>m.name===record.output);
          if(!output) { if(Date.now()>=deadline) throw fail('Named headless output was not created'); await delay(25,undefined,{signal:request.signal}); }
        }
        record.outputId=output.id;record.outputGeometry={x:output.x,y:output.y,width:output.width,height:output.height,scale:output.scale};await save(record);
        const size=options.sway.size??{width:1280,height:900};
        if(output.scale!==1||output.width<size.width||output.height<size.height) throw fail('Measured owned-output default geometry cannot contain the requested child; no persistent monitor-size rule');
        const candidate=(await ctl.query<Workspace[]>('workspaces',request.signal)).find(w=>w.id===output.activeWorkspace.id);
        if(!candidate||record.existingWorkspaces.includes(candidate.id)||Number(candidate.monitorID)!==output.id||candidate.windows!==0||candidate.ispersistent||options.protectedWorkspaces.some(w=>w===candidate.id||w===candidate.name)||(await ctl.query<Client[]>('clients',request.signal)).some(c=>c.workspace.id===candidate.id||c.monitor===output.id)) throw fail('Refusing rename of a pre-existing, persistent, protected or nonempty workspace');
        record.workspaceId=candidate.id;record.workspaceOriginalName=candidate.name;await save(record);
        await ctl.command(['dispatch','renameworkspace',`${candidate.id} ${record.workspace}`],request.signal);
        const renamed=(await ctl.query<Workspace[]>('workspaces',request.signal)).find(w=>w.id===candidate.id);
        if(!renamed||renamed.name!==record.workspace||Number(renamed.monitorID)!==output.id||renamed.windows!==0||renamed.ispersistent) throw fail('Exact owned workspace rename did not read back');
        record.workspaceRenamed=true;await save(record);
        await owned.verify(request.signal,false); await owned.log('output-create',before,await owned.proof(request.signal));
        const lease=await owned.provider.acquire(request); leases.set(lease.id,owned); return lease;
      } catch(error) { await owned.close({signal:AbortSignal.timeout(30000),timeoutMs:30000} as EngineCleanupContext); throw error; }
    },
    async release(lease,context) { const owned=leases.get(lease.id); if(!owned) return; await owned.close(context,lease); leases.delete(lease.id); },
    async sweep(request,context) {
      const root=runRoot(options,request.runId,request.targetName); let entries:string[];
      try { await ownedDirectory(root); entries=await readdir(root); } catch(error) { if((error as NodeJS.ErrnoException).code==='ENOENT') return; throw error; }
      await privateBoundary(dirname(root),[options.nativeRoot??join(tmpdir(),`hp-${process.getuid?.()}`),options.host.runtimeDir]);
      for(const name of entries) { if(!name.startsWith('attempt-')) continue; const directory=join(root,name);await ownedDirectory(directory);let record:Record;
        try{record=JSON.parse(await readFile(join(directory,'lease.json'),'utf8')) as Record;}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT'){await rm(directory,{recursive:true});continue;}throw error;}
        const nativeRoot=options.nativeRoot??join(tmpdir(),`hp-${process.getuid?.()}`);
        if(record.version!==2||record.runId!==request.runId||record.targetName!==request.targetName||record.directory!==directory||!/^e2e-[a-f0-9]{32}$/.test(record.output)||record.tag!==record.output||dirname(record.childRoot)!==nativeRoot||!/^s-[A-Za-z0-9]{6}$/.test(basename(record.childRoot))) throw fail('Refusing foreign containment cleanup record');
        await resource(options,record).close(context);
      } await rmdir(root);
    }
  };
}
