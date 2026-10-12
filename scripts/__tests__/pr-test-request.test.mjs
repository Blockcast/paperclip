import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requestTest, trustedTestComment, manualTestAuthorized, readManualTest, MANUAL_TEST_CONTEXT } from '../pr-test-request.mjs';
const H='a'.repeat(40), OLD='b'.repeat(40), R='Blockcast/example';
const event={issue:{number:1,pull_request:{}},comment:{body:'/test',html_url:'https://github.com/Blockcast/example/pull/1#issuecomment-1',author_association:'OWNER',user:{type:'User',login:'owner'}}};
const pull={state:'open',head:{sha:H,repo:{full_name:R}}};
test('a trusted line command grants CPU permission; bot, prose, quotes and outsiders do not',()=>{
  assert.equal(trustedTestComment(event),true);
  for(const body of ['mention /test','> /test','/testing']) assert.equal(trustedTestComment({...event,comment:{...event.comment,body}}),false);
  for(const user of [{type:'Bot',login:'allyblockcast[bot]'},{type:'User',login:'allyblockcast'}]) assert.equal(trustedTestComment({...event,comment:{...event.comment,user}}),false);
  assert.equal(trustedTestComment({...event,comment:{...event.comment,author_association:'CONTRIBUTOR'}}),false);
});
test('only the newest status from the Actions identity grants CPU permission',()=>{
  const s={id:1,context:MANUAL_TEST_CONTEXT,state:'success',creator:{id:41898282,login:'github-actions[bot]',type:'Bot'}};
  assert.equal(manualTestAuthorized([s]),true);
  assert.equal(manualTestAuthorized([{...s,creator:{...s.creator,type:'User'}}]),false);
  assert.equal(manualTestAuthorized([s,{...s,id:2,state:'pending'}]),false);
  assert.equal(manualTestAuthorized([{...s,creator:{id:1,login:'github-actions[bot]'}}]),false);
  assert.equal(manualTestAuthorized([{...s,context:'review/ally-complete'}]),false);
});
test('request binds the live head and writes only the CPU context',async()=>{
  const writes=[];
  const result=await requestTest(event,R,{get:(p)=>p.includes('/commits/')?[]:pull,post:(p,b)=>writes.push([p,b])});
  assert.equal(result.head_sha,H);assert.equal(writes[0][0],`repos/${R}/statuses/${H}`);assert.equal(writes[0][1].context,MANUAL_TEST_CONTEXT);
});
test('a moved, closed or fork head cannot receive a permission',async()=>{
  for(const bad of [{...pull,state:'closed'},{...pull,head:{...pull.head,sha:OLD}},{...pull,head:{...pull.head,repo:{full_name:'other/fork'}}}]){
    let reads=0;await assert.rejects(requestTest(event,R,{get:(p)=>p.includes('/commits/')?[]:(++reads===1?pull:bad),post:()=>assert.fail('must not write')}));
  }
});
test('repeating the same request does not write another status',async()=>{
  const s={id:1,context:MANUAL_TEST_CONTEXT,state:'success',creator:{id:41898282,login:'github-actions[bot]',type:'Bot'}};
  await requestTest(event,R,{get:(p)=>p.includes('/commits/')?[s]:pull,post:()=>assert.fail('already authorized')});
});

test('manual reads the status-list response that retains producer identity',()=>{
  const status={id:1,context:MANUAL_TEST_CONTEXT,state:'success',creator:{id:41898282,login:'github-actions[bot]',type:'Bot'}};
  assert.equal(readManualTest(R,H,endpoint=>{
    assert.equal(endpoint,`repos/${R}/commits/${H}/statuses?per_page=100`);
    return [status];
  }),true);
  assert.equal(manualTestAuthorized([{...status,creator:undefined}]),false,'combined-status entries lack the identity and must not authorize');
});
