import { describe, expect, it } from 'vitest';
import { humanProof, unchanged, ownedClient, type Monitor, type Client } from '../../src/proof.ts';
const monitor: Monitor={id:2,name:'owned',width:1920,height:1080,scale:1,x:1920,y:0,activeWorkspace:{id:3,name:'leased'},specialWorkspace:{id:0},focused:false,disabled:false};
const client: Client={address:'0x123',pid:42,monitor:2,workspace:{id:3,name:'leased'},tags:['nonce*'],at:[1920,0],size:[1280,900],mapped:true,hidden:false,xwayland:false};
describe('measured containment boundary',()=>{
  it('uses opaque identity and omits third-party titles and serials',()=>{
    const proof=humanProof([{...monitor,name:'human',focused:true}],{address:'0xabc'},{x:10,y:11},'owned');
    expect(proof).toEqual({monitors:[{id:2,workspace:3,special:0,focused:true,x:1920,y:0}],activeWindow:'0xabc',cursor:{x:10,y:11}});
    expect(()=>unchanged(proof,{...proof,cursor:{x:11,y:11}})).toThrow('changed');
  });
  it('requires exact PID/tag/workspace/output/actual geometry',()=>{
    expect(()=>ownedClient(client,42,'nonce',monitor,'leased',{width:1280,height:900})).not.toThrow();
    for(const changed of [{...client,pid:43},{...client,tags:['nonce-other']},{...client,monitor:1},{...client,size:[1279,900] as [number,number]},{...client,workspace:{id:9,name:'human'}},{...client,xwayland:true}]) expect(()=>ownedClient(changed,42,'nonce',monitor,'leased',{width:1280,height:900})).toThrow();
    expect(()=>ownedClient(client,42,'nonce',{...monitor,focused:true},'leased',{width:1280,height:900})).toThrow();
    for(const at of [[1919,0],[1920,-1],[2600,0],[1920,181],[Number.NaN,0]] as [number,number][])expect(()=>ownedClient({...client,at},42,'nonce',monitor,'leased',{width:1280,height:900})).toThrow();
    expect(()=>ownedClient(client,42,'nonce',{...monitor,scale:2},'leased',{width:1280,height:900})).toThrow();
  });
});
