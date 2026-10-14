/**
 * Vercel serverless entry. Every path is rewritten here (vercel.json); the
 * Nest app is built once per warm instance from the compiled dist/.
 */
let ready = null;

module.exports = async (req, res) => {
  ready ??= (async () => {
    const { createApp } = require('../dist/app.factory');
    const { app } = await createApp();
    await app.init();
    return app.getHttpAdapter().getInstance();
  })().catch((err) => {
    ready = null;
    throw err;
  });
  try {
    const handle = await ready;
    return handle(req, res);
  } catch (err) {
    console.error(`API failed to start: ${err.message}`);
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: { code: 'startup_failed', message: 'API failed to start — check the deployment logs and environment variables.' } }));
  }
};
