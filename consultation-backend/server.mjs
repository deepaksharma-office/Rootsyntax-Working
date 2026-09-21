import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, open, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const API_VERSION = process.env.SHOPIFY_API_VERSION || '2026-07';
const DEFAULT_SERVICES = [
  'Store Build or Redesign', 'Shopify Migration', 'Shopify Theme Development',
  'Shopify Plus', 'Conversion Rate Optimization', 'Shopify SEO',
  'Custom Shopify Development', 'Speed Optimization', 'B2B / Wholesale',
  'Maintenance & Support', 'Other',
];
const DEFINITIONS = [
  ['submitted_name', 'Submitted name', 'single_line_text_field'],
  ['submitted_phone', 'Submitted phone', 'single_line_text_field'],
  ['service_interested_in', 'Service interested in', 'single_line_text_field'],
  ['existing_website', 'Existing website', 'url'],
  ['message', 'Consultation message', 'multi_line_text_field'],
  ['submitted_at', 'Submitted at', 'date_time'],
  ['source', 'Lead source', 'single_line_text_field'],
  ['page_url', 'Page URL', 'url'],
  ['referrer', 'Referrer', 'url'],
  ['utm_source', 'UTM source', 'single_line_text_field'],
  ['utm_medium', 'UTM medium', 'single_line_text_field'],
  ['utm_campaign', 'UTM campaign', 'single_line_text_field'],
  ['utm_term', 'UTM term', 'single_line_text_field'],
  ['utm_content', 'UTM content', 'single_line_text_field'],
];

const DEFINITIONS_QUERY = `query {
  metafieldDefinitions(ownerType: CUSTOMER, namespace: "lead", first: 100) {
    nodes { key type { name } }
  }
}`;
const CREATE_DEFINITION = `mutation($definition: MetafieldDefinitionInput!) {
  metafieldDefinitionCreate(definition: $definition) {
    createdDefinition { id }
    userErrors { field message code }
  }
}`;
const FIND_CUSTOMER = `query($query: String!) {
  customers(first: 5, query: $query) { nodes { id email } }
}`;
const CREATE_CUSTOMER = `mutation($input: CustomerInput!) {
  customerCreate(input: $input) {
    customer { id }
    userErrors { field message }
  }
}`;
const ADD_TAGS = `mutation($id: ID!, $tags: [String!]!) {
  tagsAdd(id: $id, tags: $tags) { userErrors { field message } }
}`;
const SET_METAFIELDS = `mutation($metafields: [MetafieldsSetInput!]!) {
  metafieldsSet(metafields: $metafields) {
    metafields { id }
    userErrors { field message code }
  }
}`;

export function verifyProxySignature(url, secret, expectedShop, now = Date.now()) {
  const signature = url.searchParams.get('signature');
  const timestamp = Number(url.searchParams.get('timestamp'));
  const shop = url.searchParams.get('shop');
  if (!signature || !/^[a-f0-9]{64}$/i.test(signature)) return false;
  if (!Number.isSafeInteger(timestamp) || Math.abs(now - timestamp * 1000) > 300000) return false;
  if (shop !== expectedShop) return false;
  const values = new Map();
  for (const [key, value] of url.searchParams) {
    if (key === 'signature') continue;
    if (!values.has(key)) values.set(key, []);
    values.get(key).push(value);
  }
  const message = [...values].map(([key, list]) => `${key}=${list.join(',')}`).sort().join('');
  const expected = createHmac('sha256', secret).update(message).digest('hex');
  return timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'));
}

function clean(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function safeUrl(value, max) {
  const text = clean(value, max);
  if (!text) return '';
  try {
    const url = new URL(text);
    return ['http:', 'https:'].includes(url.protocol) ? url.toString().slice(0, max) : '';
  } catch {
    return '';
  }
}

function normalizePhone(value) {
  const raw = clean(value, 30);
  if (!raw) return '';
  const normalized = raw.replace(/[\s().-]/g, '');
  return /^\+[1-9][0-9]{7,14}$/.test(normalized) ? normalized : null;
}

export function validateLead(body, allowedServices, required = {}) {
  const errors = {};
  const name = clean(body.name, 120);
  const email = clean(body.email, 254).toLowerCase();
  const phone = normalizePhone(body.phone);
  const service = clean(body.service, 120);
  const website = safeUrl(body.website, 500);
  const message = clean(body.message, 10000);

  if (required.name && !name) errors.name = 'Enter your name.';
  if (!/^[^\s@\"\\]+@[^\s@\"\\]+\.[^\s@\"\\]+$/.test(email)) errors.email = 'Enter a valid email address.';
  if (required.phone && !clean(body.phone, 30)) errors.phone = 'Enter your phone number.';
  else if (phone === null) errors.phone = 'Include a country code, for example +15551234567.';
  if (required.service && !service) errors.service = 'Select a service.';
  else if (service && !allowedServices.includes(service)) errors.service = 'Select a listed service.';
  if (clean(body.website, 500) && !website) errors.website = 'Enter a valid http or https website URL.';
  if (required.message && !message) errors.message = 'Enter a message.';
  if (typeof body.message === 'string' && body.message.length > 10000) errors.message = 'Keep the message under 10,000 characters.';
  if (typeof body.name === 'string' && body.name.length > 120) errors.name = 'Keep the name under 120 characters.';
  if (typeof body.email === 'string' && body.email.length > 254) errors.email = 'Keep the email under 254 characters.';
  if (typeof body.website === 'string' && body.website.length > 500) errors.website = 'Keep the URL under 500 characters.';
  return { errors, lead: { name, email, phone: phone || '', service, website, message } };
}

function response(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

async function readBody(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 32768) throw new Error('BODY_TOO_LARGE');
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  const type = req.headers['content-type'] || '';
  if (type.startsWith('application/json')) return JSON.parse(raw);
  if (type.startsWith('application/x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(raw));
  throw new Error('UNSUPPORTED_CONTENT_TYPE');
}

function rateLimiter(limit = 5, windowMs = 60000) {
  const entries = new Map();
  return (key, now = Date.now()) => {
    const old = entries.get(key) || [];
    const recent = old.filter((time) => now - time < windowMs);
    recent.push(now);
    entries.set(key, recent);
    if (entries.size > 10000) {
      for (const [entryKey, times] of entries) {
        if (now - times.at(-1) > windowMs) entries.delete(entryKey);
      }
    }
    return recent.length <= limit;
  };
}

export function createLeadHandler(config, dependencies = {}) {
  const fetchImpl = dependencies.fetchImpl || fetch;
  const now = dependencies.now || (() => Date.now());
  const limited = dependencies.rateLimit || rateLimiter();
  const services = config.services || DEFAULT_SERVICES;
  let definitionsReady;

  async function graphql(query, variables = {}) {
    const result = await fetchImpl(`https://${config.shop}/admin/api/${config.apiVersion || API_VERSION}/graphql.json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': config.adminToken,
      },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(12000),
    });
    if (!result.ok) throw new Error(`SHOPIFY_HTTP_${result.status}`);
    const json = await result.json();
    if (json.errors?.length) throw new Error('SHOPIFY_GRAPHQL_ERROR');
    return json.data;
  }

  async function ensureDefinitions() {
    const existing = await graphql(DEFINITIONS_QUERY);
    const found = new Map(existing.metafieldDefinitions.nodes.map((item) => [item.key, item.type.name]));
    for (const [key, name, type] of DEFINITIONS) {
      if (found.has(key)) {
        if (found.get(key) !== type) throw new Error(`METAFIELD_TYPE_MISMATCH_${key}`);
        continue;
      }
      const data = await graphql(CREATE_DEFINITION, {
        definition: { name, namespace: 'lead', key, type, ownerType: 'CUSTOMER' },
      });
      if (data.metafieldDefinitionCreate.userErrors.length) throw new Error(`METAFIELD_DEFINITION_FAILED_${key}`);
    }
  }

  async function findCustomer(email) {
    const query = `email:"${email}"`;
    const data = await graphql(FIND_CUSTOMER, { query });
    return data.customers.nodes.find((customer) => customer.email?.toLowerCase() === email);
  }

  async function saveToShopify(lead, metadata) {
    if (!definitionsReady) definitionsReady = ensureDefinitions().catch((error) => {
      definitionsReady = null;
      throw error;
    });
    await definitionsReady;

    let customer = await findCustomer(lead.email);
    if (!customer) {
      const parts = lead.name.split(/\s+/).filter(Boolean);
      const input = { email: lead.email };
      if (parts.length) {
        input.firstName = parts.shift();
        if (parts.length) input.lastName = parts.join(' ');
      }
      if (lead.phone) input.phone = lead.phone;
      const created = await graphql(CREATE_CUSTOMER, { input });
      if (created.customerCreate.userErrors.length) {
        customer = await findCustomer(lead.email);
        if (!customer) throw new Error('CUSTOMER_CREATE_FAILED');
      } else {
        customer = created.customerCreate.customer;
      }
    }

    const serviceTag = `service-${lead.service.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'other'}`;
    const tagged = await graphql(ADD_TAGS, {
      id: customer.id,
      tags: ['lead', 'website-consultation', 'shopify-lead', serviceTag],
    });
    if (tagged.tagsAdd.userErrors.length) throw new Error('CUSTOMER_TAGS_FAILED');

    const values = {
      submitted_name: lead.name,
      submitted_phone: lead.phone,
      service_interested_in: lead.service,
      existing_website: lead.website,
      message: lead.message,
      submitted_at: metadata.includeTimestamp ? metadata.submittedAt : '',
      source: 'shopify-consultation-form',
      ...metadata.attribution,
    };
    const metafields = DEFINITIONS
      .filter(([key]) => values[key])
      .map(([key, , type]) => ({
        ownerId: customer.id, namespace: 'lead', key, type, value: values[key],
      }));
    const saved = await graphql(SET_METAFIELDS, { metafields });
    if (saved.metafieldsSet.userErrors.length) throw new Error('CUSTOMER_METAFIELDS_FAILED');
    return customer.id;
  }

  return async (req, res) => {
    try {
      if (req.method !== 'POST') return response(res, 405, { ok: false });
      const url = new URL(req.url, 'https://app.internal');
      if (url.pathname !== config.path) return response(res, 404, { ok: false });
      if (!verifyProxySignature(url, config.appSecret, config.shop, now())) return response(res, 403, { ok: false });
      if (req.headers['sec-fetch-site'] === 'cross-site') return response(res, 403, { ok: false });
      if (req.headers.origin && req.headers['x-forwarded-host']) {
        try {
          if (new URL(req.headers.origin).host !== req.headers['x-forwarded-host']) return response(res, 403, { ok: false });
        } catch {
          return response(res, 403, { ok: false });
        }
      }
      const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
      if (!limited(ip, now())) return response(res, 429, { ok: false });
      const body = await readBody(req);
      if (typeof body !== 'object' || body === null || Array.isArray(body)) return response(res, 400, { ok: false });
      if (clean(body.website_confirm, 200)) return response(res, 400, { ok: false });

      const { lead, errors } = validateLead(body, services, config.required);
      if (Object.keys(errors).length) return response(res, 422, { ok: false, errors });

      const attribution = {};
      if (body.tracking_allowed === true) {
        for (const key of ['page_url', 'referrer']) {
          const value = safeUrl(body[key], 1000);
          if (value) attribution[key] = value;
        }
        for (const key of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content']) {
          const value = clean(body[key], 200);
          if (value) attribution[key] = value;
        }
      }
      const submittedAt = new Date(now()).toISOString();
      const record = { ...lead, submittedAt, attribution, status: 'pending' };
      await mkdir(config.storageDir, { recursive: true, mode: 0o700 });
      const recordPath = join(config.storageDir, `${randomUUID()}.json`);
      const file = await open(recordPath, 'wx', 0o600);
      try {
        await file.writeFile(JSON.stringify(record));
        await file.sync();
      } finally {
        await file.close();
      }
      const customerId = await saveToShopify(lead, {
        submittedAt, attribution, includeTimestamp: body.include_timestamp === true,
      });
      await writeFile(recordPath, JSON.stringify({ ...record, status: 'saved', customerId }), { mode: 0o600 });

      if (
        body.notify === true &&
        config.notificationUrl &&
        config.notificationToken &&
        config.notificationEmail &&
        body.notification_email === config.notificationEmail
      ) {
        try {
          await fetchImpl(config.notificationUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${config.notificationToken}`,
            },
            body: JSON.stringify({ ...lead, submittedAt, attribution, recipient: config.notificationEmail }),
            signal: AbortSignal.timeout(8000),
          });
        } catch {
          // A notification failure must not turn a saved lead into a failed submission.
        }
      }
      return response(res, 200, { ok: true });
    } catch (error) {
      if (error.message === 'BODY_TOO_LARGE') return response(res, 413, { ok: false });
      if (error.message === 'UNSUPPORTED_CONTENT_TYPE') return response(res, 415, { ok: false });
      if (error instanceof SyntaxError) return response(res, 400, { ok: false });
      console.error('Consultation lead failure:', error.message);
      return response(res, 500, { ok: false });
    }
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const requiredEnvironment = [
    'SHOPIFY_APP_SECRET', 'SHOPIFY_SHOP_DOMAIN', 'SHOPIFY_ADMIN_TOKEN', 'LEAD_STORAGE_DIR',
  ];
  const missing = requiredEnvironment.filter((key) => !process.env[key]);
  if (missing.length) {
    console.error(`Missing server environment variables: ${missing.join(', ')}`);
    process.exitCode = 1;
  } else {
    const config = {
      appSecret: process.env.SHOPIFY_APP_SECRET,
      shop: process.env.SHOPIFY_SHOP_DOMAIN,
      adminToken: process.env.SHOPIFY_ADMIN_TOKEN,
      storageDir: process.env.LEAD_STORAGE_DIR,
      path: process.env.APP_PROXY_BACKEND_PATH || '/proxy/consultation-lead',
      apiVersion: API_VERSION,
      services: (process.env.ALLOWED_SERVICES || DEFAULT_SERVICES.join('|')).split('|').map((item) => item.trim()),
      required: {
        name: process.env.REQUIRE_NAME !== 'false',
        phone: process.env.REQUIRE_PHONE !== 'false',
        service: process.env.REQUIRE_SERVICE !== 'false',
      },
      notificationUrl: process.env.NOTIFICATION_WEBHOOK_URL,
      notificationToken: process.env.NOTIFICATION_WEBHOOK_TOKEN,
      notificationEmail: process.env.NOTIFICATION_EMAIL,
    };
    createServer(createLeadHandler(config)).listen(Number(process.env.PORT) || 3000);
  }
}
