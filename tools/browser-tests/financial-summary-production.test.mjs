import assert from 'node:assert/strict';
import test from 'node:test';
import { drainVerification, withDeadline } from './financial-summary-production.mjs';
import { assertRequestsComplete } from './recent-optimizations-production.mjs';

test('financial drain awaits delayed body verification and newly queued work', async () => {
    const requests = new Map([['first', { url: 'app.js', status: 'pending' }]]);
    const tasks = [];
    let releaseFirst, releaseSecond;
    const first = new Promise(resolve => { releaseFirst = resolve; });
    const second = new Promise(resolve => { releaseSecond = resolve; });
    tasks.push(first.then(() => {
        requests.get('first').status = 'verified';
        requests.set('second', { url: 'style.css', status: 'pending' });
        tasks.push(second.then(() => { requests.get('second').status = 'verified'; }));
    }));
    let done = false;
    const drain = drainVerification(tasks, requests).then(() => { done = true; });
    await Promise.resolve();
    assert.equal(done, false);
    releaseFirst();
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(done, false, 'earlier body cannot hide later body');
    releaseSecond();
    await drain;
    assert.equal(done, true);
});

test('financial drain fails a delayed body error or a header-pending request', async () => {
    let rejectBody;
    const body = new Promise((_, reject) => { rejectBody = reject; });
    const drain = drainVerification([body], new Map(), 200);
    rejectBody(new Error('late body failure'));
    await assert.rejects(drain, /late body failure/);
    await assert.rejects(drainVerification([], new Map([['pending', { status: 'pending' }]]), 20), /remained pending/);
    await assert.rejects(withDeadline(new Promise(() => {}), 20, 'body'), /body deadline/);
});

test('financial resource success is isolated to each fresh context', () => {
    const required = new Set(['page', 'app.js', 'styles.css', 'bootstrap.css']);
    const verified = new Set(required);
    const successful = [...required].map(url => ({ url, status: 'verified' }));
    assert.doesNotThrow(() => assertRequestsComplete(successful, required, verified));
    assert.throws(() => assertRequestsComplete([], required, new Set()), /this context did not verify/);
    assert.throws(() => assertRequestsComplete([...successful, { url: 'app.js', status: 'failed' }], required, verified), /each requested/);
    assert.throws(() => assertRequestsComplete(successful, required, new Set(['page', 'app.js', 'styles.css'])), /this context did not verify/);
});
