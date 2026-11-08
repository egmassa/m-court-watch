// 府中・都営の予約サイトに GitHub のサーバーから届くかを確かめるテスト(1回だけ手動で実行)
const fs = require('fs');
const out = [];
const log = s => { console.log(s); out.push(s); };
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36';

// クッキーを引き継ぐ簡易fetch
const jar = {};
async function req(url, opt = {}) {
  const host = new URL(url).host;
  const cookie = Object.entries(jar[host] || {}).map(([k, v]) => `${k}=${v}`).join('; ');
  const res = await fetch(url, {
    redirect: 'manual', signal: AbortSignal.timeout(30000), ...opt,
    headers: { 'User-Agent': UA, 'Accept-Language': 'ja', ...(cookie ? { Cookie: cookie } : {}), ...(opt.headers || {}) },
  });
  for (const c of res.headers.getSetCookie ? res.headers.getSetCookie() : []) {
    const [kv] = c.split(';'); const i = kv.indexOf('=');
    (jar[host] ||= {})[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
  }
  if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
    return req(new URL(res.headers.get('location'), url).href, { headers: opt.headers });
  }
  return res;
}
const title = html => ((html.match(/<title[^>]*>([^<]*)/i) || [])[1] || '').trim();

async function toei() {
  log('## 都立公園(kouen.sports.metro.tokyo.lg.jp)');
  const base = 'https://kouen.sports.metro.tokyo.lg.jp';
  let r = await req(base + '/web/');
  const html = await r.text();
  log(`- トップ: HTTP ${r.status} / タイトル「${title(html)}」 / クッキー ${Object.keys(jar[new URL(base).host] || {}).join(',') || 'なし'}`);
  // 野川公園・今週の月曜
  const d = new Date(Date.now() + 9 * 3600e3); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  const useDay = d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
  const bld = '1260', inst = '12600010';
  const form = { 'Content-Type': 'application/x-www-form-urlencoded' };
  r = await req(base + '/web/rsvWOpeInstSrchVacantAction.do', { method: 'POST', headers: form, body: [
    'displayNo=prwrc2000', 'displayNoFrm=prwrc2000', 'applyFlg=0', 'dayofweekClearFlg=1', 'timezoneClearFlg=1',
    'selectPpsClsCd=1000', 'selectPpsCd=1030', `selectBldCd=${bld}`, `selectInstCd=${inst}`, `iniBCd=${bld}`,
    `iniICd=${inst}_3`, `useDay=${useDay}`, 'selectSize=0', 'penaltyday=3', `selectAreaBcd=${bld}`, 'selectIcd=0',
    'initBcd=null', 'initIcd=null', 'initPpsClPpscd=null'].join('&') });
  log(`- 施設の初期化(野川公園 ${useDay}): HTTP ${r.status}`);
  await new Promise(s => setTimeout(s, 800));
  r = await req(base + '/web/rsvWOpeInstSrchVacantAjaxAction.do', { method: 'POST',
    headers: { ...form, 'X-Requested-With': 'XMLHttpRequest' },
    body: ['displayNo=prwrc2000', `useDay=${useDay}`, `bldCd=${bld}`, `instCd=${inst}`, 'transVacantMode=11', 'clearFlag=0'].join('&') });
  const txt = await r.text();
  let info = '';
  try {
    const j = JSON.parse(txt);
    const arrays = Object.entries(j).filter(([, v]) => Array.isArray(v)).map(([k, v]) => `${k}:${v.length}件`);
    info = `JSON OK / キー: ${Object.keys(j).slice(0, 12).join(',')} / 配列: ${arrays.join(' ') || 'なし'}`;
  } catch { info = `JSONではない応答: ${txt.slice(0, 120).replace(/\s+/g, ' ')}`; }
  log(`- 週の空きデータ: HTTP ${r.status} / ${info}`);
}

async function fuchu() {
  log('## 府中市(shisetsu.city.fuchu.tokyo.jp)');
  const r = await req('https://shisetsu.city.fuchu.tokyo.jp/web/Home/WgR_ModeSelect');
  const html = await r.text();
  log(`- トップ: HTTP ${r.status} / タイトル「${title(html)}」 / 大きさ ${html.length}文字 / 画面のフォーム ${(html.match(/<form/gi) || []).length}個`);
}

(async () => {
  for (const f of [toei, fuchu]) {
    try { await f(); } catch (e) { log(`- ❌ エラー: ${e.name} ${e.message}`); }
    log('');
  }
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, out.join('\n') + '\n');
})();
