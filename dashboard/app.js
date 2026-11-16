/* Token Radar dashboard: renders window.RADAR (written beside this page by
   main.ts) as a sortable, filterable board with a per-protocol detail view.
   No framework, no network: everything comes from the data file. */
(function () {
  'use strict';

  var R = window.RADAR;
  var rows = R.rows;
  var bySlug = {};
  rows.forEach(function (r) { bySlug[r.slug] = r; });

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function commas(n) {
    return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }
  function money(n) { return '$' + commas(n); }
  function pct(v) {
    if (v === null || v === undefined) return '<span class="pct flat">—</span>';
    var cls = v > 0 ? 'up' : v < 0 ? 'down' : 'flat';
    var sign = v > 0 ? '+' : '';
    return '<span class="pct ' + cls + '">' + sign + v.toFixed(2) + '%</span>';
  }

  /* ------------------------------------------------------------ masthead */
  var meta = R.meta;
  var chips = [
    ['Snapshot', meta.as_of],
    ['Protocols scanned', commas(meta.protocols_total)],
    ['Pre-token ranked', commas(meta.pre_token_count)],
    ['Watchlist covered', meta.watchlist_count + ' / ' + meta.watchlist_count],
    ['Already tokenized', commas(meta.tokenized_count)]
  ];
  $('chips').innerHTML = chips.map(function (c) {
    return '<div><dt>' + esc(c[0]) + '</dt><dd>' + esc(c[1]) + '</dd></div>';
  }).join('');

  /* ------------------------------------------------- category multiples */
  var mult = R.model.categories.map(function (c) {
    return '<tr><td>' + esc(c.category) + '</td><td>&times;' + c.multiple.toFixed(3) + '</td><td>' +
      c.peers + '</td><td>' + (c.source === 'category' ? 'own peers' : 'global fallback') + '</td></tr>';
  }).join('');
  $('multiples').innerHTML =
    '<details><summary>Category multiples derived from this snapshot (global median &times;' +
    R.model.global_multiple.toFixed(3) + ' from ' + R.model.global_peers + ' tokenized peers)</summary>' +
    '<table class="mult-table"><thead><tr><th>Category</th><th>Multiple</th><th>Peers</th><th>Source</th></tr></thead>' +
    '<tbody>' + mult + '</tbody></table></details>';

  /* ------------------------------------------------------------- filters */
  var cats = [];
  var chainSet = {};
  rows.forEach(function (r) {
    if (r.category && cats.indexOf(r.category) === -1) cats.push(r.category);
    r.chains.forEach(function (c) { chainSet[c] = true; });
  });
  cats.sort();
  var chains = Object.keys(chainSet).sort();
  $('cat').innerHTML = '<option value="">All categories</option>' + cats.map(function (c) {
    return '<option>' + esc(c) + '</option>';
  }).join('');
  $('chain').innerHTML = '<option value="">All chains</option>' + chains.map(function (c) {
    return '<option>' + esc(c) + '</option>';
  }).join('');

  var params = new URLSearchParams(window.location.search);
  var state = {
    q: params.get('q') || '',
    cat: params.get('cat') || '',
    chain: params.get('chain') || '',
    wl: params.get('watchlist') === '1' || params.get('wl') === '1',
    min: Number(params.get('min') || 0),
    sortKey: params.get('sort') || 'rank',
    sortDir: params.get('dir') || 'asc'
  };
  $('q').value = state.q;
  if (state.cat) $('cat').value = state.cat;
  if (state.chain) $('chain').value = state.chain;
  $('wl').checked = state.wl;
  if (state.min) $('min').value = String(state.min);

  function naturalDir(key) {
    return key === 'rank' || key === 'name' || key === 'category' || key === 'chains' ? 'asc' : 'desc';
  }
  function cmp(a, b) {
    var k = state.sortKey, va, vb;
    if (k === 'name') { va = a.name.toLowerCase(); vb = b.name.toLowerCase(); }
    else if (k === 'category') { va = (a.category || '').toLowerCase(); vb = (b.category || '').toLowerCase(); }
    else if (k === 'chains') { va = a.chains.length; vb = b.chains.length; }
    else if (k === 'change_7d') { va = a.change_7d === null ? -Infinity : a.change_7d; vb = b.change_7d === null ? -Infinity : b.change_7d; }
    else { va = a[k]; vb = b[k]; }
    var d = va < vb ? -1 : va > vb ? 1 : a.rank - b.rank;
    return state.sortDir === 'asc' ? d : -d;
  }

  function visible() {
    var q = state.q.trim().toLowerCase();
    return rows.filter(function (r) {
      if (state.wl && !r.watchlist) return false;
      if (state.cat && r.category !== state.cat) return false;
      if (state.chain && r.chains.indexOf(state.chain) === -1) return false;
      if (state.min && r.implied_value_usd < state.min) return false;
      if (q && r.name.toLowerCase().indexOf(q) === -1 && r.slug.indexOf(q) === -1) return false;
      return true;
    }).sort(cmp);
  }

  function chainCell(r) {
    var shown = r.chains.slice(0, 3).join(', ');
    if (r.chains.length > 3) shown += ' +' + (r.chains.length - 3);
    return esc(shown || '—');
  }

  function render() {
    var list = visible();
    var html = '';
    list.forEach(function (r) {
      html += '<tr data-slug="' + esc(r.slug) + '"' + (r.rank <= 3 ? ' class="top3"' : '') + '>' +
        '<td class="rank num">#' + r.rank + '</td>' +
        '<td class="name">' + esc(r.name) + (r.watchlist ? '<span class="badge">Watchlist</span>' : '') +
        '<span class="slug">' + esc(r.slug) + '</span></td>' +
        '<td class="cat">' + esc(r.category || '—') + '</td>' +
        '<td class="chains">' + chainCell(r) + '</td>' +
        '<td class="money num">' + money(r.tvl_usd) + '</td>' +
        '<td class="num">' + pct(r.change_7d) + '</td>' +
        '<td class="money implied num">' + money(r.implied_value_usd) + '</td>' +
        '<td class="signal num"><span class="sig"><span class="bar"><i style="width:' + r.signal + '%"></i></span>' + r.signal + '</span></td>' +
        '</tr>';
    });
    $('rows').innerHTML = html;
    $('empty').hidden = list.length > 0;
    $('count').textContent = 'Showing ' + list.length + ' of ' + rows.length + ' protocols';
    var ths = document.querySelectorAll('.board th.sortable');
    ths.forEach(function (th) {
      var base = th.getAttribute('data-label') || th.textContent.replace(/ [▲▼]$/, '');
      th.setAttribute('data-label', base);
      th.innerHTML = esc(base) + (th.dataset.key === state.sortKey
        ? ' <span class="arrow">' + (state.sortDir === 'asc' ? '▲' : '▼') + '</span>' : '');
    });
  }

  /* -------------------------------------------------------------- detail */
  function barFrac(kind, v) {
    if (kind === 'multiple') {
      var lo = Math.log10(0.02), hi = Math.log10(3);
      return Math.min(1, Math.max(0, (Math.log10(Math.max(0.02, v)) - lo) / (hi - lo)));
    }
    if (kind === 'momentum') return Math.min(1, Math.max(0, (v - 0.5) / 1.1));
    if (kind === 'maturity') return Math.min(1, Math.max(0, (v - 0.75) / 0.25));
    return Math.min(1, Math.max(0, (v - 1) / 0.21));
  }
  function factorRow(label, kind, v, text) {
    return '<div class="factor"><span class="fname">' + label + '</span>' +
      '<span class="fbar"><i style="width:' + Math.round(barFrac(kind, v) * 100) + '%"></i></span>' +
      '<span class="fval">' + text + '</span></div>';
  }
  function ageText(r) {
    if (!r.listed_at) return 'not reported';
    var days = Math.floor((Date.parse(meta.as_of + 'T00:00:00Z') - Date.parse(r.listed_at + 'T00:00:00Z')) / 86400000);
    return r.listed_at + ' (' + (days / 365.25).toFixed(1) + ' yrs)';
  }

  function openDetail(slug) {
    var r = bySlug[slug];
    if (!r) return;
    var multSrc = r.multiple_source === 'category'
      ? 'median of ' + r.peers + ' tokenized ' + esc(r.category || '') + ' peers'
      : 'the global median of ' + R.model.global_peers + ' tokenized protocols — ' + esc(r.category || 'this category') + ' has too few tokenized peers of its own';
    $('detail').innerHTML =
      '<button class="close" id="dclose" type="button">Close ✕</button>' +
      '<p class="kicker">Rank #' + r.rank + ' of ' + rows.length + (r.watchlist ? ' · Watchlist' : '') + '</p>' +
      '<h2>' + esc(r.name) + '</h2>' +
      '<p class="sub">' + esc(r.slug) + ' · ' + esc(r.category || 'Uncategorized') + ' · ' + esc(r.chains.join(', ') || 'chain not reported') + '</p>' +
      '<p class="big"><small>Implied token value</small>' + money(r.implied_value_usd) + '</p>' +
      '<dl class="stats">' +
      '<div><dt>TVL</dt><dd>' + money(r.tvl_usd) + '</dd></div>' +
      '<div><dt>TVL change, 7d</dt><dd>' + (r.change_7d === null ? '—' : (r.change_7d > 0 ? '+' : '') + r.change_7d.toFixed(2) + '%') + '</dd></div>' +
      '<div><dt>Listed since</dt><dd>' + esc(ageText(r)) + '</dd></div>' +
      '<div><dt>Signal score</dt><dd>' + r.signal + ' / 100</dd></div>' +
      '</dl>' +
      '<h3>How this value is implied</h3>' +
      factorRow('Category multiple', 'multiple', r.multiple, '&times;' + r.multiple.toFixed(3)) +
      factorRow('Momentum', 'momentum', r.momentum, '&times;' + r.momentum.toFixed(2)) +
      factorRow('Maturity', 'maturity', r.maturity, '&times;' + r.maturity.toFixed(2)) +
      factorRow('Breadth', 'breadth', r.breadth, '&times;' + r.breadth.toFixed(2)) +
      '<p class="factor-note">' + money(r.tvl_usd) + ' of TVL &times; a &times;' + r.multiple.toFixed(3) +
      ' category multiple (' + multSrc + ') &times; momentum &times;' +
      r.momentum.toFixed(2) + ' from its 7-day TVL change &times; maturity &times;' + r.maturity.toFixed(2) +
      ' for its listing age &times; breadth &times;' + r.breadth.toFixed(2) + ' for ' + r.chains.length +
      (r.chains.length === 1 ? ' chain' : ' chains') + ' = ' + money(r.implied_value_usd) + ' implied.</p>' +
      '<h3>The farm plan</h3>' +
      '<ol class="plan">' + r.farm_steps.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ol>';
    $('detail').hidden = false;
    $('scrim').hidden = false;
    $('dclose').addEventListener('click', closeDetail);
    $('detail').scrollTop = 0;
  }
  function closeDetail() {
    $('detail').hidden = true;
    $('scrim').hidden = true;
  }

  /* -------------------------------------------------------------- events */
  $('q').addEventListener('input', function () { state.q = this.value; render(); });
  $('cat').addEventListener('change', function () { state.cat = this.value; render(); });
  $('chain').addEventListener('change', function () { state.chain = this.value; render(); });
  $('wl').addEventListener('change', function () { state.wl = this.checked; render(); });
  $('min').addEventListener('change', function () { state.min = Number(this.value); render(); });
  document.querySelectorAll('.board th.sortable').forEach(function (th) {
    th.addEventListener('click', function () {
      var k = th.dataset.key;
      if (state.sortKey === k) state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
      else { state.sortKey = k; state.sortDir = naturalDir(k); }
      render();
    });
  });
  $('rows').addEventListener('click', function (ev) {
    var tr = ev.target.closest('tr[data-slug]');
    if (tr) openDetail(tr.dataset.slug);
  });
  $('scrim').addEventListener('click', closeDetail);
  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape' && !$('detail').hidden) closeDetail();
    if (ev.key === '/' && !/INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) {
      ev.preventDefault();
      $('q').focus();
    }
  });

  /* Keep the address bar describing the current view, so any filtered or
     sorted board — not just the presets — can be linked and screenshotted. */
  function syncUrl() {
    try {
      var p = new URLSearchParams();
      if (state.q) p.set('q', state.q);
      if (state.cat) p.set('cat', state.cat);
      if (state.chain) p.set('chain', state.chain);
      if (state.wl) p.set('watchlist', '1');
      if (state.min) p.set('min', String(state.min));
      if (state.sortKey !== 'rank') p.set('sort', state.sortKey);
      if (state.sortDir !== 'asc') p.set('dir', state.sortDir);
      var qs = p.toString();
      history.replaceState(null, '', window.location.pathname + (qs ? '?' + qs : ''));
    } catch (e) { /* history is a nicety, never a requirement */ }
  }
  ['q', 'cat', 'chain', 'wl', 'min'].forEach(function (id) {
    $(id).addEventListener('change', syncUrl);
  });
  $('q').addEventListener('input', syncUrl);
  document.querySelectorAll('.board th.sortable').forEach(function (th) {
    th.addEventListener('click', syncUrl);
  });

  /* --------------------------------------------------------------- footer */
  var ex = R.live.examples.map(function (e) {
    return esc(e.name) + (e.symbol ? ' (' + esc(e.symbol) + ')' : '') + ' at ' + money(e.mcap_usd || 0);
  }).join(' · ');
  $('live').textContent = 'Set aside, not ranked: ' + R.live.count + ' protocols already record a token — the largest include ' + ex + '.';

  render();
  var startSlug = params.get('p');
  if (startSlug && bySlug[startSlug]) openDetail(startSlug);
})();
