const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.GHL_API_KEY;
const LOCATION_ID = process.env.GHL_LOCATION_ID;
const TAG_DEMO = process.env.TAG_DEMO || 'demo';

const pool = process.env.DATABASE_URL ? new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
}) : null;

async function setupDb() {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS snapshots (
      id SERIAL PRIMARY KEY,
      captured_at TIMESTAMPTZ DEFAULT NOW(),
      pitches INT,
      responses INT,
      demos INT
    )
  `);
}

function ghlRequest(urlPath) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'services.leadconnectorhq.com',
      path: urlPath,
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Version': '2021-07-28',
        'Content-Type': 'application/json'
      }
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('Parse error: ' + data.slice(0, 300))); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function getCustomValues() {
  const data = await ghlRequest(`/locations/${LOCATION_ID}/customValues`);
  return data.customValues || [];
}

async function getHistory() {
  if (!pool) return [];
  const res = await pool.query(`
    SELECT captured_at, pitches, responses, demos
    FROM snapshots
    ORDER BY captured_at DESC
    LIMIT 30
  `);
  return res.rows;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost`);

  if (url.pathname === '/' || url.pathname === '/index.html') {
    const file = fs.readFileSync(path.join(__dirname, 'index.html'));
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(file);
  }

  // Shows all custom values so we can find the right IDs
  if (url.pathname === '/api/debug') {
    try {
      const customValues = await getCustomValues();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(customValues, null, 2));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  if (url.pathname === '/api/counts') {
    try {
      const customValues = await getCustomValues();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ customValues, ts: new Date().toISOString() }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  if (url.pathname === '/api/history') {
    try {
      const rows = await getHistory();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(rows));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  res.writeHead(404);
  res.end('Not found');
});

setupDb().then(() => {
  server.listen(PORT, () => console.log(`Running on port ${PORT}`));
});
