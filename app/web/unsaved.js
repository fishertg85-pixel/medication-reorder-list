/* Unsaved changes: when a page or window with edits is about to be left, ask "Save your changes?"  Yes saves, then leaves.  No leaves without saving.
   A form is watched with UG.watch(container). The first thing a person does inside it (click, key, focus) takes a picture of its values; it is "changed" when the values
   differ from that picture. A save re-draws the form, which starts it over. Call  await UG.leave()  before any move away; it answers true when the move may go ahead.
   Closing the browser tab can only show the browser's own warning (a page cannot draw its own window there). */
(function () {
  'use strict';
  if (window.UG) return;
  var W = [];                                                   // watched forms: {root, base, save}
  var SKIP = '[data-ownpick],[data-ownreason],[data-on],[data-cn],[data-cownpick],[data-cownreason],[data-cld],[data-cln],[data-cly],[data-draftnote],[data-reason],[data-npires],[type=file],[type=button],[type=submit],[type=password]';
  function snap(root) {
    var out = [];
    root.querySelectorAll('input,select,textarea').forEach(function (e) {
      if (e.matches(SKIP) || e.closest('[data-noguard]') || e.classList.contains('tp-t') || e.classList.contains('tp-m')) return;    // the visible time boxes mirror the hidden time input
      out.push(e.type === 'checkbox' || e.type === 'radio' ? (e.checked ? 1 : 0) : e.value);
    });
    root.querySelectorAll('[data-cl],[data-ctcs]').forEach(function (e) { out.push(e.dataset.cl || e.dataset.ctcs || ''); });
    return JSON.stringify(out);
  }
  function shown(w) { var r = w.root; return !!r && !r.hidden && r.isConnected && r.getClientRects().length > 0; }
  function dirty(w) { if (w.ext) { try { return !!w.ext.dirty(); } catch (e) { return false; } } return !!w.base && shown(w) && snap(w.root) !== w.base; }
  function realSave(w) { return w.root.querySelector('.savebar button') || w.root.querySelector('[data-savestore],[data-saveclient],[data-createclient],[data-createstore]'); }

  function watch(root, opt) {
    if (!root || root.__ug) return; root.__ug = true;
    var w = { root: root, base: null, save: (opt && opt.save) || null };
    var first = function () { if (!w.base && !root.hidden) w.base = snap(root); };
    var later = function () { w.base = null; setTimeout(function () { if (!w.base && shown(w)) w.base = snap(root); }, 400); };    // the picture is taken once the page has settled (formats, time boxes)
    ['pointerdown', 'keydown', 'focusin'].forEach(function (t) { root.addEventListener(t, first, true); });
    new MutationObserver(function (ms) {                        // the form was drawn again (after a save, or another page opened)
      for (var i = 0; i < ms.length; i++) for (var j = 0; j < ms[i].addedNodes.length; j++) { var n = ms[i].addedNodes[j]; if (n.nodeType === 1 && (n.matches('.pcard') || n.querySelector('.pcard'))) { later(); return; } }
    }).observe(root, { childList: true });
    if (root.querySelector('.pcard')) later();
    W.push(w);
  }

  var box = null;
  function ask() {
    return new Promise(function (res) {
      if (!box) {
        box = document.createElement('div'); box.className = 'ug-back'; box.hidden = true; box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true'); box.setAttribute('aria-label', 'Unsaved changes');
        box.innerHTML = '<div class="ug-box"><div class="ug-q">Save your changes?</div><div class="ug-btns"><button type="button" class="btn" data-ug="yes">Yes</button><button type="button" class="btn2" data-ug="no">No</button></div></div>';
        document.body.appendChild(box);
      }
      box.hidden = false; var yes = box.querySelector('[data-ug=yes]'); yes.focus();
      var done = function (v) { box.hidden = true; box.removeEventListener('click', onClick); document.removeEventListener('keydown', onKey, true); res(v); };
      var onClick = function (e) { var b = e.target.closest('[data-ug]'); if (b) done(b.dataset.ug === 'yes'); };
      var onKey = function (e) { if (e.key === 'Tab') { var bs = box.querySelectorAll('button'); var i = [].indexOf.call(bs, document.activeElement); bs[(i + (e.shiftKey ? -1 : 1) + bs.length) % bs.length].focus(); e.preventDefault(); } else if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); } };
      box.addEventListener('click', onClick); document.addEventListener('keydown', onKey, true);
    });
  }
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  async function saveOne(w) {
    if (w.ext) { try { await w.ext.save(); } catch (e) { return false; } await sleep(250); return !dirty(w); }
    var b = realSave(w); if (!b) return false;
    b.click(); await sleep(300);
    var t0 = Date.now();
    while ((b.disabled && b.isConnected) && Date.now() - t0 < 15000) await sleep(150);
    await sleep(150);
    return !dirty(w);                                           // still changed means the save was refused (a message is on the page): stay
  }
  var asking = null;
  async function leave() {
    if (asking) return asking;
    var ds = W.filter(dirty); if (!ds.length) return true;
    asking = (async function () {
      try {
        var yes = await ask();
        if (!yes) { ds.forEach(function (w) { if (w.ext) { try { w.ext.discard(); } catch (e) {} } else w.base = null; }); return true; }
        for (var i = 0; i < ds.length; i++) if (!(await saveOne(ds[i]))) return false;
        return true;
      } finally { asking = null; }
    })();
    return asking;
  }
  window.addEventListener('beforeunload', function (e) { if (W.some(dirty)) { e.preventDefault(); e.returnValue = ''; } });
  function external(ext) { W.push({ ext: ext }); }                // a form that lives in another page (the Calendar window): {dirty(), save(), discard()}
  window.UG = { watch: watch, leave: leave, ask: ask, external: external, changed: function () { return W.some(dirty); }, _snap: snap };
})();
