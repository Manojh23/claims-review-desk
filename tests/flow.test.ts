import {after,before,test} from 'node:test';
import assert from 'node:assert/strict';
import type {Server} from 'node:http';
import {once} from 'node:events';
import fixture from '../fixtures/sample.json' with {type:'json'};
import {connect,type Database} from '../src/db.js';
import {makeApp} from '../src/api.js';
import {azureProvider} from '../src/advice.js';

const keys={reviewer:'test-review-key',viewer:'test-viewer-key',worker:'test-worker-key'};
let db:Database, server:Server, base:string;
before(async()=>{
  db=await connect();
  server=makeApp(db,{keys,provider:async()=>{throw Error('synthetic failure');},staticDir:'dist'}).listen(0,'127.0.0.1');
  await once(server,'listening');
  const address=server.address();
  assert(address&&typeof address==='object');
  base='http://127.0.0.1:'+address.port;
});
after(async()=>{if(server)await new Promise<void>(resolve=>server.close(()=>resolve()));if(db)await db.close();});
async function req(path:string,role?:keyof typeof keys,body?:unknown){
  return fetch(base+'/api/'+path,{
    method:body===undefined?'GET':'POST',
    headers:{...(role?{authorization:'Bearer '+keys[role]}:{}),...(body!==undefined?{'content-type':'application/json'}:{})},
    body:body===undefined?undefined:JSON.stringify(body),
  });
}
test('readiness and access boundaries',async()=>{
  const h=await req('health');assert.deepEqual(await h.json(),{ok:true});
  assert.ok(h.headers.get('x-request-id'));
  assert.equal((await req('claims')).status,401);
  assert.equal((await req('claims','worker')).status,403);
  assert.equal((await req('batches','viewer',fixture)).status,403);
  assert.equal((await req('automation/jobs','reviewer')).status,403);
});
test('intake is idempotent and detects conflicting replay',async()=>{
  const made=await req('batches','reviewer',fixture);assert.equal(made.status,201);
  assert.deepEqual(await made.json(),{inserted:4,replay:false});
  const replay=await req('batches','reviewer',{...fixture,claims:fixture.claims.slice().reverse()});assert.equal(replay.status,200);
  assert.deepEqual(await replay.json(),{inserted:0,replay:true});
  const bad=await req('batches','reviewer',{...fixture,claims:fixture.claims.slice(1)});assert.equal(bad.status,409);
});
test('invalid and conflicting batches leave no partial rows',async()=>{
  const c=fixture.claims[0];
  assert.equal((await req('batches','reviewer',{id:'DEMO-BAD',claims:[{...c,paid_cents:c.billed_cents+1}]})).status,422);
  const batch={id:'DEMO-COLLIDE',claims:[{...c,id:'DEMO-TEMP'},c]};
  assert.equal((await req('batches','reviewer',batch)).status,409);
  assert.equal((await db.rows("SELECT id FROM claims WHERE id='DEMO-TEMP'")).length,0);
  assert.equal((await db.rows("SELECT id FROM batches WHERE id='DEMO-COLLIDE'")).length,0);
});
test('queue filters, paginates and aggregates integer amounts',async()=>{
  const list=await req('claims?status=open&limit=2&offset=2','viewer');
  assert.equal((await list.json()).length,2);
  const summary=await req('summary','viewer');
  assert.deepEqual(await summary.json(),{total:4,open:4,approved:0,dismissed:0,open_cents:'176000'});
  assert.equal((await req('claims?limit=0','viewer')).status,422);
});
test('draft fallback has no decision side effect',async()=>{
  assert.equal((await req('claims/DEMO-C101/draft','viewer',{})).status,403);
  const d=await req('claims/DEMO-C101/draft','reviewer',{});
  assert.equal((await d.json()).source,'fallback');
  const jobs=await req('automation/jobs','worker');
  assert.deepEqual(await jobs.json(),[]);
});
test('review approval writes one audit event and one automation job',async()=>{
  assert.equal((await req('claims/DEMO-C101/decision','viewer',{decision:'approved'})).status,403);
  const results=await Promise.all([req('claims/DEMO-C101/decision','reviewer',{decision:'approved'}),req('claims/DEMO-C101/decision','reviewer',{decision:'approved'})]);
  assert.deepEqual(results.map(x=>x.status).sort(),[200,409]);
  assert.equal((await req('claims/DEMO-C102/decision','reviewer',{decision:'dismissed'})).status,200);
  const audit=await req('claims/DEMO-C101/audit','viewer');
  assert.deepEqual((await audit.json()).map((e:{action:string})=>e.action),['imported','approved']);
  const r=await req('automation/jobs','worker');const jobs=await r.json();
  assert.equal(jobs.length,1);
  assert.equal(jobs[0].claim_id,'DEMO-C101');
  assert.equal((await req('automation/jobs/'+jobs[0].id+'/ack','worker',{})).status,200);
  assert.equal((await req('automation/jobs/'+jobs[0].id+'/ack','worker',{})).status,200);
  const left=await req('automation/jobs','worker');assert.deepEqual(await left.json(),[]);
});
test('Azure adapter builds a constrained request and validates model JSON',async()=>{
  const mock:typeof fetch=async(url,init)=>{
    assert.match(String(url),/\/openai\/v1\/chat\/completions$/);
    const body=JSON.parse(String(init?.body));
    assert.equal(body.model,'demo-deployment');
    assert.deepEqual(JSON.parse(body.messages[1].content),{reason:'OTHER',billed_cents:100,paid_cents:0});
    return Response.json({choices:[{message:{content:JSON.stringify({summary:'Review the adjustment.',nextStep:'Compare records.'})}}]});
  };
  const p=azureProvider('https://demo.openai.azure.com','test-key','demo-deployment',mock);
  assert.equal((await p({reason:'OTHER',billed_cents:100,paid_cents:0})).nextStep,'Compare records.');
  const bad=azureProvider('https://demo.openai.azure.com','test-key','demo-deployment',async()=>Response.json({choices:[{message:{content:'{"summary":"No next step"}'}}]}));
  await assert.rejects(bad({reason:'OTHER',billed_cents:100,paid_cents:0}));
});
test('serves the built React dashboard and assets',async()=>{
  const page=await fetch(base);
  assert.equal(page.status,200);
  const html=await page.text();
  assert.match(html,/Claims Review Desk/);
  const bundle=html.match(/src="([^"]+\.js)"/)?.[1];
  assert.ok(bundle);
  assert.equal((await fetch(base+bundle)).status,200);
});
