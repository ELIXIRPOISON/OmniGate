import request from 'supertest';
import { createApp } from './app.ts';

describe('mock upstream', () => {
  const app = createApp();

  it('lists and creates items', async () => {
    const list = await request(app).get('/items').expect(200);
    expect(list.body.items).toHaveLength(3);
    const created = await request(app).post('/items').send({ name: 'Doohickey' }).expect(201);
    expect(created.body).toMatchObject({ id: 4, name: 'Doohickey' });
    await request(app).post('/items').send({}).expect(400);
  });

  it('returns the requested status code', async () => {
    await request(app).get('/status/503').expect(503);
    await request(app).get('/status/99').expect(400);
  });

  it('sleeps for the requested time', async () => {
    const started = Date.now();
    const res = await request(app).get('/slow?ms=60').expect(200);
    expect(res.body.slept_ms).toBe(60);
    expect(Date.now() - started).toBeGreaterThanOrEqual(50);
  });

  it('echoes method, path, headers and body', async () => {
    const res = await request(app)
      .patch('/echo/a/b?x=1')
      .set('X-Test', 'yes')
      .send({ hello: 'world' })
      .expect(200);
    expect(res.body).toMatchObject({
      method: 'PATCH',
      path: '/echo/a/b?x=1',
      query: { x: '1' },
      body: { hello: 'world' },
    });
    expect(res.body.headers['x-test']).toBe('yes');
  });

  it('404s unknown paths as JSON', async () => {
    const res = await request(app).get('/nope').expect(404);
    expect(res.body).toEqual({ error: 'not found' });
  });
});
