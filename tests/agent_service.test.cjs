const test = require('node:test');
const assert = require('node:assert/strict');
const mobx = require('mobx');
const {loadAgentModules} = require('./agent_loader.cjs');

const {service: agentServiceModule} = loadAgentModules();
const {AgentService, AGENT_MAX_MESSAGE_CHARS} = agentServiceModule;

const originalFetch = globalThis.fetch;
test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

function makeService({documentId = null, lifeCycleState = 'EDITING'} = {}) {
  const documentStoreService = mobx.observable({documentId});
  const appService = mobx.observable({lifeCycleState});
  const textEditorService = {getPlainText: () => 'doc'};
  const service = new AgentService({
    appService,
    documentStoreService,
    textEditorService,
  });
  return {service, documentStoreService, appService};
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

test('document switch resets the conversation', () => {
  const {service, documentStoreService} = makeService({documentId: 'A'});
  service.messages = [{role: 'user', content: 'a'}];
  documentStoreService.documentId = 'B';
  assert.equal(service.messages.length, 0);
});

test('null -> id keeps the conversation (first autosave of a new story)', () => {
  const {service, documentStoreService} = makeService({documentId: null});
  service.messages = [{role: 'user', content: 'a'}];
  service.draft = 'x';
  documentStoreService.documentId = 'A';
  assert.equal(service.messages.length, 1);
  assert.equal(service.draft, 'x');
});

test('leaving EDITING resets the conversation', () => {
  const {service, appService} = makeService({documentId: 'A'});
  service.messages = [{role: 'user', content: 'a'}];
  appService.lifeCycleState = 'INITIALIZING';
  assert.equal(service.messages.length, 0);
});

test('send keeps history starting with user and within the limit', async () => {
  const {service} = makeService({documentId: 'A'});
  const bodies = [];
  globalThis.fetch = async (_url, opts) => {
    bodies.push(JSON.parse(opts.body));
    return jsonResponse({reply: 'r', toolCalls: []});
  };
  for (let i = 0; i < 15; i++) {
    service.setDraft(`p${i}`);
    await service.send();
  }
  assert.equal(service.messages.length, 20);
  assert.equal(service.messages[0].role, 'user');
  for (let i = 0; i < service.messages.length; i += 2) {
    assert.equal(service.messages[i].role, 'user');
    assert.equal(service.messages[i + 1].role, 'assistant');
  }
  const last = bodies.at(-1).messages;
  assert.equal(last[0].role, 'user');
  assert.equal(last.at(-1).content, 'p14');
  assert.ok(last.length <= 20);
});

test('send rejects over-long drafts without calling the server', async () => {
  const {service} = makeService();
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    return jsonResponse({reply: 'r'});
  };
  service.setDraft('x'.repeat(AGENT_MAX_MESSAGE_CHARS + 1));
  await service.send();
  assert.equal(called, false);
  assert.match(service.error, /demasiado largo/);
});

test('cancel keeps the draft and does not duplicate messages', async () => {
  const {service} = makeService();
  globalThis.fetch = (_url, opts) =>
    new Promise((_res, rej) => {
      opts.signal.addEventListener('abort', () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        rej(err);
      });
    });
  service.setDraft('hola');
  const pending = service.send();
  assert.equal(service.isBusy, true);
  service.cancel();
  await pending;
  assert.equal(service.draft, 'hola');
  assert.equal(service.messages.length, 0);
  assert.equal(service.isBusy, false);
  assert.equal(service.pendingMessage, null);
  assert.match(service.error, /Dejaste de esperar/);

  globalThis.fetch = async () => jsonResponse({reply: 'ok', toolCalls: []});
  await service.send();
  assert.equal(service.messages.length, 2);
  assert.equal(service.draft, '');
});

test('server error keeps the draft and does not duplicate on retry', async () => {
  const {service} = makeService();
  let ok = false;
  globalThis.fetch = async () =>
    ok ? jsonResponse({reply: 'r', toolCalls: [{name: 't'}]}) : jsonResponse({error: 'boom'}, 500);
  service.setDraft('hola');
  await service.send();
  assert.equal(service.draft, 'hola');
  assert.equal(service.messages.length, 0);
  assert.equal(service.error, 'boom');

  ok = true;
  await service.send();
  assert.equal(service.messages.length, 2);
  assert.equal(service.messages[1].toolCalls[0], 't');
  assert.equal(service.draft, '');
  assert.equal(service.error, null);
});

test('reset during send discards the stale reply', async () => {
  const {service} = makeService();
  let resolve;
  globalThis.fetch = () =>
    new Promise((r) => {
      resolve = r;
    });
  service.setDraft('hola');
  const pending = service.send();
  service.reset();
  resolve(jsonResponse({reply: 'tarde', toolCalls: []}));
  await pending;
  assert.equal(service.messages.length, 0);
});

test('stale login response does not overwrite a newer login attempt', async () => {
  const {service} = makeService();
  const resolvers = [];
  globalThis.fetch = () =>
    new Promise((r) => resolvers.push(r));

  const p1 = service.startLogin();
  service.reset();
  const p2 = service.startLogin();
  assert.equal(service.isStartingLogin, true);

  resolvers[0](jsonResponse({started: true}));
  await p1;
  assert.equal(service.isStartingLogin, true, 'stale finally must not clear new flag');
  assert.equal(service.loginStarted, false);

  resolvers[1](jsonResponse({started: true}));
  await p2;
  assert.equal(service.isStartingLogin, false);
  assert.equal(service.loginStarted, true);
});

test('stale login failure does not set an error on the new attempt', async () => {
  const {service} = makeService();
  const resolvers = [];
  globalThis.fetch = () =>
    new Promise((r) => resolvers.push(r));

  const p1 = service.startLogin();
  service.reset();
  const p2 = service.startLogin();

  resolvers[0](jsonResponse({error: 'viejo'}, 500));
  await p1;
  assert.equal(service.loginError, null);
  assert.equal(service.isStartingLogin, true);

  resolvers[1](jsonResponse({started: true}));
  await p2;
  assert.equal(service.loginError, null);
  assert.equal(service.loginStarted, true);
});

test('401 on chat invalidates health so login is offered, keeping the draft', async () => {
  const {service} = makeService();
  service.health = {ready: true, provider: 'anthropic', model: 'm'};
  globalThis.fetch = async () => jsonResponse({error: 'no autenticado'}, 401);
  service.setDraft('hola');
  assert.equal(service.canSend, true);
  await service.send();
  assert.equal(service.health.ready, false);
  assert.equal(service.health.loginRequired, true);
  assert.equal(service.health.model, 'm');
  assert.equal(service.canSend, false);
  assert.equal(service.draft, 'hola');
  assert.equal(service.messages.length, 0);
  assert.equal(service.error, 'no autenticado');
});

test('401 without prior health still sets loginRequired', async () => {
  const {service} = makeService();
  globalThis.fetch = async () => jsonResponse({error: 'x'}, 401);
  service.setDraft('hola');
  await service.send();
  assert.equal(service.health.ready, false);
  assert.equal(service.health.loginRequired, true);
});

test('non-401 errors do not touch health', async () => {
  const {service} = makeService();
  service.health = {ready: true, provider: 'anthropic', model: 'm'};
  globalThis.fetch = async () => jsonResponse({error: 'boom'}, 500);
  service.setDraft('hola');
  await service.send();
  assert.equal(service.health.ready, true);
});

test('response.model updates the visible model without changing ready', async () => {
  const {service} = makeService();
  service.health = {ready: true, provider: 'anthropic', model: 'old'};
  globalThis.fetch = async () => jsonResponse({reply: 'r', toolCalls: [], model: 'new'});
  service.setDraft('hola');
  await service.send();
  assert.equal(service.health.model, 'new');
  assert.equal(service.health.ready, true);
});

test('alreadyLoggedIn triggers an immediate health check', async () => {
  const {service} = makeService();
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(url);
    if (url.endsWith('/login')) {
      return jsonResponse({started: true, alreadyLoggedIn: true, message: 'ya'});
    }
    return jsonResponse({ready: true, provider: 'anthropic', model: 'm'});
  };
  await service.startLogin();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(urls, ['/api/agent/login', '/api/agent/health']);
  assert.equal(service.loginStarted, false);
  assert.equal(service.health.ready, true);
  assert.equal(service.loginMessage, 'ya');
});

test('login stores message and only accepts http(s) urls', async () => {
  const {service} = makeService();
  globalThis.fetch = async () =>
    jsonResponse({started: true, running: true, url: 'javascript:alert(1)', message: 'abierto'});
  await service.startLogin();
  assert.equal(service.loginStarted, true);
  assert.equal(service.loginMessage, 'abierto');
  assert.equal(service.loginUrl, null);
  globalThis.fetch = async () =>
    jsonResponse({started: true, url: 'https://claude.ai/login', message: 'm'});
  await service.startLogin();
  assert.equal(service.loginUrl, 'https://claude.ai/login');
});