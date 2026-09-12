const tg = window.Telegram?.WebApp;
if (tg) {
  tg.ready();
  tg.expand();
  tg.setHeaderColor('#07090b');
  tg.setBackgroundColor('#07090b');
}

const listings = [
  { title: 'BMW 320d', meta: '2018 · 167 000 км · Минск', price: '17 900 BYN', discount: '↓ 14%', tag: 'NEW', image: 'https://images.unsplash.com/photo-1555215695-3004980ad54e?auto=format&fit=crop&w=500&q=80' },
  { title: 'iPhone 15 Pro', meta: '256 GB · Минск', price: '2 350 BYN', discount: '↓ 8%', tag: 'TARGET', image: 'https://images.unsplash.com/photo-1592286927505-2fd9b1c5d7fa?auto=format&fit=crop&w=500&q=80' },
  { title: 'MacBook Pro 14', meta: 'M3 · 18 GB · Минск', price: '4 290 BYN', discount: '↓ 6%', tag: 'WATCH', image: 'https://images.unsplash.com/photo-1517336714739-489689fd1ca8?auto=format&fit=crop&w=500&q=80' }
];

const feed = document.querySelector('#feed');
feed.innerHTML = listings.map(x => `
  <article class="listing">
    <img src="${x.image}" alt="${x.title}" loading="lazy" />
    <div class="listing-body">
      <span class="tag ${x.tag === 'TARGET' ? 'target' : ''}">${x.tag}</span>
      <h3>${x.title}</h3><p>${x.meta}</p>
      <span class="price">${x.price}</span><span class="discount">${x.discount}</span>
    </div>
  </article>`).join('');

function showMonitorForm() {
  const existing = document.querySelector('#hunt-monitor-modal');
  if (existing) existing.remove();

  const modal = document.createElement('div');
  modal.id = 'hunt-monitor-modal';
  modal.style.cssText = [
    'position:fixed','inset:0','z-index:9999','display:flex','align-items:flex-end',
    'background:rgba(0,0,0,.72)','backdrop-filter:blur(8px)','padding:16px'
  ].join(';');
  modal.innerHTML = `
    <div style="width:100%;background:#11161a;border:1px solid #2a353b;border-radius:18px;padding:20px;box-shadow:0 20px 70px rgba(0,0,0,.55)">
      <div style="font-size:11px;letter-spacing:.14em;color:#8dff00;font-weight:800;margin-bottom:8px">NEW MONITOR</div>
      <h2 style="margin:0 0 8px;color:#fff;font-size:22px">Куда ставим радар?</h2>
      <p style="margin:0 0 16px;color:#89939b;font-size:13px;line-height:1.45">Вставь ссылку на поиск Kufar с нужными фильтрами. HUNT сохранит параметры и начнёт мониторинг сразу.</p>
      <input id="hunt-monitor-url" type="url" inputmode="url" autocomplete="off" placeholder="https://www.kufar.by/l/..." style="width:100%;box-sizing:border-box;background:#080b0d;color:#fff;border:1px solid #334047;border-radius:12px;padding:14px;font-size:14px;outline:none" />
      <div id="hunt-monitor-error" style="display:none;color:#ff6b6b;font-size:12px;margin-top:8px"></div>
      <div style="display:flex;gap:10px;margin-top:14px">
        <button id="hunt-monitor-cancel" type="button" style="flex:1;border:1px solid #334047;background:#171d21;color:#aeb7bd;border-radius:12px;padding:13px;font-weight:700">Отмена</button>
        <button id="hunt-monitor-submit" type="button" style="flex:2;border:0;background:#8dff00;color:#081000;border-radius:12px;padding:13px;font-weight:900">Запустить радар</button>
      </div>
    </div>`;

  document.body.appendChild(modal);
  const input = modal.querySelector('#hunt-monitor-url');
  const error = modal.querySelector('#hunt-monitor-error');
  const submit = modal.querySelector('#hunt-monitor-submit');

  modal.querySelector('#hunt-monitor-cancel').addEventListener('click', () => modal.remove());
  modal.addEventListener('click', (event) => {
    if (event.target === modal) modal.remove();
  });

  const submitUrl = () => {
    const url = String(input.value || '').trim();
    if (!/^https?:\/\//i.test(url) || !/kufar\.by/i.test(url)) {
      error.textContent = 'Нужна корректная ссылка на поиск Kufar.';
      error.style.display = 'block';
      input.focus();
      return;
    }

    if (!tg?.sendData) {
      error.textContent = 'Открой HUNT из Telegram — только там можно запустить мониторинг.';
      error.style.display = 'block';
      return;
    }

    submit.disabled = true;
    submit.textContent = 'Запускаю…';
    tg.sendData(JSON.stringify({ action: 'add_link', url }));
    setTimeout(() => tg.close(), 250);
  };

  submit.addEventListener('click', submitUrl);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') submitUrl();
    if (event.key === 'Escape') modal.remove();
  });
  setTimeout(() => input.focus(), 50);
}

document.querySelectorAll('[data-action="add"]').forEach(btn => btn.addEventListener('click', showMonitorForm));

document.querySelectorAll('.nav-item').forEach(btn => btn.addEventListener('click', () => {
  document.querySelectorAll('.nav-item').forEach(x => x.classList.remove('active'));
  btn.classList.add('active');
}));
