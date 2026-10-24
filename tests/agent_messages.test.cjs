const test = require('node:test');
const assert = require('node:assert/strict');
const {loadAgentModules} = require('./agent_loader.cjs');

const {messages} = loadAgentModules();
const {buildRequestMessages, AGENT_MAX_MESSAGES, BACKEND_MAX_MESSAGE_CHARS} =
  messages;

test('request history starts with a user turn and keeps whole pairs', () => {
  const history = [];
  for (let i = 0; i < 30; i++) {
    history.push({role: 'user', content: `u${i}`});
    history.push({role: 'assistant', content: `a${i}`});
  }
  const req = buildRequestMessages(history, 'nuevo');
  assert.equal(req[0].role, 'user');
  assert.equal(req.at(-1).role, 'user');
  assert.equal(req.at(-1).content, 'nuevo');
  assert.ok(req.length <= AGENT_MAX_MESSAGES);
  assert.equal(req.length % 2, 1);
  req.slice(0, -1).forEach((m, i) => {
    assert.equal(m.role, i % 2 === 0 ? 'user' : 'assistant');
  });
});

test('orphan assistant turns at the start are dropped', () => {
  const req = buildRequestMessages(
    [
      {role: 'assistant', content: 'x'},
      {role: 'user', content: 'u'},
      {role: 'assistant', content: 'a'},
    ],
    'n'
  );
  assert.equal(req[0].role, 'user');
  assert.equal(req[0].content, 'u');
});

test('long assistant replies are clipped only in the request', () => {
  const long = 'z'.repeat(50000);
  const history = [
    {role: 'user', content: 'u'},
    {role: 'assistant', content: long},
  ];
  const req = buildRequestMessages(history, 'n');
  assert.ok(req[1].content.length <= BACKEND_MAX_MESSAGE_CHARS);
  assert.equal(history[1].content, long);
});
