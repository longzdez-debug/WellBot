const WELLBOT_BUILD = '2026.10.04.1';
const tg = window.Telegram?.WebApp;
const state = { data: null, metrics: null, filter: 'all', loading: false, submitting: false, lastLoadedAt: 0 };

function applyTelegramTheme() {
  if (!tg) return;
  const p = tg.themeParams || {};
  const root = document.documentElement;
  if (p.bg_color) root.style.setProperty('--tg-bg', p.bg_color);
  if (p.text_color) root.style.setProperty('--tg-text', p.text_color);
  try {
    tg.ready(); tg.expand();
    tg.setHeaderColor(p.bg_color || '#07090b');
    tg.setBackgroundColor(p.bg_color || '#07090b');
    tg.onEvent?.('themeChanged', applyTelegramTheme);
    tg.enableClosingConfirmation?.();
  } catch {}
}
applyTelegramTheme();

function getTelegramInitData() {
  if (tg?.initData) return tg.initData;
  try { const internal = window.Telegram?.WebView?.initParams?.tgWebAppData; if (internal) return internal; } catch {}
  try {
    for (const source of [String(window.location.hash || ''), String(window.location.search || '')]) {
      const raw = source.replace(/^#|^\?/, '');
      const value = new URLSearchParams(raw).get('tgWebAppData');
      if (value) return value;
    }
  } catch {}
  return '';
}

const esc = (value) => String(value ?? '').replace(/[&<>\"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',"'":'&#39;'}[c]));
const platformLabel = (p) => ({ kufar: 'KUFAR', onliner: 'ONLINER', av: 'AV.BY' }[p] || String(p || '').toUpperCase());
const platformIcon = (p) => ({ kufar: '▣', onliner: '◈', av: '🚗' }[p] || '⌖');
const fmtDate = (value) => { if (!value) return '—'; const d = new Date(value); return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('ru-RU', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' }); };
const price = (value) => value !== null && value !== undefined && value !== '' ? esc(value) : 'Цена не указана';

async function api(path, options = {}) {
  const initData = getTelegramInitData();
  if (!initData) throw new Error('WellBOT нужно открыть кнопкой внутри Telegram. Открой WellBOT заново из бота.');
  const response = await fetch(path, { ...options, cache: 'no-store', headers: { 'Content-Type': 'application/json', 'X-Telegram-Init-Data': initData, ...(options.headers || {}) } });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = payload.message || ({ unauthorized: 'Сессия Telegram недействительна. Закройте WellBOT и откройте заново.', user_not_registered: 'Сначала нажмите /start в боте.', duplicate: 'Эта ссылка уже добавлена.', limit_reached: 'Достигнут лимит в 50 поисков.', unsupported_url: 'Ссылка не поддерживается.' }[payload.error]) || `HTTP ${response.status}`;
    throw new Error(message);
  }
  return payload;
}

function haptic(type = 'light') { try { tg?.HapticFeedback?.impactOccurred(type); } catch {} }
function setLiveStatus(text, active = true) { const pill = document.querySelector('.live-pill'); if (!pill) return; pill.innerHTML = `<i></i> ${esc(text)}`; pill.classList.toggle('stale', !active); }
function updateFreshness() { if (!state.lastLoadedAt) return; const seconds = Math.max(0, Math.round((Date.now() - state.lastLoadedAt) / 1000)); setLiveStatus(seconds < 20 ? 'LIVE' : `SYNC ${seconds}s`, seconds < 90); }

function renderPerformance(metrics) { const scheduler=metrics?.scheduler||{}; const notifications=metrics?.notifications||{}; const set=(id,value)=>{const el=document.querySelector(id);if(el)el.textContent=value;}; set('#metric-p50',`${scheduler.cycleDurationMs?.p50??0}ms`); set('#metric-p95',`${scheduler.cycleDurationMs?.p95??0}ms`); set('#metric-p99',`${scheduler.cycleDurationMs?.p99??0}ms`); set('#metric-overruns',String(scheduler.cycleOverruns??0)); set('#metric-link-failures',String(scheduler.linkFailures??0)); set('#metric-active',String(scheduler.activeLinks??0)); const freshness=Number(scheduler.freshnessLagMs?.oldest||0); set('#metric-freshness',freshness?`${Math.round(freshness/1000)}s`:'—'); set('#metric-ads-minute',String(scheduler.adsPerMinute??0)); set('#metric-sent',String(notifications.sent??0)); set('#metric-duplicates',String(metrics.duplicateNotifications??0)); set('#metric-pending',String(notifications.pending??0)); const age=Number(notifications.oldestAgeMs||0); set('#metric-oldest',age?`${Math.round(age/1000)}s`:'—'); set('#metric-notify-p95',`${notifications.latencyMs?.p95??0}ms`); const health=document.querySelector('#performance-health'); if(health){const degraded=(notifications.pending??0)>100||(notifications.oldestAgeMs??0)>30000||freshness>120000||scheduler.cycleOverruns>5; health.textContent=degraded?'DEGRADED':'HEALTHY'; health.classList.toggle('bad',degraded);}}
function renderStats(stats) {
  document.querySelector('#stat-active').textContent = stats?.activeLinks ?? 0;
  document.querySelector('#stat-new').textContent = stats?.adsToday ?? 0;
  document.querySelector('#stat-drops').textContent = stats?.priceDropsToday ?? 0;
  document.querySelector('#overview-count').textContent = stats?.adsToday ?? 0;
  const inlineActive = document.querySelector('#stat-active-inline');
  if (inlineActive) inlineActive.textContent = stats?.activeLinks ?? 0;
  const username = state.data?.user?.username;
  if (username) document.querySelector('#hero-copy').textContent = `@${esc(username)} — цели под контролем. Новая цель сразу приходит в Telegram.`;
}

function listingMarkup(a, compact = false) {
  const image = esc(a.image_url || '');
  const title = esc(a.title || 'Без названия');
  const location = esc([a.location, a.address].filter(Boolean).join(' · ')) || 'Беларусь';
  const platform = a.link_platform || '';
  const market = a.market_status === 'below_market' ? `<span class="market-badge below">↓ НИЖЕ ${a.market_percent != null ? Math.abs(Number(a.market_percent)).toFixed(1) + '%' : ''}</span>` : a.market_status === 'above_market' ? `<span class="market-badge above">↑ ВЫШЕ ${a.market_percent != null ? Number(a.market_percent).toFixed(1) + '%' : ''}</span>` : a.market_status === 'market' ? `<span class="market-badge fair">≈ РЫНОК</span>` : '';
  return `<article class="listing ${compact ? 'listing-compact' : ''}" data-url="${esc(a.ad_url)}" tabindex="0" role="link" aria-label="${title}"><img src="${image}" alt="" loading="lazy" decoding="async" onerror="this.style.visibility='hidden'"><div class="listing-body"><div class="listing-top"><span class="tag ${platform === 'onliner' ? 'target' : ''}">${platformLabel(platform)}</span><time>${fmtDate(a.published_at || a.created_at)}</time></div><h3>${title}</h3><p>${location}</p><div class="listing-bottom"><span class="price">${price(a.price)}</span><span>${market}</span></div></div></article>`;
}

function bindListingLinks(root) {
  root.querySelectorAll('[data-url]').forEach(card => {
    const open = () => { const url = card.dataset.url; if (!url) return; haptic('light'); tg?.openLink ? tg.openLink(url) : window.open(url, '_blank', 'noopener'); };
    card.addEventListener('click', open);
    card.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
  });
}

function renderHotFind() {
  const root = document.querySelector('#hot-find');
  const ads = state.data?.ads || [];
  if (!root) return;
  const hot = ads[0];
  if (!hot) { root.hidden = true; root.innerHTML = ''; return; }
  root.hidden = false;
  const title = esc(hot.title || 'Новая находка');
  const location = esc([hot.location, hot.address].filter(Boolean).join(' · ')) || 'Беларусь';
  const image = esc(hot.image_url || '');
  root.innerHTML = `<div class="hot-head"><div><span class="hot-kicker">⚡ HOT FIND</span><h2>Свежая цель</h2></div><span class="hot-time">${fmtDate(hot.published_at || hot.created_at)}</span></div><div class="hot-body"><div class="hot-image-wrap"><img src="${image}" alt="" loading="eager" onerror="this.style.visibility='hidden'"><span class="hot-platform">${platformLabel(hot.link_platform)}</span></div><div class="hot-info"><h3>${title}</h3><p>${location}</p><strong>${price(hot.price)}</strong><button class="hot-open" type="button">Открыть объявление <span>↗</span></button></div></div>`;
  const open = () => { if (!hot.ad_url) return; haptic('medium'); tg?.openLink ? tg.openLink(hot.ad_url) : window.open(hot.ad_url, '_blank', 'noopener'); };
  root.querySelector('.hot-open')?.addEventListener('click', open);
  root.querySelector('.hot-image-wrap')?.addEventListener('click', open);
}

function renderFeed() {
  const all = state.data?.ads || [];
  const ads = state.filter === 'all' ? all : all.filter(a => a.link_platform === state.filter);
  const feed = document.querySelector('#feed');
  if (!ads.length) { feed.innerHTML = `<div class="empty"><strong>Лента чиста.</strong><br>Новых объявлений по этому фильтру пока нет.</div>`; return; }
  feed.innerHTML = ads.map(a => listingMarkup(a)).join('');
  bindListingLinks(feed);
}

function catalogLabel(id) {
  const categories = state.catalog?.categories || [];
  for (const category of categories) {
    if (category.id === id) return category.title;
    const child = (category.children || []).find(item => item.id === id);
    if (child) return child.title;
  }
  return id || 'Каталог';
}

function renderMonitors() {
  const links = state.data?.links || [];
  const counts = new Map((state.data?.statsByLink || []).map(x => [Number(x.linkId), Number(x.count)]));
  const root = document.querySelector('#monitors');
  if (!links.length) { root.innerHTML = '<div class="empty"><strong>Первый поиск ещё не создан.</strong><br>Выберите категорию и фильтры — WellBOT начнёт поиск.</div>'; return; }
  root.innerHTML = links.map(l => { const c=l.config||{}; const scope=[c.city,c.region].filter(Boolean).join(' · ')||'Вся Беларусь'; const filters=[c.query,c.minPrice!=null?`от ${c.minPrice}`:'',c.maxPrice!=null?`до ${c.maxPrice}`:'',c.condition==='new'?'Новое':c.condition==='used'?'Б/у':'',c.seller==='company'?'Компания':c.seller==='private'?'Частное лицо':''].filter(Boolean).join(' · '); const categoryTitle=c.subcategoryId?catalogLabel(c.subcategoryId):catalogLabel(c.categoryId); const mode=c.mode==='sniper'?'SNIPER':'NORMAL'; return `<div class="monitor"><span class="monitor-icon">${platformIcon(l.platform)}</span><div><strong>${platformLabel(l.platform)} <span class="monitor-status ${l.is_active ? 'on' : ''}">${l.is_active ? 'LIVE' : 'PAUSED'}</span></strong><small>📂 ${esc(categoryTitle)} · 📍 ${esc(scope)}${filters?` · 🔎 ${esc(filters)}`:''} · ⚡ ${mode}</small></div><span class="count">${counts.get(l.id) || 0}</span><button class="switch ${l.is_active ? 'on' : ''}" data-toggle="${l.id}" aria-label="Переключить" aria-pressed="${!!l.is_active}"></button><button class="delete-link" data-delete="${l.id}" aria-label="Удалить">×</button></div>`; }).join('');
  root.querySelectorAll('[data-toggle]').forEach(btn => btn.addEventListener('click', async () => {
    const id = Number(btn.dataset.toggle); const link = links.find(x => x.id === id); if (!link) return;
    haptic('light'); btn.disabled = true;
    try { await api(`/api/links/${id}`, { method:'PATCH', body: JSON.stringify({ is_active: !link.is_active }) }); await load(true); }
    catch (e) { showError(e.message); } finally { btn.disabled = false; }
  }));
  root.querySelectorAll('[data-delete]').forEach(btn => btn.addEventListener('click', async () => {
    const id = Number(btn.dataset.delete); if (!confirm('Удалить этот поиск?')) return;
    haptic('medium'); btn.disabled = true;
    try { await api(`/api/links/${id}`, { method:'DELETE' }); await load(true); }
    catch (e) { showError(e.message); } finally { btn.disabled = false; }
  }));
}

function renderDrops() {
  const drops = state.data?.priceDrops || [];
  const root = document.querySelector('#drops');
  if (!drops.length) { root.innerHTML = '<div class="empty">Новых снижений цены пока нет.</div>'; return; }
  root.innerHTML = drops.map(d => `<article class="listing drop" data-url="${esc(d.ad_url)}" tabindex="0" role="link"><img src="${esc(d.image_url || '')}" alt="" loading="lazy" decoding="async" onerror="this.style.visibility='hidden'"><div class="listing-body"><div class="listing-top"><span class="tag target">↓ ${d.price_change_percent != null ? esc(Number(d.price_change_percent).toFixed(1)) + '%' : 'PRICE DROP'}</span><time>${fmtDate(d.created_at)}</time></div><h3>${esc(d.title || 'Без названия')}</h3><p>${esc(platformLabel(d.link_platform))}</p><div class="listing-bottom"><span class="price">${price(d.new_price)}</span><span class="discount">было ${price(d.old_price)}</span></div></div></article>`).join('');
  bindListingLinks(root);
}

function renderSkeleton() {
  const skeleton = '<div class="skeleton-list"><div class="skeleton-row"></div><div class="skeleton-row"></div><div class="skeleton-row"></div></div>';
  ['#feed','#monitors'].forEach(selector => { const node = document.querySelector(selector); if (node && !state.data) node.innerHTML = skeleton; });
}

async function load(force = false) {
  if (state.loading) return;
  state.loading = true;
  document.body.classList.add('is-loading');
  if (!state.data) renderSkeleton();
  setLiveStatus('SYNC', true);
  try {
    const [data, catalog, metrics] = await Promise.all([api('/api/bootstrap'), state.catalog ? Promise.resolve(state.catalog) : api('/api/catalog'), api('/api/metrics')]);
    state.catalog = catalog; state.metrics = metrics;
    const hadData = !!state.data;
    const previousAds = new Set((state.data?.ads || []).map(a => String(a.id ?? a.ad_id ?? a.ad_url)));
    state.data = data; state.lastLoadedAt = Date.now();
    renderStats(data.stats); renderPerformance(metrics); renderHotFind(); renderFeed(); renderMonitors(); renderDrops();
    const newCount = (data.ads || []).filter(a => !previousAds.has(String(a.id ?? a.ad_id ?? a.ad_url))).length;
    setLiveStatus('LIVE', true);
    if (hadData && newCount > 0) {
      haptic('success');
      const badge = document.querySelector('#overview-count');
      badge?.classList.add('pulse-value'); setTimeout(() => badge?.classList.remove('pulse-value'), 900);
    }
    console.info('[WellBOT]', WELLBOT_BUILD, 'bootstrap ok', { links: data.links?.length || 0, ads: data.ads?.length || 0, newCount });
  } catch (e) {
    console.error('[WellBOT]', WELLBOT_BUILD, 'bootstrap failed', e);
    setLiveStatus('OFFLINE', false);
    if (!state.data) {
      document.querySelector('#feed').innerHTML = `<div class="empty error"><strong>WellBOT ${WELLBOT_BUILD}</strong><br>${esc(e.message)}<br><button class="link-btn" data-action="refresh">Повторить</button></div>`;
      document.querySelector('#monitors').innerHTML = `<div class="empty error">${esc(e.message)}</div>`;
      document.querySelector('#drops').innerHTML = '<div class="empty">Данные временно недоступны.</div>';
      document.querySelector('#hot-find').hidden = true;
      document.querySelectorAll('[data-action="refresh"]').forEach(x => x.addEventListener('click', () => load(true)));
    } else showError(`Не удалось обновить данные: ${e.message}`);
  } finally {
    state.loading = false;
    document.body.classList.remove('is-loading');
    updateFreshness();
  }
}

function showError(message) { if (tg?.showAlert) tg.showAlert(message); else alert(message); }
function showSuccess(message) { if (tg?.showPopup) tg.showPopup({ title: 'WellBOT', message, buttons: [{ type: 'ok' }] }); else alert(message); }

async function showMonitorForm() {
  if (state.submitting) return;
  document.querySelector('#wellbot-monitor-modal')?.remove();
  state.catalog = state.catalog || null;
  if (!state.catalog) {
    try { state.catalog = await api('/api/catalog'); }
    catch (e) { showError(e.message); return; }
  }
  const categories = state.catalog.categories || [];
  const modal = document.createElement('div'); modal.id='wellbot-monitor-modal'; modal.className='wellbot-modal';
  modal.innerHTML = `<div class="modal-card catalog-modal" role="dialog" aria-modal="true">
    <button class="modal-close" id="wellbot-monitor-x" type="button">×</button>
    <div class="modal-kicker">NEW SEARCH</div>
    <h2>Создать поиск</h2>
    <p>Выберите категорию и фильтры. Ссылки Kufar больше не нужны.</p>
    <label class="modal-label">Категория</label>
    <input id="catalog-category-search" type="search" maxlength="80" placeholder="Найти категорию…">
    <select id="catalog-category"><option value="">Выберите категорию</option>${categories.map(c=>`<option value="${esc(c.id)}">${esc(c.title)}</option>`).join('')}</select>
    <label class="modal-label" id="subcategory-label" hidden>Подкатегория</label>
    <select id="catalog-subcategory" hidden><option value="">Все в категории</option></select>
    <label class="modal-label">Город</label>
    <select id="catalog-city"><option value="">Вся Беларусь</option><option value="minsk">Минск</option><option value="brest">Брест</option><option value="vitebsk">Витебск</option><option value="gomel">Гомель</option><option value="grodno">Гродно</option><option value="mogilev">Могилёв</option></select>
    <div class="catalog-grid">
      <div><label class="modal-label">Цена от</label><input id="catalog-min" type="number" min="0" placeholder="0"></div>
      <div><label class="modal-label">Цена до</label><input id="catalog-max" type="number" min="0" placeholder="Без лимита"></div>
    </div>
    <label class="modal-label">Ключевые слова <span class="muted">необязательно</span></label>
    <input id="catalog-query" type="text" maxlength="120" placeholder="Например: iPhone 15 Pro">
    <label class="modal-label">Состояние</label>
    <select id="catalog-condition"><option value="">Любое</option><option value="new">Новое</option><option value="used">Б/у</option></select>
    <label class="modal-label">Продавец</label>
    <select id="catalog-seller"><option value="">Любой</option><option value="private">Частное лицо</option><option value="company">Компания</option></select>
    <label class="modal-label">Режим</label>
    <select id="catalog-mode"><option value="normal">Обычный — стандартная нагрузка</option><option value="sniper">SNIPER — максимально частая проверка</option></select>
    <div id="wellbot-monitor-error" class="modal-error" role="alert"></div>
    <div class="modal-actions"><button id="wellbot-monitor-cancel" class="modal-secondary" type="button">Отмена</button><button id="wellbot-monitor-submit" class="modal-primary" type="button">Создать поиск <span>→</span></button></div>
  </div>`;
  document.body.appendChild(modal);
  const categorySearch=modal.querySelector('#catalog-category-search'), category=modal.querySelector('#catalog-category'), sub=modal.querySelector('#catalog-subcategory'), subLabel=modal.querySelector('#subcategory-label');
  const city=modal.querySelector('#catalog-city'), min=modal.querySelector('#catalog-min'), max=modal.querySelector('#catalog-max'), query=modal.querySelector('#catalog-query'), condition=modal.querySelector('#catalog-condition'), seller=modal.querySelector('#catalog-seller'), mode=modal.querySelector('#catalog-mode');
  const error=modal.querySelector('#wellbot-monitor-error'), submit=modal.querySelector('#wellbot-monitor-submit');
  const close=()=>{if(!state.submitting)modal.remove();};
  modal.querySelector('#wellbot-monitor-cancel').onclick=close; modal.querySelector('#wellbot-monitor-x').onclick=close; modal.onclick=e=>{if(e.target===modal)close();};
  const renderCategories=(needle='')=>{
    const q=needle.trim().toLocaleLowerCase('ru-RU');
    const matches=categories.filter(c=>!q || c.title.toLocaleLowerCase('ru-RU').includes(q) || (c.children||[]).some(x=>x.title.toLocaleLowerCase('ru-RU').includes(q)));
    category.innerHTML='<option value="">Выберите категорию</option>'+matches.map(c=>'<option value="'+esc(c.id)+'">'+esc(c.title)+'</option>').join('');
    if (category.value) category.dispatchEvent(new Event('change'));
  };
  categorySearch.oninput=()=>renderCategories(categorySearch.value);
  category.onchange=()=>{
    const node=categories.find(c=>c.id===category.value);
    const children=node?.children||[];
    sub.innerHTML='<option value="">Все в категории</option>'+children.map(c=>`<option value="${esc(c.id)}">${esc(c.title)}</option>`).join('');
    sub.hidden=!children.length; subLabel.hidden=!children.length;
  };
  renderCategories();
  const submitMonitor=async()=>{
    if(state.submitting)return;
    error.textContent='';
    if(!category.value){error.textContent='Выберите категорию.';return;}
    if(min.value && max.value && Number(min.value)>Number(max.value)){error.textContent='Минимальная цена не может быть выше максимальной.';return;}
    state.submitting=true; submit.disabled=true; submit.textContent='Запускаю…'; haptic('light');
    const payload={source:'kufar',categoryId:category.value,subcategoryId:sub.value||undefined,city:city.value||undefined,query:query.value.trim()||undefined,minPrice:min.value?Number(min.value):undefined,maxPrice:max.value?Number(max.value):undefined,condition:condition.value||undefined,seller:seller.value||undefined,mode:mode.value||'normal'};
    try { const result=await api('/api/monitors',{method:'POST',body:JSON.stringify(payload)}); modal.remove(); state.submitting=false; await load(true); showSuccess(result.reactivated?'Поиск снова активен.':'Поиск создан. WellBOT уже начал проверку.'); haptic('success'); }
    catch(e){error.textContent=e.message;submit.disabled=false;submit.textContent='Создать поиск →';state.submitting=false;}
  };
  submit.onclick=submitMonitor;
  modal.querySelectorAll('input,select').forEach(x=>x.addEventListener('keydown',e=>{if(e.key==='Enter')submitMonitor();if(e.key==='Escape')close();}));
}

document.querySelectorAll('[data-action="add"]').forEach(btn => btn.addEventListener('click', showMonitorForm));
document.querySelectorAll('[data-action="refresh"]').forEach(btn => btn.addEventListener('click', () => { haptic('light'); load(true); }));
document.querySelectorAll('[data-filter]').forEach(btn => btn.addEventListener('click', () => { state.filter = btn.dataset.filter; document.querySelectorAll('[data-filter]').forEach(x => x.classList.toggle('active', x === btn)); haptic('light'); renderFeed(); }));
document.querySelectorAll('[data-scroll]').forEach(btn => btn.addEventListener('click', () => { document.querySelectorAll('.nav-item').forEach(x => x.classList.remove('active')); btn.classList.add('active'); haptic('light'); document.getElementById(btn.dataset.scroll)?.scrollIntoView({ behavior:'smooth', block:'start' }); }));

let scrollTimer;
window.addEventListener('scroll', () => { clearTimeout(scrollTimer); scrollTimer = setTimeout(() => { const sections = [...document.querySelectorAll('main > section[id]')]; const y = window.scrollY + 120; let active = sections[0]?.id; sections.forEach(section => { if (section.offsetTop <= y) active = section.id; }); document.querySelectorAll('.nav-item').forEach(btn => btn.classList.toggle('active', btn.dataset.scroll === active)); }, 80); }, { passive: true });
document.addEventListener('visibilitychange', () => { if (!document.hidden) load(true); });
window.addEventListener('online', () => load(true));
window.addEventListener('offline', () => setLiveStatus('OFFLINE', false));
setInterval(() => { if (!document.hidden) load(); updateFreshness(); }, 2000);
load();