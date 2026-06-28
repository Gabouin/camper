let currentUser = null;
let ticketsPage = 0;
const TICKETS_PER_PAGE = 20;

// ─── Init ──────────────────────────────────────────────────────────────────────

async function init() {
  try {
    const res = await fetch('/api/me');
    if (!res.ok) throw new Error('not auth');
    currentUser = await res.json();
    showMain();
  } catch {
    showLogin();
  }
}

function showLogin() {
  document.getElementById('login-screen').classList.remove('hidden');
}

function showMain() {
  document.getElementById('main-screen').classList.remove('hidden');
  document.getElementById('user-avatar').src = currentUser.avatar || '';
  document.getElementById('user-name').textContent = currentUser.name || '';
  setupNav();
  navigateTo('overview');
}

// ─── Navigation ───────────────────────────────────────────────────────────────

function setupNav() {
  document.querySelectorAll('[data-page]').forEach(link => {
    link.addEventListener('click', e => {
      e.preventDefault();
      navigateTo(link.dataset.page);
    });
  });
}

function navigateTo(page) {
  document.querySelectorAll('.page').forEach(p => p.classList.add('hidden'));
  document.querySelectorAll('[data-page]').forEach(l => l.classList.remove('active'));
  document.getElementById(`page-${page}`)?.classList.remove('hidden');
  document.querySelector(`[data-page="${page}"]`)?.classList.add('active');

  if (page === 'overview') loadOverview();
  if (page === 'tickets') loadTickets();
  if (page === 'leaderboard') loadLeaderboard('all');
}

// ─── Overview ─────────────────────────────────────────────────────────────────

async function loadOverview() {
  const [stats, activity] = await Promise.all([
    fetch('/api/stats').then(r => r.json()),
    fetch('/api/activity').then(r => r.json()),
  ]);

  document.getElementById('stat-total').textContent = stats.total;
  document.getElementById('stat-open').textContent = stats.open;
  document.getElementById('stat-resolved').textContent = stats.resolved;
  document.getElementById('stat-oldest').textContent = stats.oldest_open
    ? timeAgo(new Date(stats.oldest_open))
    : 'None';

  renderActivityChart(activity);
}

function renderActivityChart(data) {
  const container = document.querySelector('.chart-container');
  if (!data.length) { container.innerHTML = '<p style="color:var(--text-muted);text-align:center;padding-top:60px">No data</p>'; return; }

  const max = Math.max(...data.map(d => d.count));
  const bars = data.map(d => {
    const pct = max > 0 ? (d.count / max) * 100 : 0;
    return `<div class="chart-bar" style="height:${pct}%" title="${d.day}: ${d.count} ticket${d.count > 1 ? 's' : ''}"></div>`;
  }).join('');

  container.innerHTML = `<div class="chart-bars">${bars}</div>`;
}

// ─── Tickets ──────────────────────────────────────────────────────────────────

function loadTickets(page = 0) {
  ticketsPage = page;
  const search = document.getElementById('search-input').value;
  const status = document.getElementById('status-filter').value;
  const params = new URLSearchParams({ limit: TICKETS_PER_PAGE, offset: page * TICKETS_PER_PAGE });
  if (status !== 'all') params.set('status', status);
  if (search) params.set('search', search);

  fetch(`/api/tickets?${params}`)
    .then(r => r.json())
    .then(({ tickets, total }) => {
      renderTickets(tickets);
      renderPagination(total, page);
    });
}

function renderTickets(tickets) {
  const list = document.getElementById('tickets-list');
  if (!tickets.length) {
    list.innerHTML = '<p style="color:var(--text-muted);padding:20px 0">No tickets found.</p>';
    return;
  }

  list.innerHTML = tickets.map(t => `
    <div class="ticket-row" data-ts="${t.msg_ts}">
      <div class="ticket-status ${t.status}"></div>
      <div class="ticket-desc">${escHtml(t.description)}</div>
      <div class="ticket-meta">${timeAgo(new Date(t.created_at))}</div>
    </div>
  `).join('');

  list.querySelectorAll('.ticket-row').forEach(row => {
    row.addEventListener('click', () => openTicketModal(row.dataset.ts));
  });
}

function renderPagination(total, page) {
  const pages = Math.ceil(total / TICKETS_PER_PAGE);
  document.getElementById('page-info').textContent = `Page ${page + 1} / ${Math.max(pages, 1)}`;
  document.getElementById('prev-page').disabled = page === 0;
  document.getElementById('next-page').disabled = page >= pages - 1;
}

document.getElementById('search-input').addEventListener('input', debounce(() => loadTickets(0), 300));
document.getElementById('status-filter').addEventListener('change', () => loadTickets(0));
document.getElementById('prev-page').addEventListener('click', () => loadTickets(ticketsPage - 1));
document.getElementById('next-page').addEventListener('click', () => loadTickets(ticketsPage + 1));

// ─── Ticket modal ─────────────────────────────────────────────────────────────

async function openTicketModal(ts) {
  const modal = document.getElementById('ticket-modal');
  const body = document.getElementById('modal-body');
  const actions = document.getElementById('modal-actions');
  const replyArea = document.getElementById('reply-area');

  modal.classList.remove('hidden');
  body.innerHTML = '<p style="color:var(--text-muted)">Loading...</p>';
  actions.innerHTML = '';
  replyArea.classList.add('hidden');

  const [messages, ticketRes] = await Promise.all([
    fetch(`/api/tickets/${ts}/thread`).then(r => r.json()),
    fetch(`/api/tickets?search=${ts}&limit=1`).then(r => r.json()),
  ]);

  const ticket = ticketRes.tickets?.[0];
  const isHelper = currentUser?.isHelper;

  body.innerHTML = messages.map(msg => {
    if (msg.subtype === 'bot_message' || msg.bot_id) return '';
    return `
      <div class="thread-msg">
        <div class="thread-avatar" style="background:var(--surface2)"></div>
        <div class="thread-msg-body">
          <span class="thread-msg-name">${escHtml(msg.username || msg.user || 'Unknown')}</span>
          <span class="thread-msg-time"> — ${timeAgo(new Date(parseFloat(msg.ts) * 1000))}</span>
          <div class="thread-msg-text">${escHtml(msg.text || '')}</div>
        </div>
      </div>
    `;
  }).join('') || '<p style="color:var(--text-muted)">No messages.</p>';

  if (ticket && isHelper) {
    if (ticket.status === 'open') {
      actions.innerHTML = `
        <button class="btn btn-success" id="modal-resolve">✅ Resolve</button>
        <button class="btn btn-ghost" id="modal-reply-btn">💬 Reply</button>
      `;
      document.getElementById('modal-resolve').addEventListener('click', async () => {
        await fetch(`/api/tickets/${ts}/resolve`, { method: 'POST' });
        closeTicketModal();
        loadTickets(ticketsPage);
      });
    } else {
      actions.innerHTML = `
        <button class="btn btn-ghost" id="modal-reopen">🔄 Reopen</button>
        <button class="btn btn-ghost" id="modal-reply-btn">💬 Reply</button>
      `;
      document.getElementById('modal-reopen').addEventListener('click', async () => {
        await fetch(`/api/tickets/${ts}/reopen`, { method: 'POST' });
        closeTicketModal();
        loadTickets(ticketsPage);
      });
    }

    document.getElementById('modal-reply-btn')?.addEventListener('click', () => {
      replyArea.classList.toggle('hidden');
    });
  }

  document.getElementById('send-reply').onclick = async () => {
    const text = document.getElementById('reply-text').value.trim();
    if (!text) return;
    await fetch(`/api/tickets/${ts}/reply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    document.getElementById('reply-text').value = '';
    replyArea.classList.add('hidden');
  };
}

function closeTicketModal() {
  document.getElementById('ticket-modal').classList.add('hidden');
}

document.querySelector('.modal-backdrop').addEventListener('click', closeTicketModal);
document.querySelector('.modal-close').addEventListener('click', closeTicketModal);

// ─── Leaderboard ──────────────────────────────────────────────────────────────

function loadLeaderboard(period) {
  fetch(`/api/leaderboard?period=${period}`)
    .then(r => r.json())
    .then(rows => {
      const list = document.getElementById('leaderboard-list');
      if (!rows.length) {
        list.innerHTML = '<p style="color:var(--text-muted);padding:20px 0">No data.</p>';
        return;
      }
      const medals = ['gold', 'silver', 'bronze'];
      list.innerHTML = rows.map((r, i) => `
        <div class="leaderboard-row">
          <div class="rank ${medals[i] || ''}">${i + 1}</div>
          <img class="leaderboard-avatar" src="${escHtml(r.user?.avatar || '')}" alt="" />
          <div class="leaderboard-name">${escHtml(r.user?.name || r.user_id)}</div>
          <div class="leaderboard-count">${r.count} resolved</div>
        </div>
      `).join('');
    });
}

document.querySelectorAll('.period-tabs .tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    loadLeaderboard(tab.dataset.period);
  });
});

// ─── Utils ────────────────────────────────────────────────────────────────────

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function timeAgo(date) {
  const diff = (Date.now() - date) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
  return date.toLocaleDateString('en-US');
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

// ─── Start ────────────────────────────────────────────────────────────────────

init();
