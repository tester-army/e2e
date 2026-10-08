import assert from 'node:assert/strict';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {test} from 'node:test';
import {mkdtemp,mkdir,lstat,symlink,rm,writeFile,readFile,chmod} from 'node:fs/promises';
import {join} from 'node:path';
const exec=promisify(execFile),binary=process.env.E2E_INPUT_BINARY;
assert(typeof binary==='string'&&binary.startsWith('/'),'explicit compiled E2E_INPUT_BINARY is required; this tests the real C helper');
test('atomic publication preserves an existing foreign directory and the owned stage',async()=>{
 const directory=await mkdtemp('/tmp/e2e-authority-');try{const stage=join(directory,'stage'),foreign=join(directory,'foreign');await mkdir(stage,{mode:0o700});await mkdir(foreign,{mode:0o700});const before=await lstat(foreign);await assert.rejects(exec(binary,['publish-root',stage,foreign]),{code:2});const after=await lstat(foreign);assert.equal(after.dev,before.dev);assert.equal(after.ino,before.ino);assert((await lstat(stage)).isDirectory());}finally{await rm(directory,{recursive:true});}
});
test('closed private fence rejects publish-root and argc4 still publishes',async()=>{
 const directory=await mkdtemp('/tmp/e2e-authority-');try{
  const stage=join(directory,'stage'),dest=join(directory,'dest'),fence=join(directory,'group.json'),late=join(directory,'late'),lateDest=join(directory,'late-dest');
  await mkdir(stage,{mode:0o700});const before=await lstat(stage);
  await exec(binary,['close',fence]);
  await assert.rejects(exec(binary,['publish-root',stage,dest,fence]),{code:2});
  assert.equal((await lstat(stage)).ino,before.ino);await assert.rejects(lstat(dest),{code:'ENOENT'});
  await exec(binary,['publish-root',stage,dest]);
  assert.equal((await lstat(dest)).ino,before.ino);
  await mkdir(late,{mode:0o700});
  await assert.rejects(exec(binary,['publish-root',late,lateDest,fence]),{code:2});
  await assert.rejects(lstat(lateDest),{code:'ENOENT'});assert((await lstat(late)).isDirectory());
 }finally{await rm(directory,{recursive:true});}
});
test('open private fence publishes under lock then close blocks a later helper',async()=>{
 const directory=await mkdtemp('/tmp/e2e-authority-');try{
  const stage=join(directory,'stage'),dest=join(directory,'dest'),fence=join(directory,'group.json');
  await mkdir(stage,{mode:0o700});const before=await lstat(stage);
  await exec(binary,['publish-root',stage,dest,fence]);
  assert.equal((await lstat(dest)).ino,before.ino);await assert.rejects(lstat(stage),{code:'ENOENT'});
  await exec(binary,['close',fence]);
  const second=join(directory,'second');await mkdir(second,{mode:0o700});
  await assert.rejects(exec(binary,['publish-root',second,join(directory,'second-dest'),fence]),{code:2});
  await assert.rejects(lstat(join(directory,'second-dest')),{code:'ENOENT'});
 }finally{await rm(directory,{recursive:true});}
});
test('guest-planted ancestor symlink cannot redirect host publication',async()=>{
 const directory=await mkdtemp('/tmp/e2e-authority-');try{const stage=join(directory,'stage'),sentinel=join(directory,'sentinel'),alias=join(directory,'alias');await mkdir(stage,{mode:0o700});await mkdir(sentinel,{mode:0o700});await symlink(sentinel,alias);await assert.rejects(exec(binary,['publish-root',stage,join(alias,'victim')]),{code:2});await assert.rejects(lstat(join(sentinel,'victim')),{code:'ENOENT'});}finally{await rm(directory,{recursive:true});}
});
test('a stale target generation cannot enter any namespace or dispatch its program',async()=>{
 const nsenter=process.env.E2E_NSENTER_BINARY;assert(typeof nsenter==='string'&&nsenter.startsWith('/'),'explicit E2E_NSENTER_BINARY is required');await assert.rejects(exec(binary,['enter-ns',String(process.pid),'0',nsenter,'/usr/bin/true']),{code:2});
});
test('closed private dispatch fence rejects a real Node child with no receipt or effect',async()=>{
 const directory=await mkdtemp('/tmp/e2e-authority-');try{
  const receipt=join(directory,'dispatch.json'),effect=join(directory,'effect'),writer=join(directory,'writer.mjs');
  await writeFile(writer,`import {writeFileSync} from 'node:fs'; writeFileSync(process.argv[2],'launched'); console.log('ok');\n`,{mode:0o700});
  await exec(binary,['close',receipt]);
  await assert.rejects(exec(binary,['dispatch-owned',receipt,process.execPath,writer,effect]),{code:2});
  await assert.rejects(lstat(receipt),{code:'ENOENT'});
  await assert.rejects(lstat(effect),{code:'ENOENT'});
 }finally{await rm(directory,{recursive:true});}
});
test('open dispatch-owned publishes a private receipt and preserves actual child stdout and exit',async()=>{
 const directory=await mkdtemp('/tmp/e2e-authority-');try{
  const receipt=join(directory,'dispatch.json'),writer=join(directory,'writer.mjs');
  await writeFile(writer,`console.log('ok'); process.exit(17);\n`,{mode:0o700});
  const failure=await exec(binary,['dispatch-owned',receipt,process.execPath,writer]).then(()=>undefined,error=>error as NodeJS.ErrnoException&{stdout?:string});
  assert.equal(failure?.code,17);
  assert.equal(String(failure?.stdout??'').trim(),'ok');
  const published=JSON.parse(await readFile(receipt,'utf8')) as {pid:number;start:string};
  assert(Number.isSafeInteger(published.pid)&&published.pid>0);
  assert(/^\d+$/.test(published.start));
  await assert.rejects(exec(binary,['dispatch-owned',receipt,'node','-e','']),{code:2});
  await chmod(directory,0o770);
  await assert.rejects(exec(binary,['dispatch-owned',join(directory,'other.json'),process.execPath,'-e','']),{code:2});
 }finally{await rm(directory,{recursive:true});}
});
test('timed-out dispatch-owned reaps the exact delayed child and writes no effect',async()=>{
 const directory=await mkdtemp('/tmp/e2e-authority-');
 const sentinel=spawn(process.execPath,['-e','process.stdin.resume()'],{stdio:['pipe','ignore','ignore']});
 try{
  assert(sentinel.pid&&sentinel.pid>0);
  const receipt=join(directory,'dispatch.json'),identity=join(directory,'child.json'),effect=join(directory,'effect'),writer=join(directory,'writer.mjs');
  // Real child delay: fake timers cannot reach the exec'd Node; the helper bound must win before the write.
  await writeFile(writer,`import {writeFileSync} from 'node:fs'; writeFileSync(process.argv[2],JSON.stringify({pid:process.pid})); await new Promise(resolve=>setTimeout(resolve,30000)); writeFileSync(process.argv[3],'launched');\n`,{mode:0o700});
  const failure=await exec(binary,['dispatch-owned',receipt,process.execPath,writer,identity,effect],{timeout:1000}).then(()=>undefined,error=>error as NodeJS.ErrnoException&{stdout?:string});
  assert(failure);
  assert.notEqual(failure.code,0);
  await assert.rejects(lstat(effect),{code:'ENOENT'});
  const published=JSON.parse(await readFile(receipt,'utf8')) as {pid:number;start:string};
  assert(Number.isSafeInteger(published.pid)&&published.pid>0);
  const child=JSON.parse(await readFile(identity,'utf8')) as {pid:number};
  assert(Number.isSafeInteger(child.pid)&&child.pid>0&&child.pid!==sentinel.pid);
  assert.throws(()=>{process.kill(child.pid,0);},{code:'ESRCH'});
  process.kill(sentinel.pid,0);
 }finally{sentinel.kill('SIGKILL');await rm(directory,{recursive:true});}
});
test('claim-root moves a pinned inode and refuses symlink source ancestors or foreign destinations',async()=>{
 const directory=await mkdtemp('/tmp/e2e-authority-');try{
  const stage=join(directory,'stage'),dest=join(directory,'dest'),real=join(directory,'real'),alias=join(directory,'alias');
  await mkdir(stage,{mode:0o700});const before=await lstat(stage);
  await exec(binary,['claim-root',stage,dest,String(before.dev),String(before.ino)]);
  const claimed=await lstat(dest);assert.equal(claimed.dev,before.dev);assert.equal(claimed.ino,before.ino);
  await assert.rejects(lstat(stage),{code:'ENOENT'});
  await mkdir(real,{mode:0o700});await mkdir(join(real,'nested'),{mode:0o700});await symlink(real,alias);
  const nested=await lstat(join(real,'nested'));
  await assert.rejects(exec(binary,['claim-root',join(alias,'nested'),join(directory,'via-alias'),String(nested.dev),String(nested.ino)]),{code:2});
  assert.equal((await lstat(join(real,'nested'))).ino,nested.ino);
  await assert.rejects(lstat(join(directory,'via-alias')),{code:'ENOENT'});
  const occupied=join(directory,'occupied'),foreignStage=join(directory,'foreign-stage');
  await mkdir(occupied,{mode:0o700});await mkdir(foreignStage,{mode:0o700});
  const foreign=await lstat(occupied),source=await lstat(foreignStage);
  await assert.rejects(exec(binary,['claim-root',foreignStage,occupied,String(source.dev),String(source.ino)]),{code:2});
  assert.equal((await lstat(occupied)).ino,foreign.ino);assert.equal((await lstat(foreignStage)).ino,source.ino);
  await assert.rejects(exec(binary,['claim-root',foreignStage,join(directory,'mismatch'),String(source.dev),'1']),{code:2});
  assert.equal((await lstat(foreignStage)).ino,source.ino);
  await assert.rejects(lstat(join(directory,'mismatch')),{code:'ENOENT'});
 }finally{await rm(directory,{recursive:true});}
});
test('claim-root refuses a source swapped after the caller recorded ownership',async()=>{
 const directory=await mkdtemp('/tmp/e2e-authority-');try{
  const stage=join(directory,'stage'),dest=join(directory,'dest');
  await mkdir(stage,{mode:0o700});await writeFile(join(stage,'owned-marker'),'owned');
  const owned=await lstat(stage);
  await rm(stage,{recursive:true});await mkdir(stage,{mode:0o700});await writeFile(join(stage,'foreign-sentinel'),'foreign-payload');
  const foreign=await lstat(stage);assert.notEqual(foreign.ino,owned.ino);
  await assert.rejects(exec(binary,['claim-root',stage,dest,String(owned.dev),String(owned.ino)]),{code:2});
  const remaining=await lstat(stage);assert.equal(remaining.dev,foreign.dev);assert.equal(remaining.ino,foreign.ino);
  assert.equal(await readFile(join(stage,'foreign-sentinel'),'utf8'),'foreign-payload');
  await assert.rejects(lstat(join(stage,'owned-marker')),{code:'ENOENT'});
  await assert.rejects(lstat(dest),{code:'ENOENT'});
  await assert.rejects(exec(binary,['claim-root',join(directory,'gone'),join(directory,'missing-dest'),String(owned.dev),String(owned.ino)]),{code:2});
  await assert.rejects(lstat(join(directory,'missing-dest')),{code:'ENOENT'});
 }finally{await rm(directory,{recursive:true});}
});
