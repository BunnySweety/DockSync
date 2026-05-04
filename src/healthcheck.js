import http from 'node:http';

const host = process.env.API_HOST || '127.0.0.1';
const port = Number(process.env.API_PORT || 8080);

const request = http.request({
  host,
  port,
  path: '/healthz',
  method: 'GET',
  timeout: 3000,
}, (response) => {
  response.resume();
  process.exit(response.statusCode >= 200 && response.statusCode < 300 ? 0 : 1);
});

request.on('timeout', () => {
  request.destroy(new Error('healthcheck timeout'));
});
request.on('error', () => process.exit(1));
request.end();
