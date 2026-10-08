import { EngineError } from 'e2e/engine';
export interface Monitor { id: number; name: string; width: number; height: number; scale: number; x: number; y: number; activeWorkspace: { id: number; name: string }; specialWorkspace: { id: number }; focused: boolean; disabled: boolean }
export interface Client { address: string; pid: number; monitor: number; workspace: { id: number; name: string }; tags: string[]; at: [number,number]; size: [number, number]; mapped: boolean; hidden: boolean; xwayland: boolean }
export interface HumanProof { monitors: Array<{ id: number; workspace: number; special: number; focused: boolean; x: number; y: number }>; activeWindow: string; cursor: { x: number; y: number } }
export function humanProof(monitors: readonly Monitor[], active: { address?: string }, cursor: { x: number; y: number }, excludedOutput: string): HumanProof {
  if (!Number.isFinite(cursor.x) || !Number.isFinite(cursor.y)) throw new EngineError('INVALID_STATE', 'Invalid host cursor readback', { retryable: false });
  return { monitors: monitors.filter(m => m.name !== excludedOutput).map(m => ({ id: m.id, workspace: m.activeWorkspace.id, special: m.specialWorkspace.id, focused: m.focused, x: m.x, y: m.y })).toSorted((a,b) => a.id-b.id), activeWindow: active.address ?? '', cursor: { x: cursor.x, y: cursor.y } };
}
export function unchanged(before: HumanProof, after: HumanProof): void {
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new EngineError('ACTION_MAY_HAVE_COMMITTED', 'Human desktop state changed across the owned operation; do not repeat input or restore focus', { retryable: false });
}
export function ownedClient(client: Client, pid: number, tag: string, output: Monitor, workspace: string, size: { width: number; height: number }): void {
  const bounds=[output.x,output.y,output.width,output.height,output.scale,...client.at,...client.size];
  const contained=bounds.every(Number.isFinite)&&output.scale>0&&output.width>0&&output.height>0&&client.size[0]>0&&client.size[1]>0&&client.at[0]>=output.x&&client.at[1]>=output.y&&client.at[0]+client.size[0]<=output.x+output.width/output.scale&&client.at[1]+client.size[1]<=output.y+output.height/output.scale;
  if (!contained || client.pid !== pid || !client.tags.some(t => t === tag || t === `${tag}*`) || client.monitor !== output.id || client.workspace.id!==output.activeWorkspace.id || client.workspace.name !== workspace || !client.mapped || client.hidden || client.xwayland || client.size[0] !== size.width || client.size[1] !== size.height || output.focused) throw new EngineError('NOT_ACTIONABLE', 'Nested client PID/tag/output/workspace/full-rectangle logical geometry containment did not read back', { retryable: false });
}
