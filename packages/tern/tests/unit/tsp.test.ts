import { expect, it } from 'vitest';
import { toolCards } from '../../src/tsp.ts';
it('preserves native tool and surface identity rather than inventing live status', () => {
  const frame = (sf: string, name: string) => JSON.stringify({ body: { sf, ops: [['add', null, 0, { id: 'tool-1', k: 'tool', p: { name, target: '/inert/fixture', status: 'running' } }]] } });
  const cards = toolCards(frame('a', 'Read') + '\n' + frame('b', 'Write') + '\nnot a frame');
  expect(cards).toHaveLength(2);
  expect(cards[0]).toEqual({ id: 'tool-1', surface: 'a', name: 'Read', target: '/inert/fixture', statusAtAdd: 'running' });
  expect(cards[1]?.surface).toBe('b');
});
it('extracts nested heads and concatenates actual styled target spans',()=>{
  const record=JSON.stringify({body:{sf:'surface',ops:[['add',null,0,{id:'column',k:'col',c:[{id:'group',k:'row',c:[{id:'read',k:'tool',p:{name:'Read',target:['/fixture/',{t:'file.ts',s:'path'}],title:'wrong-fallback'}},{id:'write',k:'tool',p:{name:'Write',title:[{t:'/other',s:'path'}]}},{id:'empty',k:'tool',p:{name:'Empty',target:[],title:'must-not-substitute'}}]}]}]]}});
  expect(toolCards(record).map(card=>[card.surface,card.id,card.target])).toEqual([['surface','read','/fixture/file.ts'],['surface','write','/other'],['surface','empty','']]);
});
