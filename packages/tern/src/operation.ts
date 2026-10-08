import { Deadline, EngineError, type OperationContext } from 'e2e/engine';

/** One action budget, including every inspection, guard and compositor dispatch. */
export async function withinOperation<T>(context: OperationContext, perform: (bounded: OperationContext) => Promise<T>): Promise<T> {
  context.signal.throwIfAborted();
  const timeoutMs=Math.max(1,context.timeoutMs);
  const deadline=new Deadline(timeoutMs);
  const timer=new AbortController();
  const expire=()=>timer.abort(new EngineError('OPERATION_TIMEOUT','Native operation deadline expired',{retryable:false}));
  const handle=setTimeout(expire,timeoutMs);
  const signal=AbortSignal.any([context.signal,timer.signal]);
  const bounded={...context,signal,get timeoutMs(){signal.throwIfAborted();const remaining=deadline.remaining();if(!remaining){expire();signal.throwIfAborted();}return remaining;}};
  try{return await perform(bounded);}finally{clearTimeout(handle);}
}
