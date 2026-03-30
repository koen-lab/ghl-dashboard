const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.GHL_API_KEY;
const LOCATION_ID = process.env.GHL_LOCATION_ID;
const WF_PITCH = process.env.WF_PITCH;
const WF_RESPONSE = process.env.WF_RESPONSE;
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

async function fetchGHL(path) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'services.leadconnectorhq.com',
      path,
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
        catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function fetchWorkflowCount(workflowId) {
  let total = 0, skip = 0;
  const limit = 100;
  while (true) {
    const data = await fetchGHL(`/contacts/?locationId=${LOCATION_ID}&workflowId=${workflowId}&limit=${limit}&skip=${skip}`);
    const contacts = data.contacts || [];
    total += contacts.length;
    if (contacts.length < limit) break;
    skip += limit;
  }
  return total;
}

async function fetchTagCount(tag) {
  let total = 0, skip = 0;
  const limit = 100;
  while (true) {
    const data = await fetchGHL(`/contacts/?locationId=${LOCATION_ID}&tags[]=${encodeURIComponent(tag)}&limit=${limit}&skip=${skip}`);
    const contacts = data.contacts || [];
    total += contacts.length;
    if (contacts.length < limit) break;
    skip += limit;
  }
  return total;
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

  // Serve dashboard HTML
  if (url.pathname === '/' || url.pathname === '/index.html') {
    const file = fs.readFileSync(path.join(__dirname, 'index.html'));
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(file);
  }

  // API: get current counts
  if (url.pathname === '/api/counts') {
    try {
      const [pitches, responses, demos] = await Promise.all([
        fetchWorkflowCount(WF_PITCH),
        fetchWorkflowCount(WF_RESPONSE),
        fetchTagCount(TAG_DEMO)
      ]);

      // Save snapshot to DB
      if (pool) {
        await pool.query(
          'INSERT INTO snapshots (pitches, responses, demos) VALUES ($1, $2, $3)',
          [pitches, responses, demos]
        );
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ pitches, responses, demos, ts: new Date().toISOString() }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  // API: get history
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
