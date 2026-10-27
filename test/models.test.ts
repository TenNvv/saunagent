import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ModelCatalog, endpoint } from '../src/models.js';
import { defaults } from '../src/store.js';

test('OPENAI_BASE_URL selects Chat Completions, preserves path prefix, and supports arbitrary gateway model IDs', async () => {
  const catalog = new ModelCatalog(defaults, {
    PROVIDER: 'openai', OPENAI_BASE_URL: 'https://gateway.example/coder/v1',
    MODEL: 'gateway-only-model', OPENAI_API_KEY: 'unit-test-not-a-real-key',
  });
  const selected = catalog.resolve(defaults.model, 'default');
  assert.deepEqual(selected, { provider: 'openai', modelId: 'gateway-only-model' });
  const model = catalog.models.getModel(selected.provider, selected.modelId)!;
  assert.equal(model.api, 'openai-completions');
  assert.equal(model.baseUrl, 'https://gateway.example/coder/v1');
  let calls = 0;
  const answer = await catalog.models.completeSimple(model, {
    messages: [{ role: 'user', content: 'ping gateway', timestamp: Date.now() }],
  }, { fetch: async (input, init) => {
    calls++;
    const request = new Request(input, init);
    assert.equal(request.url, 'https://gateway.example/coder/v1/chat/completions');
    assert.equal(request.headers.get('authorization'), 'Bearer unit-test-not-a-real-key');
    const body = await request.json();
    assert.equal(body.model, 'gateway-only-model');
    assert.equal(body.stream, true);
    assert.equal(body.messages.at(-1).content, 'ping gateway');
    assert.equal(body.max_tokens, 8192);
    assert.equal(body.store, undefined);
    const chunk = (delta: object, finish_reason: string | null) => `data: ${JSON.stringify({
      id: 'chatcmpl-test', object: 'chat.completion.chunk', created: 1, model: body.model,
      choices: [{ index: 0, delta, finish_reason }],
    })}\n\n`;
    return new Response(chunk({ role: 'assistant', content: 'gateway reply' }, null) + chunk({}, 'stop') + 'data: [DONE]\n\n', {
      headers: { 'content-type': 'text/event-stream' },
    });
  } });
  assert.equal(calls, 1);
  assert.equal(answer.stopReason, 'stop', answer.errorMessage);
  assert.deepEqual(answer.content.filter(part => part.type === 'text').map(part => part.text), ['gateway reply']);
});

test('config supports separate named gateways and supervisor model selection', async () => {
  const config = { ...defaults, providers: {
    gateway: { baseUrl: 'https://gateway.example/prefix/v1/chat/completions', apiKeyEnv: 'GATEWAY_TOKEN', contextWindow: 64000, maxTokens: 4000 },
  } };
  const catalog = new ModelCatalog(config, { PROVIDER: 'gateway', MODEL: 'worker-model', SUPERVISOR_MODEL: 'router-model', GATEWAY_TOKEN: 'test-key' });
  assert.deepEqual(catalog.resolve(config.model, 'default'), { provider: 'gateway', modelId: 'worker-model' });
  assert.deepEqual(catalog.resolve(config.supervisorModel, 'supervisor'), { provider: 'gateway', modelId: 'router-model' });
  assert.equal(catalog.models.getModel('gateway', 'router-model')!.baseUrl, 'https://gateway.example/prefix/v1');
  assert.equal(catalog.models.getModel('gateway', 'worker-model')!.contextWindow, 64000);
  assert.equal((await catalog.models.getAuth('gateway'))?.auth.apiKey, 'test-key');
  assert.deepEqual(catalog.resolve({ provider: 'gateway', modelId: 'explicit-task-model' }), { provider: 'gateway', modelId: 'explicit-task-model' });
});

test('responses and messages protocols normalize full endpoint URLs without silently switching protocols', () => {
  assert.equal(endpoint({ baseUrl: 'https://gateway.example/p/v1/responses' }).api, 'openai-responses');
  assert.equal(endpoint({ baseUrl: 'https://gateway.example/p/v1/responses' }).baseUrl, 'https://gateway.example/p/v1');
  assert.equal(endpoint({ baseUrl: 'https://gateway.example/p/v1/messages' }).baseUrl, 'https://gateway.example/p');
  assert.equal(endpoint({ baseUrl: 'https://gateway.example/p/v1/messages' }).api, 'anthropic-messages');
  assert.throws(() => endpoint({ baseUrl: 'https://gateway.example/v1/responses', api: 'openai-completions' }), /does not match/);
  assert.throws(() => endpoint({ baseUrl: 'https://user:secret@gateway.example/v1' }), /embedded credentials/);
  assert.throws(() => endpoint({ baseUrl: 'https://gateway.example/v1?api_key=secret' }), /embedded credentials/);
  assert.throws(() => endpoint({ baseUrl: 'file:///tmp/model' }), /HTTP/);
});

test('missing gateway credentials fail with the environment variable name, without a request', async () => {
  const catalog = new ModelCatalog(defaults, { OPENAI_BASE_URL: 'https://gateway.example/coder/v1' });
  await assert.rejects(catalog.models.getAuth('openai'), /OPENAI_API_KEY/);
});
