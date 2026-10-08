import assert from 'node:assert/strict';
import { test } from 'node:test';
import { requireExpectedNativeFailures } from './failure-report.ts';
type Attempt={status:string;error:{message?:string;code?:string};secondaryErrors:unknown[];steps?:Array<{api:string;status:string}>};
function result():{schemaVersion:string;run:{errors:unknown[];results:Array<{titlePath:string[];attempts:Attempt[]}>}}{return {schemaVersion:'report-1',run:{errors:[],results:[{titlePath:['cleanup after an actual native action, including its retry'],attempts:[0,1].map(()=>({status:'failed',error:{message:'Expected fixture failure after actual native semantic proof'},secondaryErrors:[]}))},{titlePath:['attempt deadline releases its actual native client'],attempts:[{status:'timed-out',error:{code:'TEST_TIMEOUT'},secondaryErrors:[],steps:[{api:'expect.toBeVisible',status:'passed'}]}]}]}};}
test('only the intended post-action failure and post-visibility deadline are accepted',()=>{assert.doesNotThrow(()=>requireExpectedNativeFailures(result()));});
test('three acquisitions and assertion failure cannot stand in for native acceptance',()=>{const report=result();report.run.results[0]!.attempts[0]!.error={message:'Actual value did not match'};assert.throws(()=>requireExpectedNativeFailures(report));});
test('a deadline during initial visibility cannot stand in for the actual wait case',()=>{const report=result();report.run.results[1]!.attempts[0]!.steps![0]!.status='failed';assert.throws(()=>requireExpectedNativeFailures(report));});
