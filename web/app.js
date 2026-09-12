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

document.querySelectorAll('[data-action="add"]').forEach(btn => btn.addEventListener('click', () => {
  const message = 'Вставь ссылку на поиск Kufar — HUNT сам определит категорию и фильтры.';
  if (tg?.showPopup) tg.showPopup({ title: 'Новый мониторинг', message, buttons: [{ id: 'ok', type: 'ok', text: 'Понятно' }] });
  else window.alert(message);
}));

document.querySelectorAll('.nav-item').forEach(btn => btn.addEventListener('click', () => {
  document.querySelectorAll('.nav-item').forEach(x => x.classList.remove('active'));
  btn.classList.add('active');
}));
