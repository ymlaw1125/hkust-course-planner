/*
 * Optional, cookieless usage analytics (GoatCounter).
 *
 * Disabled until SITE is filled in — with it empty nothing is loaded and no
 * request is ever made, so the site works exactly as before.
 *
 * To turn it on: sign up at goatcounter.com, then put your code here — the
 * "xxx" from https://xxx.goatcounter.com.
 */
(function (global) {
  'use strict';

  const SITE = 'ymlaw1125';

  /* Never count local development, file:// copies, or anyone who has asked not
     to be tracked. */
  function enabled() {
    if (!SITE) return false;
    if (location.protocol === 'file:') return false;
    if (/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname)) return false;
    const dnt = global.navigator.doNotTrack || global.doNotTrack;
    return dnt !== '1' && dnt !== 'yes';
  }

  let loading = false;

  function load() {
    if (!enabled() || loading) return;
    loading = true;
    const s = document.createElement('script');
    s.async = true;
    s.dataset.goatcounter = `https://${SITE}.goatcounter.com/count`;
    s.src = 'https://gc.zgo.at/count.js';
    document.head.appendChild(s);
  }

  /**
   * Record a named action. Silently does nothing when analytics is off or the
   * script was blocked, so call sites never need to check.
   */
  function event(name) {
    if (!enabled()) return;
    const gc = global.goatcounter;
    if (!gc || typeof gc.count !== 'function') return;
    try {
      gc.count({ path: name, title: name, event: true });
    } catch (_) { /* never let a counter break the page */ }
  }

  global.HK = global.HK || {};
  global.HK.Analytics = { load, event, enabled };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', load);
  } else {
    load();
  }
})(window);
