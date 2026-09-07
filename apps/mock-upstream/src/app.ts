import express, { type Express } from 'express';

export interface Item {
  id: number;
  name: string;
  [key: string]: unknown;
}

const MAX_SLEEP_MS = 120_000;

/**
 * Endpoints per docs/08 S1-06: GET/POST /items, GET /slow?ms=, GET /status/:code,
 * plus /echo which reflects method, path, query, headers and body for proxy tests.
 * Runs on Node's built-in TypeScript type stripping in dev, so keep the syntax erasable.
 */
export function createApp(): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: false, limit: '2mb' }));
  app.use(express.text({ type: ['text/*'], limit: '2mb' }));

  let nextId = 4;
  const items: Item[] = [
    { id: 1, name: 'Widget', price: 9.99 },
    { id: 2, name: 'Gadget', price: 24.5 },
    { id: 3, name: 'Gizmo', price: 3.25 },
  ];

  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.get('/items', (_req, res) => {
    res.json({ items });
  });

  app.get('/items/:id', (req, res) => {
    const item = items.find((i) => i.id === Number(req.params.id));
    if (!item) {
      res.status(404).json({ error: 'item not found' });
      return;
    }
    res.json(item);
  });

  app.post('/items', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.name !== 'string' || body.name.length === 0) {
      res.status(400).json({ error: 'name is required' });
      return;
    }
    const item: Item = { ...body, id: nextId++, name: body.name };
    items.push(item);
    res.status(201).json(item);
  });

  app.get('/slow', (req, res) => {
    const requested = Number(req.query.ms ?? 1000);
    const ms = Number.isFinite(requested) ? Math.min(Math.max(requested, 0), MAX_SLEEP_MS) : 1000;
    setTimeout(() => {
      if (!res.destroyed) res.json({ slept_ms: ms });
    }, ms);
  });

  app.get('/status/:code', (req, res) => {
    const code = Number(req.params.code);
    if (!Number.isInteger(code) || code < 200 || code > 599) {
      res.status(400).json({ error: 'code must be an integer between 200 and 599' });
      return;
    }
    res.status(code).json({ status: code });
  });

  app.all('/echo{/*path}', (req, res) => {
    res.json({
      method: req.method,
      path: req.originalUrl,
      query: req.query,
      headers: req.headers,
      body: req.body ?? null,
    });
  });

  app.use((_req, res) => {
    res.status(404).json({ error: 'not found' });
  });

  return app;
}
