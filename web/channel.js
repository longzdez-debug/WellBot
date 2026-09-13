(() => {
  const tg = window.Telegram?.WebApp;
  const styles = `
    #hunt-channel-section{margin:0 0 28px}.hunt-channel-card{padding:18px;border:1px solid rgba(255,255,255,.08);border-radius:18px;background:linear-gradient(145deg,rgba(255,255,255,.045),rgba(255,255,255,.018))}.hunt-channel-kicker{font-size:11px;letter-spacing:.14em;font-weight:800;opacity:.55}.hunt-channel-title{margin:5px 0 7px;font:700 22px/1.15 'Space Grotesk',sans-serif}.hunt-channel-copy{margin:0 0 14px;opacity:.68;font-size:13px;line-height:1.45}.hunt-channel-status{padding:12px 13px;border-radius:13px;background:rgba(255,255,255,.045);margin-bottom:12px}.hunt-channel-status strong{display:block}.hunt-channel-status small{display:block;margin-top:4px;opacity:.58;word-break:break-word}.hunt-channel-row{display:flex;gap:8px}.hunt-channel-input{min-width:0;flex:1;padding:12px 13px;border:1px solid rgba(255,255,255,.12);border-radius:12px;background:#0b0e12;color:inherit;outline:none}.hunt-channel-input:focus{border-color:rgba(255,255,255,.3)}.hunt-channel-button{border:0;border-radius:12px;padding:12px 14px;font-weight:800;background:#fff;color:#07090b;cursor:pointer}.hunt-channel-button.secondary{background:rgba(255,255,255,.08);color:inherit}.hunt-channel-button:disabled{opacity:.5}.hunt-channel-error{margin-top:9px;color:#ff8585;font-size:12px;min-height:16px}.hunt-channel-help{margin-top:12px;font-size:12px;line-height:1.5;opacity:.55}
  `;
  const mount = () => {
    if (!document.body || document.querySelector('#hunt-channel-section')) return;
    const style = document.createElement('style'); style.textContent = styles; document.head.appendChild(style);
    const section = document.createElement('section');
    section.id = 'hunt-channel-section';
    section.className = 'section';
    section.innerHTML = `<div class="section-head"><div><span class="label">PUBLISHING</span><h2>Канал</h2></div></div><div class="hunt-channel-card"><div class="hunt-channel-kicker">TELEGRAM CHANNEL</div><h3 class="hunt-channel-title">Публикуй находки автоматически</h3><p class="hunt-channel-copy">Добавь HUNT администратором канала с правом публикации. Новые объявления и снижения цены будут отправляться туда автоматически.</p><div id="hunt-channel-status" class="hunt-channel-status">Проверяю подключение…</div><div class="hunt-channel-row"><input id="hunt-channel-id" class="hunt-channel-input" inputmode="numeric" placeholder="ID канала: -1001234567890" autocomplete="off"><button id="hunt-channel-connect" class="hunt-channel-button">Подключить</button></div><div id="hunt-channel-error" class="hunt-channel-error" role="alert"></div><div class="hunt-channel-help">Как узнать ID: перешли сообщение из канала боту @userinfobot или используй ID канала из Telegram. Канал должен быть доступен HUNT.</div></div>`;
    const monitors = document.querySelector('#monitors-section');
    const drops = document.querySelector('#drops-section');
    (monitors || drops || document.querySelector('main'))?.insertAdjacentElement('afterend', section);
    bind();
  };
  const initData = () => window.__HUNT_INIT_DATA__ || tg?.initData || '';
  const api = async (method, body) => {
    const data = initData();
    if (!data) throw new Error('Нет авторизации Telegram. Открой HUNT заново.');
    const response = await fetch('/api/channel', { method, cache:'no-store', headers:{'Content-Type':'application/json','X-Telegram-Init-Data':data}, ...(body ? {body:JSON.stringify(body)} : {}) });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.message || 'Не удалось выполнить операцию с каналом.');
    return payload;
  };
  const render = (channel) => {
    const status = document.querySelector('#hunt-channel-status'); if (!status) return;
    if (!channel) {
      status.innerHTML = '<strong>○ Канал не подключён</strong><small>Объявления пока идут только в личные сообщения.</small>';
      return;
    }
    const name = channel.channel_username ? '@' + channel.channel_username : (channel.channel_title || 'Канал');
    status.innerHTML = `<strong>● Канал подключён</strong><small>${escapeHtml(name)} · HUNT может публиковать объявления</small><button id="hunt-channel-disconnect" class="hunt-channel-button secondary" style="margin-top:10px">Отключить канал</button>`;
    document.querySelector('#hunt-channel-disconnect')?.addEventListener('click', disconnect);
  };
  const escapeHtml = (v) => String(v ?? '').replace(/[&<>\"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',"'":'&#39;'}[c]));
  const refresh = async () => { try { const result = await api('GET'); render(result.channel); } catch (e) { const el=document.querySelector('#hunt-channel-status'); if(el) el.innerHTML='<strong>Не удалось проверить канал</strong>'; const err=document.querySelector('#hunt-channel-error'); if(err) err.textContent=e.message; } };
  const connect = async () => {
    const input = document.querySelector('#hunt-channel-id'); const button=document.querySelector('#hunt-channel-connect'); const err=document.querySelector('#hunt-channel-error');
    const channelId=String(input?.value||'').trim(); if(!/^-?\d+$/.test(channelId)){if(err)err.textContent='Укажи ID канала вида -1001234567890.';return;}
    if(button) {button.disabled=true;button.textContent='Проверяю…'} if(err)err.textContent='';
    try { const result=await api('POST',{channelId}); render(result.channel); if(input)input.value=''; if(tg?.HapticFeedback) tg.HapticFeedback.notificationOccurred('success'); }
    catch(e){if(err)err.textContent=e.message;if(tg?.showAlert)tg.showAlert(e.message);}
    finally{if(button){button.disabled=false;button.textContent='Подключить'}}
  };
  const disconnect = async () => { try { await api('DELETE'); render(null); if(tg?.HapticFeedback)tg.HapticFeedback.notificationOccurred('success'); } catch(e){if(tg?.showAlert)tg.showAlert(e.message);else alert(e.message);} };
  const bind = () => { document.querySelector('#hunt-channel-connect')?.addEventListener('click',connect); document.querySelector('#hunt-channel-id')?.addEventListener('keydown',e=>{if(e.key==='Enter')connect();}); refresh(); };
  const wait = () => { if (initData()) mount(); else setTimeout(wait,100); };
  wait();
})();
