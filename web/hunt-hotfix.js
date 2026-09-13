(() => {
  'use strict';

  const tg = window.Telegram?.WebApp;
  const HUNT = window.__HUNT__ || {};

  const notify = (message) => {
    try {
      if (tg?.showAlert) tg.showAlert(message);
      else window.alert(message);
    } catch (_) {}
  };

  const confirmTelegram = (message, onConfirm) => {
    if (tg?.showPopup) {
      try {
        tg.showPopup({
          title: 'HUNT',
          message,
          buttons: [
            { id: 'delete', type: 'destructive', text: 'Удалить' },
            { id: 'cancel', type: 'cancel', text: 'Отмена' }
          ]
        }, (buttonId) => {
          if (buttonId === 'delete') onConfirm();
        });
        return;
      } catch (_) {}
    }
    if (window.confirm(message)) onConfirm();
  };

  const deleteMonitor = async (button) => {
    const id = Number(button?.dataset?.delete);
    if (!Number.isInteger(id) || id <= 0) return;
    button.disabled = true;
    try {
      if (typeof window.api === 'function') {
        await window.api(`/api/links/${id}`, { method: 'DELETE' });
      } else {
        throw new Error('HUNT API недоступен. Обнови Mini App.');
      }
      try { window.haptic?.('medium'); } catch (_) {}
      if (typeof window.load === 'function') await window.load(true);
    } catch (error) {
      notify(error?.message || 'Не удалось удалить мониторинг.');
      button.disabled = false;
    }
  };

  const disconnectChannel = async () => {
    try {
      const initData = window.__HUNT_INIT_DATA__ || tg?.initData || '';
      if (!initData) throw new Error('Нет авторизации Telegram. Открой HUNT заново.');
      const response = await fetch('/api/channel', {
        method: 'DELETE',
        cache: 'no-store',
        headers: {
          'Content-Type': 'application/json',
          'X-Telegram-Init-Data': initData
        }
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.message || 'Не удалось отключить канал.');
      try { tg?.HapticFeedback?.notificationOccurred('success'); } catch (_) {}
      document.querySelector('#hunt-channel-status')?.replaceChildren(document.createTextNode('○ Канал не подключён'));
      const status = document.querySelector('#hunt-channel-status');
      if (status) status.innerHTML = '<strong>○ Канал не подключён</strong><small>Объявления пока идут только в личные сообщения.</small>';
    } catch (error) {
      notify(error?.message || 'Не удалось отключить канал.');
    }
  };

  document.addEventListener('click', (event) => {
    const deleteButton = event.target?.closest?.('[data-delete]');
    if (deleteButton) {
      event.preventDefault();
      event.stopImmediatePropagation();
      confirmTelegram('Удалить этот мониторинг? Все будущие уведомления по этой ссылке будут остановлены.', () => deleteMonitor(deleteButton));
      return;
    }

    const disconnectButton = event.target?.closest?.('#hunt-channel-disconnect');
    if (disconnectButton) {
      event.preventDefault();
      event.stopImmediatePropagation();
      confirmTelegram('Отключить публикацию HUNT в этот канал?', disconnectChannel);
    }
  }, true);

  const syncChannelNav = () => {
    const target = document.querySelector('#hunt-channel-section');
    const nav = document.querySelector('[data-scroll="hunt-channel-section"]');
    if (!nav) return;
    nav.disabled = !target;
    nav.style.opacity = target ? '' : '.55';
    if (target) nav.removeAttribute('aria-disabled');
    else nav.setAttribute('aria-disabled', 'true');
  };

  new MutationObserver(syncChannelNav).observe(document.body, { childList: true, subtree: true });
  syncChannelNav();
})();
