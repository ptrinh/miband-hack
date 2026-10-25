// Run: node test/remote-check.mjs
import assert from 'node:assert/strict';
import {
  encode, decode, resultText, sendErrorText, linkText, errorState, targetText, COMMANDS
} from '../src/common/remote.js';

assert.deepEqual(encode('next', 7), { v: 1, id: 7, cmd: 'next' });
assert.deepEqual(COMMANDS, ['shutter', 'prev', 'next', 'playpause', 'hello']);

// onmessage may hand us a string, an object with .data, or .data as an object
const reply = '{"v":1,"id":7,"ok":true,"did":"slide","laptop":"MacBook","camera":false}';
for (const raw of [reply, { data: reply }, { data: JSON.parse(reply) }, JSON.parse(reply)]) {
  const m = decode(raw);
  assert.equal(m.id, 7);
  assert.equal(m.ok, true);
  assert.equal(m.isReply, true);
  assert.equal(m.did, 'slide');
  assert.equal(m.laptop, 'MacBook');
}

// pushed status has no id
const status = decode('{"v":1,"laptop":null,"camera":true}');
assert.equal(status.isReply, false);
assert.equal(status.camera, true);
assert.equal(status.laptop, '');

// not ours
assert.equal(decode('not json'), null);
assert.equal(decode('{"v":2,"id":1}'), null);
assert.equal(decode(null), null);
assert.equal(decode(42), null);

assert.equal(resultText(decode('{"v":1,"id":1,"ok":true,"did":"photo"}')), 'Photo taken');
assert.equal(resultText(decode('{"v":1,"id":1,"ok":true,"did":"new-thing"}')), 'Done');
assert.equal(resultText(decode('{"v":1,"id":1,"ok":false,"error":"camera-closed"}')), 'Open the camera screen in the phone app');
assert.equal(resultText(decode('{"v":1,"id":1,"ok":false,"error":"???"}')), 'Phone error');
assert.equal(resultText(null), '');

assert.equal(sendErrorText(1006), 'Phone not connected');
assert.equal(sendErrorText(204), 'Phone timed out');
assert.equal(sendErrorText(5), 'Send failed (5)');

assert.equal(errorState(1001), 'no-app');
assert.equal(errorState(1006), 'closed');
assert.equal(linkText('open'), 'Phone connected');
assert.equal(linkText('bogus'), 'Phone not connected');

assert.equal(targetText(decode(reply)), 'Slides: MacBook');
assert.equal(targetText(status), 'Slides: media keys');

console.log('ok remote checks');
