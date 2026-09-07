export interface HealthzResponse {
  status: 'ok';
}

export interface ReadyzResponse {
  status: 'ok' | 'degraded';
  redis: 'ok' | 'error';
  postgres: 'ok' | 'error';
  routes: number;
}
