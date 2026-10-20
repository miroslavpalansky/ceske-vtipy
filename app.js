/* České vtipy – swipe app */
(() => {
  'use strict';

  const CFG = self.VTIPY_CONFIG || {};
  const API = CFG.API_URL || '';
  const SITE = CFG.SITE_URL || location.href.split('#')[0];
  const STORE = { data: 'vtipy2:data', votes: 'vtipy2:votes', seen: 'vtipy2:seen', pending: 'vtipy2:pending', rank: 'vtipy2:rank' };
  const LIST_LIMIT = 50;
  // display order of the category chips; anything unknown goes before Ostatní
  const CATS = ['Pepíček', 'Děti a škola', 'Blondýnky', 'Tchyně', 'Manželství a vztahy', 'Lechtivé', 'U doktora', 'V hospodě',
    'Práce a peníze', 'Policie a soud', 'Politika', 'Národy', 'Zvířata', 'Technika a internet', 'Černý humor', 'Slovní hříčky', 'Jednohubky', 'Ostatní'];

  const $ = (id) => document.getElementById(id);
  const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  const fmt = (n) => n.toLocaleString('cs-CZ');

  function readJSON(k, dflt) { try { const v = JSON.parse(localStorage.getItem(k)); return v ?? dflt; } catch { return dflt; } }
  function writeJSON(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode or full */ } }

  /* ------------------------------------------------------------------ state */
  let jokes = [];                         // [{id, t, up, down, x, cat, tu, td}]  tu/td = votes in the last 30 days
  let byId = new Map();
  let votes = readJSON(STORE.votes, {});  // id -> {v: 1 | -1, t: timestamp}
  let seen = new Set(readJSON(STORE.seen, []));
  let pending = readJSON(STORE.pending, []); // votes not yet confirmed by the server
  let queue = [];                         // deck order, queue[0] is the top card
  let history = [];                       // [{id, prev}] for undo
  const rankPref = readJSON(STORE.rank, {});
  let rankMode = rankPref.mode === 'all' ? 'all' : 'trend';
  let rankCat = rankPref.cat || '';
  let trendDays = 30;
  let busy = false;
  let loadState = 'loading';              // loading | ready | error
  let installEvt = null;

  function saveLocal() { writeJSON(STORE.votes, votes); writeJSON(STORE.seen, [...seen]); writeJSON(STORE.pending, pending); }

  let toastTimer = 0;
  function toast(msg) {
    const t = $('toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2800);
  }

  /* ------------------------------------------------------------------- data */
  function ingest(raw) {
    jokes = raw.jokes.map((j) => ({ id: j[0], t: j[1], up: j[2] || 0, down: j[3] || 0, x: j[4] || 0, cat: j[5] || '', tu: 0, td: 0 }));
    trendDays = raw.days || 30;
    const tmp = new Map(jokes.map((j) => [j.id, j]));
    (raw.trend || []).forEach(([id, u, d]) => { const j = tmp.get(id); if (j) { j.tu = u || 0; j.td = d || 0; } });
    // counts from the server may not include votes still waiting to be sent
    pending.forEach((p) => applyCount(byIdTemp(p.id), p.prev, p.v));
    byId = new Map(jokes.map((j) => [j.id, j]));
    queue = queue.filter((id) => byId.has(id));
  }
  function byIdTemp(id) { return jokes.find((j) => j.id === id); }

  async function load() {
    const cached = readJSON(STORE.data, null);
    if (cached && cached.jokes) { ingest(cached); loadState = 'ready'; afterData(); }
    if (!API) { if (!jokes.length) { loadState = 'error'; renderDeck(); } return; }
    try {
      const r = await fetch(API + '?a=data&t=' + Date.now(), { cache: 'no-store' });
      const fresh = await r.json();
      if (!fresh.ok) throw new Error(fresh.error);
      writeJSON(STORE.data, fresh);
      ingest(fresh); loadState = 'ready'; afterData();
      flushVotes();
    } catch {
      if (!jokes.length) { loadState = 'error'; renderDeck(); }
    }
  }

  function afterData() {
    const m = location.hash.match(/^#v(\d+)$/);
    if (m && byId.has(Number(m[1]))) { const id = Number(m[1]); queue = [id, ...queue.filter((q) => q !== id)]; }
    fillQueue(); renderDeck(); updateProgress();
    if (currentView() === 'top') renderTop();
    if (currentView() === 'mine') renderMine();
  }

  /* ------------------------------------------------------------------- deck */
  // Good jokes (by votes, or by old Twitter likes until votes come in) show up more often,
  // and jokes with few votes get extra exposure so that every joke gets rated.
  function weight(j) {
    const n = j.up + j.down;
    const prior = 0.3 + 0.5 * Math.min(1, Math.log1p(j.x) / Math.log1p(200));
    const mean = (j.up + 4 * prior) / (n + 4);
    return (mean * mean) / Math.sqrt(1 + n / 10);
  }
  function pickNext(exclude) {
    const cands = jokes.filter((j) => !seen.has(j.id) && !exclude.has(j.id));
    if (!cands.length) return null;
    let total = 0; const w = cands.map((j) => (total += weight(j)));
    const r = Math.random() * total;
    let lo = 0, hi = w.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (w[mid] < r) lo = mid + 1; else hi = mid; }
    return cands[lo].id;
  }
  function fillQueue() {
    const ex = new Set(queue);
    while (queue.length < 3) { const id = pickNext(ex); if (id == null) break; queue.push(id); ex.add(id); }
  }

  // Lay a joke's dialogue out one speaker turn per line.
  function formatDialogue(t) {
    if (t.includes('\n')) { // already laid out by hand: just even out the dashes
      return t.replace(/([:.!?…])[ \t]+[-–—][ \t]*(?=["„“«])/g, '$1\n– ').replace(/^[ \t]*[-–—](?:[ \t]+|(?=["„“«]))(?=\S)/gm, '– ');
    }
    const OPEN = '["„“«]';
    const CAP = 'A-ZÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ';
    // Split points: a dash that starts a turn (at the start, or right after . ! ? … : or a closing quote),
    // or a closing quote directly followed by an opening quote.
    const re = new RegExp(`(?:^|(?<=[.!?…:"“”»]))\\s*[-–—]\\s*(?=${OPEN}|[${CAP}])|(?<=["“”»])\\s+(?=${OPEN})`, 'g');
    const parts = t.split(re).map((s) => s.trim()).filter(Boolean);
    if (parts.length < 2) return t;
    // A quotation with its author ("…" – Winston Churchill) is not a dialogue.
    const last = parts[parts.length - 1];
    if (parts.length === 2 && !new RegExp(`^${OPEN}`).test(last) && last.length <= 40 && !/[.!?…:]$/.test(last)) return t;
    // Speaker labels (On: "…" / Ona: "…"): one line each, no dashes.
    const label = new RegExp(`^[^"„“«]{1,30}:\\s*${OPEN}`);
    if (parts.filter((p) => label.test(p)).length >= 2) return parts.join('\n');
    const lines = [];
    const startsWithTurn = /^\s*[-–—]/.test(t) || new RegExp(`^${OPEN}`).test(parts[0]);
    const intro = parts[0].match(new RegExp(`^(.*?[:.!?…])\\s+(?=${OPEN})(.*)$`));
    const intro2 = !intro && parts[0].match(new RegExp(`^(.*?\\S)\\s*[-–—]\\s*(${OPEN}.*)$`));
    if (startsWithTurn) lines.push('– ' + parts[0]);
    else if (intro) lines.push(intro[1], '– ' + intro[2]);
    else if (intro2) lines.push(intro2[1], '– ' + intro2[2]);
    else lines.push(parts[0]);
    for (const p of parts.slice(1)) lines.push('– ' + p);
    // a narrator's remark inside a turn starts a new line: … "Život." Na to cikánka: "Ty si…" -> two turns
    const mid = new RegExp(`(["“”»])\\s+([${CAP}][^"„“”«»\\n]{0,60}?:)\\s*(${OPEN})`, 'g');
    return lines.join('\n').replace(mid, '$1\n$2\n– $3');
  }
  if (typeof module !== 'undefined') module.exports = formatDialogue;

  const display = new Map(); // id -> formatted text
  function shown(j) { let s = display.get(j.id); if (s == null) { s = formatDialogue(j.t); display.set(j.id, s); } return s; }

  // one block per line, so a dialogue turn that wraps stays indented under its dash
  function putText(el, text) {
    if (!text.includes('\n')) { el.textContent = text; return; }
    el.classList.add('lines');
    el.replaceChildren(...text.split('\n').map((line) => {
      const s = document.createElement('span'); s.className = /^[–-] /.test(line) ? 'ln turn' : 'ln'; s.textContent = line || '\u00a0'; return s;
    }));
  }

  function sizeClass(t) { const n = t.length; return n < 90 ? 's1' : n < 170 ? 's2' : n < 320 ? 's3' : 's4'; }

  function makeCard(j, cls) {
    const c = document.createElement('article');
    c.className = 'card ' + cls;
    c.dataset.id = j.id;
    if (cls === 'top') { c.setAttribute('aria-label', 'Vtip. Švihněte doprava, když se vám líbí, doleva, když ne.'); c.tabIndex = 0; }
    else c.setAttribute('aria-hidden', 'true');
    c.innerHTML = '<span class="stamp haha" aria-hidden="true">Haha</span><span class="stamp nuda" aria-hidden="true">Nic moc</span>';
    c.append(metaLine(j, 'card-meta'));
    const t = shown(j);
    const p = document.createElement('p'); p.className = 'text ' + sizeClass(t); putText(p, t);
    c.append(p);
    return c;
  }

  function metaLine(j, cls) {
    const m = document.createElement('div'); m.className = cls;
    const c = document.createElement('span'); c.className = 'cat';
    if (j.cat) { c.append('Kategorie: '); const b = document.createElement('b'); b.textContent = j.cat; c.append(b); }
    const n = document.createElement('span'); n.className = 'num'; n.textContent = 'č.\u00a0' + j.id;
    m.append(c, n);
    return m;
  }

  function messageCard(title, text, button) {
    const c = document.createElement('article'); c.className = 'card top done';
    const h = document.createElement('h3'); h.textContent = title;
    const p = document.createElement('p'); p.textContent = text;
    c.append(h, p);
    if (button) {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'pill'; b.textContent = button[0]; b.onclick = button[1];
      c.append(b);
    }
    return c;
  }

  function renderDeck() {
    const deck = $('deck');
    deck.replaceChildren();
    const has = queue.length > 0;
    ['upBtn', 'downBtn', 'shareBtn'].forEach((id) => { $(id).disabled = !has; });
    $('undoBtn').disabled = history.length === 0;
    if (loadState === 'loading' && !jokes.length) { deck.append(messageCard('Načítám vtipy…', 'Chvilku strpení.')); return; }
    if (loadState === 'error' && !jokes.length) {
      deck.append(API ? messageCard('Vtipy se nenačetly', 'Zkontrolujte připojení a zkuste to znovu.', ['Zkusit znovu', () => { loadState = 'loading'; renderDeck(); load(); }])
        : messageCard('Ještě to není zapojené', 'Web zatím není propojený s databází vtipů (config.js).'));
      return;
    }
    if (!has) {
      deck.append(messageCard('Máte hotovo!', `Prošli jste všech ${fmt(jokes.length)} vtipů. Nejlepší najdete v žebříčku.`,
        ['Začít znovu', () => { seen.clear(); saveLocal(); fillQueue(); renderDeck(); updateProgress(); }]));
      return;
    }
    const cls = ['top', 'under1', 'under2'];
    for (let i = Math.min(queue.length, 3) - 1; i >= 0; i--) deck.append(makeCard(byId.get(queue[i]), cls[i]));
    attachDrag(deck.querySelector('.card.top'));
  }

  function updateProgress() {
    const rated = jokes.reduce((n, j) => n + (votes[j.id] ? 1 : 0), 0);
    $('progress').textContent = jokes.length ? `Ohodnoceno ${fmt(rated)} z ${fmt(jokes.length)}` : '\u00a0';
  }

  /* ------------------------------------------------------------- swiping */
  function setDrag(card, dx, dy) {
    card.style.transform = `translate(${dx}px, ${dy * 0.25}px) rotate(${dx / 16}deg)`;
    card.querySelector('.haha').style.opacity = String(Math.max(0, Math.min(1, dx / 90)));
    card.querySelector('.nuda').style.opacity = String(Math.max(0, Math.min(1, -dx / 90)));
  }

  function attachDrag(card) {
    if (!card) return;
    let sx = 0, sy = 0, dx = 0, dy = 0, t0 = 0, active = false, decided = false;
    card.addEventListener('pointerdown', (e) => {
      if (busy || (e.pointerType === 'mouse' && e.button !== 0)) return;
      active = true; decided = false; sx = e.clientX; sy = e.clientY; dx = dy = 0; t0 = performance.now();
      card.style.transition = 'none';
    });
    card.addEventListener('pointermove', (e) => {
      if (!active) return;
      dx = e.clientX - sx; dy = e.clientY - sy;
      if (!decided) {
        if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
        if (Math.abs(dy) > Math.abs(dx)) { active = false; return; } // a vertical scroll, not a swipe
        decided = true; card.setPointerCapture(e.pointerId); card.classList.add('dragging');
      }
      setDrag(card, dx, dy);
    });
    const end = () => {
      if (!active) return;
      active = false; card.classList.remove('dragging');
      if (!decided) return;
      const v = Math.abs(dx) / Math.max(performance.now() - t0, 1);
      if (Math.abs(dx) > card.offsetWidth * 0.28 || (v > 0.6 && Math.abs(dx) > 40)) fling(dx > 0 ? 1 : -1, dy);
      else { card.style.transition = 'transform .25s cubic-bezier(.2,.8,.3,1.2)'; setDrag(card, 0, 0); }
    };
    card.addEventListener('pointerup', end);
    card.addEventListener('pointercancel', end);
  }

  function fling(dir, dy = 0) {
    if (busy || !queue.length) return;
    const card = $('deck').querySelector('.card.top');
    const id = queue[0];
    if (!card || reduceMotion()) { commit(id, dir); return; }
    busy = true;
    card.style.transition = 'transform .3s ease-in, opacity .3s ease-in';
    card.querySelector(dir > 0 ? '.haha' : '.nuda').style.opacity = '1';
    card.style.transform = `translate(${dir * (innerWidth + card.offsetWidth)}px, ${dy * 0.25 + 40}px) rotate(${dir * 28}deg)`;
    card.style.opacity = '0';
    setTimeout(() => { busy = false; commit(id, dir); }, 280);
  }

  function commit(id, dir) {
    const prev = votes[id] ? votes[id].v : 0;
    history.push({ id, prev }); if (history.length > 50) history.shift();
    setVote(id, dir);
    seen.add(id); saveLocal();
    queue.shift(); fillQueue(); renderDeck(); updateProgress();
    if (/^#v\d+$/.test(location.hash)) history_replace('');
    focusTop();
  }

  function undo() {
    if (busy || !history.length) return;
    const h = history.pop();
    setVote(h.id, h.prev);
    seen.delete(h.id); saveLocal();
    queue = [h.id, ...queue.filter((q) => q !== h.id)];
    renderDeck(); updateProgress(); focusTop();
  }

  function focusTop() { const c = $('deck').querySelector('.card.top'); if (c && document.activeElement && document.activeElement.closest('.deck')) c.focus(); }
  function history_replace(hash) { window.history.replaceState(null, '', location.pathname + location.search + hash); }

  /* ------------------------------------------------------------------ votes */
  function applyCount(j, prev, v) {
    if (!j) return;
    if (prev === 1) { j.up = Math.max(0, j.up - 1); j.tu = Math.max(0, j.tu - 1); }
    if (prev === -1) { j.down = Math.max(0, j.down - 1); j.td = Math.max(0, j.td - 1); }
    if (v === 1) { j.up += 1; j.tu += 1; }
    if (v === -1) { j.down += 1; j.td += 1; }
  }

  function setVote(id, v) {
    const prev = votes[id] ? votes[id].v : 0;
    if (prev === v) return;
    applyCount(byId.get(id), prev, v);
    if (v) votes[id] = { v, t: Date.now() }; else delete votes[id];
    pending.push({ id, v, prev });
    saveLocal();
    flushVotes();
  }

  let flushing = false;
  async function flushVotes() {
    if (flushing || !API || !pending.length) return;
    flushing = true;
    try {
      while (pending.length) {
        const p = pending[0];
        const r = await fetch(API, { method: 'POST', body: JSON.stringify({ a: 'vote', id: p.id, v: p.v, prev: p.prev }) }).then((x) => x.json());
        if (!r.ok && r.error !== 'not found') throw new Error(r.error);
        pending.shift(); saveLocal();
      }
    } catch { /* offline: try again later */ }
    flushing = false;
  }

  /* ------------------------------------------------------------------ share */
  async function share(j) {
    if (!j) return;
    const url = SITE + '#v' + j.id, text = j.t;
    if (navigator.share) {
      try { await navigator.share({ title: 'České vtipy', text, url }); return; }
      catch (e) { if (e && e.name === 'AbortError') return; }
    }
    const enc = encodeURIComponent;
    $('shWa').href = 'https://wa.me/?text=' + enc(text + '\n\n' + url);
    $('shFb').href = 'https://www.facebook.com/sharer/sharer.php?u=' + enc(url);
    $('shX').href = 'https://x.com/intent/post?text=' + enc(text.length > 230 ? text.slice(0, 227) + '…' : text) + '&url=' + enc(url);
    $('shMail').href = 'mailto:?subject=' + enc('Vtip z Českých vtipů') + '&body=' + enc(text + '\n\n' + url);
    $('shCopy').onclick = async () => {
      try { await navigator.clipboard.writeText(text + '\n\n' + url); toast('Vtip a odkaz zkopírovány'); }
      catch { toast('Kopírování se nepovedlo. Označte text ručně.'); }
      $('shareDlg').close();
    };
    $('shareDlg').showModal();
  }

  /* ------------------------------------------------------------------ lists */
  function wilson(k, n) {
    if (!n) return 0;
    const z = 1.96, p = k / n;
    return (p + z * z / (2 * n) - z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / (1 + z * z / n);
  }

  const SHARE_SVG = '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M18 16.1a2.9 2.9 0 0 0-1.96.77l-7.13-4.15a3.2 3.2 0 0 0 0-1.44l7.05-4.11A3 3 0 1 0 15 5a3.2 3.2 0 0 0 .09.72L8.04 9.83a3 3 0 1 0 0 4.34l7.12 4.16a2.8 2.8 0 0 0-.08.67A2.92 2.92 0 1 0 18 16.1Z"/></svg>';

  function jokeItem(j, { rank, remove, trend } = {}) {
    const li = document.createElement('li');
    if (rank) { const r = document.createElement('span'); r.className = 'rank'; r.textContent = String(rank); li.append(r); }
    const meta = metaLine(j, 'item-meta');
    const p = document.createElement('p'); p.className = 'text'; putText(p, shown(j));
    const row = document.createElement('div'); row.className = 'row';
    const up = trend ? j.tu : j.up, down = trend ? j.td : j.down, n = up + down;
    const vt = document.createElement('span'); vt.className = 'votes';
    vt.textContent = n ? `${trend ? 'Za ' + trendDays + ' dní: ' : ''}👍 ${fmt(up)} · 👎 ${fmt(down)} · ${Math.round((up / n) * 100)}\u00a0%` : 'Zatím bez hlasů';
    const sh = document.createElement('button'); sh.type = 'button'; sh.className = 'pill'; sh.innerHTML = SHARE_SVG + 'Sdílet';
    sh.onclick = () => share(j);
    row.append(vt, sh);
    if (remove) {
      const rm = document.createElement('button'); rm.type = 'button'; rm.className = 'pill'; rm.textContent = 'Odebrat';
      rm.onclick = () => { setVote(j.id, 0); renderMine(); updateProgress(); toast('Odebráno z Mých vtipů'); };
      row.append(rm);
    }
    if (rank) { const body = document.createElement('div'); body.className = 'item-body'; body.append(meta, p, row); li.append(body); }
    else li.append(meta, p, row);
    return li;
  }

  function renderCats() {
    const have = new Set(jokes.map((j) => j.cat).filter(Boolean));
    const order = [...CATS.filter((c) => have.has(c) && c !== 'Ostatní'), ...[...have].filter((c) => !CATS.includes(c)).sort(), ...(have.has('Ostatní') ? ['Ostatní'] : [])];
    if (rankCat && !have.has(rankCat)) rankCat = '';
    const box = $('catChips');
    const mk = (label, val) => {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'chip'; b.textContent = label; b.dataset.cat = val;
      b.setAttribute('aria-pressed', String(val === rankCat));
      b.onclick = () => { rankCat = val; saveRank(); renderTop(); };
      return b;
    };
    box.replaceChildren(mk('Vše', ''), ...order.map((c) => mk(c, c)));
    box.hidden = order.length < 2;
  }
  function saveRank() { writeJSON(STORE.rank, { mode: rankMode, cat: rankCat }); }

  function renderTop() {
    document.querySelectorAll('.seg button').forEach((x) => x.setAttribute('aria-checked', String(x.dataset.rank === rankMode)));
    renderCats();
    const trend = rankMode === 'trend';
    const ups = trend ? (j) => j.tu : (j) => j.up, downs = trend ? (j) => j.td : (j) => j.down;
    const pool = jokes.filter((j) => (!rankCat || j.cat === rankCat) && ups(j) + downs(j) > 0);
    const arr = pool.map((j) => [wilson(ups(j), ups(j) + downs(j)), j])
      .sort((a, b) => b[0] - a[0] || (ups(b[1]) + downs(b[1])) - (ups(a[1]) + downs(a[1])))
      .slice(0, LIST_LIMIT).map((x) => x[1]);
    $('topList').replaceChildren(...arr.map((j, i) => jokeItem(j, { rank: i + 1, trend })));
    $('topEmpty').hidden = arr.length > 0;
    $('topEmpty').textContent = trend
      ? (rankCat ? `V kategorii ${rankCat} za posledních ${trendDays} dní zatím nikdo nehlasoval. Zkuste „Všech dob“.` : `Za posledních ${trendDays} dní zatím nikdo nehlasoval. Švihněte pár vtipů a vraťte se.`)
      : (rankCat ? `V kategorii ${rankCat} zatím nikdo nehlasoval.` : 'Žebříček se plní, jak lidé hlasují. Švihněte pár vtipů a vraťte se.');
    $('topNote').textContent = trend ? `Nejoblíbenější vtipy za posledních ${trendDays} dní.` : 'Nejoblíbenější vtipy od začátku.';
  }

  function renderMine() {
    const liked = Object.entries(votes).filter(([, x]) => x.v === 1).sort((a, b) => b[1].t - a[1].t)
      .map(([id]) => byId.get(Number(id))).filter(Boolean);
    $('mineList').replaceChildren(...liked.map((j) => jokeItem(j, { remove: true })));
    $('mineCount').textContent = liked.length ? `(${fmt(liked.length)})` : '';
    $('mineEmpty').hidden = liked.length > 0;
  }

  /* ------------------------------------------------------------------ views */
  function currentView() { return location.hash === '#zebricek' ? 'top' : location.hash === '#moje' ? 'mine' : 'swipe'; }
  function route() {
    const v = currentView();
    document.querySelectorAll('[data-view]').forEach((el) => { el.hidden = el.dataset.view !== v; });
    document.querySelectorAll('.tabs a').forEach((a) => { if (a.dataset.tab === v) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
    if (v === 'top') renderTop();
    if (v === 'mine') renderMine();
    if (v === 'swipe') {
      const m = location.hash.match(/^#v(\d+)$/);
      if (m && byId.has(Number(m[1]))) { const id = Number(m[1]); queue = [id, ...queue.filter((q) => q !== id)].slice(0, 3); fillQueue(); renderDeck(); }
    }
    window.scrollTo({ top: 0 });
  }

  /* ------------------------------------------------------------- submitting */
  function openSubmit() {
    if (!API) { toast('Posílání vtipů funguje, až bude web zapojený.'); return; }
    $('submitDlg').showModal(); $('subText').focus();
  }
  async function sendSubmit(e) {
    e.preventDefault();
    const text = $('subText').value.trim();
    if (text.length < 5) { toast('Vtip je moc krátký.'); return; }
    const btn = $('subSend'); btn.disabled = true;
    try {
      const r = await fetch(API, { method: 'POST', body: JSON.stringify({ a: 'submit', text, name: $('subName').value.trim(), hp: $('subHp').value }) }).then((x) => x.json());
      if (r.ok) {
        $('subText').value = ''; $('subCount').textContent = '0'; $('submitDlg').close();
        toast(r.duplicate ? 'Tenhle vtip už ve sbírce máme.' : 'Díky! Vtip se objeví, až ho schválíme.');
      } else {
        toast({ short: 'Vtip je moc krátký.', long: 'Vtip je moc dlouhý, maximum je 1000 znaků.', busy: 'Teď toho chodí hodně, zkuste to za hodinu.' }[r.error] || 'Vtip se nepodařilo poslat.');
      }
    } catch { toast('Vtip se nepodařilo poslat. Zkontrolujte připojení.'); }
    btn.disabled = false;
  }

  /* ----------------------------------------------------------------- events */
  function wire() {
    $('upBtn').addEventListener('click', () => fling(1));
    $('downBtn').addEventListener('click', () => fling(-1));
    $('undoBtn').addEventListener('click', undo);
    $('shareBtn').addEventListener('click', () => share(byId.get(queue[0])));
    document.querySelectorAll('.seg button').forEach((b) => b.addEventListener('click', () => {
      rankMode = b.dataset.rank; saveRank();
      renderTop();
    }));
    $('submitBtn').addEventListener('click', openSubmit);
    $('submitForm').addEventListener('submit', sendSubmit);
    $('subCancel').addEventListener('click', () => $('submitDlg').close());
    $('subText').addEventListener('input', (e) => { $('subCount').textContent = String(e.target.value.length); });
    window.addEventListener('hashchange', route);
    document.addEventListener('keydown', (e) => {
      if (currentView() !== 'swipe' || document.querySelector('dialog[open]') || /INPUT|TEXTAREA/.test(document.activeElement.tagName)) return;
      if (e.key === 'ArrowRight') { e.preventDefault(); fling(1); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); fling(-1); }
      else if (e.key === 'Backspace' || e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); }
    });
    window.addEventListener('online', flushVotes);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { flushVotes(); } });
    window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvt = e; $('installBtn').hidden = false; });
    $('installBtn').addEventListener('click', async () => { if (!installEvt) return; installEvt.prompt(); await installEvt.userChoice; installEvt = null; $('installBtn').hidden = true; });
    const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
    $('iosHint').hidden = !(isIOS && !standalone);
  }

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  wire();
  route();
  renderDeck();
  load();
})();
