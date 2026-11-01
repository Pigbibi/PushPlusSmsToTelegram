const test = require('node:test');
const assert = require('node:assert/strict');
const { loadWorker } = require('../test-support/worker');

test('authenticated inbox bursts reuse KV pages while TTL and token checks remain active', async () => {
  const {default:worker} = await loadWorker();
  const realNow=Date.now; let now=realNow(), lists=0, gets=0, puts=0, fail=false;
  Date.now=()=>now;
  const values=new Map([['inbox:one',JSON.stringify({id:'one',sender:'synthetic',text:'fixture',receivedAt:now})]]);
  const binding={async get(k){gets++;return values.get(k)||null;},async put(){puts++;},
    async list(){lists++;if(fail)throw Error('synthetic_failure');return {keys:[...values.keys()].map(name=>({name}))};}};
  const env={STATE_SECRET:'synthetic-state',INBOX_TOKEN:'synthetic-inbox',FORWARDED_KV:binding};
  const read=(query='',overrides={})=>worker.fetch(new Request('https://fixture.invalid/messages'+query,
    {headers:{Authorization:'Bearer synthetic-inbox'}}),{...env,...overrides},{});
  try {
    const results=await Promise.all(Array.from({length:20},()=>read()));
    for(const r of results)assert.equal((await r.json()).messages.length,1);
    assert.equal(lists,1,'20 concurrent inbox reads list once instead of 20 times');
    assert.equal(gets,1,'record reads are shared too');assert.equal(puts,0);
    assert.equal((await read('',{INBOX_TOKEN:'rotated'})).status,401);
    assert.equal((await (await read('?sender=missing')).json()).messages.length,0);
    assert.equal((await (await read('?since='+(now+1))).json()).messages.length,0);
    assert.equal(lists,1,'filter parameters are applied after snapshot reuse');
    now+=5001;
    values.set('inbox:two',JSON.stringify({id:'two',sender:'other',receivedAt:now}));
    assert.equal((await (await read()).json()).messages.length,2);
    assert.equal(lists,2,'a new TTL window sees external writes');
    now+=5001;fail=true;
    assert.equal((await read()).status,500);
    fail=false;assert.equal((await read()).status,200,'failures do not poison the snapshot');
    const isolated={...binding,async list(){return {keys:[]};}};
    assert.equal((await (await read('',{FORWARDED_KV:isolated})).json()).messages.length,0);
  } finally {Date.now=realNow;}
});
