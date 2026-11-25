/* Time fields, one standard for the whole suite.
   Every <input type="time"> is shown as a 00:00 box (digits only, the colon is added for you) with an AM/PM dropdown.
   The original input stays in the page, hidden, and always holds the plain 24-hour value (HH:MM) that the code and the
   server read. The formatting is only for the person looking at the screen. */
(function () {
  'use strict';
  if (window.__tpInit) return; window.__tpInit = true;
  var pad = function (n) { return (n < 10 ? '0' : '') + n; };
  var vdesc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');

  function parts24(v) {                       // "HH:MM" (24 h) -> {h12, m, ap}
    var m = /^(\d{1,2}):(\d{2})/.exec(v || ''); if (!m) return null;
    var h = +m[1]; if (h > 24) return null;
    return { h12: (h % 12) || 12, m: +m[2], ap: (h >= 12 && h < 24) ? 'PM' : 'AM' };
  }
  function to24(h12, m, ap) { var h = h12 % 12; if (ap === 'PM') h += 12; return pad(h) + ':' + pad(m); }

  function mask(raw) {                         // digits only, 00:00
    var d = String(raw || '').replace(/\D/g, '').slice(0, 4);
    if (d.length >= 1 && +d[0] > 2) d = '0' + d;           // 9 -> 09
    if (d.length >= 2 && +d.slice(0, 2) > 23) d = d[0] + d.slice(2);   // 3x is not an hour
    return d.length > 2 ? d.slice(0, 2) + ':' + d.slice(2) : d;
  }

  function enhance(src) {
    if (src.__tp || src.type !== 'time') return;
    var w = document.createElement('div'); w.className = 'tp';      // a div: page rules for spans (day labels) must not reach it
    var t = document.createElement('input'); t.type = 'text'; t.className = 'tp-t'; t.inputMode = 'numeric'; t.placeholder = '00:00'; t.maxLength = 5; t.autocomplete = 'off';
    t.setAttribute('aria-label', src.getAttribute('aria-label') || src.title || 'Time');
    var s = document.createElement('select'); s.className = 'tp-m'; s.setAttribute('aria-label', 'AM or PM');
    s.innerHTML = '<option value="AM">AM</option><option value="PM">PM</option>';
    w.appendChild(t); w.appendChild(s);
    src.__tp = w; src.classList.add('tp-src'); src.tabIndex = -1; src.setAttribute('aria-hidden', 'true');
    src.parentNode.insertBefore(w, src.nextSibling);

    var getv = function () { return vdesc.get.call(src); };
    function show() {                          // original -> boxes
      var p = parts24(getv());
      if (!p) { t.value = ''; return; }
      t.value = pad(p.h12) + ':' + pad(p.m); s.value = p.ap;
    }
    function commit(fire) {                    // boxes -> original
      var d = t.value.replace(/\D/g, '');
      var nv = '';
      if (d.length) {
        var h, mi;
        if (d.length <= 2) { h = +d; mi = 0; } else { h = +d.slice(0, 2); mi = +d.slice(2).padEnd(2, '0'); }
        if (mi > 59) mi = 59;
        var ap = s.value;
        if (h > 12) { h -= 12; ap = 'PM'; s.value = 'PM'; }          // 13:00 typed -> 01:00 PM
        else if (h === 0) { h = 12; ap = 'AM'; s.value = 'AM'; }      // 00:30 typed -> 12:30 AM
        nv = to24(h, mi, ap);
        if (fire) t.value = pad(h) + ':' + pad(mi);
      }
      if (getv() !== nv) { vdesc.set.call(src, nv); if (fire) { src.dispatchEvent(new Event('input', { bubbles: true })); src.dispatchEvent(new Event('change', { bubbles: true })); } }
    }
    t.addEventListener('input', function () {
      var m = mask(t.value); if (m !== t.value) t.value = m;
      if (t.value.replace(/\D/g, '').length === 4) commit(true);
    });
    t.addEventListener('blur', function () { commit(true); show(); });
    t.addEventListener('keydown', function (e) { if (e.key === 'Enter') { commit(true); show(); } });
    s.addEventListener('change', function () { commit(true); });
    // code that sets src.value = "13:30" keeps the boxes in step
    Object.defineProperty(src, 'value', { configurable: true, get: function () { return vdesc.get.call(src); }, set: function (v) { vdesc.set.call(src, v); show(); } });
    // disabled follows the original
    function dis() { t.disabled = s.disabled = src.disabled; w.classList.toggle('off', src.disabled); }
    new MutationObserver(dis).observe(src, { attributes: true, attributeFilter: ['disabled'] });
    dis(); show();
  }

  function scan(root) {
    if (!root || root.nodeType !== 1 && root.nodeType !== 9) return;
    if (root.matches && root.matches('input[type=time]')) enhance(root);
    var l = root.querySelectorAll ? root.querySelectorAll('input[type=time]') : []; for (var i = 0; i < l.length; i++) enhance(l[i]);
  }
  function start() {
    scan(document);
    new MutationObserver(function (ms) {
      for (var i = 0; i < ms.length; i++) for (var j = 0; j < ms[i].addedNodes.length; j++) scan(ms[i].addedNodes[j]);
    }).observe(document.documentElement, { childList: true, subtree: true });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
