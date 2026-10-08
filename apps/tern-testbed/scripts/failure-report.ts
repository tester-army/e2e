import assert from 'node:assert/strict';
interface Attempt {status:string;error?:{code?:string;message?:string};secondaryErrors?:unknown[];steps?:Array<{api:string;status:string}>}
interface Result {titlePath:string[];attempts:Attempt[]}
/** Receipts cannot distinguish an intended deadline from a broken setup/assertion. */
export function requireExpectedNativeFailures(document:unknown):void {
  const report=document as {schemaVersion?:string;run?:{results?:Result[];errors?:unknown[]}};
  assert.equal(report.schemaVersion,'report-1');assert.deepEqual(report.run?.errors,[]);const results=report.run!.results!;assert.equal(results.length,2);
  const failed=results.find(r=>r.titlePath.at(-1)==='cleanup after an actual native action, including its retry');assert(failed);assert.equal(failed.attempts.length,2);
  for(const attempt of failed.attempts){assert.equal(attempt.status,'failed');assert.equal(attempt.error?.message,'Expected fixture failure after actual native semantic proof');assert.deepEqual(attempt.secondaryErrors,[]);}
  const timeout=results.find(r=>r.titlePath.at(-1)==='attempt deadline releases its actual native client');assert(timeout);assert.equal(timeout.attempts.length,1);assert.equal(timeout.attempts[0]!.status,'timed-out');assert.equal(timeout.attempts[0]!.error?.code,'TEST_TIMEOUT');assert.deepEqual(timeout.attempts[0]!.secondaryErrors,[]);
  assert(timeout.attempts[0]!.steps?.some(step=>step.api==='expect.toBeVisible'&&step.status==='passed'),'the deadline must occur after actual native visibility proof, not during a broken setup/assertion');
}
