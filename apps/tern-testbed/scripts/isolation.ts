import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile, access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createConnection } from 'node:net';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { sway } from '@e2e-dev/sway';
import type { TernRequest,TernLease } from '@e2e-dev/tern';
import { nativeOptions } from '../native-options.ts';
import { nativeControl,nativeField,focusField,waitField } from './control.ts';
const directory=await mkdtemp(join(tmpdir(),'e2e-iso-')),runId=randomUUID(),provider=sway({...nativeOptions(),root:directory});
const request:TernRequest={runId,targetName:'two-leases',attemptId:'agent',workerSlot:0,projectRoot:fileURLToPath(new URL('..',import.meta.url)),app:{appPath:process.execPath,launchArguments:[fileURLToPath(new URL('../src/controls.mjs',import.meta.url))]},env:{PATH:process.env.PATH},artifactsDir:join(directory,'artifacts'),signal:AbortSignal.timeout(180000)};
await mkdir(request.artifactsDir,{mode:0o700});const leases:TernLease[]=[];
try {
  const results=await Promise.allSettled([provider.acquire(request),provider.acquire({...request,attemptId:'sentinel',workerSlot:1})]);
  for(const result of results)if(result.status==='fulfilled')leases.push(result.value);
  for(const result of results)if(result.status==='rejected')throw result.reason;
  const [agent,sentinel]=leases as [TernLease,TernLease];assert.notEqual(agent.id,sentinel.id);assert.notEqual(agent.env.XDG_RUNTIME_DIR,sentinel.env.XDG_RUNTIME_DIR);assert.notEqual(agent.env.HOME,sentinel.env.HOME);assert.notEqual(agent.client!.pid,sentinel.client!.pid);
  await focusField(sentinel,request.signal);await sentinel.input!.type('human-sentinel',request.signal);await waitField(sentinel,'human-sentinel',request.signal);await sentinel.input!.press('ArrowLeft',request.signal);
  const before=await nativeField(sentinel,request.signal);assert.equal(before.focused,true);
  await focusField(agent,request.signal);await agent.input!.type('original',request.signal);await agent.input!.press('Control+A',request.signal);await agent.input!.type('replaced',request.signal);await waitField(agent,'replaced',request.signal);
  // Hold the real retained injector in an incomplete text request, then revoke
  // queued complete key/click requests and an empty connection before dispatch.
  const endpoint=join(agent.id,'input.sock');
  const connect=async()=>{const socket=createConnection(endpoint);await once(socket,'connect');return socket;};
  const blocker=await connect();await new Promise<void>((accept,reject)=>blocker.write('T 1024\n',error=>error?reject(error):accept()));
  const dump=await nativeControl(agent,'dump button',request.signal) as unknown as {elements:Array<{visible:boolean;rect:number[]}>};
  const button=dump.elements.filter(element=>element.visible);assert.equal(button.length,1);const rect=button[0]!.rect;
  const click=`P ${Math.floor(rect[0]!+rect[2]!/2)} ${Math.floor(rect[1]!+rect[3]!/2)} 1280 900 1\n`;
  for(const command of ['K 0 U0078\n',click]){
    const queued=await connect();await new Promise<void>((accept,reject)=>queued.write(command,error=>error?reject(error):accept()));const closed=once(queued,'close');queued.destroy();await closed;
  }
  const empty=await connect(),emptyClosed=once(empty,'close');empty.destroy();await emptyClosed;
  const unblocked=once(blocker,'close');blocker.destroy();await unblocked;
  await waitField(agent,'replaced',request.signal);
  assert(JSON.stringify(await nativeControl(agent,'a11y',request.signal)).includes('Count: 0'),'cancelled queued pointer must not click');
  const hold=join(agent.id,'cutpoint.hold'),marker=join(agent.id,'cutpoint'),waiting=join(agent.id,'cutpoint.waiting'),receipt=join(agent.id,'effect.receipt');
  const snap=async()=>await readFile(receipt,'utf8');
  assert((await snap()).split('\n').includes('key-press'),'warmup effect receipt must be readable before cutpoints');
  const complete=async()=>{
    const socket=await connect();
    const {promise,resolve,reject}=Promise.withResolvers<void>();
    let reply='',settled=false;
    const finish=(error?:Error)=>{if(settled)return;settled=true;if(error)reject(error);else resolve();};
    socket.on('data',data=>{reply+=data.toString();if(reply.includes('\n'))finish(reply==='OK\n'?undefined:new Error(`T 0 reply ${JSON.stringify(reply)}`));});
    socket.on('error',error=>finish(error instanceof Error?error:new Error('T 0 transport')));
    socket.on('close',()=>{if(!reply.includes('\n'))finish(new Error('T 0 ended without reply'));});
    await new Promise<void>((accept,fail)=>socket.write('T 0\n',error=>error?fail(error):accept()));
    await promise;
    socket.destroy();
  };
  const park=async(name:string,command:string)=>{
    const prior=await snap();
    await writeFile(hold,'');
    await writeFile(marker,name);
    const socket=await connect();
    const closed=once(socket,'close');
    await new Promise<void>((accept,fail)=>socket.write(command,error=>error?fail(error):accept()));
    const deadline=Date.now()+5000;
    for(;;){
      try{await access(waiting);break;}catch{assert(Date.now()<deadline,`native cutpoint ${name} was not reached`);await delay(10,undefined,{signal:request.signal});}
    }
    socket.destroy();await closed;
    await rm(hold);
    await complete();
    const delta=(await snap()).slice(prior.length).split('\n').filter(Boolean);
    assert(!delta.includes(name),`cancelled ${name} must not append an effect receipt`);
  };
  await park('keymap-unicode','K 0 U00E9\n');
  await waitField(agent,'replaced',request.signal);
  await agent.input!.type('é',request.signal);
  await waitField(agent,'replacedé',request.signal);
  await park('keymap-restore','K 0 U0078\n');
  await waitField(agent,'replacedé',request.signal);
  await agent.input!.press('Control+A',request.signal);
  await agent.input!.type('replaced',request.signal);
  await waitField(agent,'replaced',request.signal);
  await park('modifier-press','K 1 U0078\n');
  await waitField(agent,'replaced',request.signal);
  await park('modifier-press-1','K 3 U0078\n');
  await waitField(agent,'replaced',request.signal);
  await park('modifier-state','K 0 U0078\n');
  await waitField(agent,'replaced',request.signal);
  await park('key-press','K 0 U0078\n');
  await waitField(agent,'replaced',request.signal);
  await park('pointer-motion',click);
  await waitField(agent,'replaced',request.signal);
  assert(JSON.stringify(await nativeControl(agent,'a11y',request.signal)).includes('Count: 0'),'cancelled motion cutpoint must not click');
  await park('pointer-button',click);
  await waitField(agent,'replaced',request.signal);
  assert(JSON.stringify(await nativeControl(agent,'a11y',request.signal)).includes('Count: 0'),'cancelled button cutpoint must not click');
  await agent.input!.press('End',request.signal);
  await agent.input!.type('!',request.signal);await waitField(agent,'replaced!',request.signal);
  assert.deepEqual(await nativeField(sentinel,request.signal),before,'other native lease value/focus is untouched');
  await sentinel.input!.type('!',request.signal);await waitField(sentinel,'human-sentine!l',request.signal); // actual insertion position proves the caret, not a draft receipt.
  await provider.release(agent,{signal:AbortSignal.timeout(30000),timeoutMs:30000});leases.splice(leases.indexOf(agent),1);
  await sentinel.input!.press('End',request.signal);await sentinel.input!.type('?',request.signal);await waitField(sentinel,'human-sentine!l?',request.signal);
  await nativeControl(sentinel,'state',request.signal);console.log('Real concurrent native leases: input/caret/focus and cleanup ownership remain separate');
} finally { for(const lease of leases)await provider.release(lease,{signal:AbortSignal.timeout(30000),timeoutMs:30000});await provider.sweep!(request,{signal:AbortSignal.timeout(30000),timeoutMs:30000});await rm(directory,{recursive:true}); }
