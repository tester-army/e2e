import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { requireNativeGate,type TernLease } from '@e2e-dev/tern';
import { EngineError } from 'e2e/engine';
const exec=promisify(execFile);
interface Ax { role?:string; name?:string; placeholder?:string; value?:string|number; bounds?:number[]; states?:string[]; children?:Ax[] }
interface Dom { rect?:number[]; input?:{value?:string;focused?:boolean}; children?:Dom[] }
interface Dump { path:string; nth:string; rect:number[]; visible:boolean }
function flatten<T extends {children?:T[]}>(nodes:T[]):T[] { const out:T[]=[]; const pending=[...nodes]; while(pending.length){const node=pending.shift()!;out.push(node);pending.push(...node.children??[]);}return out; }
const box=(a:readonly number[]|undefined,b:readonly number[]|undefined)=>Boolean(a&&b&&a.length===4&&b.length===4&&a.every((v,i)=>Math.abs(v-b[i]!)<=1));
/** Testbed-only native probe. Every value comes from current AX plus current rendered DOM, never TSP/ACK records. */
export async function nativeControl(lease:TernLease,scenario:string,signal:AbortSignal):Promise<Record<string,unknown>> {
  const after=await lease.guard?.(signal);
  const inspect=async(command:string)=>{const {stdout}=await exec(lease.binary,['ctl','--control',lease.control!,command],{env:lease.env,signal,timeout:30000,maxBuffer:8*1024*1024});const value=JSON.parse(stdout) as Record<string,unknown>;assert.equal(value.ok,true);return value;};
  try{if(scenario!=='state')requireNativeGate(await inspect('state'));const value=await inspect(scenario);requireNativeGate(scenario==='state'?value:await inspect('state'));return value;}
  finally {await after?.();}
}
export async function nativeField(lease:TernLease,signal:AbortSignal):Promise<{value:string;focused:boolean;selector:string}> {
  const ax=await nativeControl(lease,'a11y',signal) as unknown as Ax;
  const candidates=flatten([ax]).filter(n=>/^(TextInput|MultilineTextInput|TextField|TextBox|Editor|textbox)$/i.test(n.role??'')&&(n.name==='Value'||n.placeholder==='Value'));
  assert.equal(candidates.length,1,'one real inert native Value control');const node=candidates[0]!;
  const tree=await nativeControl(lease,'tree',signal);const matches=flatten(tree.tree as Dom[]).filter(n=>n.input&&box(n.rect,node.bounds));assert.equal(matches.length,1);
  const dumped=await nativeControl(lease,'dump *',signal);const addresses=(dumped.elements as Dump[]).filter(n=>n.visible&&box(n.rect,node.bounds));const deepest=addresses.filter(n=>!addresses.some(o=>o!==n&&o.path.startsWith(`${n.path}>`)));assert.equal(deepest.length,1);
  assert.equal(String(node.value??''),matches[0]!.input!.value??'','AX and actual rendered value agree');
  return {value:matches[0]!.input!.value??'',focused:node.states?.some(s=>s.toLowerCase()==='focused')===true&&matches[0]!.input!.focused===true,selector:deepest[0]!.nth};
}
export async function waitField(lease:TernLease,expected:string,signal:AbortSignal):Promise<void> {
  const deadline=Date.now()+30000;
  for(;;){try{if((await nativeField(lease,signal)).value===expected)return;}catch(error){if(signal.aborted||error instanceof EngineError&&error.code==='NOT_ACTIONABLE')throw error;}if(Date.now()>=deadline)throw new Error('Actual native value did not settle');await delay(25,undefined,{signal});}
}
export async function focusField(lease:TernLease,signal:AbortSignal):Promise<void>{const field=await nativeField(lease,signal);await nativeControl(lease,`a11y focus ${JSON.stringify(field.selector)}`,signal);assert.equal((await nativeField(lease,signal)).focused,true);}
