const tg = window.Telegram?.WebApp;
const state = { data: null, filter: 'all' };

if (tg) {
  tg.ready(); tg.expand();
  tg.setHeaderColor('#07090b'); tg.setBackgroundColor('#07090b');
}

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const platformLabel = (p) => ({ kufar: 'KUFAR', onliner: 'ONLINER', av: 'AV.BY' }[p] || String(p || '').toUpperCase());
const platformIcon = (p) => ({ kufar: '▣', onliner: '◈', av: '🚗' }[p] || '⌖');
const fmtDate = (value) => { if (!value) return '—'; const d = new Date(value); return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('ru-RU', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' }); };
const price = (value) => value ? esc(value) : 'Цена не указана';

async function api(path, options = {}) {
  if (!tg?.initData) throw new Error('Откройте HUNT внутри Telegram');
  const response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', 'X-Telegram-Init-Data': tg.initData, ...(options.headers || {}) } });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload;
}

function renderStats(stats) {
  document.querySelector('#stat-active').textContent = stats.activeLinks;
  document.querySelector('#stat-new').textContent = stats.adsToday;
  document.querySelector('#stat-drops').textContent = stats.priceDropsToday;
  document.querySelector('#radar-count').textContent = stats.adsToday;
  const username = state.data?.user?.username;
  if (username) document.querySelector('#hero-copy').textContent = `@${esc(username)} — цели под контролем. Новая цель сразу приходит в Telegram.`;
}

function renderFeed() {
  const all = state.data?.ads || [];
  const ads = state.filter === 'all' ? all : all.filter(a => a.link_platform === state.filter);
  const feed = document.querySelector('#feed');
  if (!ads.length) { feed.innerHTML = '<div class="empty">Пока нет объявлений по этому фильтру.</div>'; return; }
  feed.innerHTML = ads.map(a => `<article class="listing" data-url="${esc(a.ad_url)}"><img src="${esc(a.image_url || '')}" alt="" loading="lazy" onerror="this.style.visibility='hidden'"><div class="listing-body"><span class="tag ${a.link_platform === 'onliner' ? 'target' : ''}">${platformLabel(a.link_platform)}</span><h3>${esc(a.title)}</h3><p>${esc([a.location, a.address].filter(Boolean).join(' · ')) || 'Беларусь'} · ${fmtDate(a.published_at || a.created_at)}</p><span class="price">${price(a.price)}</span></div></article>`).join('');
  feed.querySelectorAll('[data-url]').forEach(card => card.addEventListener('click', () => { const url = card.dataset.url; if (url) tg?.openLink ? tg.openLink(url) : window.open(url, '_blank'); }));
}

function renderMonitors() {
  const links = state.data?.links || [];
  const counts = new Map((state.data?.statsByLink || []).map(x => [Number(x.linkId), Number(x.count)]));
  const root = document.querySelector('#monitors');
  if (!links.length) { root.innerHTML = '<div class="empty">Мониторов пока нет. Запусти первый радар.</div>'; return; }
  root.innerHTML = links.map(l => `<div class="monitor"><span class="monitor-icon">${platformIcon(l.platform)}</span><div><strong>${platformLabel(l.platform)}</strong><small>${esc(l.url)}</small></div><span class="count">${counts.get(l.id) || 0}</span><button class="switch ${l.is_active ? 'on' : ''}" data-toggle="${l.id}" aria-label="Переключить"></button><button class="delete-link" data-delete="${l.id}" aria-label="Удалить">×</button></div>`).join('');
  root.querySelectorAll('[data-toggle]').forEach(btn => btn.addEventListener('click', async () => {
    const id = Number(btn.dataset.toggle); const link = links.find(x => x.id === id); if (!link) return;
    btn.disabled = true;
    try { await api(`/api/links/${id}`, { method:'PATCH', body: JSON.stringify({ is_active: !link.is_active }) }); await load(); } catch (e) { showError(e.message); } finally { btn.disabled = false; }
  }));
  root.querySelectorAll('[data-delete]').forEach(btn => btn.addEventListener('click', async () => {
    const id = Number(btn.dataset.delete); if (!confirm('Удалить этот мониторинг?')) return;
    try { await api(`/api/links/${id}`, { method:'DELETE' }); await load(); } catch (e) { showError(e.message); }
  }));
}

function renderDrops() {
  const drops = state.data?.priceDrops || [];
  const root = document.querySelector('#drops');
  if (!drops.length) { root.innerHTML = '<div class="empty">Новых снижений цены пока нет.</div>'; return; }
  root.innerHTML = drops.map(d => `<article class="listing drop" data-url="${esc(d.ad_url)}"><img src="${esc(d.image_url || '')}" alt="" loading="lazy" onerror="this.style.visibility='hidden'"><div class="listing-body"><span class="tag target">↓ ${d.price_change_percent != null ? esc(Number(d.price_change_percent).toFixed(1)) + '%' : 'PRICE DROP'}</span><h3>${esc(d.title)}</h3><p>${esc(platformLabel(d.link_platform))} · ${fmtDate(d.created_at)}</p><span class="price">${price(d.new_price)}</span><span class="discount">было ${price(d.old_price)}</span></div></article>`).join('');
  root.querySelectorAll('[data-url]').forEach(card => card.addEventListener('click', () => { const url = card.dataset.url; if (url) tg?.openLink ? tg.openLink(url) : window.open(url, '_blank'); }));
}

async function load() {
  try {
    const data = await api('/api/bootstrap');
    state.data = data;
    renderStats(data.stats);
    renderFeed(); renderMonitors(); renderDrops();
  } catch (e) {
    document.querySelector('#feed').innerHTML = `<div class="empty error">${esc(e.message)}<br><button class="link-btn" data-action="refresh">Повторить</button></div>`;
    document.querySelector('#monitors').innerHTML = '<div class="empty">Данные доступны только внутри Telegram.</div>';
    document.querySelectorAll('[data-action="refresh"]').forEach(x => x.addEventListener('click', load));
  }
}

function showError(message) {
  if (tg?.showAlert) tg.showAlert(message); else alert(message);
}

function showMonitorForm() {
  document.querySelector('#hunt-monitor-modal')?.remove();
  const modal = document.createElement('div'); modal.id = 'hunt-monitor-modal';
  modal.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;align-items:flex-end;background:rgba(0,0,0,.72);backdrop-filter:blur(8px);padding:16px';
  modal.innerHTML = `<div style="width:100%;background:#11161a;border:1px solid #2a353b;border-radius:18px;padding:20px;box-shadow:0 20px 70px rgba(0,0,0,.55)"><div style="font-size:11px;letter-spacing:.14em;color:#9cff2e;font-weight:800;margin-bottom:8px">NEW MONITOR</div><h2 style="margin:0 0 8px;color:#fff;font-size:22px">Куда ставим радар?</h2><p style="margin:0 0 16px;color:#89939b;font-size:13px;line-height:1.45">Вставь ссылку на поиск Kufar, Onliner или av.by. Проверка и первый парсинг выполняются ботом.</p><input id="hunt-monitor-url" type="url" inputmode="url" autocomplete="off" placeholder="https://www.kufar.by/l/..." style="width:100%;box-sizing:border-box;background:#080b0d;color:#fff;border:1px solid #334047;border-radius:12px;padding:14px;font-size:14px;outline:none"><div id="hunt-monitor-error" style="display:none;color:#ff6b6b;font-size:12px;margin-top:8px"></div><div style="display:flex;gap:10px;margin-top:14px"><button id="hunt-monitor-cancel" type="button" style="flex:1;border:1px solid #334047;background:#171d21;color:#aeb7bd;border-radius:12px;padding:13px;font-weight:700">Отмена</button><button id="hunt-monitor-submit" type="button" style="flex:2;border:0;background:#9cff2e;color:#081000;border-radius:12px;padding:13px;font-weight:900">Запустить радар</button></div></div>`;
  document.body.appendChild(modal);
  const input = modal.querySelector('#hunt-monitor-url'); const error = modal.querySelector('#hunt-monitor-error'); const submit = modal.querySelector('#hunt-monitor-submit');
  modal.querySelector('#hunt-monitor-cancel').onclick = () => modal.remove();
  modal.onclick = (event) => { if (event.target === modal) modal.remove(); };
  const submitUrl = () => {
    const url = String(input.value || '').trim();
    if (!/^https?:\/\//i.test(url) || !/(kufar\.by|onliner\.by|av\.by)/i.test(url)) { error.textContent = 'Нужна ссылка на поиск Kufar, Onliner или av.by.'; error.style.display = 'block'; input.focus(); return; }
    if (!tg?.sendData) { error.textContent = 'Открой HUNT из Telegram.'; error.style.display = 'block'; return; }
    submit.disabled = true; submit.textContent = 'Запускаю…'; tg.sendData(JSON.stringify({ action:'add_link', url })); setTimeout(() => tg.close(), 250);
  };
  submit.onclick = submitUrl; input.onkeydown = (e) => { if (e.key === 'Enter') submitUrl(); if (e.key === 'Escape') modal.remove(); }; setTimeout(() => input.focus(), 50);
}

document.querySelectorAll('[data-action="add"]').forEach(btn => btn.addEventListener('click', showMonitorForm));
document.querySelectorAll('[data-action="refresh"]').forEach(btn => btn.addEventListener('click', load));
document.querySelectorAll('[data-filter]').forEach(btn => btn.addEventListener('click', () => { state.filter = btn.dataset.filter; document.querySelectorAll('[data-filter]').forEach(x => x.classList.toggle('active', x === btn)); renderFeed(); }));
document.querySelectorAll('[data-scroll]').forEach(btn => btn.addEventListener('click', () => { document.querySelectorAll('.nav-item').forEach(x => x.classList.remove('active')); btn.classList.add('active'); document.getElementById(btn.dataset.scroll)?.scrollIntoView({ behavior:'smooth', block:'start' }); }));

load();
setInterval(load, 30000);
