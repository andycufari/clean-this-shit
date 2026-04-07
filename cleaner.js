#!/usr/bin/env node

const blessed = require('blessed');
const { execSync, exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = os.homedir();
const AUTO_MODE = process.argv.includes('--auto') || process.argv.includes('-a');

// ─── Helpers ────────────────────────────────────────────────────────────────

function fmt(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(1) + ' ' + u[i];
}

function run(cmd) {
  try { return execSync(cmd, { encoding: 'utf8', timeout: 30000 }).trim(); }
  catch { return ''; }
}

function dirSize(p) {
  try {
    if (!fs.existsSync(p)) return 0;
    const out = run('du -sk "' + p + '" 2>/dev/null');
    return parseInt(out.split('\t')[0] || '0') * 1024;
  } catch { return 0; }
}

function dirSizeAsync(p) {
  return new Promise(resolve => {
    if (!fs.existsSync(p)) return resolve(0);
    exec('du -sk "' + p + '" 2>/dev/null', { encoding: 'utf8', timeout: 30000 }, (err, out) => {
      if (err || !out) return resolve(0);
      resolve(parseInt(out.split('\t')[0] || '0') * 1024);
    });
  });
}

// Scan items one-by-one, calling onProgress(item, idx, total) after each
function scanItemsLive(items, onProgress) {
  return new Promise(resolve => {
    const results = [];
    let idx = 0;

    function next() {
      if (idx >= items.length) return resolve(results.filter(i => i.size > 0));

      const item = items[idx];
      dirSizeAsync(item.path).then(size => {
        const result = { ...item, size };
        results.push(result);
        if (onProgress) onProgress(result, idx, items.length);
        idx++;
        // setTimeout gives blessed a chance to render between items
        setTimeout(next, 0);
      });
    }

    next();
  });
}

// ─── Blessed Tag Helpers ────────────────────────────────────────────────────

function fg(c, t) { return '{' + c + '-fg}' + t + '{/' + c + '-fg}'; }
function b(t) { return '{bold}' + t + '{/bold}'; }
function dim(t) { return fg('#565f89', t); }
function ctr(t) { return '{center}' + t + '{/center}'; }

// ─── Theme ──────────────────────────────────────────────────────────────────

const C = {
  bg: '#1a1b26', fg: '#c0caf5', accent: '#7aa2f7', green: '#9ece6a',
  red: '#f7768e', yellow: '#e0af68', cyan: '#7dcfff', magenta: '#bb9af7',
  dim: '#565f89', empty: '#24283b', border: '#3b4261', sel: '#33467c',
  panel: '#1f2335', orange: '#ff9e64',
};

// ─── Bars (single-width chars only) ─────────────────────────────────────────

function diskBar(ratio, w) {
  const f = Math.max(0, Math.round(ratio * w));
  const e = Math.max(0, w - f);
  const c = ratio > 0.9 ? C.red : ratio > 0.7 ? C.yellow : C.green;
  return fg(c, '#'.repeat(f)) + fg(C.empty, '-'.repeat(e));
}

function sBar(ratio, w) {
  const f = Math.max(0, Math.round(Math.min(1, ratio) * w));
  return fg(C.cyan, '#'.repeat(f)) + fg(C.empty, '-'.repeat(Math.max(0, w - f)));
}

// ─── Disk Info (APFS-aware, fallback to df) ─────────────────────────────────

function getDisk() {
  const containerTotal = run("diskutil info / 2>/dev/null | grep 'Container Total Space'");
  const containerFree = run("diskutil info / 2>/dev/null | grep 'Container Free Space'");

  if (containerTotal && containerFree) {
    const parseBytes = (line) => {
      const m = line.match(/\((\d+) Bytes\)/);
      return m ? parseInt(m[1]) : 0;
    };
    const total = parseBytes(containerTotal);
    const avail = parseBytes(containerFree);
    return { total, used: total - avail, avail };
  }

  const p = run("df -k / | tail -1").split(/\s+/);
  return { total: p[1] * 1024, used: p[2] * 1024, avail: p[3] * 1024 };
}

// ─── Spinner ────────────────────────────────────────────────────────────────

const DOTS = ['   ', '.  ', '.. ', '...', ' ..', '  .'];
function spinner(box, prefix) {
  let i = 0;
  const id = setInterval(() => {
    box.setContent(prefix + DOTS[i++ % DOTS.length]);
    screen.render();
  }, 200);
  return () => clearInterval(id);
}

// ─── List Helper: setItems without losing scroll position ───────────────────

function listSetItems(list, items) {
  const idx = list.selected;
  const scrollTop = list.childBase || 0;
  list.setItems(items);
  list.select(idx);
  list.childBase = scrollTop;
  list.scrollTo(scrollTop + idx);
}

// ─── Rainbow Text ───────────────────────────────────────────────────────────

const VERSION = require('./package.json').version;
const RAINBOW = [C.red, C.orange, C.yellow, C.green, C.cyan, C.accent, C.magenta];

function rainbow(text) {
  let out = '';
  let ci = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === ' ') { out += ' '; continue; }
    out += fg(RAINBOW[ci % RAINBOW.length], text[i]);
    ci++;
  }
  return b(out);
}

// ─── Screen ─────────────────────────────────────────────────────────────────

const screen = blessed.screen({ smartCSR: true, title: 'Clean This Shit', fullUnicode: false });

const header = blessed.box({
  parent: screen, top: 0, left: 0, width: '100%', height: 3,
  style: { fg: C.accent, bg: C.bg }, content: '', tags: true,
});

function setHeader(title) {
  const w = screen.width;
  const logo = rainbow(' Clean This Shit ') + dim(' v' + VERSION);
  const t = title ? '  ' + dim('>') + ' ' + title : '';
  header.setContent(logo + t + '\n' + fg(C.border, '-'.repeat(w)));
}

const footer = blessed.box({
  parent: screen, bottom: 0, left: 0, width: '100%', height: 1,
  style: { fg: C.dim, bg: C.empty }, tags: true, content: '',
});

function setFoot(t) { footer.setContent(' ' + t); screen.render(); }

const main = blessed.box({
  parent: screen, top: 3, left: 0, width: '100%', height: screen.height - 4,
  style: { fg: C.fg, bg: C.bg }, tags: true,
});

let curView = null;
let popupOpen = false;
function clearMain() {
  while (main.children.length) main.children[0].detach();
  curView = null;
}

// ─── Cleanable Items (definitions only, no scanning) ────────────────────────

function getCleanableDefs() {
  const h = HOME;
  // All commands use find -exec rm or 2>/dev/null; exit 0 to handle permission errors gracefully
  const rmrf = (p) => 'find "' + p + '" -mindepth 1 -maxdepth 1 -exec rm -rf {} + 2>/dev/null; exit 0';
  const rmdirs = (...ps) => ps.map(p => 'rm -rf "' + p + '"').join('; ') + ' 2>/dev/null; exit 0';

  return [
    { name: 'User Caches',         tag: 'cache',   hint: 'app junk, rebuilds on its own',    path: h + '/Library/Caches',        cmd: rmrf(h + '/Library/Caches'), safe: true },
    { name: 'Browser Caches',      tag: 'browser',  hint: 'Chrome/Safari/Arc/Firefox',       path: h + '/Library/Caches/Google',  cmd: rmdirs(h + '/Library/Caches/Google/Chrome/Default/Cache', h + '/Library/Caches/com.apple.Safari', h + '/Library/Caches/company.thebrowser.Browser'), safe: true },
    { name: 'Xcode DerivedData',   tag: 'xcode',    hint: 'build artifacts, safe to nuke',   path: h + '/Library/Developer/Xcode/DerivedData', cmd: rmrf(h + '/Library/Developer/Xcode/DerivedData'), safe: true },
    { name: 'Xcode Device Support',tag: 'xcode',    hint: 'old iOS/watchOS symbols',         path: h + '/Library/Developer/Xcode/iOS DeviceSupport', cmd: rmdirs(h + '/Library/Developer/Xcode/iOS DeviceSupport', h + '/Library/Developer/Xcode/watchOS DeviceSupport'), safe: true },
    { name: 'CoreSimulator',       tag: 'xcode',    hint: 'all simulator devices & data',    path: h + '/Library/Developer/CoreSimulator', cmd: 'xcrun simctl shutdown all 2>/dev/null; xcrun simctl delete all 2>/dev/null; ' + rmrf(h + '/Library/Developer/CoreSimulator/Caches'), safe: false },
    { name: 'Homebrew Cache',      tag: 'dev',      hint: 'old downloaded bottles',          path: h + '/Library/Caches/Homebrew', cmd: 'brew cleanup --prune=all 2>/dev/null; exit 0', safe: true },
    { name: 'npm Cache',           tag: 'dev',      hint: 'registry tarballs',               path: h + '/.npm',                   cmd: 'npm cache clean --force 2>/dev/null; exit 0', safe: true },
    { name: 'Yarn Cache',          tag: 'dev',      hint: 'offline mirror, will re-download', path: h + '/Library/Caches/Yarn',   cmd: 'yarn cache clean 2>/dev/null; exit 0',        safe: true },
    { name: 'pip Cache',           tag: 'dev',      hint: 'downloaded wheels',               path: h + '/Library/Caches/pip',     cmd: 'pip3 cache purge 2>/dev/null; exit 0',        safe: true },
    { name: 'Cargo Cache',         tag: 'dev',      hint: 'crate registry cache',            path: h + '/.cargo/registry',        cmd: rmrf(h + '/.cargo/registry/cache'), safe: true },
    { name: 'CocoaPods Cache',     tag: 'dev',      hint: 'pod spec cache',                  path: h + '/Library/Caches/CocoaPods', cmd: rmrf(h + '/Library/Caches/CocoaPods'), safe: true },
    { name: 'Slack Cache',         tag: 'app',      hint: 'cached images & data',            path: h + '/Library/Caches/com.tinyspeck.slackmacgap', cmd: rmrf(h + '/Library/Caches/com.tinyspeck.slackmacgap'), safe: true },
    { name: 'Discord Cache',       tag: 'app',      hint: 'cached media',                    path: h + '/Library/Caches/com.hnc.Discord', cmd: rmrf(h + '/Library/Caches/com.hnc.Discord'), safe: true },
    { name: 'Spotify Cache',       tag: 'app',      hint: 'streamed music cache',            path: h + '/Library/Caches/com.spotify.client', cmd: rmrf(h + '/Library/Caches/com.spotify.client'), safe: true },
    { name: 'User Logs',           tag: 'logs',     hint: 'app logs, usually useless',       path: h + '/Library/Logs',           cmd: rmrf(h + '/Library/Logs'), safe: true },
    { name: 'Crash Reports',       tag: 'logs',     hint: 'diagnostic dumps',                path: h + '/Library/Logs/DiagnosticReports', cmd: rmrf(h + '/Library/Logs/DiagnosticReports'), safe: true },
    { name: 'Temp Files',          tag: 'tmp',      hint: 'old temp files (>1 day)',         path: '/tmp',                        cmd: 'find /tmp -mindepth 1 -mtime +1 -delete 2>/dev/null; exit 0', safe: true },
    { name: 'Trash',               tag: 'trash',    hint: 'empty the bin!',                  path: h + '/.Trash',                 cmd: rmrf(h + '/.Trash'), safe: true },
    { name: 'Mail Downloads',      tag: 'cloud',    hint: 'email attachments you opened',    path: h + '/Library/Mail Downloads', cmd: rmrf(h + '/Library/Mail Downloads'), safe: true },
    { name: 'iMessage Attachments',tag: 'cloud',    hint: 'pics & vids from chats',          path: h + '/Library/Messages/Attachments', cmd: rmrf(h + '/Library/Messages/Attachments'), safe: false },
  ];
}

// ─── View: Main Menu ────────────────────────────────────────────────────────

function showMenu() {
  clearMain();
  setHeader('');
  curView = 'menu';

  const disk = getDisk();
  const ratio = disk.used / disk.total;
  const barW = Math.min(50, screen.width - 20);

  // Disk bar at top
  const diskLines = [
    '  ' + b('Macintosh HD') + '  ' + fmt(disk.used) + ' / ' + fmt(disk.total) + '  ' + fg(ratio > 0.85 ? C.red : C.green, fmt(disk.avail) + ' free'),
    '  [' + diskBar(ratio, barW) + ']  ' + (ratio * 100).toFixed(1) + '%',
  ];
  if (ratio > 0.85) diskLines.push('  ' + fg(C.red, '! Your disk is almost full'));

  blessed.box({
    parent: main, top: 0, left: 2, width: '95%', height: diskLines.length + 1,
    tags: true, style: { fg: C.fg, bg: C.bg },
    content: diskLines.join('\n'),
  });

  const menuTop = diskLines.length + 2;
  const items = [
    fg(C.cyan,    '[>]') + ' ' + b('Disk Overview') + '           ' + dim('where is my space going?'),
    fg(C.green,   '[>]') + ' ' + b('Cache & Temp') + '            ' + dim('caches, logs, temp files'),
    fg(C.accent,  '[>]') + ' ' + b('Docker Cleanup') + '          ' + dim('images, containers, volumes'),
    fg(C.magenta, '[>]') + ' ' + b('Cloud Data') + '              ' + dim('Photos, Mail, iCloud local data'),
    fg(C.yellow,  '[>]') + ' ' + b('Large Files') + '             ' + dim('find the big stuff you forgot'),
    fg(C.orange,  '[>]') + ' ' + b('Downloads Review') + '        ' + dim('old .dmg, .pkg, .zip, .iso'),
    fg(C.red,     '[>]') + ' ' + b('Stale Documents') + '         ' + dim('files untouched for months'),
    '',
    fg(C.green,   '[!]') + ' ' + b(fg(C.green, 'AUTO CLEAN')) + '             ' + dim('scan all, pick safe, go!'),
    '',
    dim('     [c] Credits   [q] Quit'),
  ];

  const menu = blessed.list({
    parent: main, top: menuTop, left: 2, width: '95%', height: items.length + 2,
    items: items, tags: true, keys: true, vi: true, mouse: true,
    style: { fg: C.fg, bg: C.bg, selected: { fg: '#ffffff', bg: C.sel, bold: true } },
    padding: { left: 1, right: 1 },
  });

  setFoot(b('j/k') + ' navigate  ' + b('enter') + ' select  ' + b('c') + ' credits  ' + b('q') + ' quit');

  menu.on('keypress', (ch) => {
    if (ch === 'c' || ch === 'C') showCredits();
  });

  // idx: 0-6 = views, 7 = blank, 8 = auto, 9 = blank, 10 = credits/quit line
  menu.on('select', (_, idx) => {
    const actions = [showOverview, showCacheCleaner, showDockerCleanup, showCloudCache, showLargeFiles, showDownloads, showStale, null, showAutoClean];
    if (idx === 10) process.exit(0);
    if (actions[idx]) actions[idx]();
  });

  menu.focus();
  screen.render();
}

// ─── View: Disk Overview ────────────────────────────────────────────────────

function showOverview() {
  clearMain();
  setHeader('Disk Overview');
  curView = 'overview';

  const disk = getDisk();
  const ratio = disk.used / disk.total;
  const barW = Math.min(50, screen.width - 20);

  // Show disk bar immediately
  blessed.box({
    parent: main, top: 0, left: 2, width: '95%', height: 3,
    tags: true, style: { fg: C.fg, bg: C.bg },
    content: [
      '  ' + b('Macintosh HD') + '  ' + fmt(disk.used) + ' / ' + fmt(disk.total) + '  ' + fg(C.green, fmt(disk.avail) + ' free'),
      '  [' + diskBar(ratio, barW) + ']  ' + (ratio * 100).toFixed(1) + '%',
    ].join('\n'),
  });

  const scanBox = blessed.box({
    parent: main, top: 4, left: 4, width: '90%', height: 1,
    tags: true, style: { fg: C.accent, bg: C.bg }, content: '',
  });

  screen.render();

  // Scan categories one by one
  const catDefs = [
    { name: 'User Caches',         path: HOME + '/Library/Caches' },
    { name: 'Application Support',  path: HOME + '/Library/Application Support' },
    { name: 'Docker',               path: HOME + '/Library/Containers/com.docker.docker' },
    { name: 'Xcode & Dev Tools',    path: HOME + '/Library/Developer' },
    { name: 'Homebrew',             path: HOME + '/Library/Caches/Homebrew' },
    { name: 'npm / Yarn',           path: HOME + '/.npm' },
    { name: 'pip / Cargo / Gem',    path: HOME + '/Library/Caches/pip' },
    { name: 'Logs & Crashes',       path: HOME + '/Library/Logs' },
    { name: 'Mail',                 path: HOME + '/Library/Mail' },
    { name: 'Photos Library',       path: HOME + '/Pictures/Photos Library.photoslibrary' },
    { name: 'iMessage',             path: HOME + '/Library/Messages' },
    { name: 'Trash',                path: HOME + '/.Trash' },
  ];

  scanItemsLive(catDefs, (item, idx, total) => {
    const pct = Math.round(((idx + 1) / total) * 100);
    const found = item.size > 0 ? '  ' + fg(C.green, '+') + ' ' + fmt(item.size) : '';
    scanBox.setContent('  Scanning ' + (idx + 1) + '/' + total + '  ' + dim(item.name) + found);
    screen.render();
  }).then(cats => {
    scanBox.detach();

    cats.sort((a, b) => b.size - a.size);
    const maxCat = cats.length > 0 ? cats[0].size : 1;
    const rows = cats.map(c => {
      const pct = disk.total > 0 ? (c.size / disk.total * 100).toFixed(1) : '0.0';
      return '  ' + c.name.padEnd(25) + fmt(c.size).padStart(10) + '  ' + sBar(c.size / maxCat, 20) + '  ' + pct + '%';
    });

    const tbl = blessed.box({
      parent: main, top: 4, left: 2, width: '95%', height: cats.length + 4,
      tags: true, style: { fg: C.fg, bg: C.bg },
      border: { type: 'line', fg: C.border },
      scrollable: true, alwaysScroll: true, keys: true, vi: true, mouse: true,
      content: [
        '  ' + b(fg(C.accent, 'Category                      Size                      %')),
        '  ' + fg(C.border, '-'.repeat(Math.min(65, screen.width - 12))),
        ...rows,
        '',
        '  ' + dim('Total visible: ' + fmt(cats.reduce((s, c) => s + c.size, 0))),
      ].join('\n'),
    });

    setFoot(b('esc') + ' back  ' + b('q') + ' quit');
    tbl.focus();
    screen.render();
  });
}

// ─── View: Auto Clean ───────────────────────────────────────────────────────

function showAutoClean() {
  clearMain();
  setHeader('AUTO CLEAN');
  curView = 'auto';

  const logBox = blessed.box({
    parent: main, top: 0, left: 2, width: '95%', height: '100%',
    tags: true, scrollable: true, alwaysScroll: true,
    keys: true, vi: true, mouse: true,
    style: { fg: C.fg, bg: C.bg }, content: '',
  });

  let log = '';
  function addLog(line) {
    log += line + '\n';
    logBox.setContent(log);
    logBox.setScrollPerc(100);
    screen.render();
  }

  // Replace last line (for progress updates)
  function updateLastLog(line) {
    const lines = log.split('\n');
    lines[lines.length - 2] = line;  // -2 because split adds trailing empty
    log = lines.join('\n');
    logBox.setContent(log);
    logBox.setScrollPerc(100);
    screen.render();
  }

  const diskBefore = getDisk();
  addLog(b(fg(C.green, '>> AUTO CLEAN')) + '  ' + dim('scan > review > confirm > clean'));
  addLog('');
  addLog(fg(C.accent, 'Step 1/3') + ' ' + b('Scanning your Mac...'));
  addLog('');

  const defs = getCleanableDefs();
  let scannedCount = 0;
  addLog(dim('  [' + scannedCount + '/' + defs.length + '] starting...'));

  logBox.focus();
  screen.render();

  scanItemsLive(defs, (item, idx, total) => {
    scannedCount = idx + 1;
    const pct = Math.round((scannedCount / total) * 100);
    const barW = 20;
    const filled = Math.round((scannedCount / total) * barW);
    const bar = fg(C.accent, '#'.repeat(filled)) + fg(C.empty, '-'.repeat(barW - filled));
    const found = item.size > 0 ? ('  ' + fg(C.green, '+') + ' ' + item.name + ' ' + dim(fmt(item.size))) : '';
    updateLastLog('  [' + bar + '] ' + scannedCount + '/' + total + '  ' + dim(item.name) + found);
  }).then(rawItems => {
    // Dedup by name
    const seen = new Set();
    const items = rawItems.filter(i => { if (seen.has(i.name)) return false; seen.add(i.name); return true; });

    // Replace progress line with done
    updateLastLog('  ' + fg(C.green, 'v') + ' Scanned ' + defs.length + ' locations, found ' + items.length + ' cleanable');
    addLog('');

    if (items.length === 0) {
      addLog(fg(C.green, '* Your Mac is already clean! Nothing to do.'));
      setFoot(b('esc') + ' back');
      return;
    }

    addLog(fg(C.accent, 'Step 2/3') + ' ' + b('Review & pick what to clean:'));
    addLog(dim('  Safe items are pre-selected. Toggle with space, enter to clean.'));
    addLog('');

    // Switch from log view to interactive checklist
    logBox.detach();

    // Summary at top
    const summaryBox = blessed.box({
      parent: main, top: 0, left: 2, width: '95%', height: 5,
      tags: true, style: { fg: C.fg, bg: C.bg },
      content: log, // keep scan log visible at top
    });

    // Build checklist
    const maxSize = items[0].size;
    const selected = new Set();

    // Pre-select safe items
    items.forEach((item, i) => { if (item.safe) selected.add(i); });

    function buildAutoRow(item, i) {
      const chk = selected.has(i) ? '[x]' : '[ ]';
      const tag = item.safe ? fg(C.green, 'safe') : fg(C.yellow, '!! ');
      return '  ' + chk + ' ' + tag + ' ' + item.name.padEnd(22) + fmt(item.size).padStart(10) + '  ' + sBar(item.size / maxSize, 12) + '  ' + dim(item.hint);
    }

    function rebuildAutoList() {
      const rows = items.map((item, i) => buildAutoRow(item, i));
      const idx = list ? list.selected : 0;
      list.setItems(rows);
      list.select(Math.min(idx, items.length - 1));
      screen.render();
    }

    const listTop = 6;
    const list = blessed.list({
      parent: main, top: listTop, left: 2, width: '95%', height: items.length,
      items: items.map((item, i) => buildAutoRow(item, i)),
      tags: true, keys: false, vi: false, mouse: true,
      style: { fg: C.fg, bg: C.bg, selected: { fg: '#ffffff', bg: C.sel, bold: true } },
    });

    const totalBox = blessed.box({
      parent: main, top: listTop + items.length + 1, left: 2, width: '95%', height: 2,
      tags: true, style: { fg: C.fg, bg: C.bg }, content: '',
    });

    function updateTotal() {
      let sz = 0;
      selected.forEach(i => { if (items[i]) sz += items[i].size; });
      totalBox.setContent('  ' + fg(C.green, selected.size + ' selected -> ~' + b(fmt(sz)) + ' reclaimable'));
      screen.render();
    }

    updateTotal();

    list.on('keypress', (ch, key) => {
      if (key.name === 'up' || ch === 'k') { list.up(1); screen.render(); }
      if (key.name === 'down' || ch === 'j') { list.down(1); screen.render(); }

      const idx = list.selected;

      if (key.name === 'space') {
        if (idx >= items.length) return;
        if (selected.has(idx)) selected.delete(idx);
        else selected.add(idx);
        rebuildAutoList();
        updateTotal();
      }
      if (ch === 'a') {
        const allSel = selected.size === items.length;
        for (let i = 0; i < items.length; i++) {
          if (allSel) selected.delete(i);
          else selected.add(i);
        }
        rebuildAutoList();
        updateTotal();
      }
      if (ch === 's') {
        selected.clear();
        for (let i = 0; i < items.length; i++) {
          if (items[i].safe) selected.add(i);
        }
        rebuildAutoList();
        updateTotal();
      }
      if (key.name === 'return' && selected.size > 0) {
        const toClean = Array.from(selected).map(i => items[i]);

        // Remove checklist, switch to cleaning log
        popupOpen = false;
        summaryBox.detach(); list.detach(); totalBox.detach();

        const cleanLogBox = blessed.box({
          parent: main, top: 0, left: 2, width: '95%', height: '100%',
          tags: true, scrollable: true, alwaysScroll: true,
          keys: true, vi: true, mouse: true,
          style: { fg: C.fg, bg: C.bg }, content: '',
        });

        let cleanLog = '';
        function addCleanLog(line) {
          cleanLog += line + '\n';
          cleanLogBox.setContent(cleanLog);
          cleanLogBox.setScrollPerc(100);
          screen.render();
        }

        addCleanLog(fg(C.accent, 'Step 3/3') + ' ' + b('Cleaning ' + toClean.length + ' items...'));
        addCleanLog('');

        let ci = 0;
        let freed = 0;

        function nextClean() {
          if (ci >= toClean.length) {
            run('sync');
            setTimeout(() => {
              const diskAfter = getDisk();
              const actual = diskAfter.avail - diskBefore.avail;
              addCleanLog('');
              addCleanLog(fg(C.green, b('>> Done!')) + '  ~' + fg(C.green, b(fmt(freed))) + ' freed');
              addCleanLog('  ' + dim('Free space: ' + fmt(diskBefore.avail) + ' -> ' + fmt(diskAfter.avail)));
              if (actual < freed * 0.5) {
                addCleanLog('  ' + dim('Note: macOS may take a moment to release all space'));
              }
              addCleanLog('');
              addCleanLog(dim('Press esc to go back.'));
              setFoot(b('esc') + ' back');
              cleanLogBox.focus();
            }, 1500);
            return;
          }

          const item = toClean[ci];
          addCleanLog('  ' + fg(C.cyan, '>') + ' ' + item.name + dim('...'));

          exec(item.cmd, { encoding: 'utf8', timeout: 60000 }, (err) => {
            if (err) {
              addCleanLog('    ' + fg(C.yellow, '! ' + err.message.split('\n')[0].slice(0, 60)));
            } else {
              freed += item.size;
              addCleanLog('    ' + fg(C.green, 'v') + ' cleaned  ' + dim(fmt(item.size)));
            }
            ci++;
            nextClean();
          });
        }

        nextClean();
      }
    });

    setFoot(b('space') + ' toggle  ' + b('a') + ' all  ' + b('s') + ' safe only  ' + b('enter') + ' clean  ' + b('esc') + ' back');
    list.focus();
    screen.render();
  });
}

// ─── View: Cache & Temp Cleaner ─────────────────────────────────────────────

function showCacheCleaner() {
  clearMain();
  setHeader('Cache & Temp');
  curView = 'checklist';

  const spinBox = blessed.box({
    parent: main, top: 1, left: 4, width: '90%', height: 1,
    tags: true, style: { fg: C.accent, bg: C.bg }, content: '',
  });
  const stopSpin = spinner(spinBox, '  Scanning');
  screen.render();

  const defs = getCleanableDefs();
  scanItemsLive(defs, (item, idx, total) => {
    spinBox.setContent('  Scanning... ' + (idx + 1) + '/' + total + '  ' + dim(item.name) + (item.size > 0 ? ' ' + fg(C.green, fmt(item.size)) : ''));
    screen.render();
  }).then(items => {
    stopSpin();
    spinBox.detach();
    // Dedup by name (in case scan fires twice)
    const seen = new Set();
    const unique = items.filter(i => { if (seen.has(i.name)) return false; seen.add(i.name); return true; });
    showChecklist('Cache & Temp', unique);
  });
}

// ─── Generic Checklist ──────────────────────────────────────────────────────

function showChecklist(title, items) {
  clearMain();
  setHeader(title);
  curView = 'checklist';

  if (items.length === 0) {
    blessed.box({
      parent: main, top: 2, left: 4, width: '90%', height: 3,
      tags: true, style: { fg: C.green, bg: C.bg },
      content: '* Nothing to clean here!',
    });
    setFoot(b('esc') + ' back');
    screen.render();
    return;
  }

  const maxSize = items[0].size;
  const selected = new Set();

  function buildRow(item, i) {
    const chk = selected.has(i) ? '[x]' : '[ ]';
    const bar = sBar(item.size / maxSize, 12);
    const tag = item.safe === false ? '  ' + fg(C.yellow, '!') : '';
    return '  ' + chk + ' ' + item.name.padEnd(24) + fmt(item.size).padStart(10) + '  ' + bar + '  ' + dim(item.hint) + tag;
  }

  function rebuildList() {
    const rows = items.map((item, i) => buildRow(item, i));
    const idx = list ? list.selected : 0;
    list.setItems(rows);
    list.select(Math.min(idx, items.length - 1));
    screen.render();
  }

  const list = blessed.list({
    parent: main, top: 1, left: 2, width: '95%', height: items.length,
    items: items.map((item, i) => buildRow(item, i)),
    tags: true, keys: false, vi: false, mouse: true,
    style: { fg: C.fg, bg: C.bg, selected: { fg: '#ffffff', bg: C.sel, bold: true } },
  });

  const totalBox = blessed.box({
    parent: main, top: items.length + 2, left: 2, width: '95%', height: 2,
    tags: true, style: { fg: C.fg, bg: C.bg },
    content: '  ' + dim('space=toggle  a=all  s=safe  enter=clean'),
  });

  function updateTotal() {
    let total = 0;
    selected.forEach(i => { if (items[i]) total += items[i].size; });
    if (selected.size > 0) {
      totalBox.setContent('  ' + fg(C.green, selected.size + ' selected -> ~' + b(fmt(total)) + ' reclaimable'));
    } else {
      totalBox.setContent('  ' + dim('space=toggle  a=all  s=safe  enter=clean'));
    }
    screen.render();
  }

  list.on('keypress', (ch, key) => {
    if (key.name === 'up' || ch === 'k') { list.up(1); screen.render(); }
    if (key.name === 'down' || ch === 'j') { list.down(1); screen.render(); }

    const idx = list.selected;

    if (key.name === 'space') {
      if (idx >= items.length) return;
      if (selected.has(idx)) selected.delete(idx);
      else selected.add(idx);
      rebuildList();
      updateTotal();
    }
    if (ch === 'a') {
      const allSel = selected.size === items.length;
      for (let i = 0; i < items.length; i++) {
        if (allSel) selected.delete(i);
        else selected.add(i);
      }
      rebuildList();
      updateTotal();
    }
    if (ch === 's') {
      selected.clear();
      for (let i = 0; i < items.length; i++) {
        if (items[i].safe !== false) selected.add(i);
      }
      rebuildList();
      updateTotal();
    }
    if (key.name === 'return' && selected.size > 0) {
      confirmAndClean(items, selected);
    }
  });

  setFoot(b('space') + ' toggle  ' + b('a') + ' all  ' + b('s') + ' safe  ' + b('enter') + ' clean  ' + b('esc') + ' back');
  list.focus();
  screen.render();
}

// ─── Confirm & Clean ────────────────────────────────────────────────────────

function confirmAndClean(items, selectedSet) {
  const toClean = Array.from(selectedSet).map(i => items[i]);
  const totalSize = toClean.reduce((s, i) => s + (i.size || 0), 0);

  let typed = '';
  const showItems = toClean.slice(0, 8);
  const moreCount = toClean.length - showItems.length;
  const boxH = showItems.length + (moreCount > 0 ? 1 : 0) + 12;

  const box = blessed.box({
    parent: screen, top: 'center', left: 'center',
    width: 58, height: Math.min(boxH, screen.height - 2),
    tags: true, border: { type: 'line', fg: C.red },
    style: { fg: C.fg, bg: C.panel }, padding: 1,
    content: '',
  });

  function renderConfirm() {
    const target = 'DELETE';
    let typedDisplay = '';
    for (let i = 0; i < target.length; i++) {
      if (i < typed.length) typedDisplay += fg(C.green, b(typed[i]));
      else if (i === typed.length) typedDisplay += fg('#ffffff', b('_'));
      else typedDisplay += fg(C.dim, target[i]);
    }

    const lines = [
      ctr(b(fg(C.red, '! Confirm Cleanup'))),
      '',
      ...showItems.map(i => '  * ' + i.name.padEnd(28) + fg(C.yellow, fmt(i.size || 0).padStart(10))),
    ];
    if (moreCount > 0) lines.push('  ' + dim('... and ' + moreCount + ' more'));
    lines.push(
      '',
      ctr(b('~' + fmt(totalSize) + ' will be freed')),
      '',
      ctr('Type ' + b(fg(C.red, 'DELETE')) + ' to confirm:'),
      '',
      ctr('>>  [ ' + typedDisplay + ' ]  <<'),
      '',
      ctr(dim('esc = cancel   backspace = undo')),
    );

    box.setContent(lines.join('\n'));
    screen.render();
  }

  renderConfirm();
  popupOpen = true;
  box.focus();

  box.on('keypress', (ch, key) => {
    if (key.name === 'escape') {
      popupOpen = false; box.detach(); screen.render();
      return;
    }
    if (key.name === 'backspace') {
      typed = typed.slice(0, -1);
      renderConfirm();
      return;
    }

    const target = 'DELETE';
    if (ch && ch.length === 1 && typed.length < target.length) {
      const upper = ch.toUpperCase();
      if (upper === target[typed.length]) {
        typed += upper;
        renderConfirm();

        if (typed === target) {
          popupOpen = false; box.detach();
          executeClean(toClean);
        }
      } else {
        typed = '';
        renderConfirm();
      }
    }
  });
}

function executeClean(toClean) {
  popupOpen = false;
  clearMain();
  setHeader('Cleaning...');

  const logBox = blessed.box({
    parent: main, top: 0, left: 2, width: '95%', height: '100%',
    tags: true, scrollable: true, alwaysScroll: true,
    keys: true, vi: true, mouse: true,
    style: { fg: C.fg, bg: C.bg }, content: '',
  });

  const diskBefore = getDisk();
  let log = b('Cleaning ' + toClean.length + ' items...') + '\n\n';
  let freed = 0;
  let idx = 0;

  function addLog(line) {
    log += line + '\n';
    logBox.setContent(log);
    logBox.setScrollPerc(100);
    screen.render();
  }

  function next() {
    if (idx >= toClean.length) {
      run('sync');
      // Wait a moment for APFS to update free space
      setTimeout(() => {
        const diskAfter = getDisk();
        const actual = diskAfter.avail - diskBefore.avail;
        addLog('');
        addLog(fg(C.green, b('>> Done!')) + '  ~' + fg(C.green, b(fmt(freed))) + ' freed');
        addLog('  ' + dim('Free space: ' + fmt(diskBefore.avail) + ' -> ' + fmt(diskAfter.avail)));
        if (actual < freed * 0.5) {
          addLog('  ' + dim('Note: macOS may take a moment to release all space'));
        }
        addLog('');
        addLog(dim('Press esc to go back.'));
        setFoot(b('esc') + ' back');
        logBox.focus();
      }, 1500);
      return;
    }

    const item = toClean[idx];
    addLog('  ' + fg(C.cyan, '>') + ' ' + item.name + dim('...'));

    exec(item.cmd, { encoding: 'utf8', timeout: 60000 }, (err) => {
      if (err) {
        addLog('    ' + fg(C.yellow, '! ' + err.message.split('\n')[0].slice(0, 60)));
      } else {
        freed += item.size || 0;
        addLog('    ' + fg(C.green, 'v') + '  ' + dim(fmt(item.size)));
      }
      idx++;
      next();
    });
  }

  next();
}

// ─── View: Docker Cleanup ───────────────────────────────────────────────────

function showDockerCleanup() {
  clearMain();
  setHeader('Docker Cleanup');
  curView = 'docker';

  const dockerOk = run('docker info 2>/dev/null');
  const vmDiskSize = dirSize(HOME + '/Library/Containers/com.docker.docker');

  if (!dockerOk) {
    blessed.box({
      parent: main, top: 2, left: 4, width: '90%', height: 7,
      tags: true, style: { fg: C.fg, bg: C.bg },
      border: { type: 'line', fg: C.border },
      content: [
        '',
        '  ' + fg(C.yellow, 'Docker is not running'),
        '',
        '  ' + dim('Docker VM disk on this Mac: ') + b(fmt(vmDiskSize)),
        '  ' + dim('Start Docker Desktop to cleanup, or uninstall to reclaim all of it.'),
      ].join('\n'),
    });
    setFoot(b('esc') + ' back');
    screen.render();
    return;
  }

  const df = run('docker system df 2>/dev/null');

  // Parse docker system df for reclaimable sizes
  const dfLines = df.split('\n').slice(1); // skip header
  let totalReclaimable = 0;
  for (const line of dfLines) {
    const m = line.match(/(\d+\.?\d*)(kB|MB|GB|TB)\s*\((\d+)%\)\s*$/);
    if (m) {
      const units = { kB: 1024, MB: 1024*1024, GB: 1024*1024*1024, TB: 1024*1024*1024*1024 };
      totalReclaimable += parseFloat(m[1]) * (units[m[2]] || 1);
    }
  }

  // Explain the gap
  const infoLines = [
    '  ' + b(fg(C.accent, 'Docker Disk Usage')),
    '',
    '  ' + df.replace(/\n/g, '\n  '),
    '',
    '  ' + dim('VM disk on this Mac: ') + b(fmt(vmDiskSize)),
    '  ' + dim('The VM disk is bigger than images+volumes because Docker'),
    '  ' + dim('pre-allocates space. Reclaim with "Compact" or prune below.'),
  ];

  blessed.box({
    parent: main, top: 1, left: 2, width: '95%', height: infoLines.length + 2,
    tags: true, style: { fg: C.fg, bg: C.bg },
    border: { type: 'line', fg: C.border },
    content: infoLines.join('\n'),
  });

  const listTop = infoLines.length + 4;

  const items = [
    { name: 'Dangling Images',    hint: 'untagged image layers nobody uses',              size: 0, cmd: 'docker image prune -f 2>/dev/null; exit 0',   safe: true },
    { name: 'Stopped Containers', hint: 'containers that exited and sit idle',            size: 0, cmd: 'docker container prune -f 2>/dev/null; exit 0', safe: true },
    { name: 'Unused Volumes',     hint: 'data volumes not attached to any container',     size: 0, cmd: 'docker volume prune -f 2>/dev/null; exit 0',  safe: true },
    { name: 'Build Cache',        hint: 'cached layers from docker build',                size: 0, cmd: 'docker builder prune -f 2>/dev/null; exit 0', safe: true },
    { name: 'FULL PRUNE',         hint: 'removes ALL images/volumes not currently in use', size: 0, cmd: 'docker system prune -a --volumes -f 2>/dev/null; exit 0', safe: false },
  ];

  const selected = new Set();

  function buildDockerRow(item, i) {
    const chk = selected.has(i) ? '[x]' : '[ ]';
    if (!item.safe) return '  ' + chk + ' ' + fg(C.red, item.name.padEnd(22)) + fg(C.red, item.hint);
    return '  ' + chk + ' ' + item.name.padEnd(22) + dim(item.hint);
  }

  function rebuildDockerList() {
    const rows = items.map((item, i) => buildDockerRow(item, i));
    const idx = list ? list.selected : 0;
    list.setItems(rows);
    list.select(Math.min(idx, items.length - 1));
    screen.render();
  }

  blessed.box({
    parent: main, top: listTop, left: 4, width: '90%', height: 1,
    tags: true, style: { fg: C.fg, bg: C.bg },
    content: dim('Top 4 = safe cleanup  |  FULL PRUNE = re-downloads images next time'),
  });

  const list = blessed.list({
    parent: main, top: listTop + 2, left: 2, width: '95%',
    height: items.length,
    items: items.map((item, i) => buildDockerRow(item, i)),
    tags: true, keys: false, vi: false, mouse: true,
    style: { fg: C.fg, bg: C.bg, selected: { fg: '#ffffff', bg: C.sel, bold: true } },
  });

  list.on('keypress', (ch, key) => {
    if (key.name === 'up' || ch === 'k') { list.up(1); screen.render(); }
    if (key.name === 'down' || ch === 'j') { list.down(1); screen.render(); }

    if (key.name === 'space') {
      const idx = list.selected;
      if (idx >= items.length) return;
      if (selected.has(idx)) selected.delete(idx);
      else selected.add(idx);
      rebuildDockerList();
    }
    if (key.name === 'return' && selected.size > 0) {
      confirmAndClean(items, selected);
    }
  });

  setFoot(b('space') + ' toggle  ' + b('enter') + ' clean  ' + b('esc') + ' back');
  list.focus();
  screen.render();
}

// ─── View: Cloud Data ───────────────────────────────────────────────────────

function showCloudCache() {
  clearMain();
  setHeader('Cloud Data');
  curView = 'cloud';

  const items = [
    { name: 'Photos Library',      path: HOME + '/Pictures/Photos Library.photoslibrary', hint: 'Use "Optimize Mac Storage" in Photos prefs', canClean: false },
    { name: 'Mail Downloads',      path: HOME + '/Library/Mail Downloads', hint: 'Attachments you opened from emails', canClean: true, cmd: 'find "' + HOME + '/Library/Mail Downloads" -mindepth 1 -maxdepth 1 -exec rm -rf {} + 2>/dev/null; exit 0' },
    { name: 'Mail Data',           path: HOME + '/Library/Mail', hint: 'Local IMAP/Exchange cache', canClean: false },
    { name: 'iCloud Drive Cache',  path: HOME + '/Library/Mobile Documents', hint: 'Right-click in Finder > Remove Download', canClean: false },
    { name: 'iMessage Attachments', path: HOME + '/Library/Messages/Attachments', hint: 'Pics & vids from chats', canClean: true, cmd: 'find "' + HOME + '/Library/Messages/Attachments" -mindepth 1 -maxdepth 1 -exec rm -rf {} + 2>/dev/null; exit 0' },
  ].map(i => ({ ...i, size: dirSize(i.path) }));

  const maxSize = Math.max(...items.map(i => i.size), 1);

  const lines = items.map(item => {
    const bar = item.size > 0 ? sBar(item.size / maxSize, 15) : '';
    const tag = item.canClean ? fg(C.green, '[cleanable]') : dim('[info only]');
    return [
      '  ' + b(item.name),
      '    ' + fmt(item.size).padStart(10) + '  ' + bar + '  ' + tag,
      '    ' + dim(item.hint),
      '',
    ].join('\n');
  });

  const box = blessed.box({
    parent: main, top: 1, left: 2, width: '95%', height: '90%',
    tags: true, scrollable: true, alwaysScroll: true,
    keys: true, vi: true, mouse: true,
    style: { fg: C.fg, bg: C.bg },
    border: { type: 'line', fg: C.border },
    content: [
      '  ' + b(fg(C.accent, 'Cloud-Synced Data on This Mac')),
      '', ...lines,
      '  ' + fg(C.yellow, 'Press ' + b('c') + ' to clean Mail Downloads & iMessage Attachments'),
    ].join('\n'),
  });

  box.on('keypress', (ch) => {
    if (ch === 'c' || ch === 'C') {
      const cleanable = items.filter(i => i.canClean && i.size > 0).map(i => ({ ...i, safe: true }));
      if (cleanable.length > 0) confirmAndClean(cleanable, new Set(cleanable.map((_, i) => i)));
    }
  });

  setFoot(b('c') + ' clean safe items  ' + b('esc') + ' back');
  box.focus();
  screen.render();
}

// ─── View: Large Files ──────────────────────────────────────────────────────

function showLargeFiles() {
  clearMain();
  setHeader('Large Files');
  curView = 'large';

  // Explain what we're doing
  blessed.box({
    parent: main, top: 0, left: 2, width: '95%', height: 2,
    tags: true, style: { fg: C.fg, bg: C.bg },
    content: '  ' + b('Searching for files > 50 MB') + '  ' + dim('across your home directory'),
  });

  const progressBox = blessed.box({
    parent: main, top: 2, left: 2, width: '95%', height: 2,
    tags: true, style: { fg: C.accent, bg: C.bg }, content: '',
  });

  screen.render();

  // Scan dirs one by one so we get live progress
  const scanDirs = [
    { name: 'Desktop',          path: HOME + '/Desktop' },
    { name: 'Documents',        path: HOME + '/Documents' },
    { name: 'Downloads',        path: HOME + '/Downloads' },
    { name: 'Developer',        path: HOME + '/Developer' },
    { name: 'Projects',         path: HOME + '/DEUS' },
    { name: 'Pictures',         path: HOME + '/Pictures' },
    { name: 'Movies',           path: HOME + '/Movies' },
    { name: 'Music',            path: HOME + '/Music' },
    { name: 'Library',          path: HOME + '/Library' },
    { name: 'Application Support', path: HOME + '/Library/Application Support' },
    { name: 'Hidden dirs',      path: HOME },  // shallow scan of dotfiles
  ];

  const allFiles = [];
  const seenPaths = new Set();
  let dirIdx = 0;

  function scanNext() {
    if (dirIdx >= scanDirs.length) {
      progressBox.detach();
      showLargeFileResults(allFiles);
      return;
    }

    const dir = scanDirs[dirIdx];
    const barW = 20;
    const filled = Math.round(((dirIdx + 1) / scanDirs.length) * barW);
    const bar = fg(C.accent, '#'.repeat(filled)) + fg(C.empty, '-'.repeat(barW - filled));
    progressBox.setContent(
      '  [' + bar + '] ' + (dirIdx + 1) + '/' + scanDirs.length + '  Scanning ' + dim(dir.name) + '...' +
      '\n  ' + dim(allFiles.length + ' files found so far  |  ' + fmt(allFiles.reduce((s, f) => s + f.size, 0)) + ' total')
    );
    screen.render();

    // For the home dir, only scan shallow (dotfiles); for others scan deep
    const maxdepth = dir.path === HOME ? '-maxdepth 1' : '-maxdepth 6';
    const excludes = '-not -path "*/.Trash/*" -not -path "*/Photos Library*" -not -path "*/node_modules/*" -not -path "*/com.docker.docker/*" -not -path "*/.git/objects/*" -not -path "*/Library/Mail/*"';

    exec(
      'find "' + dir.path + '" ' + maxdepth + ' -type f -size +50M ' + excludes + ' 2>/dev/null',
      { encoding: 'utf8', timeout: 15000 },
      (err, stdout) => {
        const lines = (stdout || '').split('\n').filter(Boolean);
        for (const f of lines) {
          if (seenPaths.has(f)) continue;
          seenPaths.add(f);
          try {
            const s = fs.statSync(f);
            allFiles.push({ path: f, size: s.size, atime: s.atimeMs, mtime: s.mtimeMs, name: path.basename(f) });
          } catch {}
        }
        dirIdx++;
        scanNext();
      }
    );
  }

  scanNext();
}

function showLargeFileResults(files) {
  files.sort((a, b) => b.size - a.size);

  if (!files.length) {
    blessed.box({ parent: main, top: 3, left: 4, width: '90%', height: 3, tags: true, style: { fg: C.fg, bg: C.bg },
      content: dim('No files > 50 MB found. Your disk is tidy!') });
    setFoot(b('esc') + ' back'); screen.render(); return;
  }

  const maxSize = files[0].size;
  const total = files.reduce((s, f) => s + f.size, 0);
  const selected = new Set();

  blessed.box({
    parent: main, top: 0, left: 2, width: '95%', height: 3, tags: true, style: { fg: C.fg, bg: C.bg },
    content: [
      '  ' + b(files.length + ' large files found') + '  |  ' + fg(C.yellow, b(fmt(total))) + ' total',
      '  ' + dim('files > 50 MB across your home directory'),
    ].join('\n'),
  });

  function buildFileRow(f, i) {
    const chk = selected.has(i) ? '[x]' : '[ ]';
    const sp = f.path.replace(HOME, '~');
    const d = sp.length > 42 ? '...' + sp.slice(-39) : sp;
    const days = Math.floor((Date.now() - f.mtime) / 86400000);
    return '  ' + chk + ' ' + fmt(f.size).padStart(10) + '  ' + sBar(f.size / maxSize, 10) + '  ' + dim(days + 'd') + '  ' + d;
  }

  function rebuildFileList() {
    const rows = files.map((f, i) => buildFileRow(f, i));
    const idx = list ? list.selected : 0;
    list.setItems(rows);
    list.select(Math.min(idx, files.length - 1));
    screen.render();
  }

  const totalBox = blessed.box({
    parent: main, top: main.height - 3, left: 2, width: '95%', height: 1,
    tags: true, style: { fg: C.fg, bg: C.bg },
    content: '  ' + dim('space=select  enter=delete selected  o=Finder  i=details'),
  });

  function updateTotal() {
    let sz = 0;
    selected.forEach(i => { if (files[i]) sz += files[i].size; });
    if (selected.size > 0) {
      totalBox.setContent('  ' + fg(C.green, selected.size + ' selected -> ' + b(fmt(sz))) + '  ' + dim('enter=delete  space=toggle'));
    } else {
      totalBox.setContent('  ' + dim('space=select  enter=delete selected  o=Finder  i=details'));
    }
    screen.render();
  }

  const list = blessed.list({
    parent: main, top: 3, left: 2, width: '95%', height: main.height - 7,
    items: files.map((f, i) => buildFileRow(f, i)),
    tags: true, mouse: true, scrollable: true, keys: false, vi: false,
    style: { fg: C.fg, bg: C.bg, selected: { fg: '#ffffff', bg: C.sel, bold: true } },
  });

  list.on('keypress', (ch, key) => {
    if (key.name === 'up' || ch === 'k') { list.up(1); screen.render(); return; }
    if (key.name === 'down' || ch === 'j') { list.down(1); screen.render(); return; }

    const idx = list.selected;
    if (idx >= files.length) return;
    const f = files[idx];

    if (key.name === 'space') {
      if (selected.has(idx)) selected.delete(idx);
      else selected.add(idx);
      rebuildFileList();
      updateTotal();
    }
    if (key.name === 'return' && selected.size > 0) {
      confirmDeleteFiles(files, selected, showLargeFiles);
    }
    if (ch === 'i' && f) showFilePopup(f);
    if (ch === 'o' && f) run('open -R "' + f.path + '"');
    if (ch === 'a') {
      const allSel = selected.size === files.length;
      for (let i = 0; i < files.length; i++) {
        if (allSel) selected.delete(i);
        else selected.add(i);
      }
      rebuildFileList();
      updateTotal();
    }
  });

  setFoot(b('space') + ' select  ' + b('a') + ' all  ' + b('enter') + ' delete  ' + b('i') + ' info  ' + b('o') + ' Finder  ' + b('esc') + ' back');
  list.focus(); screen.render();
}

function confirmDeleteFiles(files, selectedSet, onDone) {
  const toDelete = Array.from(selectedSet).map(i => files[i]);
  const totalSize = toDelete.reduce((s, f) => s + f.size, 0);

  // Track typed characters for "DELETE" confirmation
  let typed = '';

  // Show max 5 files in the dialog
  const showFiles = toDelete.slice(0, 5);
  const moreCount = toDelete.length - showFiles.length;
  const boxHeight = showFiles.length + (moreCount > 0 ? 1 : 0) + 14;

  const box = blessed.box({
    parent: screen, top: 'center', left: 'center',
    width: 60, height: Math.min(boxHeight, screen.height - 2),
    tags: true, border: { type: 'line', fg: C.red },
    style: { fg: C.fg, bg: C.panel }, padding: 1,
    content: '',
  });

  function renderBox() {
    const target = 'DELETE';
    // Build the visual typing indicator
    let typedDisplay = '';
    for (let i = 0; i < target.length; i++) {
      if (i < typed.length) {
        typedDisplay += fg(C.green, b(typed[i]));
      } else if (i === typed.length) {
        typedDisplay += fg('#ffffff', b('_'));
      } else {
        typedDisplay += fg(C.dim, target[i]);
      }
    }

    const lines = [
      ctr(b(fg(C.red, '! DELETE ' + toDelete.length + ' FILES'))),
      '',
      ...showFiles.map(f => '  ' + fg(C.yellow, fmt(f.size).padStart(10)) + '  ' + f.name),
    ];
    if (moreCount > 0) lines.push('  ' + dim('... and ' + moreCount + ' more'));
    lines.push(
      '',
      ctr(fg(C.red, b('~' + fmt(totalSize))) + ' will be ' + fg(C.red, b('permanently deleted'))),
      '',
      ctr(fg(C.border, '- - - - - - - - - - - - - - -')),
      '',
      ctr('Type the word DELETE to confirm:'),
      '',
      ctr('>>  [ ' + typedDisplay + ' ]  <<'),
      '',
      ctr(dim('esc = cancel   backspace = undo')),
    );

    box.setContent(lines.join('\n'));
    screen.render();
  }

  renderBox();

  popupOpen = true;
  box.focus();

  box.on('keypress', (ch, key) => {
    if (key.name === 'escape') {
      popupOpen = false; box.detach(); screen.render();
      return;
    }
    if (key.name === 'backspace') {
      typed = typed.slice(0, -1);
      renderBox();
      return;
    }

    const target = 'DELETE';
    if (ch && ch.length === 1 && typed.length < target.length) {
      const upper = ch.toUpperCase();
      if (upper === target[typed.length]) {
        typed += upper;
        renderBox();

        if (typed === target) {
          popupOpen = false; box.detach();
          // Execute deletion
          let freed = 0;
          let deleted = 0;
          let errors = 0;
          for (const f of toDelete) {
            try {
              fs.unlinkSync(f.path);
              freed += f.size;
              deleted++;
            } catch { errors++; }
          }
          // Flush filesystem so diskutil reports updated free space
          run('sync');

          const resultBox = blessed.box({
            parent: screen, top: 'center', left: 'center', width: 50, height: 5,
            tags: true, border: { type: 'line', fg: C.green },
            style: { fg: C.fg, bg: C.panel }, padding: 1,
            content: [
              ctr(fg(C.green, b('Deleted ' + deleted + ' files'))),
              ctr(fg(C.green, fmt(freed) + ' freed')),
              errors > 0 ? ctr(fg(C.yellow, errors + ' files could not be deleted')) : '',
            ].join('\n'),
          });
          screen.render();
          setTimeout(() => { resultBox.detach(); if (onDone) onDone(); else showMenu(); }, 2000);
        }
      } else {
        // Wrong key, reset
        typed = '';
        renderBox();
      }
    }
  });
}

function showFilePopup(file) {
  const age = Math.floor((Date.now() - file.mtime) / 86400000);
  const lastAccess = Math.floor((Date.now() - file.atime) / 86400000);
  const ext = path.extname(file.name).toLowerCase();

  const box = blessed.box({
    parent: screen, top: 'center', left: 'center', width: 64, height: 14,
    tags: true, mouse: true,
    border: { type: 'line', fg: C.accent },
    style: { fg: C.fg, bg: C.panel }, padding: 1,
    content: [
      ctr(b(fg(C.accent, 'File Details'))),
      '',
      '  Name:     ' + file.name,
      '  Path:     ' + file.path.replace(HOME, '~'),
      '  Size:     ' + b(fmt(file.size)),
      '  Type:     ' + (ext || 'unknown'),
      '  Modified: ' + age + ' days ago',
      '  Accessed: ' + lastAccess + ' days ago',
      '',
      ctr(dim('[o] Finder   [esc/click outside] close')),
    ].join('\n'),
  });

  function closePopup() { popupOpen = false; box.detach(); screen.render(); }

  popupOpen = true;
  box.focus(); screen.render();
  box.key(['escape', 'q'], closePopup);
  box.on('click', () => {}); // absorb clicks on the box itself
  box.onceKey(['o'], () => { run('open -R "' + file.path + '"'); });

  // Close on click outside the box
  screen.once('click', (data) => {
    // Check if click is outside the box area
    const bTop = box.atop || 0;
    const bLeft = box.aleft || 0;
    const bWidth = box.width || 0;
    const bHeight = box.height || 0;
    if (data.y < bTop || data.y >= bTop + bHeight || data.x < bLeft || data.x >= bLeft + bWidth) {
      closePopup();
    }
  });
}

// ─── View: Downloads Review ─────────────────────────────────────────────────

function showDownloads() {
  clearMain();
  setHeader('Downloads Review');
  curView = 'downloads';

  const spinBox = blessed.box({
    parent: main, top: 1, left: 4, width: '90%', height: 1,
    tags: true, style: { fg: C.accent, bg: C.bg }, content: '',
  });
  const stopSpin = spinner(spinBox, '  Checking Downloads');
  screen.render();

  const dlDir = HOME + '/Downloads';
  exec(
    'find "' + dlDir + '" -type f \\( -name "*.dmg" -o -name "*.pkg" -o -name "*.zip" -o -name "*.tar" -o -name "*.tar.gz" -o -name "*.tgz" -o -name "*.iso" -o -name "*.rar" -o -name "*.7z" \\) 2>/dev/null',
    { encoding: 'utf8', timeout: 30000 },
    (err, stdout) => {
      const installers = new Set((stdout || '').split('\n').filter(Boolean));

      exec(
        'find "' + dlDir + '" -type f -atime +30 -size +1M 2>/dev/null | head -80',
        { encoding: 'utf8', timeout: 30000 },
        (err2, stdout2) => {
          stopSpin(); spinBox.detach();
          const oldFiles = (stdout2 || '').split('\n').filter(Boolean);
          const allPaths = new Set([...installers, ...oldFiles]);

          const files = Array.from(allPaths).map(f => {
            try { const s = fs.statSync(f); return { path: f, size: s.size, atime: s.atimeMs, name: path.basename(f), isInstaller: installers.has(f) }; }
            catch { return null; }
          }).filter(Boolean).sort((a, b) => b.size - a.size);

          if (!files.length) {
            blessed.box({ parent: main, top: 2, left: 4, width: '90%', height: 3, tags: true, style: { fg: C.green, bg: C.bg },
              content: '* Downloads is clean!\n' + dim('  No old installers or stale downloads.') });
            setFoot(b('esc') + ' back'); screen.render(); return;
          }

          const maxSize = files[0].size;
          const total = files.reduce((s, f) => s + f.size, 0);
          const instCnt = files.filter(f => f.isInstaller).length;
          const selected = new Set();

          blessed.box({
            parent: main, top: 0, left: 2, width: '95%', height: 3, tags: true, style: { fg: C.fg, bg: C.bg },
            content: [
              '  ' + b(files.length + ' files') + '  |  ' + fg(C.magenta, instCnt + ' installers') + '  |  ' + fg(C.yellow, b(fmt(total))),
              '  ' + dim('.dmg/.pkg/.zip/.iso + anything untouched 30+ days'),
            ].join('\n'),
          });

          function buildDlRow(f, i) {
            const chk = selected.has(i) ? '[x]' : '[ ]';
            const days = Math.floor((Date.now() - f.atime) / 86400000);
            const tag = f.isInstaller ? fg(C.magenta, ' [installer]') : '';
            const n = f.name.length > 32 ? f.name.slice(0, 29) + '...' : f.name;
            return '  ' + chk + ' ' + fmt(f.size).padStart(10) + '  ' + sBar(f.size / maxSize, 10) + '  ' + dim(days + 'd') + '  ' + n + tag;
          }

          function rebuildDlList() {
            const rows = files.map((f, i) => buildDlRow(f, i));
            const idx = list ? list.selected : 0;
            list.setItems(rows);
            list.select(Math.min(idx, files.length - 1));
            screen.render();
          }

          const totalBox = blessed.box({
            parent: main, top: main.height - 3, left: 2, width: '95%', height: 1,
            tags: true, style: { fg: C.fg, bg: C.bg },
            content: '  ' + dim('space=select  a=all  enter=delete  i=info  o=Finder'),
          });

          function updateTotal() {
            let sz = 0;
            selected.forEach(i => { if (files[i]) sz += files[i].size; });
            if (selected.size > 0) {
              totalBox.setContent('  ' + fg(C.green, selected.size + ' selected -> ' + b(fmt(sz))) + '  ' + dim('enter=delete  space=toggle'));
            } else {
              totalBox.setContent('  ' + dim('space=select  a=all  enter=delete  i=info  o=Finder'));
            }
            screen.render();
          }

          const list = blessed.list({
            parent: main, top: 4, left: 2, width: '95%', height: main.height - 8,
            items: files.map((f, i) => buildDlRow(f, i)),
            tags: true, keys: false, vi: false, mouse: true, scrollable: true,
            style: { fg: C.fg, bg: C.bg, selected: { fg: '#ffffff', bg: C.sel, bold: true } },
          });

          list.on('keypress', (ch, key) => {
            if (key.name === 'up' || ch === 'k') { list.up(1); screen.render(); return; }
            if (key.name === 'down' || ch === 'j') { list.down(1); screen.render(); return; }

            const idx = list.selected;
            if (idx >= files.length) return;
            const f = files[idx];

            if (key.name === 'space') {
              if (selected.has(idx)) selected.delete(idx);
              else selected.add(idx);
              rebuildDlList();
              updateTotal();
            }
            if (key.name === 'return' && selected.size > 0) {
              confirmDeleteFiles(files, selected, showDownloads);
            }
            if (ch === 'i' && f) showFilePopup(f);
            if (ch === 'o' && f) run('open -R "' + f.path + '"');
            if (ch === 'a') {
              const allSel = selected.size === files.length;
              for (let i = 0; i < files.length; i++) {
                if (allSel) selected.delete(i);
                else selected.add(i);
              }
              rebuildDlList();
              updateTotal();
            }
          });

          setFoot(b('space') + ' select  ' + b('a') + ' all  ' + b('enter') + ' delete  ' + b('i') + ' info  ' + b('o') + ' Finder  ' + b('esc') + ' back');
          list.focus(); screen.render();
        }
      );
    }
  );
}

// ─── View: Stale Documents ──────────────────────────────────────────────────

function showStale() {
  clearMain();
  setHeader('Stale Documents');
  curView = 'stale';

  const spinBox = blessed.box({
    parent: main, top: 1, left: 4, width: '90%', height: 1,
    tags: true, style: { fg: C.accent, bg: C.bg }, content: '',
  });
  const stopSpin = spinner(spinBox, '  Looking for forgotten files');
  screen.render();

  exec(
    'find "' + HOME + '/Documents" "' + HOME + '/Downloads" "' + HOME + '/Desktop" -type f -size +10M -atime +90 2>/dev/null | head -80',
    { encoding: 'utf8', timeout: 60000 },
    (err, stdout) => {
      stopSpin(); spinBox.detach();

      const files = (stdout || '').split('\n').filter(Boolean).map(f => {
        try { const s = fs.statSync(f); return { path: f, size: s.size, atime: s.atimeMs, mtime: s.mtimeMs, name: path.basename(f) }; }
        catch { return null; }
      }).filter(Boolean).sort((a, b) => b.size - a.size);

      if (!files.length) {
        blessed.box({ parent: main, top: 2, left: 4, width: '90%', height: 4, tags: true, style: { fg: C.fg, bg: C.bg },
          content: [
            fg(C.green, '* No stale documents found!'),
            '', dim('  Searched ~/Documents, ~/Downloads, ~/Desktop'),
            dim('  Criteria: >10MB, untouched 90+ days'),
          ].join('\n') });
        setFoot(b('esc') + ' back'); screen.render(); return;
      }

      const maxSize = files[0].size;
      const total = files.reduce((s, f) => s + f.size, 0);

      blessed.box({
        parent: main, top: 0, left: 2, width: '95%', height: 2, tags: true, style: { fg: C.fg, bg: C.bg },
        content: '  ' + b(files.length + ' stale files') + '  |  ' + fg(C.yellow, b(fmt(total))) + '  |  ' + dim('untouched 90+ days'),
      });

      const listItems = files.map((f, i) => {
        const days = Math.floor((Date.now() - f.atime) / 86400000);
        const sp = f.path.replace(HOME, '~');
        const d = sp.length > 42 ? '...' + sp.slice(-39) : sp;
        return '  ' + fmt(f.size).padStart(10) + '  ' + sBar(f.size / maxSize, 10) + '  ' + dim(days + 'd ago') + '  ' + d;
      });

      const list = blessed.list({
        parent: main, top: 3, left: 2, width: '95%', height: main.height - 6,
        items: listItems, tags: true, keys: true, vi: true, mouse: true, scrollable: true,
        style: { fg: C.fg, bg: C.bg, selected: { fg: '#ffffff', bg: C.sel, bold: true } },
      });

      list.on('keypress', (ch, key) => {
        const f = files[list.selected];
        if (key.name === 'return') showFilePopup(f);
        if (ch === 'o') run('open -R "' + f.path + '"');
      });

      setFoot(b('enter') + ' details  ' + b('o') + ' Finder  ' + b('esc') + ' back');
      list.focus(); screen.render();
    }
  );
}

// ─── View: Credits ──────────────────────────────────────────────────────────

function showCredits() {
  const box = blessed.box({
    parent: screen, top: 'center', left: 'center', width: 52, height: 17,
    tags: true, mouse: true,
    border: { type: 'line', fg: C.accent },
    style: { fg: C.fg, bg: C.panel }, padding: 1,
    content: [
      '',
      ctr(rainbow('Clean This Shit')),
      ctr(dim('v' + VERSION)),
      '',
      ctr(fg(C.accent, '- - - - - - - - - - - -')),
      '',
      ctr(b('Made by ') + fg(C.cyan, b('andycufari'))),
      '',
      ctr(dim('github.com/andycufari/clean-this-shit')),
      '',
      ctr(fg(C.accent, '- - - - - - - - - - - -')),
      '',
      ctr(dim('Built with Node.js + blessed')),
      '',
      ctr(dim('[esc] close')),
    ].join('\n'),
  });

  function close() { popupOpen = false; box.detach(); screen.render(); }

  popupOpen = true;
  box.focus(); screen.render();
  box.key(['escape', 'q', 'return'], close);
  screen.once('click', close);
}

// ─── Global Keys ────────────────────────────────────────────────────────────

screen.key(['escape'], () => {
  if (popupOpen) return; // let the popup handle its own esc
  if (curView && curView !== 'menu') showMenu();
});
screen.key(['q', 'C-c'], () => process.exit(0));

// ─── Start ──────────────────────────────────────────────────────────────────

if (AUTO_MODE) {
  showAutoClean();
} else {
  showMenu();
}
screen.render();
