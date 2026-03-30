const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.GHL_API_KEY;
const LOCATION_ID = process.env.GHL_LOCATION_ID;

// Custom Value IDs from GHL
const CV_PITCH    = 'q6ZyybZZwmC7uQS5abP1';
const CV_EXPLAINER = 'TezVlG1RySPuXPPICHCy';
const CV_DEMO     = 'qJM60fohvyFE2DV1otMl';

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
      explainers INT,
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

async function getCustomValue(id) {
  const data = await ghlRequest(`/locations/${LOCATION_ID}/customValues/${id}`);
  const val = (data.customValue || {}).value;
  return parseInt(val) || 0;
}

async function getCounts() {
  const [pitches, explainers, demos] = await Promise.all([
    getCustomValue(CV_PITCH),
    getCustomValue(CV_EXPLAINER),
    getCustomValue(CV_DEMO)
  ]);
  return { pitches, explainers, demos };
}

async function getHistory() {
  if (!pool) return [];
  const res = await pool.query(`
    SELECT captured_at, pitches, explainers, demos
    FROM snapshots
    ORDER BY captured_at DESC
    LIMIT 30
  `);
  return res.rows;
}

async function saveSnapshot(pitches, explainers, demos) {
  if (!pool) return;
  await pool.query(
    'INSERT INTO snapshots (pitches, explainers, demos) VALUES ($1, $2, $3)',
    [pitches, explainers, demos]
  );
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost`);

  if (url.pathname === '/' || url.pathname === '/index.html') {
    const file = fs.readFileSync(path.join(__dirname, 'index.html'));
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(file);
  }

  if (url.pathname === '/api/counts') {
    try {
      const { pitches, explainers, demos } = await getCounts();
      await saveSnapshot(pitches, explainers, demos);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ pitches, explainers, demos, ts: new Date().toISOString() }));
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

  // Debug
  if (url.pathname === '/api/debug') {
    try {
      const counts = await getCounts();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(counts, null, 2));
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
