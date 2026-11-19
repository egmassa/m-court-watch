// 友達が決めた条件を GAS から取り、巡回が読むファイルに書く。
// 失敗しても巡回は止めない(その場合は config.yml の値で動く)。
const fs = require('fs');

const out = process.env.SHARED_COND_FILE;
const url = process.env.GAS_URL, token = process.env.GAS_WRITE_TOKEN;

const jstToday = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); // m は 1〜12
const diffDays = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400e3);

// 期間 → 巡回の設定(days_ahead / date_from)。days_ahead は 1 以上にする(0 だと watch.js が 30 と読む)
function periodOf(p, today) {
  if (p && p.mode === 'days') return { days_ahead: Number(p.days) || 14, date_from: '' };
  const [y, m] = today.split('-').map(Number);
  if (p && p.mode === 'month' && p.which === 'next') {
    const ny = m === 12 ? y + 1 : y, nm = m === 12 ? 1 : m + 1;
    const first = `${ny}-${String(nm).padStart(2, '0')}-01`;
    return { days_ahead: Math.max(1, diffDays(today, lastDay(ny, nm))), date_from: first };
  }
  // 今月(this) とその他の不正値
  return { days_ahead: Math.max(1, diffDays(today, lastDay(y, m))), date_from: '' };
}

(async () => {
  if (!out || !url || !token) { console.log('共有の条件: 設定がないので config.yml で動きます'); return; }
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'getConditions', token }),
      redirect: 'follow',
      signal: AbortSignal.timeout(30000),
    });
    const j = await res.json();
    if (!j.ok || !j.data) { console.log('共有の条件: まだ保存がないので config.yml で動きます'); return; }
    const today = jstToday();
    const result = {};
    for (const id of ['mitaka', 'toei', 'fuchu']) {
      const s = j.data[id];
      if (!s) continue;
      const per = periodOf(s.period, today);
      result[id] = {
        enabled: !!s.enabled,
        facilities: s.facilities || [],
        weekdays: s.weekdays || [],
        exclude_holidays: !!s.exclude_holidays,
        time_from: s.time_from || '00:00',
        days_ahead: per.days_ahead,
        date_from: per.date_from,
      };
    }
    fs.writeFileSync(out, JSON.stringify(result));
    console.log('共有の条件を取り込みました');
  } catch (e) {
    console.log('共有の条件: 取得できなかったので config.yml で動きます (' + e.message + ')');
  }
})();
