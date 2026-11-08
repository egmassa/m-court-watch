// テニスコート 空き監視スクリプト(GitHub Actions 用)
//   三鷹市   … コートチェッカー(mitaka-tennis-checker.user.js)と同じデータ
//               https://yoyaku-mitaka.jp/reservation/room-data/{roomId}/month?year=&month=
//   都立公園 … コートチェッカー(toei-tennis-checker.user.js)と同じデータ
//               https://kouen.sports.metro.tokyo.lg.jp/web/rsvWOpeInstSrchVacantAjaxAction.do
// を取得し、config.yml のサイトごとの条件に合う空き枠のうち「前回なかった枠」だけを LINE に通知する。
// LINE の設定(Secrets)が無いときは通知せず、ログと実行サマリーに出すだけ。

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const STATE_FILE = path.join(__dirname, 'state.json');
// 設定ページのURL(GitHub Pages)。リポジトリ名から自動で作る
const pageUrl = process.env.PAGE_URL || (process.env.GITHUB_REPOSITORY
  ? (([o, r]) => `https://${o.toLowerCase()}.github.io/${r}/`)(process.env.GITHUB_REPOSITORY.split('/'))
  : '');
const WD = ['日', '月', '火', '水', '木', '金', '土'];
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36';

const cfg = yaml.load(fs.readFileSync(path.join(__dirname, 'config.yml'), 'utf8')) || {};
// LINEに日時を並べる上限(これを超えたら件数の要約だけ送る)
const LINE_MAX = Number(cfg.line_max_items || 10);
// 取られた枠を設定ページに取り消し線で残す時間
const GONE_KEEP_HOURS = Number(cfg.gone_keep_hours || 24);

const log = (...a) => console.log(...a);
const pad = n => String(n).padStart(2, '0');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const toMin = s => { const [h, m] = String(s).split(':').map(Number); return h * 60 + (m || 0); };

// 日本時間の今日
const jst = new Date(Date.now() + 9 * 3600e3);
const ymd = d => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const todayUtc = Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth(), jst.getUTCDate());
const startStr = ymd(new Date(todayUtc));
const label = ds => { const d = new Date(ds + 'T00:00:00Z'); return `${d.getUTCMonth() + 1}/${d.getUTCDate()}(${WD[d.getUTCDay()]})`; };
const addDays = (ds, n) => ymd(new Date(Date.parse(ds + 'T00:00:00Z') + n * 86400e3));

// ---------------- サイトごとの条件 ----------------
// 旧形式(三鷹だけ・トップに facilities)にも対応
function condOf(raw) {
  if (!raw || raw.enabled === false) return null;
  const facilities = (raw.facilities || []).filter(Boolean);
  if (!facilities.length) return null;
  const daysAhead = Number(raw.days_ahead || 30);
  return {
    facilities,
    weekdays: (raw.weekdays || WD).map(w => WD.indexOf(String(w))),
    weekdayLabels: (raw.weekdays || WD).map(String),
    excludeHolidays: !!raw.exclude_holidays,
    timeFrom: String(raw.time_from || '00:00'),
    fromMin: toMin(raw.time_from || '00:00'),
    daysAhead,
    endStr: addDays(startStr, daysAhead),
    dateFrom: raw.date_from ? String(raw.date_from) : '',
  };
}
const legacyMitaka = cfg.facilities ? {
  facilities: cfg.facilities, weekdays: cfg.weekdays, exclude_holidays: cfg.exclude_holidays,
  time_from: cfg.time_from, days_ahead: cfg.days_ahead, date_from: cfg.date_from,
} : null;

// 日付・曜日・祝日・時刻の共通チェック
function passDate(c, ds, holidays) {
  if (ds < startStr || ds > c.endStr) return false;
  if (c.dateFrom && ds < c.dateFrom) return false;
  if (!c.weekdays.includes(new Date(ds + 'T00:00:00Z').getUTCDay())) return false;
  if (c.excludeHolidays && holidays[ds]) return false;
  return true;
}

async function getJson(url, tries = 3) {
  for (let i = 1; ; i++) {
    try {
      const res = await fetch(url, {
        headers: { Accept: 'application/json', 'User-Agent': UA },
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      if (i >= tries) throw e;
      await sleep(3000 * i);
    }
  }
}

// ================= 三鷹市 =================
const MITAKA = {
  id: 'mitaka',
  name: '三鷹',
  bookUrl: 'https://yoyaku-mitaka.jp/reservation',
  prefix: f => `${f.room_id}|`,
  facilities: c => c.facilities.filter(f => f.room_id),
  async collect(c, holidays) {
    const OPEN = 1; // timeslot.status === 1 が空き
    const hits = [], failed = [], seen = new Set();
    const months = [];
    for (let d = new Date(startStr.slice(0, 7) + '-01T00:00:00Z'); ymd(d) <= c.endStr; d.setUTCMonth(d.getUTCMonth() + 1)) {
      months.push([d.getUTCFullYear(), d.getUTCMonth() + 1]);
    }
    for (const f of this.facilities(c)) {
      const excluded = (f.exclude_courts || []).map(Number);
      for (const [y, m] of months) {
        let data;
        try {
          data = await getJson(`${this.bookUrl}/room-data/${f.room_id}/month?year=${y}&month=${m}`);
        } catch (e) {
          const from = `${y}-${pad(m)}-01`;
          failed.push({ prefix: this.prefix(f), from, to: addDays(ymd(new Date(Date.UTC(y, m, 1))), -1), msg: `${f.name} ${m}月: ${e.message}` });
          continue;
        }
        const tips = data.tooltip_data || {};
        for (const ds of Object.keys(data.dates || {}).sort()) {
          if (!passDate(c, ds, holidays)) continue;
          for (const u of (tips[ds] && tips[ds].units) || []) {
            const num = ((u.name || '').match(/(\d+)/) || [])[1];
            if (num && excluded.includes(Number(num))) continue;
            for (const ts of u.timeslots || []) {
              if (ts.status !== OPEN) continue;
              if (toMin(ts.start_time) < c.fromMin) continue;
              const key = `${f.room_id}|${ds}|${u.name}|${ts.start_time}`;
              if (seen.has(key)) continue; // 月をまたぐデータの重複を除く
              seen.add(key);
              hits.push({ site: 'mitaka', facility: f.name, date: ds, court: u.name || '', time: `${ts.start_time}-${ts.end_time}`, key });
            }
          }
        }
        await sleep(500); // サイトに負担をかけないよう少し間隔をあける
      }
    }
    return { hits, failed };
  },
  // 取られた枠の判定用(コート除外)
  courtOk(f, court) {
    const num = ((court || '').match(/(\d+)/) || [])[1];
    return !(num && (f.exclude_courts || []).map(Number).includes(Number(num)));
  },
};

// ================= 都立公園 =================
const TOEI = {
  id: 'toei',
  name: '都立公園',
  bookUrl: 'https://kouen.sports.metro.tokyo.lg.jp/web/',
  base: 'https://kouen.sports.metro.tokyo.lg.jp',
  prefix: f => `toei${f.bld}|`,
  facilities: c => c.facilities.filter(f => f.bld && f.inst),
  courtOk: () => true,
  // コートチェッカーと同じ判定(altの文字を優先)
  isAvailable(item) {
    const alt = item.alt || '', img = item.imgURL || '', s = item.status;
    if (alt) {
      if (alt.includes('期間外')) return false;
      if (alt === '空き' || alt === '一部空き') return true;
      return alt.includes('空き') && !alt.includes('予約') && !alt.includes('なし');
    }
    if (s === 700) return false;
    if (/calendar_(vacant|available|parttime)/.test(img)) return true;
    return img.includes('calendar_') && !/full|maintenance|holiday|non-operating|closed/.test(img);
  },
  async collect(c, holidays) {
    const hits = [], failed = [];
    // クッキー(セッション)を引き継ぐ
    const jar = {};
    const req = async (url, opt = {}) => {
      const cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
      const res = await fetch(url, {
        redirect: 'manual', signal: AbortSignal.timeout(30000), ...opt,
        headers: { 'User-Agent': UA, 'Accept-Language': 'ja', ...(cookie ? { Cookie: cookie } : {}), ...(opt.headers || {}) },
      });
      for (const ck of res.headers.getSetCookie ? res.headers.getSetCookie() : []) {
        const [kv] = ck.split(';'); const i = kv.indexOf('=');
        jar[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
      }
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        return req(new URL(res.headers.get('location'), url).href, { headers: opt.headers });
      }
      return res;
    };
    const form = { 'Content-Type': 'application/x-www-form-urlencoded' };
    const intDay = ds => Number(ds.replace(/-/g, ''));
    const dsOf = n => { const s = String(n); return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`; };
    const hm = t => `${pad(Math.floor(t / 100))}:${pad(t % 100)}`;

    await req(this.base + '/web/');
    // 今週の月曜から
    const dow = new Date(startStr + 'T00:00:00Z').getUTCDay();
    const monday = addDays(startStr, -((dow + 6) % 7));

    for (const f of this.facilities(c)) {
      f._fails = 0;
      const t0 = Date.now(); let weeks = 0;
      let week = monday;
      for (let w = 0; w < 12 && week <= c.endStr; w++) {
        let data = null, reason = '';
        for (let attempt = 1; attempt <= 3 && !data; attempt++) {
          try {
            const useDay = intDay(week);
            await req(this.base + '/web/rsvWOpeInstSrchVacantAction.do', { method: 'POST', headers: form, body: [
              'displayNo=prwrc2000', 'displayNoFrm=prwrc2000', 'applyFlg=0', 'dayofweekClearFlg=1', 'timezoneClearFlg=1',
              'selectPpsClsCd=1000', 'selectPpsCd=1030', `selectBldCd=${f.bld}`, `selectInstCd=${f.inst}`, `iniBCd=${f.bld}`,
              `iniICd=${f.inst}_3`, `useDay=${useDay}`, 'selectSize=0', 'penaltyday=3', `selectAreaBcd=${f.bld}`, 'selectIcd=0',
              'initBcd=null', 'initIcd=null', 'initPpsClPpscd=null'].join('&') });
            await sleep(400); // コートチェッカーの既定値と同じ
            const res = await req(this.base + '/web/rsvWOpeInstSrchVacantAjaxAction.do', { method: 'POST',
              headers: { ...form, 'X-Requested-With': 'XMLHttpRequest' },
              body: ['displayNo=prwrc2000', `useDay=${useDay}`, `bldCd=${f.bld}`, `instCd=${f.inst}`, `transVacantMode=${f.mode || 11}`, 'clearFlag=0'].join('&') });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            // サイトは Shift_JIS で返すので、文字コードを合わせて読む
            const text = new TextDecoder('shift_jis').decode(await res.arrayBuffer());
            const j = JSON.parse(text);
            const items = (j.result || []).reduce((n, tz) => n + (tz.timeResult || []).length, 0);
            if (!items) { reason = 'データ0件'; await sleep(1000); continue; } // 空振りの可能性があるので取り直す
            data = j;
          } catch (e) { reason = e.message; await sleep(1500 * attempt); }
        }
        if (!data) {
          failed.push({ prefix: this.prefix(f), from: week, to: addDays(week, 6), msg: `${f.name} ${label(week)}の週: ${reason}` });
          // 2週続けて失敗したら、その施設は今回あきらめる(残りの週も「失敗」として前回の記録を残す)
          if (++f._fails >= 2) {
            failed.push({ prefix: this.prefix(f), from: addDays(week, 7), to: c.endStr, msg: `${f.name} 以降の週: 連続失敗のため中止` });
            break;
          }
        } else {
          f._fails = 0;
          for (const tz of data.result || []) for (const item of tz.timeResult || []) {
            if (!this.isAvailable(item)) continue;
            const ds = dsOf(item.useDay);
            if (!passDate(c, ds, holidays)) continue;
            if (Math.floor(item.startTime / 100) * 60 + item.startTime % 100 < c.fromMin) continue;
            const start = hm(item.startTime);
            hits.push({
              site: 'toei', facility: f.name, date: ds,
              court: item.alt === '一部空き' ? '一部空き' : '',
              time: `${start}-${hm(item.endTime)}`,
              key: `toei${f.bld}|${ds}||${start}`,
            });
          }
        }
        // 次の週(サイトが返す次週開始日。おかしければ+7日)
        const nw = data && data.nextWeekStartDay ? dsOf(data.nextWeekStartDay) : '';
        week = nw && nw > week ? nw : addDays(week, 7);
        weeks++;
        await sleep(300);
      }
      log(`  ${f.name}: ${weeks}週 ${Math.round((Date.now() - t0) / 1000)}秒`);
    }
    return { hits, failed };
  },
};

const SITES = [
  { mod: MITAKA, cond: condOf(cfg.mitaka || legacyMitaka) },
  { mod: TOEI, cond: condOf(cfg.toei) },
].filter(s => s.cond);
// node watch.js mitaka / node watch.js toei … そのサイトだけ処理する(重い都立公園に三鷹の通知が引きずられないよう分ける)
const ONLY = process.argv[2] || '';
const HANDLED = new Set(ONLY ? [ONLY] : ['mitaka', 'toei']);
const RUN = SITES.filter(s => HANDLED.has(s.mod.id));
const siteOfKey = k => String(k).startsWith('toei') ? 'toei' : 'mitaka';
const mine = k => HANDLED.has(siteOfKey(k));

// ---------------- LINE ----------------
// LINE_USER_ID の書き方で送り先が変わる
//   all            → botを友だち追加している全員に送信(ブロードキャスト)
//   Uxxxx          → その1人だけに送信
//   Uxxxx,Uyyyy    → 書いた複数人に送信
let lineError = null;
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
  const detail = r.ok ? 'OK' : await r.text();
  log('LINE送信:', r.status, detail);
  if (!r.ok) {
    process.exitCode = 1;
    lineError = r.status === 429 && /monthly limit/i.test(detail)
      ? '今月のLINE無料枠(通数の上限)に達したため、通知を送れませんでした'
      : `LINE送信エラー(${r.status})`;
    summary(`### ❌ ${lineError}\n${detail}`);
  }
}

// 今月のLINE使用数(上限/使用済み)と友だち数を調べる
async function lineQuota() {
  const token = process.env.LINE_TOKEN;
  if (!token) return null;
  try {
    const h = { headers: { Authorization: `Bearer ${token}` } };
    // LINEの統計は前日分までなので昨日の日付で問い合わせ
    const y = new Date(Date.now() + 9 * 3600e3 - 86400e3).toISOString().slice(0, 10).replace(/-/g, '');
    const [q, c, f] = await Promise.all([
      fetch('https://api.line.me/v2/bot/message/quota', h).then(r => r.json()),
      fetch('https://api.line.me/v2/bot/message/quota/consumption', h).then(r => r.json()),
      fetch(`https://api.line.me/v2/bot/insight/followers?date=${y}`, h).then(r => r.json()).catch(() => ({})),
    ]);
    const reach = f.status === 'ready' ? (f.targetedReaches ?? (f.followers != null ? f.followers - (f.blocks || 0) : null)) : null;
    return { limit: q.type === 'limited' ? q.value : null, used: c.totalUsage ?? null, reach };
  } catch (e) { log('LINE使用数の取得に失敗:', e.message); return null; }
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
    if (h.court) map.get(k).courts.push(h.court);
  }
  return [...map.values()].sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
}
const lineOf = g => `・${label(g.date)} ${g.time} ${g.courts.join('・')}`.trimEnd();

// ---------------- メイン ----------------
(async () => {
  const reset = process.env.RESET === 'true';
  const prevAll = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : { keys: [] };
  // 他のサイトの記録はそのまま残し、このサイトの分だけ入れ替える
  const others = {
    keys: (prevAll.keys || []).filter(k => !mine(k)),
    slots: (prevAll.slots || []).filter(x => !mine(x.key)),
    gone: (prevAll.gone || []).filter(x => !mine(x.key)),
  };
  const prev = reset ? { keys: [], slots: [], gone: [], line: prevAll.line } : {
    keys: (prevAll.keys || []).filter(mine),
    slots: (prevAll.slots || []).filter(x => mine(x.key)),
    gone: (prevAll.gone || []).filter(x => mine(x.key)),
    line: prevAll.line,
  };
  const writeState = st => fs.writeFileSync(STATE_FILE, JSON.stringify({
    updated: new Date().toISOString(),
    keys: [...others.keys, ...st.keys].sort(),
    slots: [...others.slots, ...st.slots].sort((a, b) => (a.date + a.time + a.facility + a.court).localeCompare(b.date + b.time + b.facility + b.court)),
    gone: [...others.gone, ...st.gone].sort((a, b) => (a.date + a.time + a.court).localeCompare(b.date + b.time + b.court)),
    line: st.line,
  }, null, 1));

  if (!RUN.length) {
    // このサイトは監視オフ → 残っている記録を消して終わり
    log(`${ONLY || '全サイト'}: 監視オフ`);
    if (prev.keys.length || prev.slots.length || prev.gone.length) writeState({ keys: [], slots: [], gone: [], line: prevAll.line || null });
    return;
  }

  let holidays = {};
  if (RUN.some(s => s.cond.excludeHolidays)) {
    try { holidays = await getJson('https://holidays-jp.github.io/api/v1/date.json'); }
    catch (e) { log('祝日データの取得に失敗(祝日除外なしで続行):', e.message); }
  }

  const hits = [], failed = [];
  let allFailed = true;
  for (const { mod, cond: c } of RUN) {
    log(`[${mod.name}] ${mod.facilities(c).map(f => f.name).join('・')} / ${c.weekdayLabels.join('')} / ${c.timeFrom}以降 / ${startStr}〜${c.endStr}`);
    const t0 = Date.now();
    try {
      const r = await mod.collect(c, holidays);
      log(`[${mod.name}] 所要 ${Math.round((Date.now() - t0) / 1000)}秒`);
      hits.push(...r.hits); failed.push(...r.failed);
      if (r.hits.length || !r.failed.length) allFailed = false;
      log(`[${mod.name}] 空き ${r.hits.length} 枠${r.failed.length ? ` / 取得失敗 ${r.failed.length} 件` : ''}`);
    } catch (e) {
      log(`[${mod.name}] エラー:`, e.message);
      for (const f of mod.facilities(c)) failed.push({ prefix: mod.prefix(f), from: startStr, to: c.endStr, msg: `${f.name}: ${e.message}` });
    }
  }

  if (failed.length) {
    log('取得エラー:\n' + failed.map(e => e.msg).join('\n'));
    summary('### ⚠️ 取得エラー\n' + failed.map(e => `- ${e.msg}`).join('\n'));
    if (allFailed) process.exit(1); // 全部失敗 → 前回結果を消さないようにここで終了
  }

  if (reset) log('基準をリセット: 今の空きをすべて通知します');
  const fresh = hits.filter(h => !prev.keys.includes(h.key));

  log(`条件に合う空き: ${hits.length} 枠 / うち新規: ${fresh.length} 枠`);
  const all = group(hits), freshKeys = new Set(fresh.map(h => `${h.facility}|${h.date}|${h.time}`));
  const mark = g => freshKeys.has(`${g.facility}|${g.date}|${g.time}`) ? '🆕 ' : '';
  all.forEach(g => log(`${mark(g) || '   '}${g.facility} ${lineOf(g).slice(1)}`));
  summary(`### 条件に合う空き ${hits.length} 枠(新規 ${fresh.length} 枠)\n` +
    (all.length ? all.map(g => `- ${mark(g)}${g.facility} ${lineOf(g).slice(1)}`).join('\n') : '- なし'));

  if (fresh.length) {
    // ?openExternalBrowser=1 … LINE内ブラウザではなく、いつものブラウザ(Safariなど)で開かせるLINEの機能
    const ext = u => u + (u.includes('?') ? '&' : '?') + 'openExternalBrowser=1';
    const sitesInFresh = RUN.filter(s => fresh.some(h => h.site === s.mod.id)).map(s => s.mod);
    const links = (pageUrl ? `\n\n今の空き一覧\n${ext(pageUrl)}` : '') +
      sitesInFresh.map(m => `\n\n${m.name}の予約サイト\n${ext(m.bookUrl)}`).join('');
    let text;
    if (fresh.length > LINE_MAX) {
      // 多いときは要約だけ(詳しくは一覧ページで)
      const cnt = {};
      fresh.forEach(h => cnt[h.facility] = (cnt[h.facility] || 0) + 1);
      const dates = fresh.map(h => h.date).sort();
      text = `🎾 新しい空きが ${fresh.length}枠 出ました\n` +
        Object.entries(cnt).map(([f, n]) => `${f} ${n}枠`).join('・') +
        `\n(${label(dates[0])}〜${label(dates[dates.length - 1])})` + links;
    } else {
      const byFac = {};
      group(fresh).forEach(g => (byFac[g.facility] ||= []).push(lineOf(g)));
      text = '🎾 コートに空きが出ました\n\n' +
        Object.entries(byFac).map(([f, ls]) => `【${f}】\n${ls.join('\n')}`).join('\n\n') + links;
    }
    await pushLine(text);
  }

  // 取得に失敗した施設・期間の枠は前回の記録を残す(復旧時に誤って「新規」扱いしないため)
  const inFailed = k => failed.some(e => k.startsWith(e.prefix) && (d => d >= e.from && d <= e.to)(k.split('|')[1]));
  const failedKeys = (prev.keys || []).filter(inFailed);
  // 設定ページ(index.html)で表示する一覧。中身が変わったときだけ保存する
  const keys = [...new Set([...hits.map(h => h.key), ...failedKeys])].sort();
  const prevSlots = prev.slots || [];
  const keep = prevSlots.filter(s => failedKeys.includes(s.key) && !hits.some(h => h.key === s.key));
  const slots = [...hits, ...keep].map(({ site, facility, date, court, time, key }) => ({ site: site || 'mitaka', facility, date, court, time, key }))
    .sort((a, b) => (a.date + a.time + a.facility + a.court).localeCompare(b.date + b.time + b.facility + b.court));

  // LINEの使用状況(設定ページに表示)。エラーは次に送信が成功するまで残す
  const quota = await lineQuota();
  const month = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 7);
  const prevLine = prev.line || {};
  if (quota && quota.reach == null && prev.line && prev.line.reach != null) quota.reach = prev.line.reach;
  const line = quota ? { ...quota, month, error: lineError || (fresh.length ? null : (prevLine.month === month ? prevLine.error || null : null)) } : (prev.line || null);
  if (quota) log(`LINE今月の使用数: ${quota.used}${quota.limit ? ' / ' + quota.limit : ''}通`);
  if (line && line.limit && line.used >= line.limit && !line.error) line.error = '今月のLINE無料枠を使い切りました。月末まで通知は届きません';
  if (line && line.limit && line.used < line.limit && /使い切りました|上限/.test(line.error || '') && !lineError) line.error = null;

  // 取られた枠(前回あって今回なくなった枠)。条件を変えて対象外になっただけの枠は含めない
  const nowIso = new Date().toISOString();
  const stillTarget = sl => {
    for (const { mod, cond: c } of RUN) {
      const f = mod.facilities(c).find(x => sl.key && sl.key.startsWith(mod.prefix(x)));
      if (!f) continue;
      if (!mod.courtOk(f, sl.court)) return false;
      if (!passDate(c, sl.date, holidays)) return false;
      return toMin(String(sl.time).split('-')[0]) >= c.fromMin;
    }
    return false;
  };
  const nowKeys = new Set(slots.map(x => x.key));
  const goneNow = prevSlots.filter(x => x.key && !nowKeys.has(x.key) && stillTarget(x))
    .map(x => ({ site: x.site || 'mitaka', facility: x.facility, date: x.date, court: x.court, time: x.time, key: x.key, goneAt: nowIso }));
  const limit = Date.now() - GONE_KEEP_HOURS * 3600e3;
  const gone = [...(prev.gone || []), ...goneNow]
    .filter((x, i, a) => !nowKeys.has(x.key) && x.date >= startStr && new Date(x.goneAt) >= limit &&
      a.findIndex(y => y.key === x.key) === i)
    .sort((a, b) => (a.date + a.time + a.court).localeCompare(b.date + b.time + b.court));
  if (goneNow.length) log(`取られた枠: ${goneNow.length} 枠`);

  const same = JSON.stringify(keys) === JSON.stringify([...(prev.keys || [])].sort()) && prev.slots &&
    JSON.stringify(slots) === JSON.stringify(prevSlots) &&
    JSON.stringify(line) === JSON.stringify(prev.line || null) &&
    JSON.stringify(gone) === JSON.stringify(prev.gone || []);
  if (same && !reset) { log('空き状況に変化なし(保存なし)'); return; }
  writeState({ keys, slots, gone, line });
})();
