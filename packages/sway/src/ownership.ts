import { readFile, lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { EngineError } from 'e2e/engine';

export interface ProcessIdentity { readonly pid: number; readonly start: string }
export async function processIdentity(pid: number): Promise<ProcessIdentity> {
  const text = await readFile(`/proc/${pid}/stat`, 'utf8');
  const fields = text.slice(text.lastIndexOf(')') + 2).split(' ');
  if (!fields[19]) throw new EngineError('ENGINE_FAILURE', 'Cannot establish native process identity', { retryable: false });
  return { pid, start: fields[19] };
}
export async function stillOwned(identity: ProcessIdentity): Promise<boolean> {
  try { return (await processIdentity(identity.pid)).start === identity.start; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; }
}
export async function ownedDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o077)) throw new EngineError('INVALID_STATE', 'Native lease directory is not private and owned', { retryable: false });
}
export async function childPids(pid: number): Promise<number[]> {
  const tasks = await readdir(`/proc/${pid}/task`);
  const children = await Promise.all(tasks.map(task => readFile(join('/proc', String(pid), 'task', task, 'children'), 'utf8')));
  return [...new Set(children.flatMap(text => text.trim().split(/\s+/).filter(Boolean).map(Number)))];
}

/** Guest-authored launch receipts are not authority: prove the current kernel ancestry. */
export async function ownedDescendant(identity:ProcessIdentity,root:ProcessIdentity):Promise<boolean>{
  if(identity.pid===root.pid||!Number.isSafeInteger(identity.pid)||identity.pid<=0||!Number.isSafeInteger(root.pid)||root.pid<=0||!await stillOwned(identity)||!await stillOwned(root))return false;
  const chain:Array<{identity:ProcessIdentity;parent:number}>=[];
  let pid=identity.pid;
  try{
    for(let depth=0;depth<256&&pid>1;depth++){
      const text=await readFile(`/proc/${pid}/stat`,'utf8'),fields=text.slice(text.lastIndexOf(')')+2).split(' ');
      const current={pid,start:fields[19]!},parent=Number(fields[1]);if(!current.start||!Number.isSafeInteger(parent)||chain.some(item=>item.identity.pid===pid))return false;
      chain.push({identity:current,parent});
      if(pid===root.pid){
        if(current.start!==root.start||chain[0]!.identity.start!==identity.start)return false;
        for(const item of chain){const again=await readFile(`/proc/${item.identity.pid}/stat`,'utf8'),parts=again.slice(again.lastIndexOf(')')+2).split(' ');if(parts[19]!==item.identity.start||Number(parts[1])!==item.parent)return false;}
        return await stillOwned(root)&&await stillOwned(identity);
      }
      pid=parent;
    }
    return false;
  }catch(error){if(['ENOENT','ESRCH'].includes((error as NodeJS.ErrnoException).code??''))return false;throw error;}
}
