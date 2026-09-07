import { createApp } from './app.ts';

const port = Number(process.env.PORT ?? 3001);

createApp().listen(port, () => {
  console.log(JSON.stringify({ level: 'info', service: 'mock-upstream', msg: `listening on :${port}` }));
});
