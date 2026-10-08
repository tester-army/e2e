import { readFile } from 'node:fs/promises';
import { hyprland, type HyprlandOptions } from '@e2e-dev/hyprland';
import type { TernRequest } from '@e2e-dev/tern';
import { focusField, waitField } from './control.ts';
const {options,request}=JSON.parse(await readFile(process.argv[2]!,'utf8')) as {options:HyprlandOptions;request:Omit<TernRequest,'signal'>};
const signal=AbortSignal.timeout(90000),provider=hyprland(options),lease=await provider.acquire({...request,signal});
await waitField(lease,'',signal);await focusField(lease,signal);await lease.input!.type('interrupted-owned-client',signal);await waitField(lease,'interrupted-owned-client',signal);
process.send!({client:lease.client,id:lease.id,pane:lease.pane,mode:lease.mode,binary:lease.binary,control:lease.control,env:lease.env});
await new Promise<void>(()=>{}); // The fixture parent terminates this real worker, then recovers the durable production lease.
