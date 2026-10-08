import assert from 'node:assert/strict';
import { execFile, fork } from 'node:child_process';
import { promisify } from 'node:util';
import { access, lstat, stat, readlink, realpath, mkdir, mkdtemp, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { swayDisplay, processIdentity, stillOwned, ownedDescendant, type ProcessIdentity } from '@e2e-dev/sway';
import { hyprland, type HyprlandOptions } from '@e2e-dev/hyprland';
import type { TernLease, TernRequest } from '@e2e-dev/tern';
import { EngineError } from 'e2e/engine';
import { nativeOptions } from '../native-options.ts';
import { nativeControl, nativeField, focusField, waitField } from './control.ts';
const exec=promisify(execFile);
const required=(name:string)=>{const value=process.env[name];assert(value&&value.startsWith('/'),`explicit absolute ${name} is required`);return value;};
const binaries=nativeOptions().binaries,hyprlandBinary=required('E2E_HYPRLAND_BINARY'),hyprctl=required('E2E_HYPRCTL_BINARY'),bwrap=required('E2E_BWRAP_BINARY'),nsenter=required('E2E_NSENTER_BINARY'),render=required('E2E_RENDER_DEVICE');
assert(/^\/dev\/dri\/renderD\d+$/.test(render));assert((await lstat(render)).isCharacterDevice());await access(render,constants.R_OK|constants.W_OK);
assert(process.getuid?.()!==0,'no root or permission changes');
const directory=await mkdtemp('/tmp/hy-'),privateDirectory=await mkdtemp('/tmp/ho-'),nativeRoot=await mkdtemp('/tmp/hn-'),configurationRoot=await mkdtemp('/tmp/hc-'),runtime=join(directory,'run'),artifacts=resolve('apps/tern-testbed/.e2e-hyprland');
const repo=fileURLToPath(new URL('../../../',import.meta.url)), app=fileURLToPath(new URL('../src/controls.mjs',import.meta.url));
for(const name of ['run','home','config','cache','state','native','foreign'])await mkdir(join(directory,name),{mode:0o700});
for(const name of ['run','home','config','cache','state'])await mkdir(join(directory,'foreign',name),{mode:0o700});
await mkdir(artifacts,{recursive:true,mode:0o700});
const signal=AbortSignal.timeout(180000), cleanup=()=>({signal:AbortSignal.timeout(30000),timeoutMs:30000});
const request:TernRequest={runId:randomUUID(),targetName:'hyprland-boundary',attemptId:'real-boundary',workerSlot:0,projectRoot:repo,app:{appPath:process.execPath,launchArguments:[app]},env:{PATH:'/usr/bin:/bin'},artifactsDir:artifacts,signal};
const outer=await swayDisplay({...nativeOptions(),root:join(privateDirectory,'o'),size:{width:1920,height:1080},renderer:'gles2',renderDevice:render},request);
let provider:ReturnType<typeof hyprland>|undefined, lease:TernLease|undefined, human:TernLease|undefined;
const quote=(value:string)=>`'${value.replaceAll("'","'\\''")}'`;
let host:HyprlandOptions['host']|undefined;
const ctl=async(args:string[],json=false)=>{assert(host);const {stdout}=await exec(hyprctl,['-i',host.instance,...json?['-j']:[],...args],{env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8',XDG_RUNTIME_DIR:runtime,HYPRLAND_INSTANCE_SIGNATURE:host.instance},signal,timeout:5000});if(json)return JSON.parse(stdout) as unknown;assert.equal(stdout.trim(),'ok');return undefined;};
try {
  const config=join(directory,'fixture.conf');
  await writeFile(config,'monitor = , 1920x1080@60, auto, 1\nxwayland { enabled = false }\nmisc { disable_hyprland_logo = true; disable_splash_rendering = true; focus_on_activate = false }\ngeneral { gaps_in = 0; gaps_out = 0; border_size = 0 }\n',{mode:0o600});
  // Keep host PID coordinates for lock/start-time checks. A user namespace is not a PID namespace.
  const guestWrites=[...['run','home','config','cache','state','native','foreign'].map(name=>join(directory,name)),nativeRoot];
  const privateReal=await realpath(privateDirectory);for(const path of guestWrites){const exposed=await realpath(path);assert(privateReal!==exposed&&!privateReal.startsWith(exposed+sep),'no guest-writable ancestor or symlink reaches host journals');}
  const args=['--die-with-parent','--unshare-user','--unshare-ipc','--unshare-net','--unshare-uts','--uid',String(process.getuid!()),'--gid',String(process.getgid!()),'--cap-drop','ALL','--ro-bind','/usr','/usr','--ro-bind','/proc','/proc','--ro-bind','/sys','/sys','--dev','/dev','--tmpfs','/run','--tmpfs','/tmp','--tmpfs','/etc','--dir',directory,'--ro-bind',config,config,'--dev-bind',render,render];
  for(const path of guestWrites)args.push('--bind',path,path);
  for(const path of ['/bin','/lib','/lib64']){try{const linkStat=await lstat(path);args.push(...linkStat.isSymbolicLink()?['--symlink',await readlink(path),path]:['--ro-bind',path,path]);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}
  for(const path of ['/etc/ld.so.cache','/etc/fonts']){try{await access(path);args.push('--ro-bind',path,path);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}
  const parentSocket=join(outer.env.XDG_RUNTIME_DIR!,outer.env.WAYLAND_DISPLAY!),guestParentSocket=join(runtime,'outer-wayland');
  args.push('--ro-bind',parentSocket,guestParentSocket,'--ro-bind',configurationRoot,configurationRoot);
  for(const path of new Set([join(repo,'packages'),join(repo,'apps','tern-testbed'),join(repo,'node_modules'),process.execPath,...Object.values(binaries),hyprlandBinary,hyprctl])){if(!path.startsWith('/usr/')&&!path.startsWith('/bin/'))args.push('--ro-bind',path,path);}
  const env={PATH:'/usr/bin:/bin',LANG:'C.UTF-8',HOME:join(directory,'home'),XDG_CONFIG_HOME:join(directory,'config'),XDG_CACHE_HOME:join(directory,'cache'),XDG_STATE_HOME:join(directory,'state'),XDG_RUNTIME_DIR:runtime,WAYLAND_DISPLAY:guestParentSocket,HYPRLAND_NO_RT:'1',AQ_DRM_DEVICES:render};
  args.push('--clearenv');for(const [key,value]of Object.entries(env))args.push('--setenv',key,value);
  const inaccessible=[privateDirectory,`/proc/${process.pid}/root${privateDirectory}`].map(path=>`test ! -e ${quote(path)}`).join(' && ');
  args.push('--chdir',directory,'/usr/bin/sh','-c',`${inaccessible} && exec ${[hyprlandBinary,'--config',config].map(quote).join(' ')}`);
  const launcher=await outer.spawn(bwrap,args,signal);
  const deadline=Date.now()+30000;
  for(;;){let entries:string[]=[];try{entries=await readdir(join(runtime,'hypr'));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    if(entries.length===1){try{const instance=entries[0]!;const lines=(await readFile(join(runtime,'hypr',instance,'hyprland.lock'),'utf8')).trim().split('\n');await access(join(runtime,'hypr',instance,'.socket.sock'));const identity=await processIdentity(Number(lines[0]));assert(await ownedDescendant(identity,launcher),'parent must be a current kernel descendant of the owned outer launcher');host={instance,runtimeDir:runtime,waylandDisplay:lines[1]!,hyprctl,process:identity};break;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}
    assert(Date.now()<deadline,'sandboxed Hyprland must become ready without a physical fallback');await delay(25,undefined,{signal});}
  const version=await ctl(['version'],true) as {version:string;commit:string};assert.equal(version.version,'0.56.2');assert.equal(version.commit,'efb50993780079460b0cbed1363e2166a2de1d9f');
  const status=await ctl(['status'],true) as {backend:string};assert.equal(status.backend,'wayland');
  const first=await ctl(['monitors'],true) as Array<{name:string;activeWorkspace:{id:number}}> ;assert.equal(first.length,1);
  await ctl(['output','create','headless','fixture-secondary']);
  const protectedMonitors=await ctl(['monitors'],true) as Array<{name:string;activeWorkspace:{id:number}}> ;assert.equal(protectedMonitors.length,2);
  const control=join(directory,'native','human.sock'),identityFile=join(directory,'native','human-process.json');
  const humanEnv={...env,WAYLAND_DISPLAY:host.waylandDisplay};
  await ctl(['dispatch','exec',`exec /usr/bin/env -i ${[...Object.entries(humanEnv).map(([k,v])=>`${k}=${v}`),binaries.input,'exec-owned',identityFile,binaries.tern,'--control',control].map(quote).join(' ')}`]);
  assert(host.process);const humanBinary=join(privateDirectory,'human-ctl');
  await writeFile(humanBinary,`#!/bin/sh\nexec ${[binaries.input,'enter-ns',String(host.process.pid),host.process.start,nsenter,binaries.tern].map(quote).join(' ')} "$@"\n`,{mode:0o700,flag:'wx'});
  human={id:'inert-human',pane:'1',mode:'native',control,binary:humanBinary,env:humanEnv};
  for(;;){try{await nativeControl(human,'state',signal);break;}catch(error){if(error instanceof EngineError&&error.code==='NOT_ACTIONABLE'||Date.now()>=deadline)throw error;await delay(25,undefined,{signal});}}
  await nativeControl(human,'ready',signal);await nativeControl(human,`run ${JSON.stringify([process.execPath,app].map(quote).join(' '))}`,signal);
  await waitField(human,'',signal);await focusField(human,signal);await nativeControl(human,'type "human-sentinel"',signal);await waitField(human,'human-sentinel',signal);await nativeControl(human,'key "ArrowLeft"',signal);
  const before=await nativeField(human,signal);
  const options:HyprlandOptions={host,guest:{nsenter,configurationRoot},protectedOutputs:protectedMonitors.map(m=>m.name),protectedWorkspaces:[...new Set([1,2,8,...protectedMonitors.map(m=>m.activeWorkspace.id)])],root:join(privateDirectory,'leases'),nativeRoot,sway:{...nativeOptions(),size:{width:1280,height:900}}};
  assert.throws(()=>hyprland({...options,workspace:'fixture-protected',protectedWorkspaces:[...options.protectedWorkspaces,'fixture-protected']}));
  await assert.rejects(hyprland({...options,protectedOutputs:['missing-declared-output']}).acquire({...request,runId:randomUUID()}));
  const occupied='fixture-occupied';const ws=protectedMonitors[0]!.activeWorkspace.id;
  await ctl(['dispatch','renameworkspace',`${ws} ${occupied}`]);await assert.rejects(hyprland({...options,workspace:occupied}).acquire({...request,runId:randomUUID()}));await ctl(['dispatch','renameworkspace',`${ws} ${ws}`]);
  provider=hyprland(options);lease=await provider.acquire(request);await waitField(lease,'',signal);await focusField(lease,signal);
  // Real server/app kernel context, not a command acknowledgment: guest-visible
  // ctl run authority must never execute a host-namespace Tern or Node app.
  assert(lease.client&&host.process);const actors=[lease.client.pid];for(let index=0;index<actors.length;index++){const pid=actors[index]!;const children=(await readFile(`/proc/${pid}/task/${pid}/children`,'utf8')).trim();if(children)actors.push(...children.split(/\s+/).map(Number));}
  const guestRoot=await stat(`/proc/${host.process.pid}/root`),hostRoot=await stat('/');assert(guestRoot.dev!==hostRoot.dev||guestRoot.ino!==hostRoot.ino,'guest filesystem root is not the host root');
  let apps=0;for(const pid of actors){for(const name of ['user','mnt','net','ipc','uts'])assert.equal(await readlink(`/proc/${pid}/ns/${name}`),await readlink(`/proc/${host.process.pid}/ns/${name}`),'server/app stays in the pinned guest namespaces');const root=await stat(`/proc/${pid}/root`);assert.equal(root.dev,guestRoot.dev);assert.equal(root.ino,guestRoot.ino);if(await readlink(`/proc/${pid}/exe`)===process.execPath)apps++;}
  assert(apps>0,'actual ctl-launched Node SDK app must exist inside the guest');
  const sentinel=join(privateDirectory,'host-write-sentinel');await writeFile(sentinel,'host-private-unchanged',{mode:0o600,flag:'wx'});
  const generated=(await readdir(configurationRoot)).find(name=>/^sway-.*\.conf$/.test(name));assert(generated);
  const probe=`const fs=require('node:fs');const sentinel=${JSON.stringify(sentinel)},config=${JSON.stringify(join(configurationRoot,generated))},alias=${JSON.stringify(join(lease.id,'sway.conf'))};try{fs.statSync(sentinel);process.exit(2)}catch(e){if(!['ENOENT','EACCES'].includes(e.code))throw e}fs.symlinkSync(sentinel,alias);try{fs.writeFileSync(config,'unauthorized');process.exit(3)}catch(e){if(!['EROFS','EACCES'].includes(e.code))throw e}`;
  await exec(binaries.input,['enter-ns',String(host.process.pid),host.process.start,nsenter,process.execPath,'-e',probe],{env:{PATH:'/usr/bin:/bin'},signal,timeout:10000});
  assert.equal(await readFile(sentinel,'utf8'),'host-private-unchanged','guest symlink cannot redirect a host config write');
  const identity=lease.client!;assert(await stillOwned(identity));await lease.input!.type('original',signal);await waitField(lease,'original',signal);await lease.input!.press('Control+A',signal);await lease.input!.type('replaced',signal);await waitField(lease,'replaced',signal);await lease.input!.press('End',signal);await lease.input!.type('?',signal);await waitField(lease,'replaced?',signal);
  assert.deepEqual(await nativeField(human,signal),before,'protected native value/focus are unchanged');
  const dump=await nativeControl(lease,'dump button',signal) as unknown as {elements:Array<{visible:boolean;rect:number[]}>};const buttons=dump.elements.filter(e=>e.visible);assert.equal(buttons.length,1);const rect=buttons[0]!.rect;await lease.input!.tap!(rect[0]!+rect[2]!/2,rect[1]!+rect[3]!/2,signal);
  const clickedDeadline=Date.now()+30000;
  for(;;){const ax=await nativeControl(lease,'a11y',signal),tree=await nativeControl(lease,'tree',signal);if(JSON.stringify(ax).includes('Count: 1')&&JSON.stringify(tree).includes('Count: 1'))break;assert(Date.now()<clickedDeadline,'pointer must produce the actual native rendered count');await delay(25,undefined,{signal});}
  const png=Buffer.from(await lease.capture!(signal));assert.equal(png.subarray(0,8).toString('hex'),'89504e470d0a1a0a');assert.equal(png.readUInt32BE(16),1280);assert.equal(png.readUInt32BE(20),900);await writeFile(join(artifacts,'owned-output.png'),png,{mode:0o600});
  const ownedOutputs=(await ctl(['monitors'],true) as Array<{name:string;activeWorkspace:{name:string}}>).filter(m=>!options.protectedOutputs.includes(m.name));assert.equal(ownedOutputs.length,1);
  const foreignRoot=join(directory,'foreign');
  const foreignFile=join(foreignRoot,'process.json'),foreignConfig=join(configurationRoot,'foreign-sway.conf');
  await writeFile(foreignConfig,'xwayland disable\noutput WL-1 mode 1280x900 scale 1\n',{mode:0o600});
  const foreignEnv={PATH:'/usr/bin:/bin',LANG:'C.UTF-8',HOME:join(foreignRoot,'home'),XDG_CONFIG_HOME:join(foreignRoot,'config'),XDG_CACHE_HOME:join(foreignRoot,'cache'),XDG_STATE_HOME:join(foreignRoot,'state'),XDG_RUNTIME_DIR:join(foreignRoot,'run'),WAYLAND_DISPLAY:join(runtime,host.waylandDisplay),WLR_BACKENDS:'wayland',WLR_RENDERER:'pixman',WLR_WL_OUTPUTS:'1',WLR_LIBINPUT_NO_DEVICES:'1'};
  let foreignIdentity:ProcessIdentity|undefined;
  try{
    await ctl(['dispatch','exec',`[monitor ${ownedOutputs[0]!.name}; workspace name:${ownedOutputs[0]!.activeWorkspace.name} silent; tag +fixture-foreign; no_initial_focus on; no_focus on] exec /usr/bin/env -i ${[...Object.entries(foreignEnv).map(([k,v])=>`${k}=${v}`),binaries.input,'exec-owned',foreignFile,binaries.sway,'--config',foreignConfig].map(quote).join(' ')}`]);
    const foreignDeadline=Date.now()+30000;for(;;){const clients=await ctl(['clients'],true) as Array<{pid:number;tags:string[];mapped:boolean}>;const matching=clients.filter(c=>c.mapped&&c.tags.some(t=>t==='fixture-foreign'||t==='fixture-foreign*'));if(matching.length){assert.equal(matching.length,1);const candidate=await processIdentity(matching[0]!.pid);assert(host.process&&await ownedDescendant(candidate,host.process));foreignIdentity=candidate;break;}assert(Date.now()<foreignDeadline,'actual foreign client must map');await delay(25,undefined,{signal});}
    await assert.rejects(lease.guard!(signal));await assert.rejects(provider.release(lease,cleanup()));
    assert(await stillOwned(identity),'foreign cleanup refusal must not kill the leased native client');assert.deepEqual(await nativeField(human,signal),before);
  }finally{
    if(foreignIdentity){
      assert(host.process&&await ownedDescendant(foreignIdentity,host.process));
      await exec(binaries.input,['stop',String(foreignIdentity.pid),foreignIdentity.start],{env:{PATH:'/usr/bin:/bin'},signal:AbortSignal.timeout(30000),timeout:30000});
      const foreignDeadline=Date.now()+15000;while(await stillOwned(foreignIdentity)||(await ctl(['clients'],true) as Array<{tags:string[]}>).some(c=>c.tags.some(t=>t==='fixture-foreign'||t==='fixture-foreign*'))){assert(Date.now()<foreignDeadline,'exact fixture foreign generation must exit and its client disappear');await delay(25,undefined,{signal});}
    }
  }
  for(const workerSignal of ['SIGKILL','SIGTERM','SIGINT'] as const){
    const workerRequest={...request,runId:randomUUID(),attemptId:workerSignal,signal:undefined};
    const payload=join(privateDirectory,`worker-${workerSignal}.json`);await writeFile(payload,JSON.stringify({options,request:workerRequest}),{mode:0o600});
    const worker=fork(fileURLToPath(new URL('./hyprland-worker.ts',import.meta.url)),[payload],{env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8'},stdio:['ignore','inherit','inherit','ipc']});
    try{
      const receipt=await new Promise<TernLease>((accept,reject)=>{const timer=setTimeout(()=>reject(new Error('Real containment worker did not become ready')),90000);worker.once('message',value=>{clearTimeout(timer);accept(value as TernLease);});worker.once('error',error=>{clearTimeout(timer);reject(error);});worker.once('exit',()=>{clearTimeout(timer);reject(new Error('Real containment worker exited before native proof'));});});
      assert(receipt.client&&await stillOwned(receipt.client));assert.equal((await nativeField(receipt,signal)).value,'interrupted-owned-client');
      const exited=once(worker,'exit');worker.kill(workerSignal);await exited;
      assert(await stillOwned(receipt.client),'owned native client survives worker termination before recovery');
      if(workerSignal==='SIGKILL'){
        // Reconstruct the durable pending-launch checkpoint on real mapped
        // processes: the guest receipt is lost and no private child PID was saved.
        const runRoot=join(options.root!,createHash('sha256').update(workerRequest.runId).update('\0').update(request.targetName).digest('hex').slice(0,24)),attempts=(await readdir(runRoot)).filter(name=>name.startsWith('attempt-'));assert.equal(attempts.length,1);
        const journal=join(runRoot,attempts[0]!),file=join(journal,'lease.json'),owner=JSON.parse(await readFile(file,'utf8')) as {child?:ProcessIdentity;identityFile:string};assert(owner.child);const nested=owner.child;delete owner.child;await writeFile(file,JSON.stringify(owner),{mode:0o600});await rm(owner.identityFile);
        const swayRoot=join(journal,'sway-journals'),runs=await readdir(swayRoot);assert.equal(runs.length,1);const swayRun=join(swayRoot,runs[0]!),leases=(await readdir(swayRun)).filter(name=>name.startsWith('attempt-'));assert.equal(leases.length,1);
        const pendingFile=join(swayRun,leases[0]!,'lease.json'),pending=JSON.parse(await readFile(pendingFile,'utf8')) as {parentPending?:string;processes:ProcessIdentity[]};pending.parentPending=owner.identityFile;pending.processes=pending.processes.filter(candidate=>candidate.pid!==nested.pid||candidate.start!==nested.start);await writeFile(pendingFile,JSON.stringify(pending),{mode:0o600});
        assert(await stillOwned(nested),'actual tagged compositor remains alive at the pending checkpoint');
      }
      await hyprland(options).sweep!({...request,runId:workerRequest.runId},cleanup());
      assert.equal(await stillOwned(receipt.client),false);assert.deepEqual(await nativeField(human,signal),before);
    }finally{if(worker.exitCode===null&&worker.signalCode===null){const exited=once(worker,'exit');worker.kill('SIGKILL');await exited;}await hyprland(options).sweep!({...request,runId:workerRequest.runId},cleanup());}
  }
  assert.deepEqual(await nativeField(human,signal),before);assert.deepEqual(await processIdentity(identity.pid),identity);
  await exec(binaries.input,['stop',String(identity.pid),identity.start],{env:{PATH:'/usr/bin:/bin'},signal:AbortSignal.timeout(30000),timeout:30000});
  const exitedDeadline=Date.now()+15000;while(await stillOwned(identity)){assert(Date.now()<exitedDeadline,'the exact ended native generation must exit before stale-guard proof');await delay(25,undefined,{signal});}
  await assert.rejects(lease.guard!(signal),'actual exited native generation must refuse inspection');
  await provider.release(lease,cleanup());lease=undefined;await provider.sweep!(request,cleanup());assert.equal(await stillOwned(identity),false);
  const fixtureOptions=join(privateDirectory,'cli-options.json');await writeFile(fixtureOptions,JSON.stringify(options),{mode:0o600});
  const cli=await exec(process.execPath,[join(repo,'packages/e2e/dist/cli/bin.js'),'run','--config',join(repo,'apps/tern-testbed/e2e.hyprland.config.ts'),'--output',join(artifacts,'cli'),'--workers','2','--retries','0','--no-cache','--reporter','list,markdown'],{cwd:repo,env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8',E2E_TELEMETRY_DISABLED:'1',E2E_HYPRLAND_FIXTURE_OPTIONS:fixtureOptions},signal,timeout:90000,maxBuffer:16*1024*1024});
  await writeFile(join(artifacts,'cli.txt'),`${cli.stdout}\n${cli.stderr}`,{mode:0o600});
  assert.deepEqual(await nativeField(human,signal),before);
  await nativeControl(human,'type "!"',signal);await waitField(human,'human-sentine!l',signal);
  const after=await ctl(['monitors'],true) as Array<{name:string}>;assert.deepEqual(after.map(m=>m.name).toSorted(),protectedMonitors.map(m=>m.name).toSorted());
  console.log('Real sandboxed Hyprland boundary: independent native value/caret/focus, chord, pointer, PNG and owned cleanup');
} finally {
  try {if(lease&&provider)await provider.release(lease,cleanup());if(provider)await provider.sweep!(request,cleanup());}
  finally{await outer.release(cleanup());await rm(directory,{recursive:true});await rm(nativeRoot,{recursive:true});await rm(configurationRoot,{recursive:true});await rm(privateDirectory,{recursive:true});}
}
