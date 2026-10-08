import {createHash} from 'node:crypto';
import {once} from 'node:events';
import {spawn} from 'node:child_process';
import {mkdir,mkdtemp,readdir,readFile,writeFile,symlink,lstat,rename,rm} from 'node:fs/promises';
import {createServer} from 'node:net';
import {join} from 'node:path';
import {describe,expect,test} from 'vitest';
import {hyprland,type HyprlandOptions} from '../../src/index.ts';
import {processIdentity,stillOwned} from '@e2e-dev/sway';
import type {TernRequest} from '@e2e-dev/tern';

// Protocol-only controller fixture: real files, Unix socket ownership and kernel
// generations exercise the public adapter. This is not native rendering proof.
async function fixture(){
  const directory=await mkdtemp('/tmp/hp-'),nativeRoot=await mkdtemp('/tmp/ht-'),runtime=join(directory,'run'),journals=join(directory,'journals');
  await mkdir(join(runtime,'hypr','fixture'),{recursive:true,mode:0o700});await mkdir(journals,{mode:0o700});
  const servers=[createServer(),createServer()];
  for(const [index,path]of [join(runtime,'wayland-1'),join(runtime,'hypr','fixture','.socket.sock')].entries()){const ready=once(servers[index]!,'listening');servers[index]!.listen(path);await ready;}
  const host=await processIdentity(process.pid);await writeFile(join(runtime,'hypr','fixture','hyprland.lock'),`${host.pid}\nwayland-1\n`);
  const human={id:1,name:'human',width:1920,height:1080,scale:1,x:0,y:0,activeWorkspace:{id:1,name:'1'},specialWorkspace:{id:0},focused:true,disabled:false};
  const data={version:{version:'0.56.2'},monitors:[human],clients:[],workspaces:[{id:1,name:'1',monitorID:1,windows:0,ispersistent:false}],workspacerules:[],activewindow:{address:'0xhuman'},cursorpos:{x:1,y:2}};
  const stateFile=join(directory,'ipc.json'),binary=join(directory,'controller');
  await writeFile(stateFile,JSON.stringify(data));
  await writeFile(binary,`#!${process.execPath}\nconst fs=require('node:fs');const path=require('node:path');const file=path.join(path.dirname(process.argv[1]),'ipc.json');const data=JSON.parse(fs.readFileSync(file,'utf8'));const args=process.argv.slice(2);if(args.includes('-j')){process.stdout.write(JSON.stringify(data[args.at(-1)]));}else if(args.includes('remove')){data.monitors=data.monitors.filter(m=>m.name!==args.at(-1));fs.writeFileSync(file,JSON.stringify(data));process.stdout.write('ok');}else process.exit(2);\n`,{mode:0o700});
  const input=join(directory,'input');await writeFile(input,`#!${process.execPath}\nconst fs=require('node:fs'),path=require('node:path');const [mode,source,dest,dev,ino]=process.argv.slice(2);if(mode==='close'){fs.writeFileSync(path.join(path.dirname(source),'.closing'),'',{mode:0o600});}else if(mode==='claim-root'){const flag=path.join(path.dirname(process.argv[1]),'replace-source');if(fs.existsSync(flag)){const foreign=fs.readFileSync(flag,'utf8');fs.renameSync(source,source+'-moved');fs.renameSync(foreign,source);fs.unlinkSync(flag);}const info=fs.lstatSync(source);if(info.dev!==Number(dev)||info.ino!==Number(ino)||fs.existsSync(dest))process.exit(2);fs.renameSync(source,dest);}else if(mode==='publish-root'){if(fs.existsSync(dest))process.exit(2);fs.renameSync(source,dest);}else process.exit(2);\n`,{mode:0o700});
  const options:HyprlandOptions={host:{instance:'fixture',runtimeDir:runtime,waylandDisplay:'wayland-1',hyprctl:binary,process:host},protectedOutputs:['human'],protectedWorkspaces:[1],root:journals,nativeRoot,sway:{binaries:{sway:process.execPath,swaymsg:process.execPath,tern:process.execPath,grim:process.execPath,input}}};
  const request:TernRequest={runId:'lifecycle',targetName:'consumer',attemptId:'first',workerSlot:0,projectRoot:directory,app:{appPath:process.execPath},env:{},artifactsDir:join(directory,'artifacts'),signal:new AbortController().signal};
  const root=join(journals,createHash('sha256').update(request.runId).update('\0').update(request.targetName).digest('hex').slice(0,24));
  const attempt=join(root,'attempt-owned'),childRoot=join(nativeRoot,'s-abcdef');
  const record={version:2,runId:request.runId,targetName:request.targetName,directory:attempt,childRoot,host,existingWorkspaces:[1],output:`e2e-${'a'.repeat(32)}`,tag:`e2e-${'a'.repeat(32)}`,workspace:'owned',artifactsDir:request.artifactsDir};
  const save=async(extra:Record<string,unknown>={})=>{await mkdir(attempt,{recursive:true,mode:0o700});await writeFile(join(attempt,'lease.json'),JSON.stringify({...record,...extra}));};
  const close=async()=>{for(const server of servers){const closed=once(server,'close');server.close();await closed;}await rm(directory,{recursive:true});await rm(nativeRoot,{recursive:true});};
  return{directory,nativeRoot,options,request,root,attempt,childRoot,record,data,stateFile,save,close};
}
const cleanup=()=>({signal:new AbortController().signal,timeoutMs:1000});
describe.skipIf(process.platform!=='linux')('Linux public containment lifecycle',()=>{
test('old unfenced journal versions retain unknown launch authority',async()=>{
  const f=await fixture();try{await f.save({version:1});await expect(hyprland(f.options).sweep!(f.request,cleanup())).rejects.toThrow();expect(JSON.parse(await readFile(join(f.attempt,'lease.json'),'utf8')).version).toBe(1);}finally{await f.close();}
});
test('artifact allocation failure removes the already-journaled empty child root',async()=>{
  const f=await fixture();try{const blocked=join(f.directory,'not-a-directory');await writeFile(blocked,'inert');await expect(hyprland(f.options).acquire({...f.request,artifactsDir:join(blocked,'artifacts')})).rejects.toThrow();expect(await readdir(f.nativeRoot)).toEqual([]);expect(await readdir(f.root)).toEqual([]);}finally{await f.close();}
});
test('pre-journal worker death and already-removed child cleanup are recoverable',async()=>{
  const f=await fixture();try{await mkdir(f.attempt,{recursive:true,mode:0o700});await writeFile(join(f.attempt,'lease.next'),'incomplete');await hyprland(f.options).sweep!(f.request,cleanup());await expect(readFile(join(f.attempt,'lease.next'))).rejects.toMatchObject({code:'ENOENT'});await f.save();await hyprland(f.options).sweep!(f.request,cleanup());expect(await readdir(f.nativeRoot)).toEqual([]);await expect(readdir(f.root)).rejects.toMatchObject({code:'ENOENT'});}finally{await f.close();}
});
test('cleanup refuses a foreign empty active workspace even without a live child',async()=>{
  const f=await fixture();try{await f.save({outputRequested:true,outputId:2,workspaceId:3,workspaceOriginalName:'3',workspaceRenamed:true});f.data.monitors.push({...f.data.monitors[0]!,id:2,name:f.record.output,focused:false,activeWorkspace:{id:4,name:'foreign-empty'}});await writeFile(f.stateFile,JSON.stringify(f.data));await expect(hyprland(f.options).sweep!(f.request,cleanup())).rejects.toThrow('workspace identity');expect(JSON.parse(await readFile(f.stateFile,'utf8')).monitors).toHaveLength(2);expect(await readFile(join(f.attempt,'lease.json'),'utf8')).toContain('owned');}finally{await f.close();}
});
test('cleanup refuses changed owned-output geometry and a forged guest generation',async()=>{
  const f=await fixture();try{const output={...f.data.monitors[0]!,id:2,name:f.record.output,focused:false,activeWorkspace:{id:3,name:'owned'}};f.data.monitors.push({...output,scale:2});await writeFile(f.stateFile,JSON.stringify(f.data));const extra={outputRequested:true,outputId:2,workspaceId:3,workspaceRenamed:true,workspaceOriginalName:'3'};await f.save({...extra,outputGeometry:{x:0,y:0,width:1920,height:1080,scale:1}});await expect(hyprland(f.options).sweep!(f.request,cleanup())).rejects.toThrow('geometry changed');f.data.monitors[1]=output;await writeFile(f.stateFile,JSON.stringify(f.data));const parent=await processIdentity(process.ppid),receipt=join(f.directory,'guest-receipt.json');await writeFile(receipt,JSON.stringify(parent));await f.save({...extra,identityFile:receipt});await expect(hyprland(f.options).sweep!(f.request,cleanup())).rejects.toThrow('independently verified descendant');expect(await stillOwned(parent)).toBe(true);}finally{await f.close();}
});
test('guest-writable ancestors and symlinks cannot become cleanup journals',async()=>{
  const f=await fixture();try{const guestJournals=join(f.nativeRoot,'journals');await mkdir(guestJournals,{mode:0o700});const alias=join(f.directory,'alias');await symlink(guestJournals,alias);for(const root of [guestJournals,alias])await expect(hyprland({...f.options,root}).acquire(f.request)).rejects.toMatchObject({code:'INVALID_STATE',retryable:false});}finally{await f.close();}
});
test('planned and staged allocation never remove a colliding foreign private directory',async()=>{
  const f=await fixture();try{await mkdir(f.childRoot,{mode:0o700});const foreign=await lstat(f.childRoot);await f.save();await hyprland(f.options).sweep!(f.request,cleanup());assertIdentity(await lstat(f.childRoot),foreign);await f.save();const stage=join(f.attempt,'child-stage');await mkdir(stage,{mode:0o700});const identity=await lstat(stage);await f.save({childIdentity:{dev:identity.dev,ino:identity.ino}});await hyprland(f.options).sweep!(f.request,cleanup());assertIdentity(await lstat(f.childRoot),foreign);}finally{await f.close();}
});
test('crash after atomic publication is recovered using the already-persisted inode',async()=>{
  const f=await fixture();try{await f.save();const stage=join(f.attempt,'child-stage');await mkdir(stage,{mode:0o700});const identity=await lstat(stage);await f.save({childIdentity:{dev:identity.dev,ino:identity.ino}});await rename(stage,f.childRoot);await hyprland(f.options).sweep!(f.request,cleanup());await expect(lstat(f.childRoot)).rejects.toMatchObject({code:'ENOENT'});}finally{await f.close();}
});
test.each(['moved','resized','hidden','unmapped','foreign PID','retagged and moved','retagged and moved without owned output','missing mapped client'])('cleanup refuses a live recorded client with changed %s containment',async(change)=>{
  const f=await fixture(),child=spawn(process.execPath,['-e','process.stdin.resume()'],{stdio:['pipe','ignore','ignore']});
  try{
    await once(child,'spawn');const identity=await processIdentity(child.pid!);
    f.data.monitors.push({...f.data.monitors[0]!,id:2,name:f.record.output,focused:false,activeWorkspace:{id:3,name:'owned'}});
    const client={address:'0xowned',pid:identity.pid,monitor:2,workspace:{id:3,name:'owned'},tags:[f.record.tag],at:[0,0],size:[1280,900],mapped:true,hidden:false,xwayland:false};
    if(change==='moved'||change.startsWith('retagged and moved')){client.monitor=1;client.workspace={id:1,name:'1'};if(change.startsWith('retagged and moved'))client.tags=[];if(change==='retagged and moved without owned output')f.data.monitors.pop();}else if(change==='resized')client.size=[1279,900];else if(change==='hidden')client.hidden=true;else if(change==='unmapped')client.mapped=false;else if(change==='foreign PID')client.pid=process.pid;
    await writeFile(f.stateFile,JSON.stringify({...f.data,clients:change==='missing mapped client'?[]:[client]}));await f.save({outputRequested:true,outputId:2,workspaceId:3,workspaceOriginalName:'3',workspaceRenamed:true,child:identity});
    await expect(hyprland(f.options).sweep!(f.request,cleanup())).rejects.toThrow(/containment|foreign client/);
    expect(await stillOwned(identity)).toBe(true);expect(await readFile(join(f.attempt,'lease.json'),'utf8')).toContain(String(identity.pid));expect(JSON.parse(await readFile(f.stateFile,'utf8')).monitors).toHaveLength(change==='retagged and moved without owned output'?1:2);
  }finally{if(child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill('SIGTERM');await exited;}await f.close();}
});
test('cleanup permits an independently exited generation with no mapped client',async()=>{
  const f=await fixture(),child=spawn(process.execPath,['-e','process.stdin.resume()'],{stdio:['pipe','ignore','ignore']});
  try{
    await once(child,'spawn');const identity=await processIdentity(child.pid!);const exited=once(child,'exit');child.kill('SIGTERM');await exited;expect(await stillOwned(identity)).toBe(false);
    f.data.monitors.push({...f.data.monitors[0]!,id:2,name:f.record.output,focused:false,activeWorkspace:{id:3,name:'owned'}});
    await writeFile(f.stateFile,JSON.stringify({...f.data,clients:[]}));await f.save({outputRequested:true,outputId:2,workspaceId:3,workspaceOriginalName:'3',workspaceRenamed:true,child:identity});
    await hyprland(f.options).sweep!(f.request,cleanup());await expect(readFile(join(f.attempt,'lease.json'))).rejects.toMatchObject({code:'ENOENT'});
  }finally{if(child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill('SIGTERM');await exited;}await f.close();}
});
test.each(['before parent endpoint save','after parent endpoint save','potential private dispatch'])('public pending launch recovery: %s',async(cut)=>{
  const f=await fixture();try{
    await mkdir(f.childRoot,{mode:0o700});const child=await lstat(f.childRoot),runName=f.root.slice(f.root.lastIndexOf('/')+1),runtimeRun=join(f.childRoot,runName),runtime=join(runtimeRun,'attempt-abcdef'),journalRun=join(f.attempt,'sway-journals',runName),journal=join(journalRun,'attempt-abcdef'),endpoint=join(runtime,'launch-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.json');
    await mkdir(runtime,{recursive:true,mode:0o700});await mkdir(journal,{recursive:true,mode:0o700});const runtimeIdentity=await lstat(runtime);
    f.data.monitors.push({...f.data.monitors[0]!,id:2,name:f.record.output,focused:false,activeWorkspace:{id:3,name:'owned'}});await writeFile(f.stateFile,JSON.stringify(f.data));
    await f.save({childIdentity:{dev:child.dev,ino:child.ino},outputRequested:true,outputId:2,workspaceId:3,workspaceOriginalName:'3',workspaceRenamed:true,...(cut!=='before parent endpoint save'?{identityFile:endpoint}:{})});
    await writeFile(join(journal,'lease.json'),JSON.stringify({version:2,runId:f.request.runId,targetName:f.request.targetName,directory:runtime,journalDirectory:journal,processes:[],parentPending:endpoint,runtimeIdentity:{dev:runtimeIdentity.dev,ino:runtimeIdentity.ino}}),{mode:0o600});
    const runIdentity=await lstat(runtimeRun);await writeFile(join(journalRun,'runtime-root.json'),JSON.stringify({version:1,runId:f.request.runId,targetName:f.request.targetName,directory:runtimeRun,stage:join(journalRun,'run-stage-abcdef'),dev:runIdentity.dev,ino:runIdentity.ino}),{mode:0o600});
    if(cut==='potential private dispatch'){
      await writeFile(join(f.attempt,'dispatch.json'),JSON.stringify(f.record.host),{mode:0o600});
      await expect(hyprland(f.options).sweep!(f.request,cleanup())).rejects.toThrow('retain runtime and receipt');
      assertIdentity(await lstat(runtime),runtimeIdentity);expect(await readFile(join(journal,'lease.json'),'utf8')).toContain('parentPending');expect(JSON.parse(await readFile(f.stateFile,'utf8')).monitors).toHaveLength(2);
    }else{
      await hyprland(f.options).sweep!(f.request,cleanup());
      await expect(lstat(runtime)).rejects.toMatchObject({code:'ENOENT'});await expect(lstat(f.childRoot)).rejects.toMatchObject({code:'ENOENT'});await expect(lstat(f.attempt)).rejects.toMatchObject({code:'ENOENT'});expect(JSON.parse(await readFile(f.stateFile,'utf8')).monitors).toHaveLength(1);
    }
  }finally{await f.close();}
});
test('replacement between child-root check and claim preserves foreign inode and contents',async()=>{
  const f=await fixture();try{
    await mkdir(f.childRoot,{mode:0o700});const identity=await lstat(f.childRoot);await f.save({childIdentity:{dev:identity.dev,ino:identity.ino}});
    const foreign=join(f.nativeRoot,'foreign');await mkdir(foreign,{mode:0o700});await writeFile(join(foreign,'sentinel'),'foreign-unchanged');const before=await lstat(foreign);await writeFile(join(f.directory,'replace-source'),foreign);
    await expect(hyprland(f.options).sweep!(f.request,cleanup())).rejects.toThrow();assertIdentity(await lstat(f.childRoot),before);expect(await readFile(join(f.childRoot,'sentinel'),'utf8')).toBe('foreign-unchanged');expect(await readFile(join(f.attempt,'lease.json'),'utf8')).toContain('childIdentity');
  }finally{await f.close();}
});
test('private child-root claim resumes after a crash without deleting a public replacement',async()=>{
  const f=await fixture();try{
    await mkdir(f.childRoot,{mode:0o700});const identity=await lstat(f.childRoot);await f.save({childIdentity:{dev:identity.dev,ino:identity.ino}});await rename(f.childRoot,join(f.attempt,'claimed-child'));
    await mkdir(f.childRoot,{mode:0o700});const foreign=await lstat(f.childRoot);await hyprland(f.options).sweep!(f.request,cleanup());assertIdentity(await lstat(f.childRoot),foreign);
  }finally{await f.close();}
});
test('unvalidated private child-root claim is preserved with its cleanup record',async()=>{
  const f=await fixture();try{
    await mkdir(f.childRoot,{mode:0o700});const identity=await lstat(f.childRoot);await f.save({childIdentity:{dev:identity.dev,ino:identity.ino}});await rename(f.childRoot,f.childRoot+'-moved');
    const claim=join(f.attempt,'claimed-child');await mkdir(claim,{mode:0o700});await writeFile(join(claim,'sentinel'),'foreign-private-claim');const before=await lstat(claim);
    await expect(hyprland(f.options).sweep!(f.request,cleanup())).rejects.toThrow('Private child-root claim');assertIdentity(await lstat(claim),before);expect(await readFile(join(claim,'sentinel'),'utf8')).toBe('foreign-private-claim');expect(await readFile(join(f.attempt,'lease.json'),'utf8')).toContain('childIdentity');
  }finally{await f.close();}
});
});
function assertIdentity(actual:{dev:number;ino:number},expected:{dev:number;ino:number}){expect(actual.dev).toBe(expected.dev);expect(actual.ino).toBe(expected.ino);}
