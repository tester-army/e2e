export interface TernToolCard {
  readonly id: string;
  readonly surface: string;
  readonly name: string;
  readonly target: string;
  readonly statusAtAdd: string;
}

function spans(value:unknown):string|undefined {
  if(typeof value==='string')return value;
  if(!Array.isArray(value))return undefined;
  const text:string[]=[];
  for(const run of value){if(typeof run==='string')text.push(run);else if(run&&typeof run==='object'&&typeof (run as {t?:unknown}).t==='string')text.push((run as {t:string}).t);else return undefined;}
  return text.join('');
}

/** Historical native tool heads. A terminal cell capture omits these nodes.
 * Only an explicit record is read; add-time status is never called live status. */
export function toolCards(record: string): TernToolCard[] {
  const cards = new Map<string, TernToolCard>();
  for (const line of record.split('\n')) {
    if (!line.startsWith('{')) continue;
    let packet: { body?: { sf?: unknown; ops?: unknown } };
    try { packet = JSON.parse(line) as typeof packet; } catch { continue; }
    if (!Array.isArray(packet.body?.ops)) continue;
    const surface = String(packet.body.sf ?? '');
    for (const operation of packet.body.ops) {
      if (!Array.isArray(operation) || operation[0] !== 'add') continue;
      const visit=(value:unknown):void=>{
        if(!value||typeof value!=='object')return;
        const node=value as {id?:unknown;k?:unknown;p?:Record<string,unknown>;c?:unknown};
        if(node.k==='tool'&&typeof node.id==='string'){
          const props=node.p??{},id=JSON.stringify([surface,node.id]);
          cards.set(id,{id:node.id,surface,name:typeof props.name==='string'?props.name:'',target:spans(props.target)??spans(props.title)??'',statusAtAdd:typeof props.status==='string'?props.status:''});
        }
        if(Array.isArray(node.c))for(const child of node.c)visit(child);
      };
      visit(operation.at(-1));
    }
  }
  return [...cards.values()];
}
