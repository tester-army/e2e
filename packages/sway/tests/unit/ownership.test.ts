import { describe,expect,it } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp,chmod,symlink,rm,mkdir,lstat,readFile,writeFile,readdir,rename } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { processIdentity,ownedDescendant,stillOwned,ownedDirectory } from '../../src/ownership.ts';
import {createHash} from 'node:crypto';
import {sway,swayDisplay} from '../../src/index.ts';
describe.skipIf(process.platform!=='linux')('Linux lease ownership',()=>{
it('kernel ancestry accepts the real child but refuses a forged generation and parent',async()=>{
  const child=spawn(process.execPath,['-e','process.stdin.resume()'],{stdio:['pipe','ignore','ignore']});
  try{await once(child,'spawn');const identity=await processIdentity(child.pid!),root=await processIdentity(process.pid);
    expect(await ownedDescendant(identity,root)).toBe(true);expect(await ownedDescendant({...identity,start:'0'},root)).toBe(false);expect(await ownedDescendant(root,identity)).toBe(false);
    expect(await ownedDescendant(root,root)).toBe(false);
  }finally{const exited=once(child,'exit');child.kill('SIGTERM');await exited;}
});
  it('refuses stale process generations without signaling',async()=>{
    const identity=await processIdentity(process.pid);
    expect(await stillOwned(identity)).toBe(true);
    expect(await stillOwned({...identity,start:'different-generation'})).toBe(false);
  });
  it('refuses public directories and symlink ownership',async()=>{
    const directory=await mkdtemp(join(tmpdir(),'e2e-owned-test-')),link=directory+'-link';
    try{await ownedDirectory(directory);await symlink(directory,link);await expect(ownedDirectory(link)).rejects.toThrow('private and owned');await chmod(directory,0o755);await expect(ownedDirectory(directory)).rejects.toThrow('private and owned');}
    finally{await rm(link,{force:true});await rm(directory,{recursive:true});}
  });
  it('normalizes trailing-slash default journals and retains unknown pending authority',async()=>{
    const f=await filesystemLease();try{
      const provider=sway({...f.options,parent:{runtimeDir:f.directory,waylandDisplay:'wayland-1',async launch(){throw new Error('Unexpected launch');},async recover(){return {kind:'UNKNOWN'};}}});
      await expect(provider.sweep!(f.request,{signal:new AbortController().signal,timeoutMs:1000})).rejects.toThrow('retain runtime and receipt');
      expect(await readFile(f.receipt,'utf8')).toBe('untrusted-pending');expect(await readFile(join(f.journal,'lease.json'),'utf8')).toContain('parentPending');expect((await lstat(f.runtime)).ino).toBe(f.identity.ino);
    }finally{await f.close();}
  });
  it('refuses old unfenced lease records without inferring never-launched authority',async()=>{
    const f=await filesystemLease();try{await writeFile(join(f.journal,'lease.json'),JSON.stringify({...f.record,version:1}));await expect(sway(f.options).sweep!(f.request,{signal:new AbortController().signal,timeoutMs:1000})).rejects.toThrow('unowned native cleanup record');expect(await readFile(f.receipt,'utf8')).toBe('untrusted-pending');}finally{await f.close();}
  });
  it('preserves a runtime replaced between the ownership check and private claim',async()=>{
    const f=await filesystemLease();try{
      const foreign=join(f.directory,'foreign');await mkdir(foreign,{mode:0o700});await writeFile(join(foreign,'sentinel'),'foreign-unchanged');const info=await lstat(foreign);await writeFile(join(f.directory,'replace-source'),foreign);
      await writeFile(join(f.journal,'lease.json'),JSON.stringify({...f.record,parentPending:undefined}));
      await expect(sway(f.options).sweep!(f.request,{signal:new AbortController().signal,timeoutMs:1000})).rejects.toThrow();
      expect((await lstat(f.runtime)).ino).toBe(info.ino);expect(await readFile(join(f.runtime,'sentinel'),'utf8')).toBe('foreign-unchanged');expect(await readFile(join(f.journal,'lease.json'),'utf8')).toContain('runtimeIdentity');
    }finally{await f.close();}
  });
  it('resumes a private runtime claim without requiring the removed public name',async()=>{
    const f=await filesystemLease();try{await writeFile(join(f.journal,'lease.json'),JSON.stringify({...f.record,parentPending:undefined}));await rename(f.runtime,join(f.journal,'claimed-runtime'));await sway(f.options).sweep!(f.request,{signal:new AbortController().signal,timeoutMs:1000});await expect(lstat(f.runtime)).rejects.toMatchObject({code:'ENOENT'});await expect(lstat(f.journal)).rejects.toMatchObject({code:'ENOENT'});}finally{await f.close();}
  });
  it('refuses equal, nested and symlinked journal prefixes before profile writes',async()=>{
    const directory=await mkdtemp('/tmp/jb-'),runtime=join(directory,'r'),alias=join(directory,'alias');try{
      await mkdir(runtime,{mode:0o700});await symlink(runtime,alias);
      const request={runId:'boundary',targetName:'consumer',attemptId:'first',workerSlot:0,projectRoot:directory,app:{appPath:process.execPath},env:{},artifactsDir:join(directory,'artifacts'),signal:new AbortController().signal};
      const binaries={sway:process.execPath,swaymsg:process.execPath,tern:process.execPath,grim:process.execPath,input:process.execPath};
      for(const journalRoot of [runtime+'/',join(runtime,'nested'),join(alias,'nested')])await expect(swayDisplay({root:runtime,journalRoot,binaries},request)).rejects.toThrow(/Cleanup journals/);
      expect(await readdir(runtime)).toEqual([]);
    }finally{await rm(directory,{recursive:true});}
  });
});

// Public filesystem lifecycle only; native helper atomicity is independently
// covered by tests/native/authority.test.ts, not claimed by this protocol fixture.
async function filesystemLease(){
  const directory=await mkdtemp('/tmp/pe-'),prefix=join(directory,'r'),request={runId:'pending',targetName:'consumer',env:{}},hash=createHash('sha256').update(request.runId).update('\0').update(request.targetName).digest('hex').slice(0,24),run=join(prefix,hash),journalRun=join(prefix+'-j',hash),runtime=join(run,'attempt-abcdef'),journal=join(journalRun,'attempt-abcdef'),input=join(directory,'input');
  await mkdir(runtime,{recursive:true,mode:0o700});await mkdir(journal,{recursive:true,mode:0o700});const identity=await lstat(runtime),root=await lstat(run),receipt=join(runtime,'launch-owned.json');await writeFile(receipt,'untrusted-pending');
  const record={version:2,runId:request.runId,targetName:request.targetName,directory:runtime,journalDirectory:journal,processes:[],parentPending:receipt,runtimeIdentity:{dev:identity.dev,ino:identity.ino}};
  await writeFile(join(journal,'lease.json'),JSON.stringify(record),{mode:0o600});await writeFile(join(journalRun,'runtime-root.json'),JSON.stringify({version:1,runId:request.runId,targetName:request.targetName,directory:run,stage:join(journalRun,'run-stage-abcdef'),dev:root.dev,ino:root.ino}),{mode:0o600});
  await writeFile(input,`#!${process.execPath}\nconst fs=require('node:fs'),path=require('node:path');const [mode,source,dest,dev,ino]=process.argv.slice(2);if(mode==='close'){fs.writeFileSync(path.join(path.dirname(source),'.closing'),'');}else if(mode==='claim-root'){const flag=path.join(path.dirname(process.argv[1]),'replace-source');if(fs.existsSync(flag)){const foreign=fs.readFileSync(flag,'utf8');fs.renameSync(source,source+'-moved');fs.renameSync(foreign,source);fs.unlinkSync(flag);}const info=fs.lstatSync(source);if(info.dev!==Number(dev)||info.ino!==Number(ino)||fs.existsSync(dest))process.exit(2);fs.renameSync(source,dest);}else if(mode==='publish-root'){if(fs.existsSync(dest))process.exit(2);fs.renameSync(source,dest);}else process.exit(2);\n`,{mode:0o700});
  const options={root:prefix+'/',binaries:{sway:process.execPath,swaymsg:process.execPath,tern:process.execPath,grim:process.execPath,input}};
  return {directory,runtime,journal,identity,receipt,record,request,options,close:()=>rm(directory,{recursive:true})};
}
