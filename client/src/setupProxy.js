const { createProxyMiddleware } = require('http-proxy-middleware');

module.exports = function(app) {
  app.use(
    '/socket.io',
    createProxyMiddleware({
      target: 'http://localhost:3028',
      changeOrigin: true,
      ws: true,
    })
  );

  app.use(
    '/browser-stream',
    createProxyMiddleware({
      target: 'http://localhost:3028',
      changeOrigin: true,
      ws: true,
    })
  );
};