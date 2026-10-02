/* DES — one-line embed loader.
 * <script src="https://chat.dynamiqes.com/widget/embed.js" data-api="https://chat.dynamiqes.com/api" defer></script>
 * Loads the widget CSS, adds the #dq-chat markup if the page doesn't already have it
 * (the dynamiqes theme ships it in template-parts/chatbot.php), then loads widget.js.
 * Optional attributes: data-api (backend base URL; omit = mock answers), data-idle-survey-ms.
 */
(function () {
  'use strict';
  if (window.__desEmbed) return; window.__desEmbed = true;
  const me = document.currentScript || document.querySelector('script[src*="embed.js"]');
  const base = me.src.replace(/[^/]*(\?.*)?$/, '');
  const ds = me.dataset;
  const v = ds.v ? '?v=' + encodeURIComponent(ds.v) : '';

  window.DES_CFG = { ...(window.DES_CFG || {}), logoUrl: base + 'IQ_Logo.svg', ...(ds.api ? { apiBase: ds.api.replace(/\/$/, '') } : {}), ...(ds.idleSurveyMs ? { idleSurveyMs: +ds.idleSurveyMs } : {}) };

  const css = (href) => { const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = href; document.head.append(l); };
  const MARKUP = `<div class="dq-chat" id="dq-chat">
	<input type="checkbox" id="dqChatToggle" class="dq-chat__toggle" aria-hidden="true" tabindex="-1">
	<section class="dq-chat__panel" role="dialog" aria-label="DES" aria-modal="false">
		<header class="dq-chat__head">
			<span class="dq-chat__avatar"><img src="${base}IQ_Logo.svg" alt="" width="22" height="22"></span>
			<div class="dq-chat__title">
				<span class="dq-chat__eyebrow">DynamIQ</span>
				<strong>DES</strong>
				<span class="dq-chat__status"><i aria-hidden="true"></i>Online · replies in minutes</span>
			</div>
			<label for="dqChatToggle" class="dq-chat__close" role="button" aria-label="Close chat"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg></label>
		</header>
		<div class="dq-chat__body"></div>
		<footer class="dq-chat__composer">
			<input type="text" placeholder="Type your message…" aria-label="Message" autocomplete="off">
			<button type="button" class="dq-chat__send" aria-label="Send"><svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M3 11.5 21 3l-8.5 18-2.5-7.5L3 11.5z"/></svg></button>
			<p class="dq-chat__note"></p>
		</footer>
	</section>
	<label for="dqChatToggle" class="dq-chat__launcher" role="button" aria-label="Open chat">
		<span class="dq-chat__hint" aria-hidden="true">Chat with us</span>
		<svg class="dq-chat__ico-open" width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/><path d="M8.5 11.5h.01M12 11.5h.01M15.5 11.5h.01" stroke-width="2.6"/></svg>
		<svg class="dq-chat__ico-close" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>
		<span class="dq-chat__badge" aria-hidden="true">1</span>
	</label>
</div>`;

  function boot() {
    if (!document.getElementById('dq-chat')) {
      // Not on the dynamiqes theme: bring the site tokens, base widget styles and markup too.
      if (!getComputedStyle(document.documentElement).getPropertyValue('--color-brand').trim()) css(base + 'tokens.css' + v);
      css(base + 'chat-widget.css' + v);
      document.body.insertAdjacentHTML('beforeend', MARKUP);
    }
    css(base + 'widget.css' + v);
    const s = document.createElement('script'); s.src = base + 'widget.js' + v; document.body.append(s);
  }
  // Copying this script tag to another website does nothing: the backend only answers approved websites,
  // so the widget checks first and stays hidden if this site isn't allowed.
  async function start() {
    if (ds.api) {
      try {
        const r = await fetch(ds.api.replace(/\/$/, '') + '/ban', { credentials: 'omit', cache: 'no-store' });
        if (!r.ok) throw new Error('HTTP ' + r.status);
      } catch (e) { console.warn('[DES] chat not enabled for this website'); return; }
    }
    boot();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
