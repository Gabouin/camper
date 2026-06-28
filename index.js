require('dotenv').config();
const { App } = require('@slack/bolt');
const { pool, initDb } = require('./db');

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
});

const HELP_CHANNELS = (process.env.SLACK_HELP_CHANNEL || '').split(',').map(s => s.trim()).filter(Boolean);
const TICKET_CHANNEL = process.env.SLACK_TICKET_CHANNEL;
const ADMIN_IDS = (process.env.SLACK_ADMIN_USER_IDS || '').split(',').filter(Boolean);
const FAQ_URL = process.env.FAQ_URL || '';

// ─── Permissions ──────────────────────────────────────────────────────────────

async function checkIsHelper(userId) {
  if (ADMIN_IDS.includes(userId)) return true;
  const { rows } = await pool.query(
    'SELECT 1 FROM helpers WHERE slack_user_id = $1',
    [userId]
  );
  return rows.length > 0;
}

async function checkIsInTicketChannel(userId, client) {
  let cursor;
  do {
    const res = await client.conversations.members({
      channel: TICKET_CHANNEL,
      limit: 200,
      cursor,
    });
    if (res.members.includes(userId)) return true;
    cursor = res.response_metadata?.next_cursor;
  } while (cursor);
  return false;
}

// ─── Ticket helpers ───────────────────────────────────────────────────────────

function ticketBlocks(ticket) {
  const { description, title, opened_by_slack_id, status, claimed_by_slack_id, ticket_number, permalink } = ticket;
  const displayTitle = title || (description.length > 80 ? description.substring(0, 80) + '...' : description);

  let statusText;
  if (status === 'closed') {
    statusText = '✅ Resolved';
  } else if (claimed_by_slack_id) {
    statusText = `🟡 Claimed by <@${claimed_by_slack_id}>`;
  } else {
    statusText = '🟡 Not claimed';
  }

  const blocks = [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: statusText },
    },
  ];

  if (status === 'open') {
    const elements = [];
    if (!claimed_by_slack_id) {
      elements.push({
        type: 'button',
        text: { type: 'plain_text', text: 'Claim', emoji: true },
        action_id: 'claim_ticket',
        value: 'claim',
      });
    }
    elements.push({
      type: 'button',
      text: { type: 'plain_text', text: 'Mark Resolved', emoji: true },
      style: 'primary',
      action_id: 'resolve_from_ticket_channel',
      value: 'resolve',
    });
    blocks.push({ type: 'actions', block_id: 'ticket_actions', elements });
  } else {
    blocks.push({
      type: 'actions',
      block_id: 'ticket_actions',
      elements: [{
        type: 'button',
        text: { type: 'plain_text', text: '🔄 Reopen', emoji: true },
        action_id: 'reopen_ticket',
        value: 'reopen',
      }],
    });
  }

  blocks.push({
    type: 'section',
    text: { type: 'mrkdwn', text: `*${displayTitle}*\n<@${opened_by_slack_id}>` },
  });

  blocks.push({
    type: 'section',
    text: { type: 'mrkdwn', text: `>${description}` },
  });

  const viewElements = [];
  if (permalink) {
    viewElements.push({
      type: 'button',
      text: { type: 'plain_text', text: 'View in Slack', emoji: true },
      url: permalink,
      action_id: 'view_slack_link',
    });
  }
  if (viewElements.length) {
    blocks.push({ type: 'actions', block_id: 'view_actions', elements: viewElements });
  }

  if (ticket_number) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `Ticket ${ticket_number}` }],
    });
  }

  return blocks;
}

async function resolveTicket(msgTs, closedById, client) {
  const { rows } = await pool.query(
    'SELECT * FROM tickets WHERE msg_ts = $1',
    [msgTs]
  );
  if (!rows.length || rows[0].status === 'closed') return;
  const ticket = rows[0];

  await pool.query(
    `UPDATE tickets
     SET status = 'closed', closed_by_slack_id = $2, closed_at = NOW()
     WHERE msg_ts = $1`,
    [msgTs, closedById]
  );

  const channel = ticket.channel_id || HELP_CHANNELS[0];
  await Promise.allSettled([
    client.reactions.add({ channel, timestamp: msgTs, name: 'white_check_mark' }),
    client.reactions.remove({ channel, timestamp: msgTs, name: 'thinking_face' }).catch(() => {}),
    client.chat.update({
      channel: TICKET_CHANNEL,
      ts: ticket.ticket_msg_ts,
      blocks: ticketBlocks({ ...ticket, status: 'closed' }),
      text: 'Ticket resolved',
    }),
    client.chat.postMessage({
      channel,
      thread_ts: msgTs,
      text: '✅ This ticket has been marked as resolved.',
      blocks: [
        {
          type: 'section',
          text: { type: 'mrkdwn', text: `✅ This ticket has been marked as resolved by <@${closedById}>.` },
        },
        {
          type: 'actions',
          block_id: 'resolve_notice_actions',
          elements: [
            {
              type: 'button',
              text: { type: 'plain_text', text: '🔄 Reopen', emoji: true },
              action_id: 'reopen_ticket_from_thread',
              value: msgTs,
            },
          ],
        },
      ],
    }),
  ]);
}

async function reopenTicket(msgTs, reopenedById, client) {
  const { rows } = await pool.query(
    'SELECT * FROM tickets WHERE msg_ts = $1',
    [msgTs]
  );
  if (!rows.length || rows[0].status === 'open') return;
  const ticket = rows[0];

  await pool.query(
    `UPDATE tickets
     SET status = 'open', closed_by_slack_id = NULL, closed_at = NULL
     WHERE msg_ts = $1`,
    [msgTs]
  );

  const channel = ticket.channel_id || HELP_CHANNELS[0];
  await Promise.allSettled([
    client.reactions.add({ channel, timestamp: msgTs, name: 'thinking_face' }),
    client.reactions.remove({ channel, timestamp: msgTs, name: 'white_check_mark' }).catch(() => {}),
    client.chat.update({
      channel: TICKET_CHANNEL,
      ts: ticket.ticket_msg_ts,
      blocks: ticketBlocks({ ...ticket, status: 'open', closed_by_slack_id: null }),
      text: 'Ticket reopened',
    }),
  ]);
}

// ─── Ticket creation ──────────────────────────────────────────────────────────

const pendingTickets = new Map(); // msg_ts → { event, timeoutId }

async function createTicket(event, title, client) {
  const description = event.text || '(no text)';

  const [permalinkRes, ticketNumRes] = await Promise.all([
    client.chat.getPermalink({ channel: event.channel, message_ts: event.ts }).catch(() => null),
    pool.query(`SELECT COALESCE(MAX(ticket_number), 0) + 1 AS next FROM tickets`),
  ]);

  const permalink = permalinkRes?.permalink || null;
  const ticketNumber = ticketNumRes.rows[0].next;

  const newTicket = {
    msg_ts: event.ts,
    description,
    title: title || null,
    opened_by_slack_id: event.user,
    status: 'open',
    claimed_by_slack_id: null,
    ticket_number: ticketNumber,
    permalink,
  };

  const ticketMsg = await client.chat.postMessage({
    channel: TICKET_CHANNEL,
    blocks: ticketBlocks(newTicket),
    text: `New ticket from <@${event.user}>`,
  });

  await client.chat.postMessage({
    channel: event.channel,
    thread_ts: event.ts,
    blocks: [{
      type: 'actions',
      block_id: 'thread_actions',
      elements: [{
        type: 'button',
        text: { type: 'plain_text', text: '✅ Mark as resolved', emoji: true },
        style: 'primary',
        action_id: 'mark_resolved',
        value: event.ts,
      }],
    }],
    text: 'Mark as resolved',
  });

  await pool.query(
    `INSERT INTO tickets (msg_ts, ticket_msg_ts, channel_id, title, description, status, opened_by_slack_id, last_msg_at, ticket_number, permalink)
     VALUES ($1, $2, $3, $4, $5, 'open', $6, NOW(), $7, $8)
     ON CONFLICT (msg_ts) DO NOTHING`,
    [event.ts, ticketMsg.ts, event.channel, title || null, description, event.user, ticketNumber, permalink]
  );
}

app.event('message', async ({ event, client }) => {

  if (!HELP_CHANNELS.includes(event.channel)) return;
  try {
  if (event.subtype && !['file_share', 'me_message', 'thread_broadcast'].includes(event.subtype)) return;
  if (event.bot_id) return;

  // Message in an existing thread → update last_msg_at + handle macros
  if (event.thread_ts && event.thread_ts !== event.ts) {
    await pool.query(
      'UPDATE tickets SET last_msg_at = NOW() WHERE msg_ts = $1',
      [event.thread_ts]
    );

    const text = (event.text || '').trim().toLowerCase();
    const isHelper = await checkIsHelper(event.user);

    if (isHelper && text.startsWith('?')) {
      if (text === '?resolve' || text === '?close') {
        await resolveTicket(event.thread_ts, event.user, client);
        await client.chat.postMessage({
          channel: event.channel,
          thread_ts: event.thread_ts,
          text: '✅ Ticket marked as resolved.',
        });
      } else if (text === '?faq' && FAQ_URL) {
        await client.chat.postMessage({
          channel: event.channel,
          thread_ts: event.thread_ts,
          text: `Here's the FAQ that might help you: ${FAQ_URL}`,
        });
        await resolveTicket(event.thread_ts, event.user, client);
      } else if (text === '?reopen') {
        await reopenTicket(event.thread_ts, event.user, client);
        await client.chat.postMessage({
          channel: event.channel,
          thread_ts: event.thread_ts,
          text: '🔄 Ticket reopened.',
        });
      }
    }
    return;
  }

  // New message in the channel → ask for title, create ticket after
  await client.reactions.add({ channel: event.channel, timestamp: event.ts, name: 'thinking_face' });

  await client.chat.postMessage({
    channel: event.channel,
    thread_ts: event.ts,
    text: "Someone will be here to help you soon!",
  });

  await client.chat.postEphemeral({
    channel: event.channel,
    user: event.user,
    text: '📝 Please set a title for your question.',
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: '📝 Please give your question a short title so helpers can understand it at a glance.' },
      },
      {
        type: 'actions',
        elements: [{
          type: 'button',
          text: { type: 'plain_text', text: 'Set title', emoji: true },
          style: 'primary',
          action_id: 'open_title_modal',
          value: JSON.stringify({ msg_ts: event.ts, channel: event.channel }),
        }],
      },
    ],
  });

  // Auto-create ticket after 3 min if no title set
  const timeoutId = setTimeout(async () => {
    if (pendingTickets.has(event.ts)) {
      pendingTickets.delete(event.ts);
      await createTicket(event, null, client).catch(console.error);
    }
  }, 3 * 60 * 1000);

  pendingTickets.set(event.ts, { event, timeoutId });
  } catch (err) {
    console.error('[error] message handler failed:', err?.data || err?.message || err);
  }
});

// ─── Button actions ───────────────────────────────────────────────────────────

app.action('view_slack_link', async ({ ack }) => { await ack(); });

app.action('claim_ticket', async ({ ack, body, client }) => {
  await ack();
  const userId = body.user.id;

  const { rows } = await pool.query(
    'SELECT * FROM tickets WHERE ticket_msg_ts = $1',
    [body.message.ts]
  );
  if (!rows.length) return;
  const ticket = rows[0];
  if (ticket.status !== 'open' || ticket.claimed_by_slack_id) return;

  await pool.query(
    'UPDATE tickets SET claimed_by_slack_id = $1 WHERE msg_ts = $2',
    [userId, ticket.msg_ts]
  );

  await client.chat.update({
    channel: TICKET_CHANNEL,
    ts: body.message.ts,
    blocks: ticketBlocks({ ...ticket, claimed_by_slack_id: userId }),
    text: `Ticket claimed by <@${userId}>`,
  });
});

app.action('mark_resolved', async ({ ack, body, client }) => {
  await ack();
  const userId = body.user.id;
  const msgTs = body.actions[0].value;

  const { rows } = await pool.query('SELECT * FROM tickets WHERE msg_ts = $1', [msgTs]);
  if (!rows.length) return;
  const ticket = rows[0];

  const canResolve =
    ticket.opened_by_slack_id === userId ||
    (await checkIsHelper(userId)) ||
    (await checkIsInTicketChannel(userId, client));

  if (!canResolve) {
    await client.chat.postEphemeral({
      channel: ticket.channel_id || HELP_CHANNELS[0],
      user: userId,
      thread_ts: msgTs,
      text: "You don't have permission to resolve this ticket.",
    });
    return;
  }

  await resolveTicket(msgTs, userId, client);
});

app.action('resolve_from_ticket_channel', async ({ ack, body, client }) => {
  await ack();
  const userId = body.user.id;

  const { rows } = await pool.query(
    'SELECT * FROM tickets WHERE ticket_msg_ts = $1',
    [body.message.ts]
  );
  if (!rows.length) return;
  const ticket = rows[0];

  const canResolve =
    (await checkIsHelper(userId)) ||
    (await checkIsInTicketChannel(userId, client));

  if (!canResolve) {
    await client.chat.postEphemeral({
      channel: TICKET_CHANNEL,
      user: userId,
      text: "You don't have permission to resolve this ticket.",
    });
    return;
  }

  await resolveTicket(ticket.msg_ts, userId, client);
});

app.action('reopen_ticket', async ({ ack, body, client }) => {
  await ack();
  const userId = body.user.id;

  const { rows } = await pool.query(
    'SELECT * FROM tickets WHERE ticket_msg_ts = $1',
    [body.message.ts]
  );
  if (!rows.length) return;
  const ticket = rows[0];

  const canReopen =
    (await checkIsHelper(userId)) ||
    (await checkIsInTicketChannel(userId, client));

  if (!canReopen) {
    await client.chat.postEphemeral({
      channel: TICKET_CHANNEL,
      user: userId,
      text: "You don't have permission to reopen this ticket.",
    });
    return;
  }

  await reopenTicket(ticket.msg_ts, userId, client);
});

app.action('reopen_ticket_from_thread', async ({ ack, body, client }) => {
  await ack();
  const userId = body.user.id;
  const msgTs = body.actions[0].value;

  const { rows } = await pool.query('SELECT * FROM tickets WHERE msg_ts = $1', [msgTs]);
  if (!rows.length) return;
  const ticket = rows[0];

  const canReopen =
    ticket.opened_by_slack_id === userId ||
    (await checkIsHelper(userId)) ||
    (await checkIsInTicketChannel(userId, client));

  if (!canReopen) {
    await client.chat.postEphemeral({
      channel: ticket.channel_id || HELP_CHANNELS[0],
      user: userId,
      thread_ts: msgTs,
      text: "You don't have permission to reopen this ticket.",
    });
    return;
  }

  await reopenTicket(msgTs, userId, client);
});

// ─── Title modal ─────────────────────────────────────────────────────────────

app.action('open_title_modal', async ({ ack, body, client }) => {
  await ack();
  const { msg_ts, channel } = JSON.parse(body.actions[0].value);
  await client.views.open({
    trigger_id: body.trigger_id,
    view: {
      type: 'modal',
      callback_id: 'title_modal',
      private_metadata: JSON.stringify({ msg_ts, channel }),
      title: { type: 'plain_text', text: 'Set question title' },
      submit: { type: 'plain_text', text: 'Submit' },
      close: { type: 'plain_text', text: 'Skip' },
      blocks: [{
        type: 'input',
        block_id: 'title_block',
        element: {
          type: 'plain_text_input',
          action_id: 'title_input',
          placeholder: { type: 'plain_text', text: 'e.g. "How do I reset my password?"' },
          max_length: 100,
        },
        label: { type: 'plain_text', text: 'Title' },
      }],
    },
  });
});

app.view('title_modal', async ({ ack, body, view, client }) => {
  await ack();
  const { msg_ts } = JSON.parse(view.private_metadata);
  const title = view.state.values.title_block.title_input.value;
  const pending = pendingTickets.get(msg_ts);
  if (pending) {
    clearTimeout(pending.timeoutId);
    pendingTickets.delete(msg_ts);
    await createTicket(pending.event, title, client).catch(console.error);
  }
});

// ─── Slash commands ───────────────────────────────────────────────────────────

function parseUserId(text) {
  const mention = text.match(/<@([A-Z0-9]+)(?:\|[^>]+)?>/);
  if (mention) return mention[1];
  const raw = text.trim().match(/^(U[A-Z0-9]+)$/i);
  if (raw) return raw[1].toUpperCase();
  return null;
}

app.command('/camper-addhelper', async ({ ack, command, respond }) => {
  await ack();

  if (!ADMIN_IDS.includes(command.user_id)) {
    await respond({ text: "Only admins can add helpers.", response_type: 'ephemeral' });
    return;
  }

  const targetId = parseUserId(command.text);
  if (!targetId) {
    await respond({ text: 'Usage: `/camper-addhelper @user`', response_type: 'ephemeral' });
    return;
  }

  await pool.query(
    'INSERT INTO helpers (slack_user_id) VALUES ($1) ON CONFLICT DO NOTHING',
    [targetId]
  );
  await respond({ text: `<@${targetId}> is now a helper. ✅`, response_type: 'in_channel' });
});

app.command('/camper-removehelper', async ({ ack, command, respond }) => {
  await ack();

  if (!ADMIN_IDS.includes(command.user_id)) {
    await respond({ text: "Only admins can remove helpers.", response_type: 'ephemeral' });
    return;
  }

  const targetId = parseUserId(command.text);
  if (!targetId) {
    await respond({ text: 'Usage: `/camper-removehelper @user`', response_type: 'ephemeral' });
    return;
  }

  await pool.query('DELETE FROM helpers WHERE slack_user_id = $1', [targetId]);
  await respond({ text: `<@${targetId}> is no longer a helper.`, response_type: 'in_channel' });
});

app.command('/camper-helpers', async ({ ack, respond }) => {
  await ack();
  const { rows } = await pool.query('SELECT slack_user_id FROM helpers ORDER BY added_at');
  if (!rows.length) {
    await respond({ text: 'No helpers registered.', response_type: 'ephemeral' });
    return;
  }
  const list = rows.map(r => `• <@${r.slack_user_id}>`).join('\n');
  await respond({ text: `*Current helpers:*\n${list}`, response_type: 'ephemeral' });
});

app.command('/camper-helpstats', async ({ ack, respond }) => {
  await ack();
  const { rows } = await pool.query(`
    SELECT
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE status = 'open') AS open,
      COUNT(*) FILTER (WHERE status = 'closed') AS resolved
    FROM tickets
  `);
  const { total, open, resolved } = rows[0];
  await respond({
    text: `*Ticket stats:*\n• Total: ${total}\n• Open: ${open}\n• Resolved: ${resolved}`,
    response_type: 'ephemeral',
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────

(async () => {
  await initDb();
  await app.start();
  console.log('[camper] Bot started in Socket Mode ✅');
  console.log('[camper] Listening on channels:', HELP_CHANNELS);
})();
