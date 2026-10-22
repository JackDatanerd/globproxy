// OpenAPI 3.0 description of the public API (served at GET /api/v1/openapi.json).
// Hand-maintained but built from small helpers so adding an endpoint is one line.
// The prose reference lives in app/docs/api/page.tsx; keep the two in step.
type Json = Record<string, any>

const idParam = (name = 'id', description = 'Resource id (UUID)') => ({ name, in: 'path', required: true, description, schema: { type: 'string', format: 'uuid' } })
const q = (name: string, description: string, schema: Json = { type: 'string' }) => ({ name, in: 'query', required: false, description, schema })
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` })
const json = (schema: Json) => ({ content: { 'application/json': { schema } } })
const errs = (...codes: number[]) =>
  Object.fromEntries(codes.map((c) => [String(c), { description: ({ 400: 'Invalid request', 401: 'Unauthorized', 402: 'Insufficient bandwidth', 403: 'Forbidden / insufficient scope / IP not allowed', 404: 'Not found', 409: 'Conflict', 413: 'Request body too large', 422: 'Idempotency-Key reused with a different request', 429: 'Rate limited (see Retry-After)', 500: 'Internal error — safe to retry once', 503: 'Transient failure — retry' } as Record<number, string>)[c], ...json(ref('Error')) }]))

interface OpOpts {
  summary: string
  scope?: 'read' | 'write' | 'allocate'
  params?: Json[]
  body?: Json
  ok?: { status?: number; schema?: Json; description?: string }
  idempotency?: 'optional' | 'required'
  errors?: number[]
}

function op(o: OpOpts): Json {
  const scope = o.scope ?? 'read'
  const params = [...(o.params ?? [])]
  if (o.idempotency) {
    params.push({ name: 'Idempotency-Key', in: 'header', required: o.idempotency === 'required', description: '8–128 chars: letters, digits, _ - : . — a retry returns the original response (Idempotent-Replayed: true).', schema: { type: 'string' } })
  }
  return {
    summary: o.summary,
    description: `Requires an API key with the \`${scope}\` scope${scope === 'allocate' ? ' and an IP allowlist' : ''}.`,
    security: [{ bearerAuth: [] }],
    parameters: params,
    ...(o.body ? { requestBody: { required: true, ...json(o.body) } } : {}),
    responses: {
      [String(o.ok?.status ?? 200)]: { description: o.ok?.description ?? 'Success', ...(o.ok?.schema ? json(o.ok.schema) : {}) },
      ...errs(...(o.errors ?? [400, 404]), 401, 403, 429, 503, ...(o.body ? [413] : [])),
    },
  }
}

const list = (item: string, extra: Json = {}) => ({ type: 'object', properties: { [item]: { type: 'array', items: ref(extra.itemRef ?? 'Object') }, total: { type: 'integer' }, limit: { type: 'integer' }, offset: { type: 'integer' }, has_more: { type: 'boolean' } } })
const cursorList = (key: string, itemRef: string) => ({ type: 'object', properties: { [key]: { type: 'array', items: ref(itemRef) }, has_more: { type: 'boolean' }, next_before: { type: 'string', nullable: true, format: 'date-time' }, next_before_id: { type: 'string', nullable: true } } })
const pageQ = [q('limit', 'Page size', { type: 'integer' }), q('offset', 'Offset', { type: 'integer' })]
const cursorQ = (max: number) => [q('limit', `Page size (max ${max})`, { type: 'integer' }), q('before', 'Cursor: the previous page\'s next_before', { type: 'string' }), q('before_id', 'Cursor: the previous page\'s next_before_id (pass with before so rows sharing a timestamp are not skipped)')]
const createBody = { type: 'object', required: ['gb_allocated'], properties: {
  label: { type: 'string' }, gb_allocated: { type: 'number', minimum: 0.01 }, country: { type: 'string' }, state: { type: 'string' }, city: { type: 'string' }, asn: { type: 'integer' },
  protocol: { type: 'string', enum: ['http', 'socks5'] }, session_type: { type: 'string', enum: ['rotating', 'sticky'] }, sticky_duration: { type: 'integer' },
  auto_topup: { type: 'object', description: 'Turn on auto-topup at creation (same rules as PATCH /auto-topup). enabled defaults to true.', properties: { enabled: { type: 'boolean' }, threshold_gb: { type: 'number' }, amount_gb: { type: 'number', description: 'Must exceed threshold_gb' } } } } }
const bulkResult = { type: 'object', properties: { results: { type: 'array', items: { type: 'object' } }, succeeded: { type: 'integer' }, failed: { type: 'integer' } } }

export function buildOpenApi(origin: string): Json {
  return {
    openapi: '3.0.3',
    info: {
      title: 'GlobProxy API',
      version: '1',
      description: 'Automate sub-users, bandwidth, webhooks and (for resellers) allocations. Reference & guides: ' + origin + '/docs/api. Errors are `{ "error": string, "code": string }`; every response carries `X-Request-Id`; limits are 120 requests/min and 30 writes/min per key.',
    },
    servers: [{ url: origin }],
    components: {
      securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', description: 'API key, e.g. `gp_live_…`' } },
      schemas: {
        Error: { type: 'object', required: ['error', 'code'], properties: { error: { type: 'string' }, code: { type: 'string', enum: ['unauthorized', 'insufficient_scope', 'ip_not_allowed', 'account_suspended', 'reseller_required', 'api_access_disabled', 'forbidden', 'invalid_request', 'insufficient_bandwidth', 'not_found', 'conflict', 'idempotency_conflict', 'payload_too_large', 'rate_limited', 'upstream_unavailable', 'service_unavailable', 'internal_error'] } } },
        Object: { type: 'object', additionalProperties: true },
        SubUser: { type: 'object', additionalProperties: true, properties: { id: { type: 'string', format: 'uuid' }, label: { type: 'string' }, status: { type: 'string', enum: ['pending', 'active', 'suspended'] }, gb_allocated: { type: 'number' }, gb_used: { type: 'number' }, host: { type: 'string' }, port: { type: 'integer' }, username: { type: 'string' }, password: { type: 'string' }, connection_username: { type: 'string' } } },
        Webhook: { type: 'object', properties: { id: { type: 'string', format: 'uuid' }, url: { type: 'string', format: 'uri' }, description: { type: 'string', nullable: true }, event_types: { type: 'array', items: { type: 'string' } }, enabled: { type: 'boolean' }, created_at: { type: 'string', format: 'date-time' }, last_success_at: { type: 'string', format: 'date-time', nullable: true }, last_failure_at: { type: 'string', format: 'date-time', nullable: true }, last_error: { type: 'string', nullable: true }, consecutive_failures: { type: 'integer' }, disabled_at: { type: 'string', format: 'date-time', nullable: true }, disabled_reason: { type: 'string', nullable: true }, previous_secret_expires_at: { type: 'string', format: 'date-time', nullable: true, description: 'Set while a rotated-away signing secret is still accepted.' } } },
        Delivery: { type: 'object', properties: { id: { type: 'string', format: 'uuid' }, event_id: { type: 'string' }, event_type: { type: 'string' }, status: { type: 'string', enum: ['succeeded', 'retrying', 'failed'] }, attempts: { type: 'integer' }, next_attempt_at: { type: 'string', format: 'date-time', nullable: true }, last_attempt_at: { type: 'string', format: 'date-time', nullable: true }, response_status: { type: 'integer', nullable: true }, last_error: { type: 'string', nullable: true }, duration_ms: { type: 'integer', nullable: true }, created_at: { type: 'string', format: 'date-time' }, payload: { type: 'object', additionalProperties: true, description: 'Single-delivery endpoint only.' }, response_body: { type: 'string', nullable: true, description: 'Single-delivery endpoint only (truncated).' } } },
        Activity: { type: 'object', properties: { id: { type: 'integer' }, key_id: { type: 'string', format: 'uuid', nullable: true }, method: { type: 'string' }, path: { type: 'string' }, status: { type: 'integer' }, ip: { type: 'string', nullable: true }, request_id: { type: 'string', nullable: true }, created_at: { type: 'string', format: 'date-time' }, key: { type: 'object', nullable: true, properties: { key_prefix: { type: 'string' }, label: { type: 'string', nullable: true } } } } },
        Transfer: { type: 'object', properties: { id: { type: 'string', format: 'uuid' }, recipient_email: { type: 'string', nullable: true }, gb_amount: { type: 'number' }, gb_reclaimed: { type: 'number' }, gb_net: { type: 'number' }, status: { type: 'string' }, note: { type: 'string', nullable: true }, created_at: { type: 'string', format: 'date-time' } } },
        Order: { type: 'object', properties: { id: { type: 'string', format: 'uuid' }, gb_amount: { type: 'number' }, amount_usd: { type: 'number' }, status: { type: 'string', enum: ['pending', 'paid', 'failed', 'refunded', 'cancelled'] }, invoice_number: { type: 'string', nullable: true }, refunded_usd: { type: 'number' }, refunded_at: { type: 'string', format: 'date-time', nullable: true }, created_at: { type: 'string', format: 'date-time' }, paid_at: { type: 'string', format: 'date-time', nullable: true } } },
        Bandwidth: { type: 'object', properties: { total_gb: { type: 'number' }, used_gb: { type: 'number' }, allocated_gb: { type: 'number', description: 'Reserved into sub-users and reseller transfers.' }, available_gb: { type: 'number', description: 'What is left to create sub-users with.' }, expires: { type: 'string', example: 'never' } } },
        Account: { type: 'object', properties: { account: { type: 'object', properties: { id: { type: 'string', format: 'uuid' }, email: { type: 'string', nullable: true }, role: { type: 'string', nullable: true } } }, api_key: { type: 'object', properties: { id: { type: 'string', format: 'uuid' }, key_prefix: { type: 'string' }, label: { type: 'string', nullable: true }, scopes: { type: 'array', items: { type: 'string', enum: ['read', 'write', 'allocate'] } }, allowed_ips: { type: 'array', items: { type: 'string' } }, expires_at: { type: 'string', format: 'date-time', nullable: true }, created_at: { type: 'string', format: 'date-time' } } }, features: { type: 'object', properties: { password_rotation: { type: 'boolean', description: 'false => POST /sub-users/{id}/rotate-password answers 503.' } } } } },
        BulkResult: { type: 'object', properties: { results: { type: 'array', items: { type: 'object', properties: { index: { type: 'integer' }, id: { type: 'string' }, status: { type: 'integer' }, error: { type: 'object', properties: { code: { type: 'string' }, message: { type: 'string' } } } }, additionalProperties: true } }, succeeded: { type: 'integer' }, failed: { type: 'integer' } } },
        WhitelistEntry: { type: 'object', properties: { ip: { type: 'string' }, description: { type: 'string' } } },
        Country: { type: 'object', properties: { code: { type: 'string', description: 'Pass as `country`.' }, name: { type: 'string' }, state_count: { type: 'integer' } } },
        State: { type: 'object', properties: { code: { type: 'string', description: 'Pass as `state`.' }, name: { type: 'string' }, cities: { type: 'array', items: { type: 'object', properties: { code: { type: 'string', description: 'Pass as `city`.' }, name: { type: 'string' } } } }, city_count: { type: 'integer', description: 'Present instead of cities when cities=false.' } } },
        Asn: { type: 'object', properties: { asn: { type: 'integer', description: 'Pass as `asn`.' }, name: { type: 'string' } } },
      },
    },
    paths: {
      '/api/v1/account': { get: op({ summary: 'Account, key info and optional-feature flags', ok: { schema: ref('Account') }, errors: [] }) },
      '/api/v1/account/bandwidth': { get: op({ summary: 'Bandwidth balance', ok: { schema: ref('Bandwidth') }, errors: [500] as number[] }) },
      '/api/v1/account/activity': { get: op({ summary: 'Mutating API calls made with your keys (30 days)', params: [q('key_id', 'Filter to one key'), ...cursorQ(200)], ok: { schema: cursorList('activity', 'Activity') }, errors: [400] }) },
      '/api/v1/sub-users': {
        get: op({ summary: 'List sub-users', params: [...pageQ, q('status', 'pending | active | suspended'), q('label', 'Case-insensitive contains'), q('country', '2-letter code'), q('created_after', 'ISO 8601'), q('created_before', 'ISO 8601')], ok: { schema: list('sub_users', { itemRef: 'SubUser' }) }, errors: [400] }),
        post: op({ summary: 'Create a sub-user', scope: 'write', body: createBody, idempotency: 'optional', ok: { status: 201, schema: ref('SubUser') }, errors: [400, 402, 409, 422] }),
      },
      '/api/v1/sub-users/bulk': { post: op({ summary: 'Create up to 10 sub-users', scope: 'write', body: { type: 'object', required: ['items'], properties: { items: { type: 'array', maxItems: 10, items: createBody } } }, idempotency: 'required', ok: { schema: bulkResult }, errors: [400, 409, 422] }) },
      '/api/v1/sub-users/bulk-topup': { post: op({ summary: 'Top up up to 20 sub-users', scope: 'write', body: { type: 'object', required: ['items'], properties: { items: { type: 'array', maxItems: 20, items: { type: 'object', required: ['id', 'gb_amount'], properties: { id: { type: 'string', format: 'uuid' }, gb_amount: { type: 'number' } } } } } }, idempotency: 'required', ok: { schema: bulkResult }, errors: [400, 409, 422] }) },
      '/api/v1/sub-users/{id}': {
        get: op({ summary: 'Get a sub-user', params: [idParam()], ok: { schema: ref('SubUser') } }),
        patch: op({ summary: 'Update label / targeting', scope: 'write', params: [idParam()], body: ref('Object'), ok: { schema: ref('SubUser') } }),
        delete: op({ summary: 'Delete a sub-user (unused bandwidth is released)', scope: 'write', params: [idParam()], ok: { schema: ref('Object') }, errors: [404, 409] }),
      },
      '/api/v1/sub-users/{id}/usage': { get: op({ summary: 'Live usage', params: [idParam()], ok: { schema: ref('Object') } }) },
      '/api/v1/sub-users/{id}/usage/history': { get: op({ summary: 'Usage history (daily, or hourly for short ranges)', params: [idParam(), q('days', '1–90', { type: 'integer' }), q('granularity', 'day (default) | hour — hour supports a shorter range', { type: 'string', enum: ['day', 'hour'] })], ok: { schema: ref('Object') } }) },
      '/api/v1/sub-users/{id}/topup': { post: op({ summary: 'Add bandwidth to a sub-user', scope: 'write', params: [idParam()], body: { type: 'object', required: ['gb_amount'], properties: { gb_amount: { type: 'number' } } }, idempotency: 'optional', ok: { schema: ref('Object') }, errors: [400, 402, 404, 409, 422] }) },
      '/api/v1/sub-users/{id}/release': { post: op({ summary: 'Return unused bandwidth from a sub-user to the account balance', scope: 'write', params: [idParam()], body: { type: 'object', required: ['gb_amount'], properties: { gb_amount: { type: 'number' } } }, idempotency: 'optional', ok: { schema: ref('Object') }, errors: [400, 403, 404, 409, 422, 502] }) },
      '/api/v1/sub-users/{id}/rotate-password': { post: op({ summary: 'Replace the sub-user proxy password (503 until enabled platform-side)', scope: 'write', params: [idParam()], ok: { schema: ref('Object') }, errors: [404, 409, 502, 503] }) },
      '/api/v1/sub-users/{id}/auto-topup': { patch: op({ summary: 'Configure auto top-up', scope: 'write', params: [idParam()], body: { type: 'object', required: ['enabled'], properties: { enabled: { type: 'boolean' }, threshold_gb: { type: 'number' }, amount_gb: { type: 'number', description: 'Must exceed threshold_gb' } } }, ok: { schema: ref('Object') } }) },
      '/api/v1/sub-users/{id}/sessions': {
        get: op({ summary: 'List sticky sessions', params: [idParam()], ok: { schema: ref('Object') } }),
        post: op({ summary: 'Create a sticky session', scope: 'write', params: [idParam()], body: ref('Object'), ok: { status: 201, schema: ref('Object') } }),
      },
      '/api/v1/sub-users/{id}/sessions/{sessionId}': {
        patch: op({ summary: 'Update or terminate a session (terminate can only be true)', scope: 'write', params: [idParam(), idParam('sessionId')], body: ref('Object'), ok: { schema: ref('Object') } }),
        delete: op({ summary: 'Delete a session', scope: 'write', params: [idParam(), idParam('sessionId')], ok: { schema: ref('Object') } }),
      },
      '/api/v1/sub-users/{id}/whitelist': {
        get: op({ summary: 'List whitelisted IPs', params: [idParam()], ok: { schema: { type: 'object', properties: { ips: { type: 'array', items: ref('WhitelistEntry') } } } } }),
        post: op({ summary: 'Add a whitelisted IP', scope: 'write', params: [idParam()], body: { type: 'object', required: ['ip', 'description'], properties: { ip: { type: 'string' }, description: { type: 'string' } } }, ok: { status: 201, schema: ref('Object') }, errors: [400, 404, 409] }),
        delete: op({ summary: 'Remove a whitelisted IP', scope: 'write', params: [idParam(), q('ip', 'IP to remove')], ok: { schema: ref('Object') } }),
      },
      '/api/v1/sub-users/{id}/whitelist/bulk': {
        post: op({ summary: 'Bulk add whitelisted IPs (max 150)', scope: 'write', params: [idParam()], body: { type: 'object', required: ['items'], properties: { items: { type: 'array', items: { type: 'object', properties: { ip: { type: 'string' }, description: { type: 'string' } } } } } }, ok: { status: 201, schema: ref('Object') } }),
        delete: op({ summary: 'Bulk remove whitelisted IPs (max 150)', scope: 'write', params: [idParam()], body: { type: 'object', required: ['ips'], properties: { ips: { type: 'array', items: { type: 'string' } } } }, ok: { schema: ref('Object') } }),
      },
      '/api/v1/orders': { get: op({ summary: 'Purchase history', params: [...pageQ, q('status', 'pending | paid | failed | refunded | cancelled'), q('created_after', 'ISO 8601'), q('created_before', 'ISO 8601')], ok: { schema: list('orders') }, errors: [400] }) },
      '/api/v1/orders/{id}': { get: op({ summary: 'One order', params: [idParam()], ok: { schema: ref('Order') } }) },
      '/api/v1/reseller/allocations': {
        get: op({ summary: 'Allocation history (resellers)', params: cursorQ(200), ok: { schema: cursorList('transfers', 'Transfer') }, errors: [400] }),
        post: op({ summary: 'Allocate bandwidth to a client (resellers)', scope: 'allocate', body: { type: 'object', required: ['recipient_email', 'gb_allocated'], properties: { recipient_email: { type: 'string', format: 'email' }, gb_allocated: { type: 'number', minimum: 0.1 }, note: { type: 'string', maxLength: 200 } } }, idempotency: 'required', ok: { status: 201, schema: ref('Object') }, errors: [400, 402, 404, 409, 422] }),
      },
      '/api/v1/reseller/allocations/{id}/reclaim': { post: op({ summary: 'Reclaim the unused part of an allocation (resellers)', scope: 'allocate', params: [idParam('id', 'Transfer id')], body: { type: 'object', properties: { gb: { type: 'number' } } }, idempotency: 'required', ok: { schema: ref('Object') }, errors: [400, 404, 409, 422] }) },
      '/api/v1/locations': { get: op({ summary: 'Countries you can target', ok: { schema: { type: 'object', properties: { countries: { type: 'array', items: ref('Country') } } } }, errors: [] }) },
      '/api/v1/locations/{country}': { get: op({ summary: 'States and cities of one country (cities=false drops the city lists)', params: [idParam('country', '2-letter country code from GET /locations'), q('cities', 'false to omit cities', { type: 'string', enum: ['false'] })], ok: { schema: { type: 'object', properties: { code: { type: 'string' }, name: { type: 'string' }, states: { type: 'array', items: ref('State') } } } } }) },
      '/api/v1/locations/{country}/asns': { get: op({ summary: 'ISPs (ASNs) available in a country', params: [idParam('country', '2-letter country code from GET /locations')], ok: { schema: { type: 'object', properties: { country: { type: 'string' }, asns: { type: 'array', items: ref('Asn') } } } } }) },
      '/api/v1/sub-users/{id}/pause': { post: op({ summary: 'Pause a sub-user you own (keeps its allocation; idempotent)', scope: 'write', params: [idParam()], ok: { schema: { type: 'object', properties: { id: { type: 'string' }, status: { type: 'string' }, changed: { type: 'boolean' } } } }, errors: [404, 409, 502] }) },
      '/api/v1/sub-users/{id}/resume': { post: op({ summary: 'Resume a sub-user you paused (idempotent; 403 if GlobProxy suspended it)', scope: 'write', params: [idParam()], ok: { schema: { type: 'object', properties: { id: { type: 'string' }, status: { type: 'string' }, changed: { type: 'boolean' } } } }, errors: [403, 404, 409, 502] }) },
      '/api/v1/sub-users/bulk-action': { post: op({ summary: 'Delete, pause or resume up to 20 sub-users (safe to repeat)', scope: 'write', body: { type: 'object', required: ['action', 'ids'], properties: { action: { type: 'string', enum: ['delete', 'pause', 'resume'] }, ids: { type: 'array', maxItems: 20, items: { type: 'string', format: 'uuid' } } } }, ok: { schema: ref('BulkResult') }, errors: [400] }) },
      '/api/v1/webhooks': {
        get: op({ summary: 'List webhook endpoints', ok: { schema: { type: 'object', properties: { webhooks: { type: 'array', items: ref('Webhook') } } } } }),
        post: op({ summary: 'Create a webhook endpoint (secret returned once)', scope: 'write', body: { type: 'object', required: ['url', 'event_types'], properties: { url: { type: 'string', format: 'uri' }, event_types: { type: 'array', items: { type: 'string' } }, description: { type: 'string' } } }, ok: { status: 201, schema: ref('Object') } }),
      },
      '/api/v1/webhooks/events': { get: op({ summary: 'Event catalog', ok: { schema: ref('Object') }, errors: [] }) },
      '/api/v1/webhooks/{id}': {
        get: op({ summary: 'Get a webhook endpoint', params: [idParam()], ok: { schema: ref('Webhook') } }),
        patch: op({ summary: 'Update a webhook endpoint', scope: 'write', params: [idParam()], body: ref('Object'), ok: { schema: ref('Webhook') } }),
        delete: op({ summary: 'Delete a webhook endpoint', scope: 'write', params: [idParam()], ok: { schema: ref('Object') } }),
      },
      '/api/v1/webhooks/{id}/test': { post: op({ summary: 'Send a signed test event', scope: 'write', params: [idParam()], ok: { schema: ref('Object') } }) },
      '/api/v1/webhooks/{id}/rotate-secret': { post: op({ summary: 'Rotate the signing secret (optional grace window)', scope: 'write', params: [idParam()], body: { type: 'object', properties: { grace_minutes: { type: 'integer', minimum: 0, maximum: 4320 } } }, ok: { schema: ref('Object') } }) },
      '/api/v1/webhooks/{id}/deliveries': { get: op({ summary: 'Delivery log', params: [idParam(), q('status', 'succeeded | retrying | failed'), ...cursorQ(100)], ok: { schema: cursorList('deliveries', 'Delivery') } }) },
      '/api/v1/webhooks/{id}/deliveries/{deliveryId}': { get: op({ summary: 'One delivery with payload and response snippet', params: [idParam(), idParam('deliveryId')], ok: { schema: ref('Delivery') } }) },
      '/api/v1/webhooks/{id}/deliveries/{deliveryId}/redeliver': { post: op({ summary: 'Re-send a stored event', scope: 'write', params: [idParam(), idParam('deliveryId')], ok: { schema: ref('Object') } }) },
    },
  }
}
