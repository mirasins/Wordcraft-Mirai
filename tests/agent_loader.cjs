/**
 * Loads app TypeScript sources for node:test without bundling or new deps.
 * Transpiles each file in memory to CommonJS and resolves only the aliases
 * the agent modules need. Nothing is written to disk.
 */
const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const root = path.join(__dirname, '..');

function transpile(file) {
  const src = fs.readFileSync(path.join(root, file), 'utf8');
  return ts.transpileModule(src, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2019,
      experimentalDecorators: true,
    },
  }).outputText;
}

function loadTs(file, resolve) {
  const module = {exports: {}};
  const code = transpile(file);
  new Function('exports', 'require', 'module', code)(
    module.exports,
    resolve,
    module
  );
  return module.exports;
}

/** Loads the agent modules fresh so each test file gets isolated state. */
function loadAgentModules() {
  const cache = {};
  const resolve = (id) => {
    if (id === 'mobx') return require('mobx');
    if (id === '@lib/agent_messages') {
      return (cache.messages ??= loadTs('app/lib/agent_messages.ts', resolve));
    }
    if (id === './service') return {Service: class {}};
    if (id === './services') return {};
    throw new Error(`Unexpected import in agent tests: ${id}`);
  };
  const messages = (cache.messages ??= loadTs(
    'app/lib/agent_messages.ts',
    resolve
  ));
  const service = loadTs('app/core/services/agent_service.ts', resolve);
  return {messages, service};
}

module.exports = {loadAgentModules};
