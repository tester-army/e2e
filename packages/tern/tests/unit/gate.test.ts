import { expect,test } from 'vitest';
import { requireNativeState } from '../../src/control.ts';
import { nativeGateOpen } from '../../src/gate.ts';

test.each([
  [{applies:true,phase:'off',signed_in:true,error:null},true],
  [{applies:false,phase:'off',signed_in:false,error:null},true],
  [{applies:true,phase:'off',signed_in:false,error:null},false],
  [{applies:true,phase:'waitlisted',signed_in:true,error:null},false],
  [{applies:true,phase:'off',signed_in:true,error:'expired'},false],
  [{applies:false,phase:'waiting',error:null},false],
])('classifies actual native authorization state %#',(gate,open)=>{
  expect(nativeGateOpen(gate)).toBe(open);
});

test.each([
  undefined, null, {}, {applies:true,phase:'signed-out',signed_in:false}, {applies:'false'},
])('rejects an active or unknown vendor gate despite a matching pane',gate=>{
  expect(()=>requireNativeState({gate,panes:[{id:7}],focused:{id:7}},'7')).toThrow(expect.objectContaining({code:'NOT_ACTIONABLE',retryable:false}));
});

test.each([
  {panes:[],focused:{id:7}},
  {panes:[{id:7},{id:8}],focused:{id:7}},
  {panes:[{id:8}],focused:{id:8}},
  {panes:[{id:7}],focused:{id:8}},
  {panes:[{id:7}],focused:null},
])('rejects a lost leased single-pane owner even with an inactive gate',state=>{
  expect(()=>requireNativeState({gate:{applies:false,phase:'off',signed_in:false,error:null},...state},'7')).toThrow(expect.objectContaining({code:'NOT_ACTIONABLE',retryable:false}));
});
