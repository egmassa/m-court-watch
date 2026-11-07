// 三鷹テニスコート 空き監視スクリプト(GitHub Actions 用)
// コートチェッカー(mitaka-tennis-checker.user.js)と同じデータ
//   https://yoyaku-mitaka.jp/reservation/room-data/{roomId}/month?year=&month=
// を取得し、config.yml の条件に合う空き枠のうち「前回なかった枠」だけを LINE に通知する。
// LINE の設定(Secrets)が無いときは通知せず、ログと実行サマリーに出すだけ。

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const SITE = 'https://yoyaku-mitaka.jp/reservation';
const STATE_FILE = path.join(__dirname, 'state.json');
// 設定ページのURL(GitHub Pages)。リポジトリ名から自動で作る
const pageUrl = process.env.PAGE_URL || (process.env.GITHUB_REPOSITORY
  ? (([o, r]) => `https://${o.toLowerCase()}.github.io/${r}/`)(process.env.GITHUB_REPOSITORY.split('/'))
  : '');
const WD = ['日', '月', '火', '水', '木', '金', '土'];
const OPEN = 1; // timeslot.status === 1 が空き(コートチェッカーと同じ判定)

const cfg = yaml.load(fs.readFileSync(path.join(__dirname, 'config.yml'), 'utf8')) || {};
const facilities = (cfg.facilities || []).filter(f => f && f.room_id);
const weekdays = (cfg.weekdays || []).map(w => WD.indexOf(String(w)));
const toMin = s => { const [h, m] = String(s).split(':').map(Number); return h * 60 + (m || 0); };
const fromMin = toMin(cfg.time_from || '00:00');
const daysAhead = Number(cfg.days_ahead || 30);

const log = (...a) => console.log(...a);
const pad = n => String(n).padStart(2, '0');

// 日本時間の今日〜N日後を "YYYY-MM-DD" で
const jst = new Date(Date.now() + 9 * 3600e3);
const ymd = d => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const todayUtc = Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth(), jst.getUTCDate());
const startStr = ymd(new Date(todayUtc));
const endStr = ymd(new Date(todayUtc + daysAhead * 86400e3));
const dateFromStr = cfg.date_from ? String(cfg.date_from) : '';
const label = ds => { const d = new Date(ds + 'T00:00:00Z'); return `${d.getUTCMonth() + 1}/${d.getUTCDate()}(${WD[d.getUTCDay()]})`; };

async function getJson(url, tries = 3) {
  for (let i = 1; ; i++) {
    try {
      const res = await fetch(url, {
        headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 (court-watch)' },
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      if (i >= tries) throw e;
      await new Promise(r => setTimeout(r, 3000 * i));
    }
  }
}

async function loadHolidays() {
  if (!cfg.exclude_holidays) return {};
  try { return await getJson('https://holidays-jp.github.io/api/v1/date.json'); }
  catch (e) { log('祝日データの取得に失敗(祝日除外なしで続行):', e.message); return {}; }
}

function monthsInRange() {
  const out = [];
  const s = new Date(startStr + 'T00:00:00Z'), e = new Date(endStr + 'T00:00:00Z');
  for (let y = s.getUTCFullYear(), m = s.getUTCMonth() + 1; y * 12 + m <= e.getUTCFullYear() * 12 + e.getUTCMonth() + 1; m++) {
    if (m > 12) { m = 1; y++; }
    out.push([y, m]);
  }
  return out;
}

async function collect(holidays) {
  const hits = [];
  const errors = [];
  for (const f of facilities) {
    const excluded = (f.exclude_courts || []).map(Number);
    for (const [y, m] of monthsInRange()) {
      let data;
      try {
        data = await getJson(`${SITE}/room-data/${f.room_id}/month?year=${y}&month=${m}`);
      } catch (e) {
        errors.push(`${f.name} ${m}月: ${e.message}`);
        continue;
      }
      const tips = data.tooltip_data || {};
      for (const ds of Object.keys(data.dates || {}).sort()) {
        if (ds < startStr || ds > endStr) continue;
        if (dateFromStr && ds < dateFromStr) continue;
        const dow = new Date(ds + 'T00:00:00Z').getUTCDay();
        if (!weekdays.includes(dow)) continue;
        if (holidays[ds]) continue;
        const units = (tips[ds] && tips[ds].units) || [];
        for (const u of units) {
          const num = ((u.name || '').match(/(\d+)/) || [])[1];
          if (num && excluded.includes(Number(num))) continue;
          for (const ts of u.timeslots || []) {
            if (ts.status !== OPEN) continue;
            if (toMin(ts.start_time) < fromMin) continue;
            hits.push({
              facility: f.name, date: ds, court: u.name || '',
              time: `${ts.start_time}-${ts.end_time}`,
              key: `${f.room_id}|${ds}|${u.name}|${ts.start_time}`,
            });
          }
        }
      }
      await new Promise(r => setTimeout(r, 500)); // サイトに負担をかけないよう少し間隔をあける
    }
  }
  return { hits, errors };
}

// LINE_USER_ID の書き方で送り先が変わる
//   all            → botを友だち追加している全員に送信(ブロードキャスト)
//   Uxxxx          → その1人だけに送信
//   Uxxxx,Uyyyy    → 書いた複数人に送信
async function pushLine(text) {
  const token = process.env.LINE_TOKEN, toRaw = (process.env.LINE_USER_ID || '').trim();
  if (!token || !toRaw) { log('LINE未設定のため通知はスキップ'); return; }
  const messages = [{ type: 'text', text: text.slice(0, 4900) }];
  const ids = toRaw.split(/[,\s]+/).filter(Boolean);
  let endpoint, body;
  if (toRaw.toLowerCase() === 'all') { endpoint = 'broadcast'; body = { messages }; }
  else if (ids.length === 1) { endpoint = 'push'; body = { to: ids[0], messages }; }
  else { endpoint = 'multicast'; body = { to: ids, messages }; }
  log(`LINE送信先: ${endpoint === 'broadcast' ? '友だち全員' : ids.length + '人'}`);
  const r = await fetch(`https://api.line.me/v2/bot/message/${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  log('LINE送信:', r.status, r.ok ? 'OK' : await r.text());
  if (!r.ok) process.exitCode = 1;
}

function summary(md) {
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + '\n');
}

// 同じ施設・日・時間のコートをまとめて1行に
function group(list) {
  const map = new Map();
  for (const h of list) {
    const k = `${h.facility}|${h.date}|${h.time}`;
    if (!map.has(k)) map.set(k, { ...h, courts: [] });
    map.get(k).courts.push(h.court);
  }
  return [...map.values()].sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
}
const lineOf = g => `・${label(g.date)} ${g.time} ${g.courts.join('・')}`;

(async () => {
  if (!facilities.length) { log('config.yml に施設がありません'); process.exit(1); }
  log(`条件: ${facilities.map(f => f.name).join('・')} / ${(cfg.weekdays || []).join('')} / ${cfg.time_from}以降 / ${startStr}〜${endStr}`);

  const holidays = await loadHolidays();
  const { hits, errors } = await collect(holidays);

  if (errors.length) {
    log('取得エラー:\n' + errors.join('\n'));
    summary('### ⚠️ 取得エラー\n' + errors.map(e => `- ${e}`).join('\n'));
    if (errors.length >= facilities.length * monthsInRange().length) {
      // 全部失敗 → 前回結果を消さないようにここで終了
      process.exit(1);
    }
  }

  const reset = process.env.RESET === 'true';
  if (reset) log('基準をリセット: 今の空きをすべて通知します');
  const prev = !reset && fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : { keys: [] };
  const fresh = hits.filter(h => !prev.keys.includes(h.key));

  log(`条件に合う空き: ${hits.length} 枠 / うち新規: ${fresh.length} 枠`);
  const all = group(hits), freshKeys = new Set(fresh.map(h => `${h.facility}|${h.date}|${h.time}`));
  all.forEach(g => log(`${freshKeys.has(`${g.facility}|${g.date}|${g.time}`) ? '🆕' : '  '} ${g.facility} ${lineOf(g).slice(1)}`));
  summary(`### 条件に合う空き ${hits.length} 枠(新規 ${fresh.length} 枠)\n` +
    (all.length ? all.map(g => `- ${freshKeys.has(`${g.facility}|${g.date}|${g.time}`) ? '🆕 ' : ''}${g.facility} ${lineOf(g).slice(1)}`).join('\n') : '- なし'));

  if (fresh.length) {
    const byFac = {};
    group(fresh).forEach(g => (byFac[g.facility] ||= []).push(lineOf(g)));
    const text = '🎾 コートに空きが出ました\n\n' +
      Object.entries(byFac).map(([f, ls]) => `【${f}】\n${ls.join('\n')}`).join('\n\n') +
      (pageUrl ? `\n\n今の空き一覧\n${pageUrl}` : '') +
      `\n\n予約サイト\n${SITE}`;
    await pushLine(text);
  }

  // 取得に失敗した施設・月の枠は前回の記録を残す(復旧時に誤って「新規」扱いしないため)
  const failedPrefixes = errors.length ? prev.keys.filter(k => errors.some(e => {
    const f = facilities.find(x => e.startsWith(x.name + ' '));
    const mo = Number((e.match(/ (\d+)月:/) || [])[1]);
    return f && k.startsWith(f.room_id + '|') && Number(k.split('|')[1].slice(5, 7)) === mo;
  })) : [];
  // 設定ページ(index.html)で表示する一覧。中身が変わったときだけ保存する
  const keys = [...new Set([...hits.map(h => h.key), ...failedPrefixes])].sort();
  const prevSlots = prev.slots || [];
  const keep = prevSlots.filter(s => failedPrefixes.includes(s.key) && !hits.some(h => h.key === s.key));
  const slots = [...hits, ...keep].map(({ facility, date, court, time, key }) => ({ facility, date, court, time, key }))
    .sort((a, b) => (a.date + a.time + a.court).localeCompare(b.date + b.time + b.court));
  const same = JSON.stringify(keys) === JSON.stringify([...(prev.keys || [])].sort()) && prev.slots;
  if (same) { log('空き状況に変化なし(保存なし)'); return; }
  fs.writeFileSync(STATE_FILE, JSON.stringify({ updated: new Date().toISOString(), keys, slots }, null, 1));
})();
