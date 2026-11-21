// ==UserScript==
// @name         三鷹市テニスコート空き状況チェッカー
// @namespace    https://yoyaku-mitaka.jp/
// @version      5.2.0
// @description  三鷹市生涯学習施設等予約システムのテニスコート空き状況をカレンダー表示（複数施設選択・時間帯/曜日フィルタ・タップ対応・LINE共有・予約直前画面へのジャンプ）
// @author       you
// @match        https://yoyaku-mitaka.jp/*
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      yoyaku-mitaka.jp
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/egmassa/koukai/main/Netlify/tennis/%E7%A9%BA%E3%81%8D%E6%A4%9C%E7%B4%A2/2026mitaka/mitaka-tennis-checker.user.js
// @downloadURL  https://raw.githubusercontent.com/egmassa/koukai/main/Netlify/tennis/%E7%A9%BA%E3%81%8D%E6%A4%9C%E7%B4%A2/2026mitaka/mitaka-tennis-checker.user.js
// ==/UserScript==

(function () {
  'use strict';

  // ============================================================
  // 監視対象施設・コート設定（⚙設定画面から追加・編集・取得ON/OFF可、保存される）
  // ============================================================
  const DEFAULT_TARGETS = [
    { facilityId: 5,  roomId: 37,  name: '新川テニスコート',       note: 'クレー4面', enabled: true, excludeCourts: [4] },
    { facilityId: 3,  roomId: 24,  name: '大沢総合グラウンド',     note: '人工芝6面', enabled: true, excludeCourts: [6] },
    { facilityId: 36, roomId: 134, name: '第一中学校',             note: 'テニスコート', enabled: true, excludeCourts: [] },
    { facilityId: 41, roomId: 144, name: '第六中学校',             note: 'テニスコート', enabled: true, excludeCourts: [] },
    { facilityId: 4,  roomId: 34,  name: '大沢野川グラウンド',     note: 'テニスコート', enabled: true, excludeCourts: [] },
    { facilityId: 39, roomId: 141, name: '第四中学校',             note: 'テニスコート', enabled: true, excludeCourts: [] },
    { facilityId: 42, roomId: 146, name: '第七中学校',             note: 'テニスコート', enabled: true, excludeCourts: [] },
  ];
  const STORAGE_KEY = 'mtc_targets_v1';

  function gmGet(key, defVal) {
    if (typeof GM_getValue === 'function') return GM_getValue(key, defVal);
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : defVal;
    } catch (e) {
      return defVal;
    }
  }
  function gmSet(key, val) {
    if (typeof GM_setValue === 'function') return GM_setValue(key, val);
    try {
      localStorage.setItem(key, JSON.stringify(val));
    } catch (e) {
      /* ignore */
    }
  }
  function loadTargets() {
    const saved = gmGet(STORAGE_KEY, null);
    if (Array.isArray(saved) && saved.length > 0) {
      return saved.map((t) => {
        if (t.excludeCourts !== undefined) return { enabled: true, ...t };
        // 過去バージョンの保存データにはexcludeCourtsが無いため、
        // roomIdが一致する既定値があればそれを補完し、無ければ除外なしにする
        const match = DEFAULT_TARGETS.find((d) => d.roomId === t.roomId);
        return { enabled: true, excludeCourts: match ? match.excludeCourts.slice() : [], ...t };
      });
    }
    return DEFAULT_TARGETS.map((t) => ({ ...t, excludeCourts: t.excludeCourts.slice() }));
  }
  function saveTargets(targets) {
    gmSet(STORAGE_KEY, targets);
  }

  let TARGETS = loadTargets();

  const STATUS = { NO_SCHEDULE: 1, FULL: 2, AVAILABLE: 3, PARTIALLY_AVAILABLE: 4 };
  const STATUS_CLASS = {
    [STATUS.NO_SCHEDULE]: 'mtc-cell-none',
    [STATUS.FULL]:        'mtc-cell-full',
    [STATUS.AVAILABLE]:   'mtc-cell-available',
    [STATUS.PARTIALLY_AVAILABLE]: 'mtc-cell-partial',
  };
  const DOW = ['日', '月', '火', '水', '木', '金', '土'];

  const SCRIPT_VERSION = '5.2.0'; // ヘッダー表示用。@versionと必ず一致させること
  const MONTHS_AHEAD = 3;
  // サーバーが応答しないまま「読み込み中...」で止まらないよう、通信ごとに時間制限を設ける
  const FETCH_TIMEOUT_MS = 30000;

  // ============================================================
  // データ取得
  // ============================================================
  // fetchに時間制限を付ける。本文の読み込み（readBody）まで含めて制限内に収める。
  async function fetchWithTimeout(url, opts, readBody) {
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS) : null;
    try {
      const res = await fetch(url, ctrl ? { ...opts, signal: ctrl.signal } : opts);
      return await readBody(res);
    } catch (e) {
      if (e && e.name === 'AbortError') throw new Error(`タイムアウト（${FETCH_TIMEOUT_MS / 1000}秒応答なし）`);
      throw e;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function fetchRoomMonth(roomId, year, month) {
    const url = `https://yoyaku-mitaka.jp/reservation/room-data/${roomId}/month?year=${year}&month=${month}`;
    return fetchWithTimeout(url, { credentials: 'omit' }, (res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json().then((data) => {
        if (!data || typeof data !== 'object') throw new Error('応答の形式が想定外');
        return data;
      });
    });
  }

  // 施設を切り替えると、サーバー側が前回の施設に固定されてしまう問題への対策。
  // 手動で /reservation を開き直すとリセットされることが確認できたので、
  // 同じことを裏側（画面には出さず）で毎回fetchして再現する。
  // 「前回と同じ施設のときだけ省略する」といった条件分岐は、記憶がズレたときに
  // 古いCSRFトークンを使ってしまう不具合の元になるため、常に取り直す単純な方式にしている。
  async function refreshCsrfTokenViaReservationReload() {
    try {
      const html = await fetchWithTimeout(
        'https://yoyaku-mitaka.jp/reservation',
        { credentials: 'same-origin' },
        (res) => res.text()
      );
      const m = html.match(/<meta name="csrf-token" content="([^"]+)"/);
      return m ? m[1] : null;
    } catch (e) {
      console.error('[mitaka-tennis-checker] /reservation reload failed', e);
      return null;
    }
  }

  // 選択した日付を、サイト本体の「日付選択→予約へ進む」と同じAPIに直接渡し、
  // 時間帯選択画面（予約の一歩手前）へ新しいタブで飛ばす。
  // ※facilityDetail()のgoBookingTime()と同じエンドポイント・パラメータ形式を利用。
  // opts.sameTab: 新しいタブではなく今のタブで開く(空き監視ページからの自動ジャンプ用。
  // ボタンを押していない自動処理から window.open するとポップアップブロックされるため)
  async function jumpToBooking(ti, dateStr, opts = {}) {
    const t = typeof ti === 'object' ? ti : TARGETS[ti];
    if (!t) return;
    const csrfMeta = document.querySelector('meta[name="csrf-token"]');
    if (!csrfMeta) {
      alert('この操作は三鷹市の予約サイト（yoyaku-mitaka.jp）を開いた状態でのみ行えます。');
      return;
    }
    try {
      const freshToken = await refreshCsrfTokenViaReservationReload();
      const csrfToken = freshToken || csrfMeta.content;

      // サイト本体のgoBookingTime()と同じく、APIを叩く前にsessionStorageへ
      // 選択内容を書き込んでおく（遷移先の画面がこれを見て中身を組み立てている可能性があるため）
      const elId = `room-${t.roomId}`;
      const dateKey = `${t.roomId}_${dateStr}`;
      try {
        sessionStorage.removeItem('bookingTimeSelection');
        sessionStorage.setItem('user_calendar_selections', JSON.stringify({ [elId]: [dateKey] }));
      } catch (e) {
        console.error('[mitaka-tennis-checker] sessionStorage write failed', e);
      }

      const data = await fetchWithTimeout('https://yoyaku-mitaka.jp/reservation/select-dates', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'X-CSRF-TOKEN': csrfToken,
        },
        body: JSON.stringify({
          facility_ids: [t.facilityId],
          selected_data: [{ room_id: t.roomId, dates: [dateStr] }],
        }),
      }, (response) => response.json());
      if (data && data.success && data.redirect_url) {
        // 毎回同じURL（/reservation/booking-time）なので、ブラウザキャッシュで
        // 前回別施設の中身が出てしまわないよう、キャッシュ避けのパラメータを付ける
        const sep = data.redirect_url.includes('?') ? '&' : '?';
        const bustedUrl = `${data.redirect_url}${sep}_ts=${Date.now()}`;
        if (opts.sameTab) location.href = bustedUrl;
        else window.open(bustedUrl, '_blank');
      } else {
        alert((data && data.message) || '時間帯選択画面への遷移に失敗しました（すでに埋まった可能性があります）。');
      }
    } catch (e) {
      console.error('[mitaka-tennis-checker] jumpToBooking failed', e);
      alert('時間帯選択画面への遷移でエラーが発生しました。\n' + ((e && e.message) || ''));
    }
  }

  let lastData = {};       // lastData[ti][dateStr] = { status, tooltip }
  let fetchedMonths = {};  // fetchedMonths[ti] = Set('YYYY-M')

  function mergeMonthData(ti, data) {
    lastData[ti] = lastData[ti] || {};
    const dates = data.dates || {};
    const tooltip = data.tooltip_data || {};
    for (const dateStr of Object.keys(dates)) {
      lastData[ti][dateStr] = { status: dates[dateStr].status, tooltip: tooltip[dateStr] || null };
    }
  }

  let lastFetchedAt = null; // 実際にサーバーからデータを取得できた最新日時
  // 取得に失敗した月の記録。fetchFailures[ti] = Map('YYYY-M' → 理由)
  // 失敗を「空きなし」と区別して画面・画像に警告を出すために使う。
  // 失敗した月は「再取得」を押すまで取り直さない（操作のたびに30秒待たされるのを防ぐため）
  let fetchFailures = {};
  let initialFetchDone = false;

  async function ensureMonthFetched(ti, year, month) {
    fetchedMonths[ti] = fetchedMonths[ti] || new Set();
    const key = `${year}-${month}`;
    if (fetchedMonths[ti].has(key)) return;
    if (fetchFailures[ti] && fetchFailures[ti].has(key)) return;
    const t = TARGETS[ti];
    if (!t) return;
    try {
      const data = await fetchRoomMonth(t.roomId, year, month);
      mergeMonthData(ti, data);
      fetchedMonths[ti].add(key);
      lastFetchedAt = new Date();
    } catch (e) {
      console.error('[mitaka-tennis-checker] fetch failed', t.name, year, month, e);
      fetchFailures[ti] = fetchFailures[ti] || new Map();
      fetchFailures[ti].set(key, (e && e.message) || 'エラー');
    }
  }

  function hasFailure(ti) {
    return !!(fetchFailures[ti] && fetchFailures[ti].size > 0);
  }

  // 選択中の施設について「施設名（10月・11月）」の形で失敗箇所を並べる
  function failureSummaryList(indices) {
    return indices
      .filter((ti) => hasFailure(ti))
      .map((ti) => {
        const keys = Array.from(fetchFailures[ti].keys()).sort((a, b) => {
          const [ay, am] = a.split('-').map(Number);
          const [by, bm] = b.split('-').map(Number);
          return ay * 12 + am - (by * 12 + bm);
        });
        const months = keys.map((k) => `${Number(k.split('-')[1])}月`);
        return `${TARGETS[ti] ? TARGETS[ti].name : ''}（${months.join('・')}）`;
      });
  }

  async function fetchAllInitial() {
    lastData = {};
    fetchedMonths = {};
    fetchFailures = {};
    lastFetchedAt = null;
    initialFetchDone = true;
    const now = new Date();
    for (let ti = 0; ti < TARGETS.length; ti++) {
      if (TARGETS[ti].enabled === false) continue;
      for (let i = 0; i < MONTHS_AHEAD; i++) {
        const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
        await ensureMonthFetched(ti, d.getFullYear(), d.getMonth() + 1);
      }
    }
  }

  function enabledIndices() {
    return TARGETS.map((t, i) => i).filter((i) => TARGETS[i].enabled !== false);
  }

  // ============================================================
  // スタイル
  // ============================================================
  function injectStyles() {
    const css = `
      #mtc-fab {
        position: fixed;
        right: max(20px, env(safe-area-inset-right, 0px));
        bottom: max(28px, calc(env(safe-area-inset-bottom, 0px) + 20px));
        z-index: 2147483647;
        width: 56px; height: 56px; border-radius: 50%;
        background: #1565c0; color: #fff; font-size: 24px;
        display: flex; align-items: center; justify-content: center;
        box-shadow: 0 2px 8px rgba(0,0,0,0.3); cursor: pointer; border: none;
      }
      #mtc-panel {
        position: fixed; top: 3%; left: 50%; transform: translateX(-50%);
        width: min(96vw, 680px); max-height: 94vh; overflow-y: auto;
        background: #fff; z-index: 100000; border-radius: 12px;
        box-shadow: 0 4px 24px rgba(0,0,0,0.4); padding: 14px; display: none;
        font-family: sans-serif; font-size: 13px;
      }
      #mtc-panel h2, #mtc-settings h2 { margin: 0 0 8px; font-size: 15px; }
      #mtc-panel .mtc-close, #mtc-settings .mtc-close {
        position: absolute; top: 8px; right: 10px; cursor: pointer;
        font-size: 20px; background: none; border: none;
      }
      #mtc-panel .mtc-toolbar, #mtc-settings .mtc-toolbar { display: flex; gap: 6px; margin-bottom: 8px; flex-wrap: wrap; }
      #mtc-panel button.mtc-btn, #mtc-settings button.mtc-btn {
        background: #2e7d32; color: #fff; border: none; border-radius: 6px;
        padding: 5px 10px; cursor: pointer; font-size: 12px;
      }
      #mtc-panel button.mtc-btn.secondary, #mtc-settings button.mtc-btn.secondary { background: #666; }
      #mtc-panel .mtc-tabs-label { font-size: 11px; color: #888; margin-bottom: 2px; }
      #mtc-panel .mtc-tabs { display: flex; gap: 4px; flex-wrap: wrap; margin-bottom: 8px; }
      #mtc-panel .mtc-tab {
        border: 1px solid #bbb; background: #f5f5f5; color: #333;
        border-radius: 999px; padding: 4px 12px; font-size: 12px; cursor: pointer;
      }
      #mtc-panel .mtc-tab.active { background: #2e7d32; color: #fff; border-color: #2e7d32; }
      #mtc-panel .mtc-monthnav {
        display: flex; align-items: center; justify-content: center; gap: 14px;
        margin-bottom: 6px;
      }
      #mtc-panel .mtc-monthnav button {
        border: 1px solid #bbb; background: #fff; border-radius: 6px;
        width: 30px; height: 30px; cursor: pointer; font-size: 14px;
      }
      #mtc-panel .mtc-monthnav .mtc-month-select {
        font-size: 15px; font-weight: bold; text-align: center; padding: 4px 6px;
        border: 1px solid #bbb; border-radius: 6px; background: #fff;
      }
      #mtc-panel .mtc-timefilter {
        display: flex; align-items: center; gap: 6px; justify-content: center;
        margin-bottom: 10px; font-size: 12px; flex-wrap: wrap;
      }
      #mtc-panel .mtc-timefilter select {
        padding: 3px 4px; border-radius: 4px; border: 1px solid #ccc; font-size: 12px;
      }
      #mtc-panel .mtc-preset-row {
        display: flex; justify-content: center; gap: 6px; margin-bottom: 8px; flex-wrap: wrap;
      }
      #mtc-panel .mtc-preset-btn {
        background: #e8f5e9; color: #2e7d32; border: 1px solid #a5d6a7;
        border-radius: 999px; padding: 3px 10px; font-size: 11px; cursor: pointer;
      }
      #mtc-panel .mtc-preset-btn:active { background: #c8e6c9; }
      /* いまの条件と一致しているプリセットを点灯（施設タブの選択中と同じ配色） */
      #mtc-panel .mtc-preset-btn.active { background: #2e7d32; color: #fff; border-color: #2e7d32; }
      #mtc-panel button.mtc-btn.secondary.active { background: #2e7d32; }
      #mtc-panel .mtc-legend { font-size: 11px; color: #555; text-align: center; margin-bottom: 8px; }
      #mtc-panel .mtc-filter-summary {
        text-align: center; font-size: 11px; color: #333; background: #f5f5f5;
        border-radius: 8px; padding: 6px 10px; margin-bottom: 10px; line-height: 1.6;
      }
      #mtc-panel .mtc-fetched-at { font-size: 10px; color: #888; }
      #mtc-panel .mtc-ver { font-size: 11px; font-weight: normal; color: #888; margin-left: 4px; }
      #mtc-panel h2 { padding-right: 28px; }
      #mtc-panel .mtc-fail-banner {
        background: #fff3e0; border: 2px solid #f57c00; border-radius: 8px;
        padding: 8px 10px; margin-bottom: 10px; font-size: 12px; color: #e65100; line-height: 1.6;
        word-break: break-all;
      }
      #mtc-panel .mtc-fail-title { font-weight: bold; margin-bottom: 2px; }
      #mtc-panel .mtc-facility-legend {
        display: flex; flex-wrap: wrap; justify-content: center; gap: 10px;
        margin-bottom: 8px; font-size: 11px; color: #333;
      }
      #mtc-panel .mtc-legend-item { display: flex; align-items: center; gap: 4px; }
      #mtc-panel .mtc-legend-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
      #mtc-panel .mtc-calendar { width: 100%; border-collapse: collapse; table-layout: fixed; }
      #mtc-panel .mtc-calendar th {
        font-size: 11px; color: #666; padding: 4px 0; border-bottom: 1px solid #ddd;
      }
      #mtc-panel .mtc-calendar th.mtc-sun { color: #c62828; }
      #mtc-panel .mtc-calendar th.mtc-sat { color: #1565c0; }
      #mtc-panel .mtc-calendar td {
        border: 1px solid #eee; text-align: left; vertical-align: top;
        min-height: 54px; padding: 2px; font-size: 10px; cursor: pointer;
      }
      #mtc-panel .mtc-calendar td.mtc-empty { background: #fafafa; border: none; cursor: default; }
      #mtc-panel .mtc-day-num { font-size: 11px; color: #888; text-align: right; padding-right: 2px; }
      #mtc-panel .mtc-day-num.mtc-sun { color: #c62828; }
      #mtc-panel .mtc-day-num.mtc-sat { color: #1565c0; }
      #mtc-panel .mtc-cal-chip {
        border-radius: 3px; padding: 1px 4px; margin-bottom: 2px; font-size: 9px; line-height: 1.35;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      #mtc-panel .mtc-chip-full { background: #c8e6c9; color: #1b5e20; }
      #mtc-panel .mtc-chip-partial { background: #fff3cd; color: #7a5b00; }
      #mtc-panel .mtc-chip-more { background: #eee; color: #666; text-align: center; }
      #mtc-panel .mtc-cal-none { color: #bbb; font-size: 11px; text-align: center; padding-top: 8px; }
      #mtc-panel .mtc-weekday-filter {
        display: flex; justify-content: center; gap: 6px; margin-bottom: 8px; font-size: 11px;
      }
      #mtc-panel .mtc-weekday-filter label { display: flex; align-items: center; gap: 2px; cursor: pointer; }
      #mtc-panel td.mtc-cell-available { background: #e8f5e9; }
      #mtc-panel td.mtc-cell-partial { background: #fff8e1; }
      #mtc-panel td.mtc-cell-full { background: #fdecea; }
      #mtc-panel td.mtc-cell-none { background: #fafafa; }
      #mtc-panel .mtc-loading { padding: 40px; text-align: center; color: #888; }
      #mtc-panel .mtc-detail-date {
        font-weight: bold; margin: 10px 0 4px; display: flex; align-items: center; gap: 6px;
      }
      #mtc-panel .mtc-chips { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 8px; }
      #mtc-panel .mtc-chip {
        display: inline-flex; align-items: center; gap: 4px;
        background: #e8f5e9; color: #1b5e20; border: 1px solid #a5d6a7;
        border-radius: 999px; padding: 2px 10px; font-size: 11px; white-space: nowrap;
      }
      #mtc-panel .mtc-chip b { font-weight: 700; }
      #mtc-panel .mtc-facility-title {
        font-size: 13px; font-weight: bold; border-left: 4px solid #2e7d32;
        padding-left: 6px; margin: 10px 0 6px;
      }
      #mtc-daypop {
        position: fixed; z-index: 2147483647; display: none; background: #fff;
        border: 1px solid #ccc; border-radius: 8px; box-shadow: 0 4px 16px rgba(0,0,0,0.3);
        padding: 10px 12px; font-size: 12px; max-width: 280px; font-family: sans-serif;
      }
      #mtc-settings {
        position: fixed; top: 5%; left: 50%; transform: translateX(-50%);
        width: min(94vw, 560px); max-height: 90vh; overflow-y: auto;
        background: #fff; z-index: 2147483647; border-radius: 12px;
        box-shadow: 0 4px 24px rgba(0,0,0,0.4); padding: 16px; display: none;
        font-family: sans-serif; font-size: 13px;
      }
      #mtc-settings h2 { margin: 0 0 10px; font-size: 16px; }
      #mtc-settings .mtc-row {
        display: grid; grid-template-columns: 36px 55px 55px 1fr 1fr 90px;
        gap: 6px; margin-bottom: 6px; align-items: center;
      }
      #mtc-settings .mtc-row input[type="checkbox"] { width: 18px; height: 18px; justify-self: center; }
      #mtc-settings .mtc-row.mtc-row-disabled { opacity: 0.45; }
      #mtc-settings input {
        width: 100%; box-sizing: border-box; padding: 4px 6px;
        border: 1px solid #ccc; border-radius: 4px; font-size: 12px;
      }
      #mtc-settings .mtc-row-head { font-size: 11px; color: #888; }
    `;
    // CSPの厳しいサイトでは<style>タグやGM_addStyleが効かない環境があるため、
    // 複数の方法を順番に試す。Constructable Stylesheets（JSでスタイルシートを
    // 直接組み込む方式）はCSPのstyle-src制限を受けにくいので最優先で試す。
    let applied = false;
    try {
      if ('adoptedStyleSheets' in document && typeof CSSStyleSheet === 'function') {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(css);
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
        applied = true;
      }
    } catch (e) {
      console.error('[mitaka-tennis-checker] adoptedStyleSheets failed', e);
    }

    if (!applied && typeof GM_addStyle === 'function') {
      try {
        GM_addStyle(css);
        applied = true;
      } catch (e) {
        console.error('[mitaka-tennis-checker] GM_addStyle failed', e);
      }
    }

    if (!applied) {
      try {
        const style = document.createElement('style');
        style.textContent = css;
        document.head.appendChild(style);
      } catch (e) {
        console.error('[mitaka-tennis-checker] style tag injection failed', e);
      }
    }
  }

  // ============================================================
  // 時間帯フィルタ関連
  // ============================================================
  function timeToMin(hhmm) {
    const [h, m] = hhmm.split(':').map(Number);
    return h * 60 + m;
  }
  function minToTime(min) {
    const h = Math.floor(min / 60);
    const m = min % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }
  function buildTimeOptions() {
    const opts = [];
    for (let h = 0; h <= 24; h++) opts.push(`${String(h).padStart(2, '0')}:00`);
    return opts;
  }

  // 団体登録では予約できない等、集計から除外したいコートの判定
  function facilityHasExclusion(ti) {
    const t = TARGETS[ti];
    return !!(t && Array.isArray(t.excludeCourts) && t.excludeCourts.length > 0);
  }
  function filterExcludedUnits(ti, units) {
    const t = TARGETS[ti];
    const excluded = (t && t.excludeCourts) || [];
    if (excluded.length === 0) return units;
    return units.filter((u) => {
      const m = (u.name || '').match(/(\d+)/);
      if (!m) return true;
      return !excluded.includes(Number(m[1]));
    });
  }

  function computeFilteredStatus(ti, cell, startMin, endMin) {
    if (!cell) return { status: STATUS.NO_SCHEDULE, openCourts: 0, totalCourts: 0 };
    const hasExclusion = facilityHasExclusion(ti);

    if (!hasExclusion && startMin === 0 && endMin === 24 * 60) {
      return { status: cell.status, openCourts: null, totalCourts: null };
    }

    const allUnits = (cell.tooltip && cell.tooltip.units) || [];
    if (allUnits.length === 0) {
      return { status: cell.status, openCourts: null, totalCourts: null };
    }
    const units = hasExclusion ? filterExcludedUnits(ti, allUnits) : allUnits;
    if (units.length === 0) {
      // 対象コートが全て除外設定に該当した（このコートは団体登録不可のみ、等）
      return { status: STATUS.NO_SCHEDULE, openCourts: 0, totalCourts: 0 };
    }

    let overlapFound = false;
    let openCourts = 0;
    units.forEach((u) => {
      let unitOpen = false;
      u.timeslots.forEach((ts) => {
        const sMin = timeToMin(ts.start_time);
        const eMin = timeToMin(ts.end_time);
        if (sMin < endMin && eMin > startMin) {
          overlapFound = true;
          if (ts.status === 1) unitOpen = true;
        }
      });
      if (unitOpen) openCourts++;
    });
    const totalCourts = units.length;
    if (!overlapFound) return { status: STATUS.NO_SCHEDULE, openCourts: 0, totalCourts };
    if (openCourts === 0) return { status: STATUS.FULL, openCourts, totalCourts };
    if (openCourts === totalCourts) return { status: STATUS.AVAILABLE, openCourts, totalCourts };
    return { status: STATUS.PARTIALLY_AVAILABLE, openCourts, totalCourts };
  }

  function openSlotsInRange(ti, cell, startMin, endMin) {
    if (!cell || !cell.tooltip || !cell.tooltip.units) return new Map();
    const units = facilityHasExclusion(ti) ? filterExcludedUnits(ti, cell.tooltip.units) : cell.tooltip.units;
    const slotMap = new Map();
    units.forEach((u) => {
      u.timeslots.forEach((ts) => {
        if (ts.status !== 1) return;
        const sMin = timeToMin(ts.start_time);
        const eMin = timeToMin(ts.end_time);
        if (sMin < endMin && eMin > startMin) {
          const key = `${ts.start_time}-${ts.end_time}`;
          if (!slotMap.has(key)) slotMap.set(key, []);
          slotMap.get(key).push(u.name);
        }
      });
    });
    return slotMap;
  }

  // ============================================================
  // カレンダー描画
  // ============================================================
  function pad2(n) { return String(n).padStart(2, '0'); }

  const CHIP_COLOR = {
    full: { bg: '#c8e6c9', fg: '#1b5e20' },
    partial: { bg: '#fff3cd', fg: '#7a5b00' },
    more: { bg: '#eee', fg: '#666' },
  };
  const STATUS_BG = {
    [STATUS.NO_SCHEDULE]: '#fafafa',
    [STATUS.FULL]: '#fdecea',
    [STATUS.AVAILABLE]: '#e8f5e9',
    [STATUS.PARTIALLY_AVAILABLE]: '#fff8e1',
  };

  const MAX_INLINE_CHIPS_MULTI = 5;
  const FACILITY_COLORS = ['#2e7d32', '#1565c0', '#ef6c00', '#8e24aa', '#00838f', '#c62828', '#6d4c41', '#3949ab'];
  function facilityColor(ti) {
    return FACILITY_COLORS[ti % FACILITY_COLORS.length];
  }
  function facilityShortName(name) {
    const short = (name || '').replace(/テニスコート|総合グラウンド|グラウンド|中学校|小学校/g, '').trim();
    return short || (name || '').slice(0, 2);
  }
  const STATUS_PRIORITY = {
    [STATUS.AVAILABLE]: 3,
    [STATUS.PARTIALLY_AVAILABLE]: 2,
    [STATUS.FULL]: 1,
    [STATUS.NO_SCHEDULE]: 0,
  };

  // 複数施設ぶんをまとめて1マスの表示内容を計算する（HTML描画・画像描画の両方から使う）
  // chipsは全件返す（表示個数の絞り込みは呼び出し側で行う）
  function computeDayCellMulti(indices, dateStr, startMin, endMin) {
    let bestStatus = STATUS.NO_SCHEDULE;
    const chips = [];
    indices.forEach((ti) => {
      const facilityData = lastData[ti] || {};
      const cell = facilityData[dateStr];
      const filtered = computeFilteredStatus(ti, cell, startMin, endMin);
      if (STATUS_PRIORITY[filtered.status] > STATUS_PRIORITY[bestStatus]) bestStatus = filtered.status;

      const slotMap = openSlotsInRange(ti, cell, startMin, endMin);
      let totalCourtsForCell = filtered.totalCourts;
      if (totalCourtsForCell === null || totalCourtsForCell === undefined) {
        const allUnits = (cell && cell.tooltip && cell.tooltip.units) || [];
        totalCourtsForCell = facilityHasExclusion(ti) ? filterExcludedUnits(ti, allUnits).length : allUnits.length;
      }
      Array.from(slotMap.entries())
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .forEach(([time, courts]) => {
          const short = time.replace(/:00-/, '-').replace(/:00$/, '');
          const full = totalCourtsForCell && courts.length === totalCourtsForCell;
          chips.push({
            ti,
            kind: full ? 'full' : 'partial',
            color: facilityColor(ti),
            label: facilityShortName(TARGETS[ti] ? TARGETS[ti].name : ''),
            timeText: short,
            nText: `${courts.length}面`,
          });
        });
    });

    let noneText = null;
    if (bestStatus === STATUS.NO_SCHEDULE) noneText = '－';
    else if (chips.length === 0) noneText = '×空きなし';

    return { status: bestStatus, chips, noneText };
  }

  function buildCalendarMulti(indices, year, month, startMin, endMin, selectedDow) {
    const firstDay = new Date(year, month - 1, 1);
    const daysInMonth = new Date(year, month, 0).getDate();
    const startDow = firstDay.getDay();
    const dowList = [0, 1, 2, 3, 4, 5, 6].filter((d) => selectedDow.has(d));

    let html = '<table class="mtc-calendar"><thead><tr>';
    dowList.forEach((i) => {
      const cls = i === 0 ? 'mtc-sun' : i === 6 ? 'mtc-sat' : '';
      html += `<th class="${cls}">${DOW[i]}</th>`;
    });
    html += '</tr></thead><tbody><tr>';

    for (let d = 0; d < startDow; d++) {
      if (selectedDow.has(d)) html += '<td class="mtc-empty"></td>';
    }

    let dow = startDow;
    for (let day = 1; day <= daysInMonth; day++) {
      if (selectedDow.has(dow)) {
        const dateStr = `${year}-${pad2(month)}-${pad2(day)}`;
        const info = computeDayCellMulti(indices, dateStr, startMin, endMin);
        const cls = STATUS_CLASS[info.status] || 'mtc-cell-none';
        const dowClass = dow === 0 ? 'mtc-sun' : dow === 6 ? 'mtc-sat' : '';
        const shown = info.chips.slice(0, MAX_INLINE_CHIPS_MULTI);
        const overflow = info.chips.length - shown.length;

        let chipsHtml = '';
        if (info.noneText) {
          chipsHtml = `<div class="mtc-cal-none">${info.noneText}</div>`;
        } else {
          shown.forEach((c) => {
            const chipClass = c.kind === 'full' ? 'mtc-chip-full' : 'mtc-chip-partial';
            chipsHtml += `<div class="mtc-cal-chip ${chipClass}" style="border-left:3px solid ${c.color};">${c.label} ${c.timeText} ${c.nText}</div>`;
          });
          if (overflow > 0) {
            chipsHtml += `<div class="mtc-cal-chip mtc-chip-more">+${overflow}件</div>`;
          }
        }

        html += `<td class="${cls}" data-date="${dateStr}">` +
          `<div class="mtc-day-num ${dowClass}">${day}</div>` +
          chipsHtml +
          '</td>';
      }

      dow++;
      if (dow === 7) {
        html += '</tr><tr>';
        dow = 0;
      }
    }
    while (dow !== 0 && dow !== 7) {
      if (selectedDow.has(dow)) html += '<td class="mtc-empty"></td>';
      dow++;
    }
    html += '</tr></tbody></table>';
    return html;
  }

  function monthHasData(ti, year, month) {
    const facilityData = lastData[ti] || {};
    const daysInMonth = new Date(year, month, 0).getDate();
    for (let day = 1; day <= daysInMonth; day++) {
      const dateStr = `${year}-${pad2(month)}-${pad2(day)}`;
      const cell = facilityData[dateStr];
      if (cell && cell.status !== STATUS.NO_SCHEDULE) return true;
    }
    return false;
  }

  function buildMonthDetailMulti(indices, year, month, startMin, endMin, selectedDow) {
    const daysInMonth = new Date(year, month, 0).getDate();
    let html = '';
    let found = false;

    for (let day = 1; day <= daysInMonth; day++) {
      const d0 = new Date(year, month - 1, day);
      if (!selectedDow.has(d0.getDay())) continue;
      const dateStr = `${year}-${pad2(month)}-${pad2(day)}`;
      const info = computeDayCellMulti(indices, dateStr, startMin, endMin);
      if (info.chips.length === 0) continue;
      found = true;

      const dow = d0.getDay();
      const dowColor = dow === 0 ? '#c62828' : dow === 6 ? '#1565c0' : '#333';
      html += `<div class="mtc-detail-date"><span style="color:${dowColor};">${month}/${day}(${DOW[dow]})</span></div><div class="mtc-chips">`;
      info.chips.forEach((c) => {
        html += `<span class="mtc-chip mtc-chip-jump" data-ti="${c.ti}" data-date="${dateStr}" style="border-left:3px solid ${c.color};cursor:pointer;" title="予約の時間帯選択画面へ進む"><b>${c.label}</b> ${c.timeText}（${c.nText}）</span>`;
      });
      html += '</div>';
    }

    if (!found) html = '<p style="color:#888;font-size:12px;">この月・この時間帯では空きがありません。</p>';
    return html;
  }

  // ============================================================
  // 状態（時間帯・曜日・選択施設は再読み込みしても引き継がれるよう保存する）
  // ============================================================
  const FILTER_STATE_KEY = 'mtc_filter_state_v1';

  function loadFilterState() {
    const saved = gmGet(FILTER_STATE_KEY, null);
    if (!saved || typeof saved !== 'object') return null;
    try {
      return {
        startMin: typeof saved.startMin === 'number' ? saved.startMin : 0,
        endMin: typeof saved.endMin === 'number' ? saved.endMin : 24 * 60,
        selectedDow:
          Array.isArray(saved.selectedDow) && saved.selectedDow.length > 0
            ? new Set(saved.selectedDow)
            : new Set([0, 1, 2, 3, 4, 5, 6]),
        selectedTi: Array.isArray(saved.selectedTi) ? new Set(saved.selectedTi) : new Set(),
      };
    } catch (e) {
      return null;
    }
  }

  function saveFilterState() {
    gmSet(FILTER_STATE_KEY, {
      startMin: state.startMin,
      endMin: state.endMin,
      selectedDow: Array.from(state.selectedDow),
      selectedTi: Array.from(state.selectedTi),
    });
  }

  const savedFilterState = loadFilterState();
  let state = {
    selectedTi: savedFilterState ? savedFilterState.selectedTi : new Set(),
    year: new Date().getFullYear(),
    month: new Date().getMonth() + 1,
    startMin: savedFilterState ? savedFilterState.startMin : 0,
    endMin: savedFilterState ? savedFilterState.endMin : 24 * 60,
    selectedDow: savedFilterState ? savedFilterState.selectedDow : new Set([0, 1, 2, 3, 4, 5, 6]),
  };

  const PROBE_MONTHS = 6;
  let monthListCache = {}; // key: "0,2" のような選択施設indexの組み合わせ

  function monthListCacheKey(indices) {
    return indices.slice().sort((a, b) => a - b).join(',');
  }

  async function anyHasData(indices, year, month) {
    let any = false;
    for (const ti of indices) {
      await ensureMonthFetched(ti, year, month);
      if (monthHasData(ti, year, month)) any = true;
    }
    return any;
  }

  async function getMonthList(indices) {
    const key = monthListCacheKey(indices);
    if (monthListCache[key]) return monthListCache[key];
    const now = new Date();
    const list = [];
    for (let i = 0; i < PROBE_MONTHS; i++) {
      const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
      if (await anyHasData(indices, d.getFullYear(), d.getMonth() + 1)) {
        list.push({ year: d.getFullYear(), month: d.getMonth() + 1 });
      }
    }
    monthListCache[key] = list;
    return list;
  }

  async function extendMonthListForward(indices) {
    const key = monthListCacheKey(indices);
    const list = monthListCache[key] || (monthListCache[key] = []);
    const lastEntry = list[list.length - 1];
    const base = lastEntry ? new Date(lastEntry.year, lastEntry.month - 1, 1) : new Date();
    for (let i = 1; i <= 12; i++) {
      const d = new Date(base.getFullYear(), base.getMonth() + i, 1);
      if (await anyHasData(indices, d.getFullYear(), d.getMonth() + 1)) {
        list.push({ year: d.getFullYear(), month: d.getMonth() + 1 });
        return list[list.length - 1];
      }
    }
    return null;
  }

  function formatDateTime(d) {
    if (!d) return '';
    const p2 = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}/${p2(d.getMonth() + 1)}/${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
  }

  function buildFilterSummaryHtml(indices) {
    const names = indices.map((i) => (TARGETS[i] ? TARGETS[i].name : '')).join('・') || '（未選択）';
    const timeText =
      state.startMin === 0 && state.endMin === 24 * 60
        ? '指定なし'
        : `${minToTime(state.startMin)}〜${minToTime(state.endMin)}`;
    const dowText =
      state.selectedDow.size === 7
        ? '全曜日'
        : [0, 1, 2, 3, 4, 5, 6].filter((d) => state.selectedDow.has(d)).map((d) => DOW[d]).join('・');
    const monthText = `${state.year}年${state.month}月`;
    const partialFail = indices.some((ti) => hasFailure(ti));
    const fetchedText = lastFetchedAt
      ? `取得: ${formatDateTime(lastFetchedAt)}${partialFail ? '（一部取得失敗あり）' : ''}`
      : partialFail ? '取得失敗' : '';
    return (
      `<div class="mtc-filter-summary" id="mtc-filter-summary">` +
      `<div>${monthText}　施設: ${names}</div>` +
      `<div>時間帯: ${timeText}　曜日: ${dowText}</div>` +
      (fetchedText ? `<div class="mtc-fetched-at">${fetchedText}</div>` : '') +
      `</div>`
    );
  }

  // 曜日プリセットの中身（ボタンの動作と点灯判定の両方で使う）
  const DOW_PRESETS = {
    weekday: [1, 2, 3, 4, 5],
    weekend: [0, 6],
    all: [0, 1, 2, 3, 4, 5, 6],
  };

  // 「どのボタンを押したか」ではなく「いまの条件がボタンの中身と完全に一致するか」で点灯を決める。
  // 木曜だけ・06:00〜11:00など、どれにも一致しなければ自動的に全部消灯する。
  function updatePresetHighlight(panel) {
    panel.querySelectorAll('#mtc-time-presets .mtc-preset-btn').forEach((btn) => {
      const on = timeToMin(btn.dataset.start) === state.startMin && timeToMin(btn.dataset.end) === state.endMin;
      btn.classList.toggle('active', on);
    });
    const resetBtn = panel.querySelector('#mtc-time-reset');
    if (resetBtn) resetBtn.classList.toggle('active', state.startMin === 0 && state.endMin === 24 * 60);
    panel.querySelectorAll('#mtc-dow-presets .mtc-preset-btn').forEach((btn) => {
      const dows = DOW_PRESETS[btn.dataset.dowPreset] || [];
      const on = dows.length === state.selectedDow.size && dows.every((d) => state.selectedDow.has(d));
      btn.classList.toggle('active', on);
    });
  }

  async function renderCalendarView(panel) {
    updatePresetHighlight(panel); // 取得待ちの前に即座に反映
    const body = panel.querySelector('#mtc-body');
    if (!initialFetchDone) {
      body.innerHTML = '<div class="mtc-loading">読み込み中...</div>';
      await fetchAllInitial();
    }

    // 無効化された施設が選択に残っていたら外す。何も選ばれていなければ先頭を選ぶ
    const enabled = enabledIndices();
    state.selectedTi = new Set(Array.from(state.selectedTi).filter((i) => enabled.includes(i)));
    if (state.selectedTi.size === 0 && enabled.length > 0) state.selectedTi.add(enabled[0]);

    const indices = Array.from(state.selectedTi).sort((a, b) => a - b);

    const monthList = await getMonthList(indices);
    if (monthList.length > 0 && !monthList.some((m) => m.year === state.year && m.month === state.month)) {
      state.year = monthList[0].year;
      state.month = monthList[0].month;
    }
    for (const ti of indices) {
      await ensureMonthFetched(ti, state.year, state.month);
    }

    renderTabs(panel);

    const select = panel.querySelector('#mtc-month-select');
    if (monthList.length === 0) {
      select.innerHTML = indices.some((ti) => hasFailure(ti)) ? '<option>取得失敗</option>' : '<option>データなし</option>';
    } else {
      select.innerHTML = monthList
        .map(
          (m) =>
            `<option value="${m.year}-${m.month}" ${m.year === state.year && m.month === state.month ? 'selected' : ''}>${m.year}年${m.month}月</option>`
        )
        .join('');
    }

    let calendarsHtml = '';
    // 取得に失敗した施設は「受付中の月がない」とは断定できないので、ここには含めず警告枠で案内する
    const missingFacilities = indices
      .filter((ti) => !hasFailure(ti) && !monthHasData(ti, state.year, state.month))
      .map((ti) => (TARGETS[ti] ? TARGETS[ti].name : ''));
    const noDataNotice = missingFacilities.length
      ? `<p style="color:#c62828;font-size:12px;text-align:center;">${missingFacilities.join('・')} は現在、予約受付中の月がありません。</p>`
      : '';
    const legendHtml =
      indices.length > 1
        ? `<div class="mtc-facility-legend">${indices
            .map(
              (ti) =>
                `<span class="mtc-legend-item"><span class="mtc-legend-dot" style="background:${facilityColor(ti)};"></span>${TARGETS[ti] ? TARGETS[ti].name : ''}</span>`
            )
            .join('')}</div>`
        : '';

    const failList = failureSummaryList(indices);
    const failBanner = failList.length
      ? `<div class="mtc-fail-banner"><div class="mtc-fail-title">⚠ 一部のデータを取得できませんでした</div>` +
        `<div>対象：${failList.join('、')}</div>` +
        `<div>この部分は「空きなし」「予約受付中の月がありません」などと表示されていても<b>正しくない場合があります</b>。` +
        `少し時間をおいて<b>「再取得」</b>を押してください。</div></div>`
      : '';

    calendarsHtml =
      legendHtml +
      noDataNotice +
      buildCalendarMulti(indices, state.year, state.month, state.startMin, state.endMin, state.selectedDow);

    body.innerHTML =
      failBanner +
      `<div class="mtc-legend">凡例：緑=全面空き　黄=一部空き　－対象外／セルをタップで詳細</div>` +
      `<div id="mtc-capture-area">` +
      buildFilterSummaryHtml(indices) +
      calendarsHtml +
      `</div>` +
      `<h3 style="font-size:13px;margin-top:8px;">空きあり日の詳細　<span style="font-weight:normal;font-size:11px;color:#888;">（タップで時間帯選択画面へ）</span></h3>` +
      buildMonthDetailMulti(indices, state.year, state.month, state.startMin, state.endMin, state.selectedDow);

    bindCellTapPopover(panel);
    bindDetailChipJump(panel);
    saveFilterState();
  }

  function renderTabs(panel) {
    const tabs = panel.querySelector('#mtc-tabs');
    const indices = enabledIndices();
    tabs.innerHTML = indices
      .map(
        (i) =>
          `<button type="button" class="mtc-tab ${state.selectedTi.has(i) ? 'active' : ''}" data-i="${i}">${TARGETS[i].name}</button>`
      )
      .join('');
    tabs.querySelectorAll('.mtc-tab').forEach((btn) => {
      btn.addEventListener('click', () => {
        const i = Number(btn.dataset.i);
        if (state.selectedTi.has(i)) {
          if (state.selectedTi.size === 1) return; // 最低1件は残す
          state.selectedTi.delete(i);
        } else {
          state.selectedTi.add(i);
        }
        renderCalendarView(panel);
      });
    });
  }

  async function stepMonth(panel, diff) {
    const indices = Array.from(state.selectedTi).sort((a, b) => a - b);
    const list = await getMonthList(indices);
    let idx = list.findIndex((m) => m.year === state.year && m.month === state.month);
    if (idx === -1) idx = 0;
    let targetIdx = idx + diff;

    if (targetIdx < 0) return;

    if (targetIdx >= list.length) {
      const extended = await extendMonthListForward(indices);
      if (!extended) return;
      targetIdx = monthListCache[monthListCacheKey(indices)].length - 1;
    }
    const target = monthListCache[monthListCacheKey(indices)][targetIdx];
    state.year = target.year;
    state.month = target.month;
    renderCalendarView(panel);
  }

  // ============================================================
  // 日別詳細のタップ表示（スマホ対応：hoverの代わり）
  // ============================================================
  let daypopEl = null;
  function ensureDaypop() {
    if (daypopEl) return daypopEl;
    daypopEl = document.createElement('div');
    daypopEl.id = 'mtc-daypop';
    document.body.appendChild(daypopEl);
    document.addEventListener('click', (e) => {
      if (daypopEl.style.display === 'none') return;
      if (daypopEl.contains(e.target)) return;
      daypopEl.style.display = 'none';
    });
    return daypopEl;
  }

  // 「空きあり日の詳細」のチップをタップしたら、時間帯選択画面へ飛ばす
  function bindDetailChipJump(panel) {
    const body = panel.querySelector('#mtc-body');
    body.querySelectorAll('.mtc-chip-jump').forEach((chip) => {
      chip.addEventListener('click', (e) => {
        e.stopPropagation();
        const ti = Number(chip.dataset.ti);
        const dateStr = chip.dataset.date;
        chip.style.opacity = '0.5';
        jumpToBooking(ti, dateStr).finally(() => {
          chip.style.opacity = '1';
        });
      });
    });
  }

  function bindCellTapPopover(panel) {
    const body = panel.querySelector('#mtc-body');
    body.querySelectorAll('.mtc-calendar td[data-date]').forEach((td) => {
      td.addEventListener('click', (e) => {
        e.stopPropagation();
        const dateStr = td.dataset.date;
        const indices = Array.from(state.selectedTi).sort((a, b) => a - b);
        const pop = ensureDaypop();
        const d = new Date(dateStr + 'T00:00:00');
        const dow = d.getDay();

        let inner = `<div style="font-weight:bold;margin-bottom:6px;">${d.getMonth() + 1}/${d.getDate()}(${DOW[dow]})</div>`;
        let any = false;
        indices.forEach((ti) => {
          const cell = (lastData[ti] || {})[dateStr];
          const slotMap = openSlotsInRange(ti, cell, state.startMin, state.endMin);
          if (slotMap.size === 0) return;
          any = true;
          inner += `<div style="font-weight:bold;color:${facilityColor(ti)};margin-top:4px;display:flex;align-items:center;justify-content:space-between;gap:6px;">` +
            `<span>${TARGETS[ti] ? TARGETS[ti].name : ''}</span>` +
            `<button type="button" class="mtc-daypop-jump" data-ti="${ti}" data-date="${dateStr}" style="background:#2e7d32;color:#fff;border:none;border-radius:4px;padding:2px 8px;font-size:10px;cursor:pointer;">予約画面へ</button>` +
            `</div>`;
          inner += '<div class="mtc-chips" style="margin-bottom:2px;">';
          Array.from(slotMap.entries())
            .sort(([a], [b]) => (a < b ? -1 : 1))
            .forEach(([time, courts]) => {
              inner += `<span class="mtc-chip"><b>${time}</b>（${courts.length}面：${courts.join('・')}）</span>`;
            });
          inner += '</div>';
        });
        if (!any) {
          inner += '<div style="color:#c62828;">この時間帯は空きがありません</div>';
        }
        inner +=
          '<button type="button" id="mtc-daypop-close" style="margin-top:4px;background:#666;color:#fff;border:none;border-radius:4px;padding:3px 10px;font-size:11px;cursor:pointer;">閉じる</button>';
        pop.innerHTML = inner;
        pop.style.display = 'block';
        pop.style.left = '0px';
        pop.style.top = '0px';

        const rect = td.getBoundingClientRect();
        const popRect = pop.getBoundingClientRect();
        let left = rect.left;
        let top = rect.bottom + 4;
        if (left + popRect.width > window.innerWidth - 8) left = window.innerWidth - popRect.width - 8;
        if (left < 8) left = 8;
        if (top + popRect.height > window.innerHeight - 8) top = rect.top - popRect.height - 4;
        if (top < 8) top = 8;
        pop.style.left = `${left}px`;
        pop.style.top = `${top}px`;

        pop.querySelector('#mtc-daypop-close').addEventListener('click', () => {
          pop.style.display = 'none';
        });
        pop.querySelectorAll('.mtc-daypop-jump').forEach((btn) => {
          btn.addEventListener('click', (ev) => {
            ev.stopPropagation();
            const jti = Number(btn.dataset.ti);
            const jdate = btn.dataset.date;
            btn.disabled = true;
            btn.textContent = '…';
            jumpToBooking(jti, jdate).finally(() => {
              btn.disabled = false;
              btn.textContent = '予約画面へ';
            });
          });
        });
      });
    });
  }

  // ============================================================
  // LINE用画像コピー（フィルタ条件込み・元データから直接canvas描画）
  // ============================================================
  function copyAsImage() {
    const indices = Array.from(state.selectedTi).sort((a, b) => a - b);
    if (indices.length === 0) return;

    const cellW = 130;
    const chipH = 14;
    const headerH = 20;
    const legendH = indices.length > 1 ? 22 : 0;
    const dowList = [0, 1, 2, 3, 4, 5, 6].filter((d) => state.selectedDow.has(d));
    const colCount = Math.max(1, dowList.length);
    const canvasW = cellW * colCount;

    const summaryLines = [
      `${state.year}年${state.month}月　施設: ${indices.map((i) => (TARGETS[i] ? TARGETS[i].name : '')).join('・')}`,
      `時間帯: ${state.startMin === 0 && state.endMin === 24 * 60 ? '指定なし' : `${minToTime(state.startMin)}〜${minToTime(state.endMin)}`}　曜日: ${state.selectedDow.size === 7 ? '全曜日' : dowList.map((d) => DOW[d]).join('・')}`,
    ];
    if (lastFetchedAt) {
      summaryLines.push(`取得: ${formatDateTime(lastFetchedAt)}`);
    }
    // 取得失敗があれば、受け取った人にも分かるよう画像に警告行を入れる
    const imgFailList = failureSummaryList(indices);
    const warnText = imgFailList.length
      ? `⚠ 一部取得できず：${imgFailList.join('、')}　空き表示が不正確な可能性あり`
      : '';
    // 曜日を絞ると画像の幅が狭くなるので、警告文は幅に合わせて折り返す
    const warnFont = 'bold 11px sans-serif';
    const warnLineH = 15;
    const warnLines = [];
    if (warnText) {
      const wctx = document.createElement('canvas').getContext('2d');
      wctx.font = warnFont;
      let line = '';
      for (const ch of warnText) {
        if (line && wctx.measureText(line + ch).width > canvasW - 16) {
          warnLines.push(line);
          line = '';
        }
        line += ch;
      }
      if (line) warnLines.push(line);
    }
    const warnH = warnLines.length ? warnLines.length * warnLineH + 4 : 0;

    // 週ごとのデータを事前に計算し、各マスのチップ数からセル高さを決める
    const daysInMonth = new Date(state.year, state.month, 0).getDate();
    const startDow = new Date(state.year, state.month - 1, 1).getDay();
    const weeks = [];
    let week = new Array(colCount).fill(null);
    let dow = startDow;
    let maxChipsInAnyCell = 1;
    for (let day = 1; day <= daysInMonth; day++) {
      if (state.selectedDow.has(dow)) {
        const dateStr = `${state.year}-${pad2(state.month)}-${pad2(day)}`;
        const info = computeDayCellMulti(indices, dateStr, state.startMin, state.endMin);
        const shown = info.chips.slice(0, MAX_INLINE_CHIPS_MULTI);
        const overflow = info.chips.length - shown.length;
        const colIdx = dowList.indexOf(dow);
        week[colIdx] = { day, dow, status: info.status, noneText: info.noneText, chips: shown, overflow };
        maxChipsInAnyCell = Math.max(maxChipsInAnyCell, shown.length + (overflow > 0 ? 1 : 0));
      }
      dow++;
      if (dow === 7) {
        weeks.push(week);
        week = new Array(colCount).fill(null);
        dow = 0;
      }
    }
    if (week.some((c) => c !== null)) weeks.push(week);

    const cellH = 20 + Math.max(1, maxChipsInAnyCell) * chipH + 6;

    // ---- 「空きあり日の詳細」の折り返しレイアウトを、実際に描く前に計測しておく ----
    // (canvasの高さを先に決める必要があるため、計測専用の一時canvasでmeasureTextする)
    const measureCanvas = document.createElement('canvas');
    const mctx = measureCanvas.getContext('2d');
    const detailFont = '10px sans-serif';
    const detailChipH = 16;
    const detailChipGapX = 4;
    const detailChipGapY = 4;
    const detailPaddingX = 6;
    const detailMaxWidth = canvasW - 16;

    function layoutDetailChips(chips) {
      mctx.font = detailFont;
      const rows = [];
      let currentRow = [];
      let currentX = 0;
      chips.forEach((c) => {
        const text = `${c.label} ${c.timeText}（${c.nText}）`;
        const w = mctx.measureText(text).width + detailPaddingX * 2;
        if (currentX + w > detailMaxWidth && currentRow.length > 0) {
          rows.push(currentRow);
          currentRow = [];
          currentX = 0;
        }
        currentRow.push({ text, w, color: c.color });
        currentX += w + detailChipGapX;
      });
      if (currentRow.length) rows.push(currentRow);
      return rows;
    }

    const detailEntries = [];
    for (let day = 1; day <= daysInMonth; day++) {
      const d0 = new Date(state.year, state.month - 1, day);
      if (!state.selectedDow.has(d0.getDay())) continue;
      const dateStr = `${state.year}-${pad2(state.month)}-${pad2(day)}`;
      const info = computeDayCellMulti(indices, dateStr, state.startMin, state.endMin);
      if (info.chips.length === 0) continue;
      const rows = layoutDetailChips(info.chips);
      const entryH = 16 + rows.length * (detailChipH + detailChipGapY);
      detailEntries.push({ day, dow: d0.getDay(), rows, h: entryH });
    }

    const detailHeaderH = detailEntries.length > 0 ? 26 : 0;
    const detailTotalH =
      detailHeaderH + detailEntries.reduce((sum, e) => sum + e.h, 0) + (detailEntries.length > 0 ? 10 : 0);

    const totalH = 12 + summaryLines.length * 18 + warnH + 10 + legendH + headerH + weeks.length * cellH + 16 + detailTotalH;

    const canvas = document.createElement('canvas');
    canvas.width = canvasW;
    canvas.height = totalH;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.textBaseline = 'top';

    let y = 10;
    summaryLines.forEach((line, i) => {
      const isFetchedLine = lastFetchedAt && i === summaryLines.length - 1;
      ctx.font = isFetchedLine ? '10px sans-serif' : 'bold 13px sans-serif';
      ctx.fillStyle = isFetchedLine ? '#888' : '#333';
      ctx.fillText(line, 8, y, canvas.width - 16);
      y += isFetchedLine ? 14 : 18;
    });
    if (warnLines.length) {
      ctx.font = warnFont;
      ctx.fillStyle = '#e65100';
      warnLines.forEach((wl) => {
        ctx.fillText(wl, 8, y);
        y += warnLineH;
      });
      y += 4;
    }
    y += 4;

    if (indices.length > 1) {
      ctx.font = '11px sans-serif';
      let lx = 8;
      indices.forEach((ti) => {
        const color = facilityColor(ti);
        const label = TARGETS[ti] ? TARGETS[ti].name : '';
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(lx + 4, y + 8, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#333';
        ctx.fillText(label, lx + 12, y + 3);
        lx += 12 + ctx.measureText(label).width + 16;
      });
      y += legendH;
    }

    // 曜日ヘッダー
    ctx.font = 'bold 11px sans-serif';
    dowList.forEach((d, ci) => {
      ctx.fillStyle = d === 0 ? '#c62828' : d === 6 ? '#1565c0' : '#666';
      ctx.fillText(DOW[d], ci * cellW + 6, y + 4);
    });
    ctx.strokeStyle = '#ddd';
    ctx.beginPath();
    ctx.moveTo(0, y + headerH);
    ctx.lineTo(cellW * colCount, y + headerH);
    ctx.stroke();
    y += headerH;

    weeks.forEach((weekRow) => {
      weekRow.forEach((c, ci) => {
        const x = ci * cellW;
        ctx.strokeStyle = '#eee';
        ctx.strokeRect(x, y, cellW, cellH);
        if (!c) return;

        ctx.fillStyle = STATUS_BG[c.status] || '#fafafa';
        ctx.fillRect(x + 1, y + 1, cellW - 2, cellH - 2);

        ctx.font = '11px sans-serif';
        ctx.fillStyle = c.dow === 0 ? '#c62828' : c.dow === 6 ? '#1565c0' : '#888';
        const dayText = String(c.day);
        const dayTextW = ctx.measureText(dayText).width;
        ctx.fillText(dayText, x + cellW - dayTextW - 4, y + 3);

        let cy = y + 18;
        if (c.noneText) {
          ctx.font = '11px sans-serif';
          ctx.fillStyle = '#bbb';
          const w = ctx.measureText(c.noneText).width;
          ctx.fillText(c.noneText, x + (cellW - w) / 2, y + cellH / 2 - 6);
        } else {
          c.chips.forEach((chip) => {
            const colors = CHIP_COLOR[chip.kind] || CHIP_COLOR.partial;
            ctx.fillStyle = colors.bg;
            ctx.fillRect(x + 3, cy, cellW - 6, chipH - 2);
            ctx.fillStyle = chip.color;
            ctx.fillRect(x + 3, cy, 3, chipH - 2);
            ctx.font = '9px sans-serif';
            ctx.fillStyle = colors.fg;
            ctx.fillText(`${chip.label} ${chip.timeText} ${chip.nText}`, x + 8, cy + 2, cellW - 12);
            cy += chipH;
          });
          if (c.overflow > 0) {
            ctx.fillStyle = CHIP_COLOR.more.bg;
            ctx.fillRect(x + 3, cy, cellW - 6, chipH - 2);
            ctx.fillStyle = CHIP_COLOR.more.fg;
            ctx.font = '9px sans-serif';
            const t = `+${c.overflow}件`;
            const w = ctx.measureText(t).width;
            ctx.fillText(t, x + (cellW - w) / 2, cy + 2);
          }
        }
      });
      y += cellH;
    });

    // ---- 空きあり日の詳細（カレンダーでは省略された分も含め全件） ----
    if (detailEntries.length > 0) {
      y += 10;
      ctx.fillStyle = '#333';
      ctx.font = 'bold 13px sans-serif';
      ctx.fillText('空きあり日の詳細', 8, y);
      y += detailHeaderH;

      detailEntries.forEach((entry) => {
        const dowColor = entry.dow === 0 ? '#c62828' : entry.dow === 6 ? '#1565c0' : '#333';
        ctx.font = 'bold 11px sans-serif';
        ctx.fillStyle = dowColor;
        ctx.fillText(`${state.month}/${entry.day}(${DOW[entry.dow]})`, 8, y);
        y += 15;

        entry.rows.forEach((row) => {
          let x = 8;
          row.forEach((chip) => {
            ctx.fillStyle = '#e8f5e9';
            ctx.fillRect(x, y, chip.w, detailChipH - 2);
            ctx.fillStyle = chip.color;
            ctx.fillRect(x, y, 3, detailChipH - 2);
            ctx.font = detailFont;
            ctx.fillStyle = '#1b5e20';
            ctx.fillText(chip.text, x + detailPaddingX, y + 3);
            x += chip.w + detailChipGapX;
          });
          y += detailChipH + detailChipGapY;
        });
      });
    }

    canvas.toBlob((blob) => {
      if (!blob) return;
      try {
        navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        alert('画像をクリップボードにコピーしました（フィルタ条件・詳細も含まれています）。LINEに貼り付けできます。');
      } catch (e) {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `mitaka-tennis-${Date.now()}.png`;
        a.click();
      }
    });
  }

  // ============================================================
  // メインパネル
  // ============================================================
  function buildPanel() {
    const panel = document.createElement('div');
    panel.id = 'mtc-panel';
    panel.style.cssText =
      'position:fixed;top:3%;left:50%;transform:translateX(-50%);' +
      'width:min(96vw,680px);max-height:94vh;overflow-y:auto;background:#fff;' +
      'z-index:2147483647;border-radius:12px;box-shadow:0 4px 24px rgba(0,0,0,0.4);' +
      'padding:14px;display:none;font-family:sans-serif;font-size:13px;';

    const timeOptions = buildTimeOptions()
      .map((t) => `<option value="${t}">${t}</option>`)
      .join('');

    panel.innerHTML = `
      <button class="mtc-close" id="mtc-close-btn">×</button>
      <h2>三鷹市テニスコート空き状況<span class="mtc-ver">v${SCRIPT_VERSION}</span></h2>
      <div class="mtc-toolbar">
        <button class="mtc-btn" id="mtc-refresh-btn">再取得</button>
        <button class="mtc-btn secondary" id="mtc-copy-btn">LINE用に画像コピー</button>
        <button class="mtc-btn secondary" id="mtc-settings-btn">⚙ 施設設定</button>
      </div>
      <div class="mtc-tabs-label">施設（複数選択可）</div>
      <div class="mtc-tabs" id="mtc-tabs"></div>
      <div class="mtc-monthnav">
        <button type="button" id="mtc-prev-month">◀</button>
        <select class="mtc-month-select" id="mtc-month-select"></select>
        <button type="button" id="mtc-next-month">▶</button>
      </div>
      <div class="mtc-timefilter">
        時間帯：
        <select id="mtc-start-time">${timeOptions}</select>
        〜
        <select id="mtc-end-time">${timeOptions}</select>
        <button class="mtc-btn secondary" id="mtc-time-reset" type="button">指定なし</button>
      </div>
      <div class="mtc-preset-row" id="mtc-time-presets">
        <button class="mtc-preset-btn" type="button" data-start="06:00" data-end="12:00">午前</button>
        <button class="mtc-preset-btn" type="button" data-start="12:00" data-end="17:00">午後</button>
        <button class="mtc-preset-btn" type="button" data-start="17:00" data-end="19:00">夕方</button>
        <button class="mtc-preset-btn" type="button" data-start="19:00" data-end="24:00">ナイター(19時〜)</button>
      </div>
      <div class="mtc-weekday-filter" id="mtc-weekday-filter">
        ${DOW.map((d, i) => `<label><input type="checkbox" data-dow="${i}" ${state.selectedDow.has(i) ? 'checked' : ''}>${d}</label>`).join('')}
      </div>
      <div class="mtc-preset-row" id="mtc-dow-presets">
        <button class="mtc-preset-btn" type="button" data-dow-preset="weekday">平日</button>
        <button class="mtc-preset-btn" type="button" data-dow-preset="weekend">週末</button>
        <button class="mtc-preset-btn" type="button" data-dow-preset="all">全曜日</button>
      </div>
      <div id="mtc-body"><div class="mtc-loading">読み込み中...</div></div>
    `;
    document.body.appendChild(panel);

    panel.querySelector('#mtc-start-time').value = minToTime(state.startMin);
    panel.querySelector('#mtc-end-time').value = minToTime(state.endMin);

    panel.querySelector('#mtc-close-btn').addEventListener('click', () => {
      panel.style.display = 'none';
    });
    panel.querySelector('#mtc-refresh-btn').addEventListener('click', async () => {
      panel.querySelector('#mtc-body').innerHTML = '<div class="mtc-loading">読み込み中...</div>';
      monthListCache = {};
      await fetchAllInitial();
      renderCalendarView(panel);
    });
    panel.querySelector('#mtc-copy-btn').addEventListener('click', copyAsImage);
    panel.querySelector('#mtc-settings-btn').addEventListener('click', () => openSettings(panel));
    panel.querySelector('#mtc-prev-month').addEventListener('click', () => stepMonth(panel, -1));
    panel.querySelector('#mtc-next-month').addEventListener('click', () => stepMonth(panel, 1));
    panel.querySelector('#mtc-month-select').addEventListener('change', (e) => {
      const [y, m] = e.target.value.split('-').map(Number);
      if (!y || !m) return;
      state.year = y;
      state.month = m;
      renderCalendarView(panel);
    });

    const applyTimeFilter = () => {
      state.startMin = timeToMin(panel.querySelector('#mtc-start-time').value);
      state.endMin = timeToMin(panel.querySelector('#mtc-end-time').value);
      renderCalendarView(panel);
    };
    panel.querySelector('#mtc-start-time').addEventListener('change', applyTimeFilter);
    panel.querySelector('#mtc-end-time').addEventListener('change', applyTimeFilter);
    panel.querySelector('#mtc-time-reset').addEventListener('click', () => {
      panel.querySelector('#mtc-start-time').value = '00:00';
      panel.querySelector('#mtc-end-time').value = '24:00';
      applyTimeFilter();
    });

    panel.querySelectorAll('#mtc-weekday-filter input[type="checkbox"]').forEach((cb) => {
      cb.addEventListener('change', () => {
        const dow = Number(cb.dataset.dow);
        if (cb.checked) state.selectedDow.add(dow);
        else state.selectedDow.delete(dow);
        if (state.selectedDow.size === 0) {
          state.selectedDow.add(dow);
          cb.checked = true;
          return;
        }
        renderCalendarView(panel);
      });
    });

    panel.querySelectorAll('#mtc-time-presets .mtc-preset-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        panel.querySelector('#mtc-start-time').value = btn.dataset.start;
        panel.querySelector('#mtc-end-time').value = btn.dataset.end;
        applyTimeFilter();
      });
    });

    panel.querySelectorAll('#mtc-dow-presets .mtc-preset-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const dows = DOW_PRESETS[btn.dataset.dowPreset] || DOW_PRESETS.all;

        state.selectedDow = new Set(dows);
        panel.querySelectorAll('#mtc-weekday-filter input[type="checkbox"]').forEach((cb) => {
          cb.checked = dows.includes(Number(cb.dataset.dow));
        });
        renderCalendarView(panel);
      });
    });

    updatePresetHighlight(panel);
    return panel;
  }

  // ============================================================
  // 施設設定画面
  // ============================================================
  function buildSettingsModal() {
    const modal = document.createElement('div');
    modal.id = 'mtc-settings';
    modal.style.cssText =
      'position:fixed;top:5%;left:50%;transform:translateX(-50%);' +
      'width:min(94vw,560px);max-height:90vh;overflow-y:auto;background:#fff;' +
      'z-index:2147483647;border-radius:12px;box-shadow:0 4px 24px rgba(0,0,0,0.4);' +
      'padding:16px;display:none;font-family:sans-serif;font-size:13px;';
    modal.innerHTML = `
      <button class="mtc-close" id="mtc-settings-close">×</button>
      <h2>監視する施設・コート設定</h2>
      <p style="font-size:11px;color:#888;">
        「取得」のチェックを外すとその施設は取得・表示されなくなります（設定情報は消えないので、いつでもチェックを戻せば元通りです）。<br>
        「除外コート番号」に数字をカンマ区切りで入れると（例: 6 や 4,5）、そのコートは団体登録不可などの理由で空きとしてカウントしません。空欄なら全コートを対象にします。<br>
        新しい施設を追加する場合、facility_idとroom_idは対象施設の空き状況カレンダーページのソース（Ctrl+U）から
        <code>data-room-id</code> や <code>x-init="facilityId = N"</code> を探して確認できます。
      </p>
      <div class="mtc-row mtc-row-head"><div>取得</div><div>施設ID</div><div>コートID</div><div>表示名</div><div>備考</div><div>除外コート番号</div></div>
      <div id="mtc-settings-rows"></div>
      <div class="mtc-toolbar" style="margin-top:10px;">
        <button class="mtc-btn secondary" id="mtc-settings-add" type="button">＋ 行を追加</button>
        <button class="mtc-btn" id="mtc-settings-save" type="button">保存して再取得</button>
        <button class="mtc-btn secondary" id="mtc-settings-reset" type="button">初期設定に戻す</button>
      </div>
    `;
    document.body.appendChild(modal);
    return modal;
  }

  function renderSettingsRows(modal, targets) {
    const container = modal.querySelector('#mtc-settings-rows');
    container.innerHTML = '';
    targets.forEach((t, i) => {
      const row = document.createElement('div');
      row.className = 'mtc-row' + (t.enabled === false ? ' mtc-row-disabled' : '');
      row.innerHTML = `
        <input type="checkbox" data-field="enabled" data-index="${i}" ${t.enabled === false ? '' : 'checked'} title="取得する">
        <input type="number" data-field="facilityId" value="${t.facilityId ?? ''}">
        <input type="number" data-field="roomId" value="${t.roomId ?? ''}">
        <input type="text" data-field="name" value="${t.name ?? ''}" placeholder="表示名">
        <input type="text" data-field="note" value="${t.note ?? ''}" placeholder="備考">
        <input type="text" data-field="excludeCourts" value="${Array.isArray(t.excludeCourts) ? t.excludeCourts.join(',') : ''}" placeholder="例: 6">
      `;
      container.appendChild(row);
    });
  }

  function bindSettingsAutoSave(modal, panel) {
    const container = modal.querySelector('#mtc-settings-rows');
    container.addEventListener('change', (e) => {
      if (!e.target.matches('input')) return;
      const cb = e.target.matches('[data-field="enabled"]') ? e.target : null;

      workingTargets = readSettingsRows(modal, { keepEmpty: true });

      const anyEnabled = workingTargets.some((t) => t.enabled !== false && t.roomId && t.name);
      if (!anyEnabled) {
        alert('少なくとも1件は「取得」を有効にしてください。');
        if (cb) {
          cb.checked = true;
          const idx = Number(cb.dataset.index);
          if (workingTargets[idx]) workingTargets[idx].enabled = true;
        }
      }

      renderSettingsRows(modal, workingTargets);

      TARGETS = workingTargets.filter((t) => t.roomId && t.name);
      saveTargets(TARGETS);
      monthListCache = {};
      panel.querySelector('#mtc-body').innerHTML = '<div class="mtc-loading">読み込み中...</div>';
      fetchAllInitial().then(() => renderCalendarView(panel));
    });
  }

  function parseExcludeCourts(text) {
    return (text || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map(Number)
      .filter((n) => !Number.isNaN(n));
  }

  function readSettingsRows(modal, options) {
    options = options || {};
    const rows = Array.from(modal.querySelectorAll('#mtc-settings-rows .mtc-row'));
    return rows
      .map((row) => {
        const get = (f) => row.querySelector(`[data-field="${f}"]`).value;
        const enabledCb = row.querySelector('[data-field="enabled"]');
        const enabled = enabledCb ? enabledCb.checked : true;
        const facilityId = Number(get('facilityId'));
        const roomId = Number(get('roomId'));
        const name = get('name').trim();
        const note = get('note').trim();
        const excludeCourts = parseExcludeCourts(get('excludeCourts'));
        if (!options.keepEmpty && (!roomId || !name)) return null;
        return { facilityId, roomId, name, note, enabled, excludeCourts };
      })
      .filter(Boolean);
  }

  let settingsModal = null;
  let workingTargets = null;

  function openSettings(panel) {
    let isNewModal = false;
    if (!settingsModal) {
      settingsModal = buildSettingsModal();
      isNewModal = true;
    }
    workingTargets = TARGETS.map((t) => ({ ...t }));
    renderSettingsRows(settingsModal, workingTargets);
    if (isNewModal) bindSettingsAutoSave(settingsModal, panel);
    settingsModal.style.display = 'block';

    settingsModal.querySelector('#mtc-settings-close').onclick = () => {
      settingsModal.style.display = 'none';
    };
    settingsModal.querySelector('#mtc-settings-add').onclick = () => {
      workingTargets.push({ facilityId: '', roomId: '', name: '', note: '', enabled: true, excludeCourts: [] });
      renderSettingsRows(settingsModal, workingTargets);
    };
    settingsModal.querySelector('#mtc-settings-reset').onclick = () => {
      workingTargets = DEFAULT_TARGETS.map((t) => ({ ...t }));
      renderSettingsRows(settingsModal, workingTargets);
    };
    settingsModal.querySelector('#mtc-settings-save').onclick = () => {
      const newTargets = readSettingsRows(settingsModal);
      if (newTargets.length === 0) {
        alert('少なくとも1件は施設を設定してください。');
        return;
      }
      TARGETS = newTargets;
      saveTargets(TARGETS);
      monthListCache = {};
      settingsModal.style.display = 'none';
      panel.querySelector('#mtc-body').innerHTML = '<div class="mtc-loading">読み込み中...</div>';
      fetchAllInitial().then(() => renderCalendarView(panel));
    };
  }

  // ============================================================
  // 起動
  // ============================================================
  function init() {
    injectStyles();
    const panel = buildPanel();

    const fab = document.createElement('button');
    fab.id = 'mtc-fab';
    fab.title = 'テニスコート空き状況チェック';
    fab.innerHTML = '<span style="font-family:\'Apple Color Emoji\',\'Segoe UI Emoji\',\'Noto Color Emoji\',sans-serif;">🎾</span>';
    fab.style.cssText =
      'position:fixed;' +
      'right:max(20px, env(safe-area-inset-right, 0px));' +
      'bottom:max(28px, calc(env(safe-area-inset-bottom, 0px) + 20px));' +
      'z-index:2147483647;' +
      'width:56px;height:56px;border-radius:50%;background:#1565c0;color:#fff;' +
      'font-size:24px;display:flex;align-items:center;justify-content:center;' +
      'box-shadow:0 2px 8px rgba(0,0,0,0.3);cursor:pointer;border:none;' +
      '-webkit-tap-highlight-color:transparent;touch-action:manipulation;';
    document.body.appendChild(fab);

    try {
      const rect = fab.getBoundingClientRect();
      const testCanvas = document.createElement('canvas');
      testCanvas.width = 10;
      testCanvas.height = 10;
      const tctx = testCanvas.getContext('2d');
      tctx.font = '10px sans-serif';
      tctx.fillText('🎾', 0, 10);
      const noGlyph = tctx.getImageData(0, 0, 10, 10).data.every((v) => v === 0);
      if (noGlyph || rect.width === 0) {
        fab.textContent = '空き';
        fab.style.fontSize = '13px';
        fab.style.fontWeight = 'bold';
      }
    } catch (e) {
      /* 判定に失敗しても致命的ではないので無視 */
    }

    // 初期選択施設（保存されていればそれを使う。無ければ有効な最初の1件）
    const initial = enabledIndices();
    if (state.selectedTi.size === 0 && initial.length > 0) state.selectedTi.add(initial[0]);

    fab.addEventListener('click', async () => {
      const willOpen = panel.style.display !== 'block';
      panel.style.display = willOpen ? 'block' : 'none';
      if (willOpen) {
        renderTabs(panel);
        await renderCalendarView(panel);
      }
    });
  }

  // ============================================================
  // 空き監視ページ(m-court-watch)からのジャンプ
  //   https://yoyaku-mitaka.jp/reservation#cw-jump=134_2026-11-11
  // で開かれたら、その施設・その日の時間帯選択画面へ自動で進む
  // ============================================================
  function handleWatchJump() {
    const m = location.hash.match(/cw-jump=(\d+)_(\d{4}-\d{2}-\d{2})/);
    if (!m) return;
    const roomId = Number(m[1]), dateStr = m[2];
    // 戻る・再読み込みで何度も飛ばないよう、先にアドレスから消す
    try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* 無視 */ }
    const t = TARGETS.find((x) => x.roomId === roomId) || DEFAULT_TARGETS.find((x) => x.roomId === roomId);
    if (!t) {
      alert(`コートチェッカーに登録されていない施設です(room_id: ${roomId})。⚙設定で追加してください。`);
      return;
    }
    const note = document.createElement('div');
    note.textContent = `${t.name} ${dateStr.slice(5).replace('-', '/')} の予約画面へ移動中…`;
    note.style.cssText = 'position:fixed;left:50%;top:20px;transform:translateX(-50%);z-index:2147483647;' +
      'background:#1565c0;color:#fff;padding:10px 16px;border-radius:10px;font-size:15px;box-shadow:0 2px 8px rgba(0,0,0,.3);';
    document.body.appendChild(note);
    jumpToBooking(t, dateStr, { sameTab: true }).finally(() => setTimeout(() => note.remove(), 4000));
  }

  function start() {
    init();
    handleWatchJump();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
