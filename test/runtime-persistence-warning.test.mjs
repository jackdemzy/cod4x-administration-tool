import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { RuntimePersistenceWarning } from '../lib/runtime-persistence-warning.mjs';

test('storage warning is independent of lifecycle status and escapes error text', () => {
  for (const status of ['RUNNING', 'STOPPED', 'FAILED']) {
    const runtime = { status, pid: status === 'RUNNING' ? 123 : null, persistenceError: { message: '<script>disk full</script>' } };
    const before = JSON.stringify(runtime);
    const html = renderToStaticMarkup(createElement(RuntimePersistenceWarning, { runtime }));
    assert.match(html, /role="alert"/);
    assert.match(html, /Runtime-Zustand nicht gespeichert/);
    assert.match(html, /&lt;script&gt;/);
    assert.equal(JSON.stringify(runtime), before);
  }
});

test('warning supports English and disappears after successful persistence', () => {
  assert.match(renderToStaticMarkup(createElement(RuntimePersistenceWarning, { de: false, runtime: { persistenceError: { code: 'RUNTIME_PERSISTENCE_FAILED' } } })), /Runtime state not saved/);
  assert.equal(renderToStaticMarkup(createElement(RuntimePersistenceWarning, { runtime: { persistenceError: null } })), '');
  assert.equal(renderToStaticMarkup(createElement(RuntimePersistenceWarning, {})), '');
});
