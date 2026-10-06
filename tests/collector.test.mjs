import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const script=resolve('scripts/collect-snapshot.mjs');
async function fixture(fn) { const dir=await mkdtemp(join(tmpdir(),'crucix-collector-'));try {await fn(dir)}finally{await rm(dir,{recursive:true,force:true})}}
const run=(cwd,args=[],extra={})=>spawnSync(process.execPath,[script,...args],{cwd,encoding:'utf8',timeout:10000,env:{PATH:process.env.PATH,HOME:cwd,...extra}});
test('collector fails closed when credentials or .env exist',async()=>fixture(async dir=>{
 let r=run(dir,[],{LLM_API_KEY:'fake-test-value'});assert.equal(r.status,1);assert.match(r.stderr,/without source/);assert.doesNotMatch(r.stderr,/fake-test-value/);
 await writeFile(join(dir,'.env'),'LLM_API_KEY=fake-test-value');r=run(dir);assert.equal(r.status,1);assert.match(r.stderr,/refuses project/);
}));
test('collector lock prevents overlap without removing another lock',async()=>fixture(async dir=>{
 await mkdir(join(dir,'output'));await writeFile(join(dir,'output/collector.lock'),'held');
 const r=run(dir);assert.equal(r.status,1);assert.match(r.stderr,/already running/);assert.equal(await readFile(join(dir,'output/collector.lock'),'utf8'),'held');
}));
test('offline collection writes valid quality snapshot without touching KV',async()=>fixture(async dir=>{
 const input=join(dir,'raw.json');await writeFile(input,JSON.stringify({crucix:{timestamp:new Date().toISOString()},sources:{Treasury:{debt:[{totalDebt:'10'}]},BLS:{indicators:[{value:1}]},Space:{recentLaunches:[{name:'fictional-test'}]}}}));
 const r=run(dir,['--input',input]);assert.equal(r.status,0,r.stderr);const snapshot=JSON.parse(await readFile(join(dir,'output/snapshot.json'),'utf8'));assert.equal(snapshot.data.meta.quality.counts.data,3);assert.match(r.stdout,/"published":false/);
}));
