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

// Fetch all contacts in a workflow using the dedicated workflow contacts endpoint
async function fetchWorkflowCount(workflowId) {
  let total = 0;
  let startAfter = null;
  let startAfterId = null;

  while (true) {
    let urlPath = `/contacts/search/duplicate?locationId=${LOCATION_ID}&limit=100`;

    // Try the workflow-specific endpoint instead
    let path = `/workflows/${workflowId}/contacts?locationId=${LOCATION_ID}&limit=100`;
    if (startAfter) path += `&startAfter=${startAfter}&startAfterId=${startAfterId}`;

    const data = await ghlRequest(path);

    // Handle different response shapes
    const contacts = data.contacts || data.data || [];
    total += contacts.length;

    const meta = data.meta || {};
    if (!meta.nextPageUrl || contacts.length < 100) break;

    startAfter = meta.startAfter;
    startAfterId = meta.startAfterId;
  }

  return total;
}

// Fetch all contacts and filter by tag client-side
async function fetchTagCount(tag) {
  let total = 0;
  let startAfter = null;
  let startAfterId = null;

  while (true) {
    let urlPath = `/contacts/?locationId=${LOCATION_ID}&limit=100`;
    if (startAfter) urlPath += `&startAfter=${startAfter}&startAfterId=${startAfterId}`;

    const data = await ghlRequest(urlPath);
    const contacts = data.contacts || [];

    for (const contact of contacts) {
      const tags = contact.tags || [];
      if (tags.map(t => t.toLowerCase()).includes(tag.toLowerCase())) {
        total++;
      }
    }

    const meta = data.meta || {};
    if (!meta.nextPageUrl || contacts.length < 100) break;

    startAfter = meta.startAfter;
    startAfterId = meta.startAfterId;
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

  if (url.pathname === '/' || url.pathname === '/index.html') {
    const file = fs.readFileSync(path.join(__dirname, 'index.html'));
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(file);
  }

  if (url.pathname === '/api/counts') {
    try {
      const [pitches, responses, demos] = await Promise.all([
        fetchWorkflowCount(WF_PITCH),
        fetchWorkflowCount(WF_RESPONSE),
        fetchTagCount(TAG_DEMO)
      ]);
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

  // Debug endpoint
  if (url.pathname === '/api/debug') {
    try {
      const [wfContacts, allContacts] = await Promise.all([
        ghlRequest(`/workflows/${WF_PITCH}/contacts?locationId=${LOCATION_ID}&limit=5`),
        ghlRequest(`/contacts/?locationId=${LOCATION_ID}&limit=5`)
      ]);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        workflowEndpoint: wfContacts,
        allContactsSample: {
          total: (allContacts.meta || {}).total,
          firstTags: ((allContacts.contacts || [])[0] || {}).tags
        }
      }, null, 2));
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
