import { expect,test } from 'vitest';
import { semanticTree,flatten,actionSelector,focusedEditable } from '../../src/tree.ts';
const bounds=[0,0,100,30],dump=[{path:'root>input',nth:'input:nth(0)',rect:bounds,visible:true}];
test('same-sized wrapper cannot conceal password metadata or actual value disagreement',()=>{
  const ax={id:1,role:'TextInput',bounds,value:'private'};
  const root=semanticTree(ax,[{rect:bounds,children:[{rect:bounds,input:{type:'password',value:'private'}}]}],dump,{width:200,height:100});
  expect(flatten([root]).find(n=>n.ref.id==='ax:1')).toMatchObject({role:'textbox',inputPurpose:'password',states:{secure:true}});expect(JSON.stringify(root)).not.toContain('private');
  expect(()=>semanticTree(ax,[{rect:bounds,children:[{rect:bounds,input:{value:'different'}}]}],dump,{width:200,height:100})).toThrow();
  expect(()=>semanticTree(ax,[{rect:bounds,input:{value:'private'}},{rect:bounds,input:{secure:true}}],dump,{width:200,height:100})).toThrow();
});
test('explicit password AX roles remain editable without exposing values',()=>{
  const root=semanticTree({id:1,role:'PasswordInput',bounds,value:'private'},[],dump,{width:200,height:100});expect(root.children![0]).toMatchObject({role:'textbox',inputPurpose:'password',states:{secure:true}});expect(JSON.stringify(root)).not.toContain('private');
});
test('offscreen scroll resolves an owned address while taps and truly hidden scroll refuse',()=>{
  const rect=[0,300,100,30],address={path:'root>input',nth:'input:nth(4)',rect,visible:false};
  const root=semanticTree({id:1,role:'TextInput',bounds:rect},[],[address],{width:200,height:100});const node=root.children![0]!;
  expect(()=>actionSelector(node,[address])).toThrow();expect(actionSelector(node,[address],true)).toBe('input:nth(4)');
  const hidden=semanticTree({id:1,role:'TextInput',bounds:rect,states:['hidden']},[],[address],{width:200,height:100});expect(()=>actionSelector(hidden.children![0]!,[address],true)).toThrow();
});
test('a focus redirect cannot turn a targeted fill into a different secret sink',()=>{
  const root=semanticTree({id:0,children:[{id:1,role:'TextInput',bounds},{id:2,role:'PasswordInput',bounds,states:['focused']}]},[],dump,{width:200,height:100});
  expect(()=>focusedEditable(root,'ax:1')).toThrow();expect(focusedEditable(root).ref.id).toBe('ax:2');
});
test('multiple focused editors refuse a targeted typing destination',()=>{
  const secondBounds=[0,35,100,30];
  const root=semanticTree({id:0,children:[
    {id:1,role:'TextInput',bounds,states:['focused']},
    {id:2,role:'PasswordInput',bounds:secondBounds,states:['focused']},
  ]},[],[...dump,{path:'root>password',nth:'input:nth(1)',rect:secondBounds,visible:true}],{width:200,height:100});
  expect(()=>focusedEditable(root,'ax:1')).toThrow(expect.objectContaining({code:'NOT_ACTIONABLE',retryable:false}));
});
