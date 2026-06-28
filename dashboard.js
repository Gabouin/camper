require('dotenv').config();
const express = require('express');
const session = require('express-session');
const { WebClient: SlackClient } = require('@slack/web-api');
const { pool } = require('./db');
const path = require('path');

const app = express();
const PORT = process.env.DASHBOARD_PORT || 3001;
const ADMIN_IDS = (process.env.SLACK_ADMIN_USER_IDS || '').split(',').filter(Boolean);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'camper-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 },
}));
app.use(express.static(path.join(__dirname, 'public')));

const slack = new SlackClient(process.env.SLACK_BOT_TOKEN);

// Slack user cache (5 min TTL)
const userCache = new Map();
async function getSlackUser(userId) {
  const cached = userCache.get(userId);
  if (cached && Date.now() - cached.ts < 5 * 60 * 1000) return cached.data;
  const res = await slack.users.info({ user: userId });
  const data = { id: userId, name: res.user.real_name || res.user.name, avatar: res.user.profile.image_48 };
  userCache.set(userId, { ts: Date.now(), data });
  return data;
}

// ─── Auth middleware ──────────────────────────────────────────────────────────

function requireAuth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: 'Not authenticated' });
  next();
}

async function requireHelper(req, res, next) {
  const userId = req.session.user.id;
  if (ADMIN_IDS.includes(userId)) return next();
  const { rows } = await pool.query('SELECT 1 FROM helpers WHERE slack_user_id = $1', [userId]);
  if (rows.length) return next();
  return res.status(403).json({ error: 'Access denied' });
}

// ─── Auth Slack OAuth ─────────────────────────────────────────────────────────

app.get('/auth/slack', (req, res) => {
  const params = new URLSearchParams({
    client_id: process.env.SLACK_CLIENT_ID,
    scope: 'openid profile email',
    redirect_uri: process.env.SLACK_DASHBOARD_REDIRECT_URI,
    response_type: 'code',
  });
  res.redirect(`https://slack.com/openid/connect/authorize?${params}`);
});

app.get('/auth/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.redirect('/?error=no_code');

  const tokenRes = await fetch('https://slack.com/api/openid.connect.token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.SLACK_CLIENT_ID,
      client_secret: process.env.SLACK_CLIENT_SECRET,
      code,
      redirect_uri: process.env.SLACK_DASHBOARD_REDIRECT_URI,
      grant_type: 'authorization_code',
    }),
  });

  const tokenData = await tokenRes.json();
  if (!tokenData.ok) return res.redirect('/?error=auth_failed');

  const userRes = await fetch('https://slack.com/api/openid.connect.userInfo', {
    headers: { Authorization: `Bearer ${tokenData.access_token}` },
  });
  const userInfo = await userRes.json();

  req.session.user = {
    id: userInfo.sub,
    name: userInfo.name,
    avatar: userInfo.picture,
    email: userInfo.email,
  };

  res.redirect('/');
});

app.get('/auth/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

// ─── API ──────────────────────────────────────────────────────────────────────

app.get('/api/me', requireAuth, async (req, res) => {
  const userId = req.session.user.id;
  const isAdmin = ADMIN_IDS.includes(userId);
  const { rows } = await pool.query('SELECT 1 FROM helpers WHERE slack_user_id = $1', [userId]);
  res.json({ ...req.session.user, isAdmin, isHelper: rows.length > 0 || isAdmin });
});

app.get('/api/users/:id', requireAuth, async (req, res) => {
  try {
    const user = await getSlackUser(req.params.id);
    res.json(user);
  } catch {
    res.status(404).json({ error: 'User not found' });
  }
});

app.get('/api/stats', requireAuth, async (req, res) => {
  const { rows } = await pool.query(`
    SELECT
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE status = 'open') AS open,
      COUNT(*) FILTER (WHERE status = 'closed') AS resolved,
      MIN(created_at) FILTER (WHERE status = 'open') AS oldest_open
    FROM tickets
  `);
  res.json(rows[0]);
});

app.get('/api/activity', requireAuth, async (req, res) => {
  const { rows } = await pool.query(`
    SELECT DATE(created_at) AS day, COUNT(*) AS count
    FROM tickets
    WHERE created_at >= NOW() - INTERVAL '30 days'
    GROUP BY day
    ORDER BY day
  `);
  res.json(rows);
});

app.get('/api/leaderboard', requireAuth, async (req, res) => {
  const { period = 'all' } = req.query;
  let periodClause = '';
  if (period === 'week') periodClause = "AND closed_at >= NOW() - INTERVAL '7 days'";
  else if (period === 'today') periodClause = "AND closed_at >= NOW() - INTERVAL '1 day'";

  const { rows } = await pool.query(`
    SELECT closed_by_slack_id AS user_id, COUNT(*) AS count
    FROM tickets
    WHERE closed_by_slack_id IS NOT NULL AND status = 'closed'
    ${periodClause}
    GROUP BY closed_by_slack_id
    ORDER BY count DESC
    LIMIT 10
  `);

  const enriched = await Promise.all(
    rows.map(async r => ({ ...r, user: await getSlackUser(r.user_id).catch(() => ({ id: r.user_id, name: r.user_id })) }))
  );
  res.json(enriched);
});

app.get('/api/tickets', requireAuth, async (req, res) => {
  const { status, search, limit = 50, offset = 0 } = req.query;
  let where = [];
  const params = [];

  if (status && status !== 'all') {
    params.push(status);
    where.push(`status = $${params.length}`);
  }
  if (search) {
    params.push(`%${search}%`);
    where.push(`description ILIKE $${params.length}`);
  }

  params.push(Number(limit), Number(offset));
  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const { rows } = await pool.query(
    `SELECT * FROM tickets ${whereClause} ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  const { rows: countRows } = await pool.query(
    `SELECT COUNT(*) FROM tickets ${whereClause}`,
    params.slice(0, -2)
  );

  res.json({ tickets: rows, total: parseInt(countRows[0].count) });
});

app.get('/api/tickets/:ts/thread', requireAuth, async (req, res) => {
  try {
    const result = await slack.conversations.replies({
      channel: process.env.SLACK_HELP_CHANNEL,
      ts: req.params.ts,
    });
    res.json(result.messages || []);
  } catch {
    res.status(500).json({ error: 'Could not fetch thread' });
  }
});

app.post('/api/tickets/:ts/reply', requireAuth, requireHelper, async (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'Text required' });

  await slack.chat.postMessage({
    channel: process.env.SLACK_HELP_CHANNEL,
    thread_ts: req.params.ts,
    text,
  });
  res.json({ ok: true });
});

app.post('/api/tickets/:ts/resolve', requireAuth, requireHelper, async (req, res) => {
  const { rows } = await pool.query(
    "UPDATE tickets SET status = 'closed', closed_by_slack_id = $2, closed_at = NOW() WHERE msg_ts = $1 AND status = 'open' RETURNING *",
    [req.params.ts, req.session.user.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'Ticket not found or already resolved' });

  await Promise.allSettled([
    slack.reactions.add({ channel: process.env.SLACK_HELP_CHANNEL, timestamp: req.params.ts, name: 'white_check_mark' }),
    slack.reactions.remove({ channel: process.env.SLACK_HELP_CHANNEL, timestamp: req.params.ts, name: 'thinking_face' }),
  ]);

  res.json({ ok: true });
});

app.post('/api/tickets/:ts/reopen', requireAuth, requireHelper, async (req, res) => {
  const { rows } = await pool.query(
    "UPDATE tickets SET status = 'open', closed_by_slack_id = NULL, closed_at = NULL WHERE msg_ts = $1 AND status = 'closed' RETURNING *",
    [req.params.ts]
  );
  if (!rows.length) return res.status(404).json({ error: 'Ticket not found or already open' });

  await Promise.allSettled([
    slack.reactions.add({ channel: process.env.SLACK_HELP_CHANNEL, timestamp: req.params.ts, name: 'thinking_face' }),
    slack.reactions.remove({ channel: process.env.SLACK_HELP_CHANNEL, timestamp: req.params.ts, name: 'white_check_mark' }),
  ]);

  res.json({ ok: true });
});

// ─── Démarrage ────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`[camper] Dashboard available at http://localhost:${PORT}`);
});
