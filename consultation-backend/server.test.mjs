import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtemp, readdir, readFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createLeadHandler, validateLead, verifyProxySignature } from './server.mjs';

function signedUrl(secret, shop, timestamp) {
  const url = new URL('https://example.test/proxy/consultation-lead');
  url.searchParams.set('shop', shop);
  url.searchParams.set('timestamp', String(timestamp));
  url.searchParams.set('path_prefix', '/apps/consultation-lead');
  const message = [...url.searchParams].map(([key, value]) => `${key}=${value}`).sort().join('');
  url.searchParams.set('signature', createHmac('sha256', secret).update(message).digest('hex'));
  return url;
}

function mockRequest(url, body) {
  return {
    method: 'POST',
    url: url.pathname + url.search,
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '127.0.0.1' },
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)); },
  };
}

function mockResponse() {
  return {
    status: 0,
    body: null,
    writeHead(status) { this.status = status; },
    end(body) { this.body = JSON.parse(body); },
  };
}

test('verifies signed proxy requests and rejects tampering', () => {
  const now = Date.now();
  const url = signedUrl('secret', 'store.myshopify.com', Math.floor(now / 1000));
  assert.equal(verifyProxySignature(url, 'secret', 'store.myshopify.com', now), true);
  url.searchParams.set('shop', 'other.myshopify.com');
  assert.equal(verifyProxySignature(url, 'secret', 'store.myshopify.com', now), false);
});

test('validates contact fields and URLs before Shopify writes', () => {
  const result = validateLead({
    name: 'Test',
    email: 'test@example.com',
    phone: '12345',
    service: 'Other',
    website: 'javascript:alert(1)',
  }, ['Other'], { name: true, phone: true, service: true });
  assert.equal(result.errors.phone.includes('country code'), true);
  assert.equal(result.errors.website.includes('http or https'), true);
});

test('creates one customer, preserves a private submission, and adds metafields', async () => {
  const storageDir = await mkdtemp(join(tmpdir(), 'consultation-lead-test-'));
  const calls = [];
  let created = false;
  const fetchImpl = async (_url, options) => {
    const { query, variables } = JSON.parse(options.body);
    calls.push({ query, variables });
    let data;
    if (query.includes('metafieldDefinitions(')) data = { metafieldDefinitions: { nodes: [] } };
    else if (query.includes('metafieldDefinitionCreate(')) data = { metafieldDefinitionCreate: { createdDefinition: { id: 'definition' }, userErrors: [] } };
    else if (query.includes('customers(')) data = { customers: { nodes: created ? [{ id: 'gid://shopify/Customer/1', email: 'test@example.com' }] : [] } };
    else if (query.includes('customerCreate(')) {
      created = true;
      data = { customerCreate: { customer: { id: 'gid://shopify/Customer/1' }, userErrors: [] } };
    } else if (query.includes('tagsAdd(')) data = { tagsAdd: { userErrors: [] } };
    else if (query.includes('metafieldsSet(')) data = { metafieldsSet: { metafields: [{ id: 'meta' }], userErrors: [] } };
    else throw new Error('Unexpected query');
    return { ok: true, json: async () => ({ data }) };
  };
  const config = {
    appSecret: 'secret',
    shop: 'store.myshopify.com',
    adminToken: 'server-only-token',
    storageDir,
    path: '/proxy/consultation-lead',
    services: ['Other'],
    required: { name: true, phone: true, service: true },
  };
  const now = Date.now();
  const handler = createLeadHandler(config, { fetchImpl, now: () => now });
  const url = signedUrl(config.appSecret, config.shop, Math.floor(now / 1000));
  try {
    const body = {
      name: 'Test Person',
      email: 'test@example.com',
      phone: '+15551234567',
      service: 'Other',
      website: 'https://example.com',
      message: 'Please contact me.',
      include_timestamp: true,
    };
    const first = mockResponse();
    await handler(mockRequest(url, body), first);
    assert.equal(first.status, 200);
    assert.deepEqual(first.body, { ok: true });
    assert.equal(calls.filter((call) => call.query.includes('customerCreate(')).length, 1);
    assert.equal(calls.some((call) => call.query.includes('metafieldsSet(') && call.variables.metafields.some((field) => field.key === 'message')), true);

    const second = mockResponse();
    await handler(mockRequest(url, body), second);
    assert.equal(second.status, 200);
    assert.equal(calls.filter((call) => call.query.includes('customerCreate(')).length, 1);
    const files = await readdir(storageDir);
    assert.equal(files.length, 2);
    const saved = JSON.parse(await readFile(join(storageDir, files[0]), 'utf8'));
    assert.equal(saved.status, 'saved');
    assert.equal(saved.message, 'Please contact me.');
  } finally {
    for (const file of await readdir(storageDir)) await unlink(join(storageDir, file));
    await rmdir(storageDir);
  }
});

test('rejects honeypot and rate-limited requests before any Shopify call', async () => {
  const now = Date.now();
  const url = signedUrl('secret', 'store.myshopify.com', Math.floor(now / 1000));
  let calls = 0;
  const handler = createLeadHandler({
    appSecret: 'secret', shop: 'store.myshopify.com', path: url.pathname,
  }, {
    now: () => now,
    rateLimit: (_ip) => ++calls === 1,
    fetchImpl: () => { throw new Error('Shopify must not be called'); },
  });
  const spam = mockResponse();
  await handler(mockRequest(url, { website_confirm: 'filled' }), spam);
  assert.equal(spam.status, 400);
  const limited = mockResponse();
  await handler(mockRequest(url, {}), limited);
  assert.equal(limited.status, 429);
});

test('returns a sanitized error when Shopify fails', async () => {
  const storageDir = await mkdtemp(join(tmpdir(), 'consultation-lead-failure-'));
  const now = Date.now();
  const url = signedUrl('secret', 'store.myshopify.com', Math.floor(now / 1000));
  const handler = createLeadHandler({
    appSecret: 'secret', shop: 'store.myshopify.com', adminToken: 'private-token',
    path: url.pathname, storageDir, services: ['Other'], required: {},
  }, {
    now: () => now,
    fetchImpl: async () => ({ ok: false, status: 503 }),
  });
  const originalError = console.error;
  console.error = () => {};
  try {
    const res = mockResponse();
    await handler(mockRequest(url, { email: 'test@example.com', service: 'Other' }), res);
    assert.equal(res.status, 500);
    assert.deepEqual(res.body, { ok: false });
    assert.equal(JSON.stringify(res.body).includes('private-token'), false);
  } finally {
    console.error = originalError;
    for (const file of await readdir(storageDir)) await unlink(join(storageDir, file));
    await rmdir(storageDir);
  }
});
