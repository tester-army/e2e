import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readdir, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { sway } from '@e2e-dev/sway';
import type { TernRequest } from '@e2e-dev/tern';
import { nativeOptions } from '../native-options.ts';
import { requireExpectedNativeFailures } from './failure-report.ts';
const exec=promisify(execFile),root=await mkdtemp('/tmp/ef-'),artifactRoot=resolve('apps/tern-testbed/.e2e-failures');
await mkdir(artifactRoot,{recursive:true,mode:0o700});const output=await mkdtemp(join(artifactRoot,'run-'));
const env={PATH:process.env.PATH,LANG:'C.UTF-8',E2E_TELEMETRY_DISABLED:'1',E2E_NATIVE_FAILURE_ROOT:root,...Object.fromEntries(Object.entries(process.env).filter(([name])=>/^E2E_(SWAY|SWAYMSG|GRIM|TERN|INPUT)_BINARY$/.test(name)))};
async function records(path:string):Promise<Array<{client:{pid:number;start:string}}>> {const result:Array<{client:{pid:number;start:string}}>=[];for(const entry of await readdir(path,{withFileTypes:true})){const item=join(path,entry.name);if(entry.isDirectory())result.push(...await records(item));else if(entry.name==='native-client.json')result.push(JSON.parse(await readFile(item,'utf8')) as {client:{pid:number;start:string}});}return result;}
try{
  let failed=false;
  try{await exec(process.execPath,[resolve('packages/e2e/dist/cli/bin.js'),'run','--config',resolve('apps/tern-testbed/e2e.failures.config.ts'),'--output',output,'--workers','1','--no-cache','--reporter','json'],{env,timeout:180000,maxBuffer:16*1024*1024});}
  catch(error){const failure=error as {code?:number;stdout?:string;stderr?:string};assert.equal(failure.code,1,'only the runner expected failed-test exit is accepted');requireExpectedNativeFailures(JSON.parse(failure.stdout??''));await writeFile(join(output,'expected-failure.json'),failure.stdout!,{mode:0o600});failed=true;}
  assert(failed);const clients=await records(output);assert.equal(clients.length,3,'two actual retry clients and the actual deadline client must be recorded');
  for(const {client}of clients){try{const stat=await readFile(`/proc/${client.pid}/stat`,'utf8');assert.notEqual(stat.slice(stat.lastIndexOf(')')+2).split(' ')[19],client.start,'no recorded native generation may survive');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}
  assert.deepEqual(await readdir(root),[],'failed/retried/deadline run ownership is swept');
  const provider=sway({...nativeOptions(),root}),request:TernRequest={runId:randomUUID(),targetName:'partial-start',attemptId:'aborted',workerSlot:0,projectRoot:resolve('apps/tern-testbed'),app:{appPath:process.execPath,launchArguments:[fileURLToPath(new URL('../src/controls.mjs',import.meta.url))]},env:{PATH:process.env.PATH},artifactsDir:output,signal:AbortSignal.abort()};
  await assert.rejects(provider.acquire(request));await provider.sweep!(request,{signal:AbortSignal.timeout(30000),timeoutMs:30000});assert.deepEqual(await readdir(root),[]);
  const invalid=sway({...nativeOptions(),binaries:{...nativeOptions().binaries,sway:join(root,'absent-sway')},root}),badRequest={...request,attemptId:'bad-exec',signal:AbortSignal.timeout(30000)};
  await assert.rejects(invalid.acquire(badRequest));await invalid.sweep!(badRequest,{signal:AbortSignal.timeout(30000),timeoutMs:30000});assert.deepEqual(await readdir(root),[],'partial failed launch leaves no lease');
  console.log('Real native failures, retry, deadline, early abort and partial-launch ownership cleanup');
}finally{await rm(root,{recursive:true});}
