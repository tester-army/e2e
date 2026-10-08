import { EngineError } from 'e2e/engine';
export function nativeGateOpen(value:unknown):boolean {
  if(!value||typeof value!=='object'||Array.isArray(value))return false;
  const gate=value as Record<string,unknown>;
  return gate.phase==='off'&&gate.error===null&&(gate.applies===false||(gate.applies===true&&gate.signed_in===true));
}
/** AX may describe a hidden app beneath vendor sign-in. Unknown gates fail closed. */
export function requireNativeGate(state:unknown):void {
  const gate=state&&typeof state==='object'&&!Array.isArray(state)?(state as Record<string,unknown>).gate:undefined;
  if(!nativeGateOpen(gate))throw new EngineError('NOT_ACTIONABLE','Native Tern vendor gate is active or unknown; an authenticated isolated native window is required',{retryable:false});
}
