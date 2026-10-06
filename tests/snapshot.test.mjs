import test from 'node:test';
import assert from 'node:assert/strict';
import { assessQuality, createSnapshot, validateSnapshot, MAX_SNAPSHOT_BYTES } from '../lib/snapshot/index.mjs';
import { publishSnapshot } from '../scripts/publish-snapshot.mjs';
const raw = () => ({ crucix: { timestamp: new Date().toISOString() }, sources: { Treasury:{ debt:[{date:'2026-10-06',totalDebt:'1'}] }, BLS:{indicators:[{value:1}]}, Space:{recentLaunches:[{name:'ISS'}]} }, errors:[] });
const good = () => createSnapshot(raw(), { meta:{}, news:[] });
test('credential placeholders and error objects do not count as data', () => {
 const quality = assessQuality({ sources:{FRED:{error:'No FRED API key'},FIRMS:{status:'no_key'},'CISA-KEV':{error:'HTTP 403'},NOAA:{topAlerts:[]},Maritime:{status:'limited',chokepoints:{known:3}}}});
 assert.deepEqual(quality.counts,{data:0,no_data:1,unavailable:3,error:1}); assert.equal(quality.partial,true);
});
test('transport success alone cannot produce a publishable snapshot', () => assert.throws(() => createSnapshot({crucix:{timestamp:new Date().toISOString(),sourcesOk:29},sources:{}},{meta:{}}),/Insufficient/));
test('quality counts override upstream transport counts', () => {
 const r=raw();r.sources.FRED={error:'No FRED API key'};
 const s=createSnapshot(r,{meta:{sourcesOk:29},ideas:['bad']});
 assert.equal(s.data.meta.sourcesOk,3);assert.equal(s.data.meta.sourcesUnavailable,1);assert.deepEqual(s.data.ideas,[]);assert.equal(s.data.meta.quality.partial,true);
});
test('old, future, oversized or malformed snapshot rejected', () => {
 const r=raw();r.crucix.timestamp='2020-01-01';assert.throws(()=>createSnapshot(r,{meta:{}}),/timestamp/);
 r.crucix.timestamp=new Date(Date.now()+3600_000).toISOString();assert.throws(()=>createSnapshot(r,{meta:{}}),/timestamp/);
 assert.throws(()=>createSnapshot(raw(),{meta:{},blob:'a'.repeat(MAX_SNAPSHOT_BYTES)}),/2 MiB/);
 assert.throws(()=>validateSnapshot({schemaVersion:1,generatedAt:new Date().toISOString(),data:{meta:{timestamp:new Date().toISOString()}}}),/Invalid/);
});
test('dry run never calls network', async()=> {const r=await publishSnapshot(good(),{fetchFn:()=>assert.fail('network')});assert.equal(r.published,false)});
test('publisher only writes one snapshot key and does not expose token', async()=>{
 let calls=0; const result=await publishSnapshot(good(),{dryRun:false,accountId:'a'.repeat(32),namespaceId:'b'.repeat(32),token:'not-real',fetchFn:async(url,options)=>{calls++;assert.match(url,/snapshot%3Av1$/);assert.equal(options.method,'PUT');assert.equal(options.headers.Authorization,'Bearer not-real');return new Response('{"success":true}',{status:200});}});
 assert.equal(calls,1);assert.equal(result.published,true);assert.doesNotMatch(JSON.stringify(result),/not-real/);
});
test('invalid input and denied writes do not retry', async()=> {
 let calls=0; const options={dryRun:false,accountId:'a'.repeat(32),namespaceId:'b'.repeat(32),token:'not-real',fetchFn:async()=>{calls++;return new Response('no',{status:403})}};
 await assert.rejects(publishSnapshot({},options),/Invalid/);assert.equal(calls,0);
 await assert.rejects(publishSnapshot(good(),options),/403/);assert.equal(calls,1);
});
test('directory entries do not claim online status and nested failures are degraded',()=>{
 const r=raw();r.sources.KiwiSDR={status:'active',network:{totalReceivers:2},conflictZones:{test:{receivers:[{name:'fictional'}]}}};
 const s=createSnapshot(r,{meta:{},sdr:{total:2,online:2,zones:[]}});
 assert.equal(s.data.sdr.online,null);assert.equal(s.data.sdr.directoryOnly,true);assert.equal(s.data.meta.quality.counts.data,4);assert.equal(s.data.meta.quality.partial,true);
 assert.equal(s.data.health.find(h=>h.n==='KiwiSDR').err,true);
});
