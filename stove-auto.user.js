// ==UserScript==
// @name         STOVE 플레이크 전체 자동화 + 상태 패널
// @namespace    https://github.com/supsupsupsupsu/stove-auto
// @version      0.1.0
// @description  캡슐 뽑기 → 캡슐 누적 보상 → Daily Shop → 미션 → 인기 게시글 → 라운지 → 보상 수령을 자동 처리합니다. (뽑기 성공 검증 / 단계 워치독 / 자동 복구 포함)
// @homepageURL  https://github.com/supsupsupsupsu/stove-auto
// @supportURL   https://github.com/supsupsupsupsu/stove-auto/issues
// @updateURL    https://raw.githubusercontent.com/supsupsupsupsu/stove-auto/main/stove-auto.user.js
// @downloadURL  https://raw.githubusercontent.com/supsupsupsupsu/stove-auto/main/stove-auto.user.js
// @match        https://reward.onstove.com/*
// @match        https://event.onstove.com/ko/dailyshop/*
// @match        https://lounge.onstove.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_openInTab
// @grant        GM_registerMenuCommand
// @run-at       document-idle
// ==/UserScript==

/* eslint-disable no-console */

(() => {
  'use strict';

  // ===========================================================================
  // 0. 설정
  // ===========================================================================

  const VERSION = '0.1.0';

  // 저장소 키는 스키마가 바뀌면 뒤 숫자를 올린다. (이전 버전 잔여 상태와 충돌 방지)
  const KEY = {
    MAIN: '__stove_auto_main_s1',
    RETRY: '__stove_daily_retry_s1',
    LOG: '__stove_auto_status_log_s1',
    LEDGER: '__stove_draw_ledger_s1',
  };

  const CFG = {
    // 캡슐 뽑기 목표 횟수
    DRAW_COUNT: 30,

    // 1회 뽑기 결과를 기다리는 최대 시간
    DRAW_RESULT_TIMEOUT: 12000,

    // 결과 확인 실패 시 같은 회차를 다시 시도할 횟수
    DRAW_RETRY_PER_ROUND: 2,

    // 오늘의 아이템 재시도 간격(4시간) / 당일 최종 시도 시각
    RETRY_INTERVAL_MS: 4 * 60 * 60 * 1000,
    FINAL_RETRY_TIME: '23:50:00',

    // 방문 미션 체류 시간
    VISIT_WAIT: 4000,

    // 워치독: 이 시간 동안 상태 갱신이 없으면 멈춘 것으로 판단
    STALL_TIMEOUT_MS: 90 * 1000,
    WATCHDOG_INTERVAL_MS: 10 * 1000,

    // 같은 phase 에서 페이지 이동을 이 횟수 이상 반복하면 중단(무한 리다이렉트 방지)
    MAX_NAV_PER_PHASE: 4,

    // 단계 전체 타임아웃 (이 시간을 넘기면 해당 단계는 실패 처리하고 다음으로)
    STEP_TIMEOUT_MS: 5 * 60 * 1000,

    // 페이지 리로드로 뽑기가 끊겼을 때 남은 횟수를 자동 재개할지 여부
    // (중복 차감 위험이 있어 기본 false — 이후 단계는 그대로 이어서 진행)
    RESUME_DRAW_AFTER_RELOAD: false,
  };

  // 자주 바뀌는 셀렉터는 한 곳에 모아둔다. 사이트 개편 시 여기만 고치면 된다.
  const SEL = {
    flake: [
      'span.whitespace-nowrap.block.overflow-ellipsis',
      '[class*="flake"] span.whitespace-nowrap',
    ],
    rewardPopup: '.l1l2-flakehub-popup-common-received_reward',
    drawButtonText: 'span.button-draw-hover-text',
    repeatButtonText: 'span.block.whitespace-nowrap',
    popularAnchor: 'a[href*="page.onstove.com"]',
    loungeTitle: 'textarea.sc-feed-editor-form-title',
    loungeBody: 'div.fr-element.fr-view',
    loungeSubmit: 'button.sc-feed-editor-submit-button',
    feedTitle: '.sc-feed-detail-header-title',
    commentOpener: '.sc-feed-comment-editor-form-button',
    commentBox: '.sc-feed-comment-editor-content',
    commentSubmit: '.sc-feed-comment-editor-submit-button',
    likeButton: '.sc-feed-detail-like-button',
  };

  const BODY_TEXT = '오늘도 좋은 하루 보내세요!';
  const COMMENT_TEXT = '좋은 글 잘 봤습니다';

  const LOUNGE_URL =
    'https://lounge.onstove.com/feed/%ED%94%8C%EB%A0%88%EC%9D%B4%ED%81%AC%EB%AF%B8%EC%85%98';

  const REWARD_URL = 'https://reward.onstove.com/ko/event';

  // Daily Shop URL 의 연월은 매달 바뀐다. 하드코딩하면 다음 달에 반드시 멈춘다.
  const DAILY_SHOPS = [
    { code: 'RIICHICITY_IND', label: '마작일번가' },
    { code: 'STOVEINDIE', label: '스토브 스토어' },
  ];

  const VISIT_MISSIONS = [
    '365일 특가 게임 구경하기',
    'MY홈 방문하기',
    '스토브 메인 방문하기',
  ];

  const LOUNGE_MISSIONS = [
    '라운지 글쓰기',
    '라운지 좋아요 누르기',
    '라운지 댓글 쓰기',
  ];

  /**
   * 캡슐 누적 보상.
   *
   * 주의: 수령을 마치면 버튼 문구에서 금액이 사라지고 그냥 '플레이크 받기 완료' 가 된다.
   * 그래서 버튼 라벨만으로는 어느 칸이 완료됐는지 알 수 없다.
   * 옆에 붙은 달성 조건 문구로 카드를 특정하고, 그 카드 안의 버튼 상태를 읽는다.
   */
  const CAPSULE_REWARDS = [
    { label: '2,000 플레이크 받기', multiplier: 5 },
    { label: '5,000 플레이크 받기', multiplier: 10 },
    { label: '20,000 플레이크 받기', multiplier: 20 },
  ];

  // ===========================================================================
  // 1. 기본 유틸
  // ===========================================================================

  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

  const random = (min, max) =>
    Math.floor(Math.random() * (max - min + 1)) + min;

  const normalize = text =>
    String(text ?? '').replace(/,/g, '').replace(/\s+/g, ' ').trim();

  /**
   * 버튼 텍스트 비교용. 공백까지 전부 제거한다.
   *
   * 실제 사이트는 같은 기능을 페이지마다 다르게 띄어쓴다.
   * (예: Daily Shop 은 "보상받기", 리워드 페이지는 "플레이크 받기")
   * 공백을 남겨두면 이런 버튼을 영영 못 찾아 조용히 아무것도 안 하게 된다.
   */
  const squash = text => normalize(text).replace(/\s/g, '');

  const escapeHtml = value =>
    String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');

  function kstDateKey(nowMs = Date.now()) {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Seoul',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(nowMs));
  }

  /** KST 기준 YYYYMM (Daily Shop URL 용) */
  function kstYearMonth(nowMs = Date.now()) {
    return kstDateKey(nowMs).slice(0, 7).replace('-', '');
  }

  function shopUrl(shop, ym = kstYearMonth()) {
    return `https://event.onstove.com/ko/dailyshop/${shop.code}/${ym}`;
  }

  function kstTime(ms, withSeconds = false) {
    return new Date(ms).toLocaleTimeString('ko-KR', {
      timeZone: 'Asia/Seoul',
      hour: '2-digit',
      minute: '2-digit',
      ...(withSeconds ? { second: '2-digit' } : {}),
      hour12: false,
    });
  }

  function isVisible(el) {
    if (!el || !document.contains(el)) return false;

    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;

    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  /**
   * getter 가 truthy 를 반환할 때까지 대기.
   * onTick 이 있으면 매 폴링마다 호출해 워치독 하트비트를 유지한다.
   */
  async function waitFor(getter, timeout = 12000, interval = 250) {
    const end = Date.now() + timeout;

    while (Date.now() < end) {
      let value = null;

      try {
        value = getter();
      } catch (error) {
        console.warn('[stove] waitFor getter 오류', error);
      }

      if (value) return value;

      beat();
      await delay(interval);
    }

    return null;
  }

  /** 어떤 promise 든 지정 시간 안에 반드시 끝나게 만든다 (영구 대기 방지). */
  function withTimeout(promise, ms, label) {
    let timer = null;

    const guard = new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${label} 단계가 ${Math.round(ms / 1000)}초 안에 끝나지 않았습니다.`)),
        ms
      );
    });

    return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
  }

  // ===========================================================================
  // 2. 저장소 (GM storage)
  // ===========================================================================

  const DEFAULT_MAIN = {
    active: false,
    phase: 'idle',
    progress: {},
  };

  function getMain() {
    const value = GM_getValue(KEY.MAIN, null);
    return value && typeof value === 'object' ? { ...DEFAULT_MAIN, ...value } : { ...DEFAULT_MAIN };
  }

  function setMain(patch) {
    const next = { ...getMain(), ...patch, updatedAt: Date.now() };
    GM_setValue(KEY.MAIN, next);
    markPanelDirty();
    return next;
  }

  /**
   * 상태 값은 그대로 두고 "살아있다"는 신호만 갱신 (워치독용).
   * 폴링마다 저장하면 낭비라 5초에 한 번으로 제한한다.
   */
  let lastBeatAt = 0;

  function beat() {
    const now = Date.now();
    if (now - lastBeatAt < 5000) return;

    const current = getMain();
    if (!current.active) return;

    lastBeatAt = now;
    GM_setValue(KEY.MAIN, { ...current, updatedAt: now });
  }

  function patchProgress(patch) {
    const current = getMain();
    return setMain({ progress: { ...(current.progress || {}), ...patch } });
  }

  function patchLounge(patch) {
    return patchProgress({
      lounge: { ...(getMain().progress?.lounge || {}), ...patch },
    });
  }

  function clearMain() {
    GM_deleteValue(KEY.MAIN);
    markPanelDirty();
  }

  function getRetries() {
    const value = GM_getValue(KEY.RETRY, null);
    return value && typeof value === 'object' ? value : {};
  }

  function setRetries(value) {
    GM_setValue(KEY.RETRY, value);
    markPanelDirty();
  }

  function getStatusLog() {
    const value = GM_getValue(KEY.LOG, null);
    return Array.isArray(value) ? value : [];
  }

  function clearStatusLog() {
    GM_deleteValue(KEY.LOG);
    markPanelDirty();
  }

  /**
   * 로그는 명시적으로 기록한다.
   * (기존 버전은 console.log 를 가로채 이모지 정규식으로 걸렀는데,
   *  새 이모지를 쓸 때마다 조용히 누락되는 구조라 제거했다.)
   */
  function logStatus(message) {
    if (!message) return;

    console.log(`[stove] ${message}`);

    const logs = getStatusLog();
    logs.push({ time: Date.now(), message: String(message) });

    while (logs.length > 80) logs.shift();

    GM_setValue(KEY.LOG, logs);
    markPanelDirty();
  }

  // --- 뽑기 기록(원장): "오늘 이미 뽑았는지"를 버튼 상태가 아니라 기록으로 판단 ---

  function getLedger() {
    const value = GM_getValue(KEY.LEDGER, null);
    const today = kstDateKey();

    if (!value || typeof value !== 'object' || value.date !== today) {
      return { date: today, total: 0, byCost: {}, runs: [] };
    }

    return value;
  }

  function recordDraw(cost) {
    const ledger = getLedger();

    ledger.total += 1;
    ledger.byCost[cost] = (ledger.byCost[cost] || 0) + 1;
    ledger.lastAt = Date.now();

    GM_setValue(KEY.LEDGER, ledger);
    return ledger;
  }

  function recordRun(cost, completed) {
    const ledger = getLedger();

    ledger.runs.push({ cost, completed, at: Date.now() });
    while (ledger.runs.length > 20) ledger.runs.shift();

    GM_setValue(KEY.LEDGER, ledger);
    markPanelDirty();
  }

  // ===========================================================================
  // 3. Daily Shop 재시도 상태
  // ===========================================================================

  function cleanupOldRetries() {
    const today = kstDateKey();
    const retries = getRetries();

    let changed = false;

    for (const [code, item] of Object.entries(retries)) {
      if (!item || item.date !== today) {
        delete retries[code];
        changed = true;
      }
    }

    if (changed) setRetries(retries);

    return retries;
  }

  function getFinalRetryMs(dateKey = kstDateKey()) {
    return new Date(`${dateKey}T${CFG.FINAL_RETRY_TIME}+09:00`).getTime();
  }

  function getNextRetryAt() {
    const now = Date.now();
    const finalMs = getFinalRetryMs();

    if (now >= finalMs) return null;

    return Math.min(now + CFG.RETRY_INTERVAL_MS, finalMs);
  }

  function scheduleDailyRetry(shopCode) {
    const retries = cleanupOldRetries();
    const nextAt = getNextRetryAt();
    const prev = retries[shopCode] || {};

    if (nextAt === null) {
      delete retries[shopCode];
      setRetries(retries);

      logStatus(`⏭️ ${shopCode}: 최종 시도 시각(${CFG.FINAL_RETRY_TIME})이 지나 재시도를 종료합니다.`);
      return null;
    }

    retries[shopCode] = {
      pending: true,
      date: kstDateKey(),
      nextAt,
      retryCount: (prev.retryCount || 0) + 1,
      inProgress: false,
      returnUrl: prev.returnUrl || '',
    };

    setRetries(retries);
    logStatus(`⏰ ${shopCode}: 오늘의 아이템 재시도 예약 → ${kstTime(nextAt)}`);

    return nextAt;
  }

  function clearDailyRetry(shopCode) {
    const retries = getRetries();

    if (!(shopCode in retries)) return;

    delete retries[shopCode];
    setRetries(retries);
  }

  function findDueRetry() {
    const retries = cleanupOldRetries();
    const now = Date.now();

    return (
      Object.entries(retries)
        .filter(([, item]) => item?.pending && item.nextAt <= now)
        .sort((a, b) => a[1].nextAt - b[1].nextAt)[0] || null
    );
  }

  function armRetryTimer() {
    cleanupOldRetries();

    if (getMain().active) return;

    const pending = Object.entries(getRetries())
      .filter(([, item]) => item?.pending && item.date === kstDateKey())
      .sort((a, b) => a[1].nextAt - b[1].nextAt)[0];

    if (!pending) return;

    const wait = Math.max(0, pending[1].nextAt - Date.now());

    clearTimeout(window.__stoveRetryTimer);
    window.__stoveRetryTimer = setTimeout(launchDueRetry, Math.min(wait, 2147483000));
  }

  function launchDueRetry() {
    if (getMain().active) return;

    const due = findDueRetry();

    if (!due) {
      armRetryTimer();
      return;
    }

    const [code] = due;
    const shop = DAILY_SHOPS.find(item => item.code === code);

    if (!shop) {
      clearDailyRetry(code);
      return;
    }

    const retries = getRetries();

    retries[code] = {
      ...retries[code],
      inProgress: true,
      returnUrl: location.href,
    };

    setRetries(retries);
    location.href = shopUrl(shop);
  }

  // ===========================================================================
  // 4. DOM 헬퍼
  // ===========================================================================

  function allButtons() {
    return [...document.querySelectorAll('button')];
  }

  /** 텍스트가 (공백 무시하고) 정확히 일치하는, 보이고 활성화된 버튼 */
  function findButtonExact(text) {
    const expected = squash(text);

    return (
      allButtons().find(
        btn => !btn.disabled && isVisible(btn) && squash(btn.innerText) === expected
      ) || null
    );
  }

  /** 여러 표기 중 먼저 발견되는 버튼 하나 */
  function findButtonAny(texts) {
    for (const text of texts) {
      const button = findButtonExact(text);
      if (button) return button;
    }

    return null;
  }

  function tabButton(text) {
    const expected = squash(text);
    return allButtons().find(btn => squash(btn.innerText) === expected) || null;
  }

  /**
   * 텍스트가 정확히 일치하는 "말단 요소"를 찾는다.
   * 기존 구현은 document.querySelectorAll('*') 로 전체 DOM 을 배열화해 매우 느렸다.
   * TreeWalker 로 텍스트 노드만 훑어 같은 결과를 훨씬 싸게 얻는다.
   */
  function findLeafByText(text, root = document.body) {
    if (!root) return null;

    const expected = normalize(text);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);

    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (normalize(node.nodeValue) !== expected) continue;

      const el = node.parentElement;
      if (el && el.children.length === 0) return el;
    }

    return null;
  }

  function findAllLeavesByText(text, root = document.body) {
    if (!root) return [];

    const expected = normalize(text);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const result = [];

    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (normalize(node.nodeValue) !== expected) continue;

      const el = node.parentElement;
      if (el && el.children.length === 0) result.push(el);
    }

    return result;
  }

  /** 라벨 텍스트에서 위로 올라가며 가장 가까운 버튼을 찾는다. */
  function findMissionButton(title) {
    for (const node of findAllLeavesByText(title)) {
      let current = node;

      for (let i = 0; i < 10 && current; i++) {
        current = current.parentElement;
        if (!current) break;

        const button = current.querySelector('button');
        if (button) return button;
      }
    }

    return null;
  }

  function getFlakeCount() {
    for (const selector of SEL.flake) {
      const el = document.querySelector(selector);
      if (!el) continue;

      const raw = (el.innerText || '').replace(/[^\d]/g, '');
      if (!raw) continue;

      const num = parseInt(raw, 10);
      if (!Number.isNaN(num)) return num;
    }

    return null;
  }

  async function closeVisiblePopup() {
    for (const label of ['확인', '닫기', 'Close', 'OK']) {
      const button = findButtonExact(label);

      if (button) {
        button.click();
        await delay(500);
        return true;
      }
    }

    const ariaButton = allButtons().find(
      btn =>
        !btn.disabled &&
        isVisible(btn) &&
        /close|닫기/i.test(btn.getAttribute('aria-label') || '')
    );

    if (ariaButton) {
      ariaButton.click();
      await delay(500);
      return true;
    }

    return false;
  }

  async function clickWithScroll(el, ms = 250) {
    if (!el) return false;

    try {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } catch (_) {
      /* 무시 */
    }

    await delay(ms);
    el.click();

    return true;
  }

  async function waitAndClick(getter, label, timeout = 10000) {
    const el = await waitFor(() => {
      const found = getter();
      return found && !found.disabled ? found : null;
    }, timeout, 250);

    if (!el) return false;

    await clickWithScroll(el);
    logStatus(`🖱️ 자동 클릭: ${label}`);

    return true;
  }

  // ===========================================================================
  // 5. 상태 패널
  // ===========================================================================

  let panelDirty = true;
  let lastPanelSignature = '';

  function markPanelDirty() {
    panelDirty = true;
  }

  const PHASE_LABEL = {
    idle: '대기',
    draw_start: '뽑기 시작',
    draw_running: '캡슐 뽑기',
    capsule_rewards: '캡슐 누적 보상',
    daily_shop: 'Daily Shop',
    missions_start: '플레이크 미션 준비',
    missions_running: '플레이크 미션',
    go_lounge: '라운지 이동',
    lounge_running: '라운지 미션',
    return_reward: '리워드 페이지 복귀',
    reward_finalize: '최종 보상 수령',
    done: '전체 완료',
    error: '오류 발생',
  };

  const PHASE_ORDER = {
    draw_start: 0,
    draw_running: 0,
    capsule_rewards: 1,
    daily_shop: 2,
    missions_start: 3,
    missions_running: 3,
    go_lounge: 4,
    lounge_running: 4,
    return_reward: 5,
    reward_finalize: 5,
    done: 6,
  };

  function getStageStatus(stage, phase) {
    if (phase === 'error') return '❌';
    if (phase === 'done') return '✅';

    const current = PHASE_ORDER[phase];

    if (current === undefined) return '⬜';
    if (current > stage) return '✅';
    if (current === stage) return '⏳';

    return '⬜';
  }

  function getRetryDisplay() {
    const retries = cleanupOldRetries();
    const today = kstDateKey();
    const rows = [];

    for (const [code, item] of Object.entries(retries)) {
      if (!item?.pending || item.date !== today) continue;

      const shop = DAILY_SHOPS.find(x => x.code === code);
      rows.push(`${shop?.label || code} → ${kstTime(item.nextAt)}`);
    }

    return rows;
  }

  /**
   * 결과 표기 규칙 (전 항목 공통)
   *   done    ✅ 이번 실행에서 처리함
   *   already ☑️ 실행 전부터 이미 완료돼 있었음  ← 실패와 구분되어야 하는 값
   *   locked  🔒 아직 조건 미달 (버튼이 비활성)
   *   retry   🔁 재시도 예약됨
   *   none    ⏭️ 처리할 대상이 없었음
   *   pending ⬜ 아직 진행 전
   */
  const RESULT_TEXT = {
    done: '✅ 완료',
    already: '☑️ 이미 완료',
    locked: '🔒 조건 미달',
    none: '⏭️ 대상 없음',
    pending: '⬜ 대기',
  };

  function resultText(value, fallback = 'pending') {
    return RESULT_TEXT[value] || RESULT_TEXT[fallback];
  }

  function formatTodayItemStatus(value, code) {
    const retry = getRetries()[code];

    if (value === 'retry' && retry?.nextAt) return `🔁 ${kstTime(retry.nextAt)} 재시도`;
    if (value === 'retry') return '🔁 재시도 예정';

    return resultText(value);
  }

  function createStatusPanel() {
    if (!document.body) return;

    if (document.getElementById('__stove_status_panel')) {
      renderStatusPanel();
      return;
    }

    const panel = document.createElement('div');

    panel.id = '__stove_status_panel';
    panel.style.cssText = [
      'position:fixed',
      'right:18px',
      'bottom:90px',
      'z-index:2147483645',
      'width:380px',
      'background:rgba(17,17,17,.96)',
      'color:#fff',
      'border-radius:14px',
      'padding:15px',
      'font:13px/1.5 -apple-system,BlinkMacSystemFont,"Malgun Gothic",sans-serif',
      'box-shadow:0 8px 30px rgba(0,0,0,.35)',
      'max-height:72vh',
      'overflow:auto',
    ].join(';');

    // 이벤트 위임 — innerHTML 을 다시 그려도 핸들러가 살아있다.
    panel.addEventListener('click', event => {
      const action = event.target?.dataset?.stoveAction;
      if (!action) return;

      if (action === 'stop') {
        stopAutomation('사용자가 중지했습니다.');
      } else if (action === 'resume') {
        logStatus('🩺 사용자 요청으로 현재 단계를 다시 시도합니다.');
        void dispatchPhase({ forced: true });
      } else if (action === 'toggle-log') {
        panel.dataset.logOpen = panel.dataset.logOpen === '1' ? '0' : '1';
        markPanelDirty();
        renderStatusPanel();
      }
    });

    document.body.appendChild(panel);
    renderStatusPanel();
  }

  function renderStatusPanel() {
    const panel = document.getElementById('__stove_status_panel');
    if (!panel) return;

    const state = getMain();
    const progress = state.progress || {};
    const phase = state.phase || 'idle';
    const logOpen = panel.dataset.logOpen !== '0';

    const recentLogs = getStatusLog().slice(logOpen ? -9 : -3);
    const currentFlake = getFlakeCount();
    const retryRows = getRetryDisplay();
    const ledger = getLedger();

    const capsule = progress.capsuleRewards || {};
    const daily = progress.dailyShop || {};
    const lounge = progress.lounge || {};

    const daily1 = daily.RIICHICITY_IND || {};
    const daily2 = daily.STOVEINDIE || {};

    const capsuleValues = Object.values(capsule);

    const capsuleDone = capsuleValues.filter(v => v === 'done').length;
    const capsuleAlready = capsuleValues.filter(v => v === 'already').length;
    const capsuleLocked = capsuleValues.filter(v => v === 'locked').length;

    const capsuleSummary = capsuleValues.length
      ? [
          capsuleDone ? `✅ ${capsuleDone}개 수령` : '',
          capsuleAlready ? `☑️ ${capsuleAlready}개 이미 완료` : '',
          capsuleLocked ? `🔒 ${capsuleLocked}개 조건 미달` : '',
        ]
          .filter(Boolean)
          .join(' · ') || '⏭️ 대상 없음'
      : '⬜ 대기';

    const visitTotal = VISIT_MISSIONS.length;
    const visitDone = progress.visitMissionCount || 0;
    const visitAlready = progress.visitAlready || 0;

    const visitSummary = visitDone
      ? `${visitDone}/${visitTotal}개 처리` +
        (visitAlready ? ` (☑️ ${visitAlready}개는 이미 완료)` : '')
      : '⬜ 대기';

    const popularTotalCount = progress.popularTotal || 3;

    const popularSummary =
      progress.popularState === 'already'
        ? `☑️ ${popularTotalCount}개 모두 이미 완료`
        : progress.popularState === 'none'
          ? '⏭️ 대상 없음'
          : progress.popularVisited
            ? `✅ ${progress.popularVisited}/${popularTotalCount}개 방문`
            : '⬜ 대기';

    // lounge 값은 done | already | true(구버전) | false
    const loungeIcon = value => {
      if (value === 'already') return '☑️';
      if (value === 'done' || value === true) return '✅';
      return '⬜';
    };

    // 값이 실제로 바뀌었을 때만 다시 그린다. (기존: 1초마다 무조건 innerHTML 재구성)
    const signature = JSON.stringify([
      state.active,
      phase,
      state.drawCost,
      state.drawsCompleted,
      state.error,
      currentFlake,
      progress,
      retryRows,
      recentLogs.length,
      recentLogs[recentLogs.length - 1]?.time,
      ledger.total,
      logOpen,
    ]);

    if (!panelDirty && signature === lastPanelSignature) return;

    panelDirty = false;
    lastPanelSignature = signature;

    const stageRows = [
      ['캡슐 뽑기', 0],
      ['캡슐 누적 보상', 1],
      ['Daily Shop', 2],
      ['플레이크 미션', 3],
      ['라운지 미션', 4],
      ['최종 보상', 5],
    ]
      .map(([name, no]) => `<div>${getStageStatus(no, phase)} ${no + 1}. ${name}</div>`)
      .join('');

    const logsHtml = recentLogs.length
      ? recentLogs
          .map(
            log =>
              `<div style="padding:2px 0;border-bottom:1px solid rgba(255,255,255,.05)">` +
              `<span style="opacity:.5;margin-right:5px">${kstTime(log.time, true)}</span>` +
              `${escapeHtml(log.message)}` +
              `</div>`
          )
          .join('')
      : '<div style="opacity:.55">아직 실행 기록이 없습니다.</div>';

    const statusText = state.active
      ? '실행 중'
      : phase === 'done'
        ? '완료'
        : phase === 'error'
          ? '오류'
          : '대기';

    const buttonStyle =
      'border:0;border-radius:8px;padding:6px 10px;font-size:11px;font-weight:700;cursor:pointer';

    panel.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:9px">
        <div style="font-size:15px;font-weight:800">STOVE 자동화 현황</div>
        <div style="font-size:11px;opacity:.65">v${VERSION} · ${statusText}</div>
      </div>

      <div style="display:flex;gap:6px;margin-bottom:10px">
        <button type="button" data-stove-action="stop"
          style="${buttonStyle};background:#ff5f56;color:#fff">중지 / 초기화</button>
        <button type="button" data-stove-action="resume"
          style="${buttonStyle};background:#fff;color:#111">현재 단계 재시도</button>
        <button type="button" data-stove-action="toggle-log"
          style="${buttonStyle};background:rgba(255,255,255,.16);color:#fff">로그</button>
      </div>

      <div style="background:rgba(255,255,255,.07);padding:9px 10px;border-radius:9px;margin-bottom:10px">
        <div>📍 현재 단계: <strong>${escapeHtml(PHASE_LABEL[phase] || phase)}</strong></div>
        <div>🎯 선택: <strong>${state.drawCost ? `${state.drawCost.toLocaleString()} 뽑기` : '-'}</strong></div>
        <div>🔢 뽑기: <strong>${state.drawsCompleted || 0} / ${CFG.DRAW_COUNT}</strong></div>
        <div>📒 오늘 누적 뽑기: <strong>${ledger.total}회</strong></div>
        ${
          currentFlake !== null
            ? `<div>💰 현재 플레이크: <strong>${currentFlake.toLocaleString()}</strong></div>`
            : ''
        }
        ${
          state.error
            ? `<div style="color:#ff9f9a;margin-top:4px">❌ ${escapeHtml(state.error)}</div>`
            : ''
        }
      </div>

      <div style="margin-bottom:10px">${stageRows}</div>

      <div style="border-top:1px solid rgba(255,255,255,.12);padding-top:9px">
        <div style="font-weight:700;margin-bottom:5px">결과 요약</div>
        <div>🎁 캡슐 누적 보상: ${capsuleSummary}</div>
        <div>🛍️ 마작일번가 오늘 아이템: ${formatTodayItemStatus(daily1.todayItem, 'RIICHICITY_IND')}</div>
        <div>　└ 보상 받기: ${daily1.rewardCount || 0}개</div>
        <div>🛍️ 스토브 스토어 오늘 아이템: ${formatTodayItemStatus(daily2.todayItem, 'STOVEINDIE')}</div>
        <div>　└ 보상 받기: ${daily2.rewardCount || 0}개</div>
        <div>🔗 방문 미션: ${visitSummary}</div>
        <div>📰 인기 게시글: ${popularSummary}</div>
        <div>
          ✍️ 글쓰기: ${loungeIcon(lounge.post)}
          💬 댓글: ${loungeIcon(lounge.comment)}
          👍 좋아요: ${loungeIcon(lounge.like)}
          ${progress.loungeAlready ? '<span style="opacity:.6">(실행 전 이미 완료)</span>' : ''}
        </div>
        <div>🎁 일반 [받기]: ${
          progress.genericRewardCount
            ? `${progress.genericRewardCount}개`
            : PHASE_ORDER[phase] >= 3
              ? '⏭️ 수령 가능한 항목 없음'
              : '⬜ 대기'
        }</div>
        <div style="font-size:11px;opacity:.5;margin-top:6px">
          ✅ 이번 실행에서 처리 · ☑️ 이미 완료돼 있었음 · 🔒 조건 미달 · ⏭️ 대상 없음
        </div>
      </div>

      ${
        retryRows.length
          ? `<div style="margin-top:10px;padding-top:9px;border-top:1px solid rgba(255,255,255,.12)">
              <div style="font-weight:700">🔁 오늘의 아이템 재시도</div>
              ${retryRows.map(x => `<div>• ${escapeHtml(x)}</div>`).join('')}
              <div style="font-size:11px;opacity:.6">4시간 간격 / 마지막 ${CFG.FINAL_RETRY_TIME} / 자정 이후 폐기</div>
            </div>`
          : ''
      }

      <div style="margin-top:10px;padding-top:9px;border-top:1px solid rgba(255,255,255,.12)">
        <div style="font-weight:700;margin-bottom:5px">최근 작업</div>
        ${logsHtml}
      </div>
    `;

    panel.style.bottom = isRewardEventPage() ? '90px' : '18px';
  }

  function toast(message, ms = 7000) {
    if (!document.body) return;

    let box = document.getElementById('__stove_auto_toast');

    if (!box) {
      box = document.createElement('div');
      box.id = '__stove_auto_toast';
      box.style.cssText = [
        'position:fixed',
        'top:16px',
        'right:16px',
        'z-index:2147483647',
        'background:#111',
        'color:#fff',
        'padding:14px 18px',
        'border-radius:10px',
        'font:14px/1.6 -apple-system,BlinkMacSystemFont,"Malgun Gothic",sans-serif',
        'max-width:430px',
        'white-space:pre-wrap',
        'box-shadow:0 6px 24px rgba(0,0,0,.35)',
      ].join(';');

      document.body.appendChild(box);
    }

    box.textContent = message;

    clearTimeout(box._timer);
    box._timer = setTimeout(() => box.remove(), ms);

    logStatus(message.split('\n')[0]);
  }

  // ===========================================================================
  // 6. 시작 패널
  // ===========================================================================

  /**
   * 플레이크 샵 화면인지 판단.
   * 이 사이트는 SPA 라서 '샵/미션' 탭을 누르면 경로가 /ko/event → /ko 로 바뀐다.
   * 경로를 /ko/event 로만 좁히면 탭 전환 후 새로고침했을 때 시작 패널이 사라진다.
   */
  function isRewardEventPage() {
    if (location.hostname !== 'reward.onstove.com') return false;

    return /^\/ko(\/event.*)?\/?$/.test(location.pathname);
  }

  function createDrawPanel() {
    if (!isRewardEventPage() || !document.body) return;
    if (document.getElementById('__stove_draw_panel')) return;

    const panel = document.createElement('div');

    panel.id = '__stove_draw_panel';
    panel.style.cssText = [
      'position:fixed',
      'right:18px',
      'bottom:18px',
      'z-index:2147483646',
      'background:#111',
      'color:#fff',
      'padding:14px',
      'border-radius:14px',
      'font:14px/1.4 -apple-system,BlinkMacSystemFont,"Malgun Gothic",sans-serif',
      'box-shadow:0 6px 22px rgba(0,0,0,.32)',
      'display:flex',
      'gap:8px',
      'align-items:center',
    ].join(';');

    for (const cost of [100, 1000]) {
      const button = document.createElement('button');

      button.type = 'button';
      button.dataset.drawCost = String(cost);
      button.dataset.confirm = '0';
      button.textContent = `${cost.toLocaleString()} 뽑기`;
      button.style.cssText = [
        'border:0',
        'border-radius:10px',
        'padding:10px 14px',
        'background:#fff',
        'color:#111',
        'font-weight:700',
        'cursor:pointer',
      ].join(';');

      button.addEventListener('click', () => void onStartClick(button, cost));
      panel.appendChild(button);
    }

    document.body.appendChild(panel);
    updateDrawPanel();
  }

  /**
   * 오늘 이미 뽑기 기록이 있으면 한 번 더 확인을 받는다.
   * (기존에는 "이미 진행됐는지"를 버튼 활성 상태로만 추정해 중복 실행을 막지 못했다.)
   */
  async function onStartClick(button, cost) {
    if (getMain().active) return;

    const ledger = getLedger();

    if (ledger.total > 0 && button.dataset.confirm !== '1') {
      button.dataset.confirm = '1';
      button.textContent = `⚠️ 오늘 ${ledger.total}회 기록 · 그래도 진행`;

      clearTimeout(button._confirmTimer);
      button._confirmTimer = setTimeout(() => {
        button.dataset.confirm = '0';
        button.textContent = `${cost.toLocaleString()} 뽑기`;
      }, 8000);

      return;
    }

    clearTimeout(button._confirmTimer);
    button.dataset.confirm = '0';
    button.textContent = `${cost.toLocaleString()} 뽑기`;

    clearMain();
    clearStatusLog();

    setMain({
      active: true,
      phase: 'draw_start',
      drawCost: cost,
      drawsCompleted: 0,
      rewardUrl: location.href,
      postTitle: makeRunTitle(),
      startedAt: Date.now(),
      navCount: 0,
      navPhase: '',
      progress: {
        capsuleRewards: {},
        dailyShop: {},
        visitMissionCount: 0,
        popularVisited: 0,
        lounge: { post: false, comment: false, like: false },
        genericRewardCount: 0,
      },
    });

    updateDrawPanel();
    renderStatusPanel();

    await dispatchPhase({ forced: true });
  }

  function updateDrawPanel() {
    const panel = document.getElementById('__stove_draw_panel');
    if (!panel) return;

    const active = Boolean(getMain().active);

    for (const button of panel.querySelectorAll('button[data-draw-cost]')) {
      button.disabled = active;
      button.style.opacity = active ? '0.55' : '1';
      button.style.cursor = active ? 'default' : 'pointer';
    }
  }

  function makeRunTitle() {
    const d = new Date();
    const pad = n => String(n).padStart(2, '0');

    return (
      `오늘의 한 줄 ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
      `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
    );
  }

  // ===========================================================================
  // 7. 캡슐 뽑기 — 결과를 "검증"하는 루프
  // ===========================================================================

  function findInitialDrawButton(cost) {
    const expected = normalize(`${cost.toLocaleString()} 뽑기`);

    return (
      allButtons().find(btn => {
        if (btn.disabled) return false;

        const span = btn.querySelector(SEL.drawButtonText);
        return span && normalize(span.innerText) === expected;
      }) || null
    );
  }

  function findRepeatDrawButton(cost) {
    const expected = normalize(`${cost.toLocaleString()} 뽑기 한번 더!`);

    const span = [...document.querySelectorAll(SEL.repeatButtonText)].find(
      node => normalize(node.innerText) === expected
    );

    if (!span) return null;

    const button = span.closest('button');

    if (button) return button.disabled ? null : button;

    return isVisible(span) ? span : null;
  }

  /** 현재 화면의 "뽑기 결과 지문". 팝업 노드/텍스트/잔액 3가지를 함께 본다. */
  function drawSignature() {
    const popup = document.querySelector(SEL.rewardPopup);

    return {
      node: popup || null,
      text: popup ? (popup.innerText || '').trim() : '',
      flake: getFlakeCount(),
    };
  }

  /**
   * 클릭 이후 실제로 1회가 소모되었는지 확인한다.
   * - 보상 팝업 노드가 교체되었거나 문구가 바뀌었다 → 성공
   * - 플레이크 잔액이 변했다 → 성공
   * 둘 중 하나도 없으면 "클릭은 됐지만 뽑히지 않은" 상태로 본다.
   */
  async function waitForDrawResult(before, timeout = CFG.DRAW_RESULT_TIMEOUT) {
    const end = Date.now() + timeout;

    while (Date.now() < end) {
      const now = drawSignature();

      const popupChanged =
        Boolean(now.node) &&
        Boolean(now.text) &&
        (now.node !== before.node || now.text !== before.text);

      const flakeChanged =
        now.flake !== null && before.flake !== null && now.flake !== before.flake;

      if (popupChanged || flakeChanged) {
        return { ok: true, via: popupChanged ? 'popup' : 'flake', ...now };
      }

      beat();
      await delay(150);
    }

    return { ok: false, via: 'none', ...drawSignature() };
  }

  function hasInsufficientFlakeMessage() {
    const text = document.body?.innerText || '';
    return /플레이크가 부족|보유.*부족|잔액이 부족/.test(text);
  }

  async function runDrawLoop(cost) {
    const startFlake = getFlakeCount();

    if (startFlake === null) {
      throw new Error('플레이크 보유량 표시를 찾지 못했습니다. 로그인 상태와 페이지를 확인해 주세요.');
    }

    setMain({
      phase: 'draw_running',
      drawCost: cost,
      drawStartFlake: startFlake,
      drawsCompleted: 0,
    });

    toast(`🎯 ${cost.toLocaleString()} 뽑기 ${CFG.DRAW_COUNT}회를 시작합니다.`, 10000);

    let completed = 0;
    let stopReason = '';

    for (let drawNo = 1; drawNo <= CFG.DRAW_COUNT; drawNo++) {
      const isFirst = drawNo === 1;

      const button = await waitFor(
        () => (isFirst ? findInitialDrawButton(cost) : findRepeatDrawButton(cost)),
        isFirst ? 12000 : 8000,
        200
      );

      if (!button) {
        stopReason = isFirst
          ? `"${cost.toLocaleString()} 뽑기" 버튼을 찾지 못했습니다.`
          : `${drawNo - 1}회차 후 "한번 더" 버튼이 나타나지 않았습니다.`;
        break;
      }

      let result = null;

      for (let attempt = 0; attempt <= CFG.DRAW_RETRY_PER_ROUND; attempt++) {
        const before = drawSignature();
        const target = isFirst
          ? findInitialDrawButton(cost) || button
          : findRepeatDrawButton(cost) || button;

        if (!target) break;

        target.click();

        result = await waitForDrawResult(before);
        if (result.ok) break;

        if (hasInsufficientFlakeMessage()) {
          stopReason = '플레이크가 부족해 뽑기를 중단합니다.';
          break;
        }

        // 결과 팝업이 앞을 가려 클릭이 먹지 않는 경우가 있어 한 번 닫고 재시도한다.
        logStatus(`⚠️ ${drawNo}회차 결과 확인 실패 — 재시도 ${attempt + 1}/${CFG.DRAW_RETRY_PER_ROUND}`);

        await closeVisiblePopup();
        await delay(random(900, 1400));
      }

      if (stopReason) break;

      if (!result?.ok) {
        stopReason = `${drawNo}회차 뽑기 결과를 확인하지 못했습니다. 중복 소모를 막기 위해 중단합니다.`;
        break;
      }

      completed = drawNo;

      recordDraw(cost);
      setMain({ drawsCompleted: completed });

      logStatus(
        result.text
          ? `🎁 ${drawNo}/${CFG.DRAW_COUNT}회차 보상: ${result.text} (확인:${result.via})`
          : `🎁 ${drawNo}/${CFG.DRAW_COUNT}회차 완료 (확인:${result.via})`
      );

      if (drawNo < CFG.DRAW_COUNT) {
        await delay(random(2400, 3000));
      }
    }

    if (stopReason) logStatus(`⚠️ ${stopReason}`);

    const endFlake = getFlakeCount();

    recordRun(cost, completed);

    setMain({
      phase: 'capsule_rewards',
      drawEndFlake: endFlake,
      missionStartFlake: endFlake,
      drawsCompleted: completed,
      drawStopReason: stopReason || '',
    });

    toast(
      `✅ 뽑기 ${completed}/${CFG.DRAW_COUNT}회 완료\n➡️ 캡슐 누적 보상을 확인합니다.`,
      9000
    );

    await delay(1200);

    // 뽑기 팝업이 남아 있으면 이후 단계의 버튼 탐색을 방해하므로 새로고침 후 진행한다.
    navigate(getMain().rewardUrl || REWARD_URL, 'capsule_rewards', { reloadIfSame: true });
  }

  // ===========================================================================
  // 8. 캡슐 누적 보상
  // ===========================================================================

  /** 누적 보상 칸에 들어가는 버튼인지 (수령 전/후 문구를 모두 포함) */
  function isMilestoneButton(button) {
    return /플레이크받기(완료)?$/.test(squash(button.innerText));
  }

  /**
   * 화면의 누적 보상 카드 목록.
   *
   * 카드는 '30번x5 이상 뽑기 시' 같은 조건을 갖는데, 이 문구가 여러 엘리먼트로
   * 쪼개져 있어 텍스트 완전일치로는 못 찾는다.
   * 그래서 버튼에서 위로 올라가다 조건(x숫자)이 처음 등장하는 조상을 카드로 보고,
   * 그 배수로 어느 칸인지 식별한다.
   */
  function milestoneCards() {
    return allButtons()
      .filter(isMilestoneButton)
      .map((button, index) => {
        let node = button;
        let text = '';

        for (let i = 0; i < 5 && node; i++) {
          node = node.parentElement;
          if (!node) break;

          text = normalize(node.innerText);
          if (/x\s*\d+/i.test(text)) break;
        }

        const matched = text.match(/x\s*(\d+)/i);

        return { button, index, multiplier: matched ? Number(matched[1]) : null };
      });
  }

  /**
   * 1순위 — 달성 배수(x5 / x10 / x20)로 카드를 특정
   * 2순위 — 화면에 나타난 순서로 특정
   */
  function findMilestoneButton(item, index) {
    const cards = milestoneCards();

    const byMultiplier = cards.find(card => card.multiplier === item.multiplier);
    if (byMultiplier) return byMultiplier.button;

    return cards[index]?.button || null;
  }

  /**
   * 누적 보상 한 칸의 상태.
   *   available — 지금 누를 수 있음
   *   already   — 이미 수령함
   *   locked    — 아직 누적 횟수 미달
   *   none      — 화면에서 찾지 못함
   */
  function milestoneState(item, index) {
    const button = findMilestoneButton(item, index);

    if (!button) return { state: 'none', button: null };
    if (/완료$/.test(squash(button.innerText))) return { state: 'already', button };
    if (button.disabled || !isVisible(button)) return { state: 'locked', button };

    return { state: 'available', button };
  }

  function setCapsuleResult(label, value) {
    patchProgress({
      capsuleRewards: {
        ...(getMain().progress?.capsuleRewards || {}),
        [label]: value,
      },
    });
  }

  async function claimCapsuleMilestoneRewards() {
    let count = 0;

    for (let index = 0; index < CAPSULE_REWARDS.length; index++) {
      const item = CAPSULE_REWARDS[index];
      const { state, button } = milestoneState(item, index);

      if (state !== 'available') {
        setCapsuleResult(item.label, state);

        logStatus(
          state === 'already'
            ? `☑️ 캡슐 누적 보상 이미 수령됨: ${item.label}`
            : state === 'locked'
              ? `🔒 캡슐 누적 보상 조건 미달: ${item.label}`
              : `⏭️ 캡슐 누적 보상 항목 없음: ${item.label}`
        );

        continue;
      }

      await clickWithScroll(button);
      count++;

      setCapsuleResult(item.label, 'done');
      logStatus(`🎁 캡슐 누적 보상 수령: ${item.label}`);

      await delay(1200);
      await closeVisiblePopup();
    }

    return count;
  }

  // ===========================================================================
  // 9. Daily Shop
  // ===========================================================================

  function currentDailyShop() {
    return (
      DAILY_SHOPS.find(shop => location.href.includes(`/dailyshop/${shop.code}`)) || null
    );
  }

  function hasNoPlayRecordMessage() {
    const text = document.body?.innerText || '';
    return text.includes('당일 플레이 기록이 있는 회원만') && text.includes('게임 플레이 기록');
  }

  function updateDailyProgress(shopCode, patch) {
    const daily = getMain().progress?.dailyShop || {};

    patchProgress({
      dailyShop: {
        ...daily,
        [shopCode]: { ...(daily[shopCode] || {}), ...patch },
      },
    });
  }

  /**
   * 수령 버튼이 없을 때 "이미 받은 것"인지 "아직 안 열린 것"인지 구분한다.
   * 사이트는 수령을 마치면 버튼 문구가 '오늘의 아이템 확인' 으로 바뀐다.
   */
  function todayItemAlreadyDone() {
    if (findButtonAny(['오늘의 아이템 확인', '오늘의 아이템 받기 완료'])) return true;

    return /오늘의 아이템\s*(받기\s*)?완료/.test(document.body?.innerText || '');
  }

  async function claimTodayItem(shop, isRetry = false) {
    const button = await waitFor(() => findButtonExact('오늘의 아이템 받기'), 8000, 250);

    if (!button) {
      const already = todayItemAlreadyDone();

      logStatus(
        already
          ? `☑️ ${shop.label}: 오늘의 아이템은 이미 수령된 상태입니다.`
          : `⏭️ ${shop.label}: 오늘의 아이템 버튼을 찾지 못했습니다.`
      );

      clearDailyRetry(shop.code);
      updateDailyProgress(shop.code, { todayItem: already ? 'already' : 'none' });

      return { status: already ? 'already' : 'none' };
    }

    await clickWithScroll(button);
    logStatus(`🎁 ${shop.label}: 오늘의 아이템 받기 클릭${isRetry ? ' (재시도)' : ''}`);

    await delay(1300);

    if (hasNoPlayRecordMessage()) {
      logStatus(`⏳ ${shop.label}: 당일 플레이 기록이 없어 수령 실패.`);

      await closeVisiblePopup();

      const nextAt = scheduleDailyRetry(shop.code);
      updateDailyProgress(shop.code, { todayItem: 'retry' });

      if (nextAt) {
        toast(
          `⏳ ${shop.label}: 플레이 기록 미반영\n오늘 ${kstTime(nextAt)}에 다시 시도합니다.`,
          9000
        );
      }

      return { status: 'retry' };
    }

    clearDailyRetry(shop.code);
    updateDailyProgress(shop.code, { todayItem: 'done' });

    logStatus(`✅ ${shop.label}: 오늘의 아이템 수령 처리 완료`);

    await closeVisiblePopup();
    return { status: 'done' };
  }

  async function collectDailyShopRewards(shop, maxClicks = 30) {
    let count = 0;

    for (let i = 0; i < maxClicks; i++) {
      const button = findButtonAny(['보상받기', '보상 받기', '받기']);
      if (!button) break;

      await clickWithScroll(button);
      count++;

      logStatus(`🎁 ${shop.label}: [보상 받기] 자동 수령 (${count})`);
      updateDailyProgress(shop.code, { rewardCount: count });

      await delay(1300);
      await closeVisiblePopup();
    }

    updateDailyProgress(shop.code, { rewardCount: count });
    return count;
  }

  /** Daily Shop 페이지가 실제로 열렸는지 (빈 페이지/만료 URL 감지) */
  async function dailyShopLoaded() {
    return waitFor(
      () =>
        findButtonAny(['오늘의 아이템 받기', '보상받기', '보상 받기']) ||
        (document.body && document.body.innerText.includes('오늘의 아이템')),
      12000,
      300
    );
  }

  async function runMainDailyShop(shop) {
    toast(`🛍️ Daily Shop 처리 중\n${shop.label}`, 8000);

    const loaded = await dailyShopLoaded();

    if (!loaded) {
      logStatus(`⚠️ ${shop.label}: 페이지 내용을 확인하지 못해 건너뜁니다.`);
    } else {
      await claimTodayItem(shop, false);
      await collectDailyShopRewards(shop);
    }

    const index = DAILY_SHOPS.findIndex(item => item.code === shop.code);

    if (index >= 0 && index < DAILY_SHOPS.length - 1) {
      const next = DAILY_SHOPS[index + 1];

      setMain({ phase: 'daily_shop', dailyIndex: index + 1 });
      navigate(shopUrl(next), 'daily_shop');

      return;
    }

    setMain({ phase: 'missions_start', dailyIndex: DAILY_SHOPS.length });
    navigate(getMain().rewardUrl || REWARD_URL, 'missions_start');
  }

  async function runDailyRetry(shop) {
    const item = cleanupOldRetries()[shop.code];

    if (!item || !item.inProgress || item.date !== kstDateKey()) return;

    toast(`🔁 ${shop.label}\n오늘의 아이템 받기만 재시도합니다.`, 8000);

    await dailyShopLoaded();

    const result = await claimTodayItem(shop, true);
    const updated = getRetries();

    if (updated[shop.code]) {
      updated[shop.code].inProgress = false;
      setRetries(updated);
    }

    if (['done', 'already', 'none'].includes(result.status)) {
      toast(`✅ ${shop.label}: 오늘의 아이템 재시도 종료`, 7000);
    }

    if (item.returnUrl && item.returnUrl !== location.href) {
      await delay(900);
      location.href = item.returnUrl;
    }
  }

  // ===========================================================================
  // 10. 리워드 미션
  // ===========================================================================

  async function refreshMissionList() {
    const shop = tabButton('샵');

    if (shop) {
      shop.click();
      await delay(1500);
    }

    const mission = await waitFor(() => tabButton('미션'), 6000, 200);

    if (mission) {
      mission.click();
      await delay(2500);
    }
  }

  async function collectAllAvailableRewards(maxClicks = 60) {
    let total = 0;

    for (let i = 0; i < maxClicks; i++) {
      const button = findButtonExact('받기');
      if (!button) break;

      await clickWithScroll(button);
      total++;

      const currentCount = (getMain().progress?.genericRewardCount || 0) + 1;

      patchProgress({ genericRewardCount: currentCount });
      logStatus(`🎁 활성 [받기] 자동 수령 (${currentCount})`);

      await delay(1500);
      await closeVisiblePopup();
    }

    return total;
  }

  function popularSection() {
    const heading = findLeafByText('인기 게시글 보고 플레이크 받기!');
    if (!heading) return null;

    let section = heading;

    for (let i = 0; i < 10 && section; i++) {
      section = section.parentElement;

      if (section && section.querySelector(SEL.popularAnchor)) return section;
    }

    return null;
  }

  /**
   * 개별 게시글 카드가 이미 수령 완료인지 판단한다.
   *
   * 주의: 부모를 끝까지 거슬러 올라가면 섹션 전체 텍스트에 다른 카드의
   * "받기 완료" 가 섞여 들어와 멀쩡한 카드까지 완료로 오판한다.
   * 그래서 섹션에 도달하면 탐색을 멈춘다.
   */
  function isPopularComplete(anchor, section) {
    let card = anchor;

    for (let i = 0; i < 8 && card; i++) {
      if (section && card === section) break;

      const badge = card.querySelector?.('[class*="flakeshop-mission-badge"]');

      if (badge && /receive_complete/.test(badge.className)) return true;

      // 카드 단위(자식 수가 적은 구간)에서만 텍스트 판정을 신뢰한다.
      if (i <= 3 && /받기 완료|플레이크 받기 완료/.test(card.innerText || '')) return true;

      card = card.parentElement;
    }

    return false;
  }

  function pendingPopularPosts() {
    const section = popularSection();
    if (!section) return [];

    const unique = new Map();

    for (const anchor of section.querySelectorAll(SEL.popularAnchor)) {
      if (!anchor.href || unique.has(anchor.href) || isPopularComplete(anchor, section)) continue;
      unique.set(anchor.href, anchor);
    }

    return [...unique.values()].slice(0, 3);
  }

  async function collectPopular() {
    const section = popularSection();
    if (!section) return 0;

    let count = 0;

    // 공백 표기가 페이지마다 달라 squash 로 비교한다.
    // '...받기 완료' 처럼 이미 수령한 버튼은 제외해야 하므로 끝이 '받기' 인 것만 고른다.
    const buttons = [...section.querySelectorAll('button')].filter(btn => {
      if (btn.disabled || !isVisible(btn)) return false;

      const text = squash(btn.innerText);
      return text === '받기' || /플레이크받기$/.test(text);
    });

    for (const button of buttons) {
      if (!document.contains(button) || button.disabled) continue;

      button.click();
      count++;

      logStatus(`🎁 인기 게시글 보상 수령 (${count})`);
      await delay(1500);
    }

    return count;
  }

  /** 섹션에 걸린 인기 게시글 전체 개수 (분모 표시용) */
  function popularTotal() {
    const section = popularSection();
    if (!section) return 0;

    return new Set(
      [...section.querySelectorAll(SEL.popularAnchor)].map(a => a.href).filter(Boolean)
    ).size;
  }

  async function runPopular() {
    const posts = pendingPopularPosts();
    const total = popularTotal();

    if (!posts.length) {
      // 섹션은 있는데 남은 글이 없다 = 이미 전부 처리된 상태
      const already = total > 0;

      patchProgress({
        popularTotal: total,
        popularVisited: already ? total : 0,
        popularState: already ? 'already' : 'none',
      });

      logStatus(
        already
          ? `☑️ 인기 게시글 미션: ${total}개 모두 이미 완료된 상태입니다.`
          : '⏭️ 인기 게시글 미션: 대상 게시글을 찾지 못했습니다.'
      );

      return 0;
    }

    logStatus(`📰 인기 게시글 ${posts.length}/3개 자동 방문`);

    const hrefs = posts.map(post => post.href);

    for (let i = 0; i < hrefs.length; i++) {
      let opened = null;

      try {
        opened = GM_openInTab(hrefs[i], { active: false, insert: true, setParent: true });
      } catch (error) {
        logStatus(`⚠️ 새 탭 열기 실패: ${error?.message || error}`);
        continue;
      }

      logStatus(`🔗 ${i + 1}/${hrefs.length} 방문 중`);

      await delay(CFG.VISIT_WAIT);

      try {
        opened?.close();
      } catch (_) {
        /* 이미 닫힌 경우 무시 */
      }

      await delay(400);
    }

    patchProgress({
      popularVisited: hrefs.length,
      popularTotal: total || hrefs.length,
      popularState: 'done',
    });

    await refreshMissionList();
    return collectPopular();
  }

  /** 미션 카드 버튼 문구 → 상태 */
  function missionStateOf(title) {
    const button = findMissionButton(title);
    if (!button) return { state: 'none', label: '' };

    const label = squash(button.innerText);

    if (label === '미션하기') return { state: 'todo', label, button };
    if (label === '받기') return { state: 'claimable', label, button };
    if (/완료$/.test(label)) return { state: 'already', label, button };

    return { state: 'unknown', label, button };
  }

  function loungeMissionLeft() {
    return LOUNGE_MISSIONS.filter(title =>
      ['todo', 'claimable'].includes(missionStateOf(title).state)
    );
  }

  async function runRewardMissions() {
    setMain({ phase: 'missions_running' });

    toast('▶️ Daily Shop 완료\n플레이크 미션을 자동 진행합니다.', 9000);

    await refreshMissionList();

    // 실행 시작 시점의 라운지 미션 상태를 먼저 찍어둔다.
    // (이걸 안 해두면 "원래 완료였던 것"과 "내가 방금 한 것"을 구분할 수 없다.)
    const loungeBefore = {};

    for (const title of LOUNGE_MISSIONS) {
      loungeBefore[title] = missionStateOf(title).state;
    }

    const loungeAlreadyDone = LOUNGE_MISSIONS.every(t => loungeBefore[t] === 'already');

    patchProgress({ loungeAlready: loungeAlreadyDone });

    let visitCount = 0;
    let visitAlready = 0;

    for (const title of VISIT_MISSIONS) {
      const { state, label } = missionStateOf(title);

      if (state === 'todo') {
        missionStateOf(title).button?.click();
        visitCount++;

        patchProgress({ visitMissionCount: visitCount, visitAlready });
        logStatus(`🔗 방문 미션: ${title}`);

        await delay(CFG.VISIT_WAIT);
      } else if (state === 'claimable' || state === 'already') {
        visitCount++;
        if (state === 'already') visitAlready++;

        patchProgress({ visitMissionCount: visitCount, visitAlready });
        logStatus(`☑️ 방문 미션 이미 진행됨: ${title} [${label}]`);
      }
    }

    patchProgress({ visitMissionCount: visitCount, visitAlready });

    await refreshMissionList();
    await collectAllAvailableRewards();

    // runPopular() 내부에서 이미 collectPopular() 를 호출한다. (중복 호출 제거)
    await runPopular();
    await collectAllAvailableRewards();

    if (!loungeMissionLeft().length) {
      // 실행 전부터 완료였는지, 이번에 채워진 건지를 구분해 기록한다.
      const value = loungeAlreadyDone ? 'already' : 'done';

      patchLounge({ post: value, comment: value, like: value });

      logStatus(
        loungeAlreadyDone
          ? '☑️ 라운지 미션 3종은 이미 완료된 상태라 건너뜁니다.'
          : '✅ 라운지 미션이 이미 충족되어 바로 마무리합니다.'
      );

      await finalizeReward();
      return;
    }

    setMain({ phase: 'go_lounge' });

    toast('➡️ 라운지로 이동합니다.\n글쓰기 → 댓글 → 좋아요를 자동 처리합니다.', 9000);

    await delay(1000);
    navigate(LOUNGE_URL, 'go_lounge');
  }

  // ===========================================================================
  // 11. 라운지
  // ===========================================================================

  function setTextarea(el, text) {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      'value'
    )?.set;

    el.click();
    el.focus();

    if (setter) {
      setter.call(el, text);
    } else {
      el.value = text;
    }

    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function setEditor(el, text) {
    el.innerHTML = '<p><br></p>';
    el.focus();

    const range = document.createRange();

    range.selectNodeContents(el);
    range.collapse(false);

    const selection = window.getSelection();

    selection.removeAllRanges();
    selection.addRange(range);

    document.execCommand('insertText', false, text);

    el.dispatchEvent(new Event('input', { bubbles: true }));
  }

  async function ensureLoungeEditor() {
    const existing = document.querySelector(SEL.loungeTitle);
    if (existing) return existing;

    const writeButton = allButtons().find(btn => btn.innerText.trim().includes('글쓰기'));

    if (writeButton) {
      writeButton.click();
      await delay(1200);
    }

    return waitFor(() => document.querySelector(SEL.loungeTitle), 8000, 200);
  }

  function findCreatedPostNow(title) {
    const titleEl = [...document.querySelectorAll(SEL.feedTitle)].find(
      el => el.innerText.trim() === title
    );

    if (!titleEl) return null;

    return (
      titleEl.closest('.sc-feed') ||
      titleEl.closest('.sc-feed-detail')?.parentElement ||
      null
    );
  }

  async function fillPost(titleText) {
    const title = await ensureLoungeEditor();

    if (!title) throw new Error('라운지 글쓰기 제목 입력창을 찾지 못했습니다.');

    setTextarea(title, titleText);

    const body = await waitFor(() => document.querySelector(SEL.loungeBody), 10000, 200);

    if (!body) throw new Error('라운지 본문 입력창을 찾지 못했습니다.');

    const submit = () => document.querySelector(SEL.loungeSubmit);

    for (let i = 0; i < 3; i++) {
      setEditor(body, BODY_TEXT);
      await delay(500);

      const button = submit();
      if (button && !button.disabled) break;
    }

    if (!(await waitAndClick(submit, '글 [등록]'))) {
      throw new Error('글 [등록] 자동 처리에 실패했습니다.');
    }

    patchLounge({ post: 'done' });
    logStatus('✍️ 라운지 글쓰기 완료');

    await delay(2500);
  }

  async function fillCommentAndLike(titleText) {
    const post = await waitFor(() => findCreatedPostNow(titleText), 15000, 400);

    if (!post) throw new Error(`방금 작성한 글("${titleText}")을 찾지 못했습니다.`);

    post.scrollIntoView({ behavior: 'smooth', block: 'center' });
    await delay(500);

    const opener = post.querySelector(SEL.commentOpener);

    if (opener) {
      opener.click();
      await delay(1000);
    }

    const editor = await waitFor(
      () => {
        for (const box of post.querySelectorAll(SEL.commentBox)) {
          const ed = box.querySelector('.fr-element.fr-view');
          const sub = box.querySelector(SEL.commentSubmit);

          if (ed && sub) return { ed, sub };
        }

        return null;
      },
      10000,
      250
    );

    if (!editor) throw new Error('댓글 입력창을 찾지 못했습니다.');

    setEditor(editor.ed, COMMENT_TEXT);
    await delay(500);

    const commentOK = await waitAndClick(
      () =>
        document.contains(editor.sub) ? editor.sub : post.querySelector(SEL.commentSubmit),
      '댓글 [등록]'
    );

    if (!commentOK) throw new Error('댓글 [등록] 자동 처리에 실패했습니다.');

    patchLounge({ comment: 'done' });
    logStatus(`💬 댓글 작성 완료: ${COMMENT_TEXT}`);

    await delay(1000);

    const like = post.querySelector(SEL.likeButton);

    if (!like) throw new Error('좋아요 버튼을 찾지 못했습니다.');

    const alreadyLiked =
      like.classList.contains('active') ||
      like.getAttribute('aria-pressed') === 'true' ||
      /좋아요 취소|좋아요 해제/.test(like.innerText.trim());

    if (!alreadyLiked) {
      const likeOK = await waitAndClick(
        () => post.querySelector(SEL.likeButton),
        '[좋아요]'
      );

      if (!likeOK) throw new Error('[좋아요] 자동 처리에 실패했습니다.');
    }

    patchLounge({ like: alreadyLiked ? 'already' : 'done' });
    logStatus('👍 좋아요 처리 완료');
  }

  async function runLoungePhase() {
    setMain({ phase: 'lounge_running' });

    toast('✍️ 라운지 글쓰기 → 댓글 → 좋아요 자동 처리 중...', 11000);

    const state = getMain();
    const titleText = state.postTitle || makeRunTitle();

    if (!state.postTitle) setMain({ postTitle: titleText });

    let post = findCreatedPostNow(titleText);

    if (!post) {
      await fillPost(titleText);
      post = await waitFor(() => findCreatedPostNow(titleText), 15000, 400);
    }

    if (!post) throw new Error('작성한 게시글을 확인하지 못했습니다.');

    await fillCommentAndLike(titleText);

    setMain({ phase: 'return_reward' });

    toast('✅ 라운지 미션 완료\n리워드 페이지로 자동 복귀합니다.', 7000);

    await delay(1200);
    navigate(getMain().rewardUrl || REWARD_URL, 'return_reward');
  }

  // ===========================================================================
  // 12. 최종 보상
  // ===========================================================================

  async function finalizeReward() {
    setMain({ phase: 'reward_finalize' });

    toast('🔄 완료된 미션의 활성 [받기]를 모두 수령합니다.', 10000);

    for (let attempt = 1; attempt <= 4; attempt++) {
      await refreshMissionList();
      await collectPopular();
      await collectAllAvailableRewards();

      if (!loungeMissionLeft().length) break;

      logStatus(`⏳ 라운지 미션 반영 대기 ${attempt}/4`);
      await delay(3500);
    }

    await refreshMissionList();
    await collectAllAvailableRewards();

    const finalFlake = getFlakeCount();
    const current = getMain();

    const overallChange =
      current.drawStartFlake != null && finalFlake != null
        ? finalFlake - current.drawStartFlake
        : null;

    setMain({
      active: false,
      phase: 'done',
      finalFlake,
      overallChange,
      finishedAt: Date.now(),
    });

    logStatus('✅ STOVE 전체 자동화 완료');

    if (finalFlake != null) logStatus(`💰 최종 플레이크: ${finalFlake.toLocaleString()}`);
    if (overallChange != null) logStatus(`📊 시작 대비 변화: ${overallChange.toLocaleString()}`);

    toast(
      [
        '✅ 전체 자동화 완료',
        `🎯 뽑기: ${(current.drawCost || 0).toLocaleString()} × ${current.drawsCompleted || 0}/${CFG.DRAW_COUNT}회`,
        current.drawStopReason ? `⚠️ ${current.drawStopReason}` : '',
        finalFlake != null ? `▶️ 최종 플레이크: ${finalFlake.toLocaleString()}` : '',
        overallChange != null ? `📊 시작 대비 변화: ${overallChange.toLocaleString()}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
      20000
    );

    updateDrawPanel();
    armRetryTimer();
  }

  // ===========================================================================
  // 13. 오류 / 중지
  // ===========================================================================

  function handleFatal(error) {
    console.error('[stove] ❌ 자동화 오류:', error);

    const message = String(error?.message || error);

    setMain({ active: false, phase: 'error', error: message });
    logStatus(`❌ ${message}`);

    toast(`❌ 자동화가 중단되었습니다.\n${message}`, 20000);

    updateDrawPanel();
    armRetryTimer();
  }

  function stopAutomation(reason) {
    running = false;

    setMain({ active: false, phase: 'idle', error: '', stoppedAt: Date.now() });
    logStatus(`🛑 ${reason}`);

    updateDrawPanel();
    renderStatusPanel();
  }

  // ===========================================================================
  // 14. 페이지 이동 / phase 라우터
  // ===========================================================================

  const HOST = {
    reward: 'reward.onstove.com',
    dailyshop: 'event.onstove.com',
    lounge: 'lounge.onstove.com',
  };

  /**
   * phase 별 담당 페이지와 실행 함수.
   * 담당 호스트가 아니면 알아서 해당 페이지로 이동한다.
   * → "리워드 페이지인데 phase 가 go_lounge" 같은 조합에서 조용히 멈추던 문제 해결.
   */
  const PHASE_PLAN = {
    draw_start: {
      host: HOST.reward,
      url: () => getMain().rewardUrl || REWARD_URL,
      run: () => runDrawLoop(getMain().drawCost || 100),
    },
    draw_running: {
      host: HOST.reward,
      url: () => getMain().rewardUrl || REWARD_URL,
      run: resumeInterruptedDraw,
    },
    capsule_rewards: {
      host: HOST.reward,
      url: () => getMain().rewardUrl || REWARD_URL,
      run: async () => {
        await delay(1500);
        await claimCapsuleMilestoneRewards();

        setMain({ phase: 'daily_shop', dailyIndex: 0 });
        navigate(shopUrl(DAILY_SHOPS[0]), 'daily_shop');
      },
    },
    daily_shop: {
      host: HOST.dailyshop,
      url: () => shopUrl(DAILY_SHOPS[Math.min(getMain().dailyIndex || 0, DAILY_SHOPS.length - 1)]),
      run: async () => {
        const shop = currentDailyShop();

        if (!shop) {
          logStatus('⚠️ Daily Shop 페이지를 식별하지 못해 미션 단계로 넘어갑니다.');

          setMain({ phase: 'missions_start' });
          navigate(getMain().rewardUrl || REWARD_URL, 'missions_start');

          return;
        }

        await runMainDailyShop(shop);
      },
    },
    missions_start: {
      host: HOST.reward,
      url: () => getMain().rewardUrl || REWARD_URL,
      run: async () => {
        await delay(1500);
        await runRewardMissions();
      },
    },
    missions_running: {
      host: HOST.reward,
      url: () => getMain().rewardUrl || REWARD_URL,
      run: async () => {
        await delay(1500);
        await runRewardMissions();
      },
    },
    go_lounge: {
      host: HOST.lounge,
      url: () => LOUNGE_URL,
      run: runLoungePhase,
    },
    lounge_running: {
      host: HOST.lounge,
      url: () => LOUNGE_URL,
      run: runLoungePhase,
    },
    return_reward: {
      host: HOST.reward,
      url: () => getMain().rewardUrl || REWARD_URL,
      run: async () => {
        await delay(1700);
        await finalizeReward();
      },
    },
    reward_finalize: {
      host: HOST.reward,
      url: () => getMain().rewardUrl || REWARD_URL,
      run: async () => {
        await delay(1700);
        await finalizeReward();
      },
    },
  };

  /** 뽑기 도중 페이지가 새로고침된 경우의 처리 */
  async function resumeInterruptedDraw() {
    const state = getMain();
    const done = state.drawsCompleted || 0;

    if (CFG.RESUME_DRAW_AFTER_RELOAD && done < CFG.DRAW_COUNT) {
      logStatus(`🔁 뽑기가 끊겨 ${done}회 이후부터 재개합니다.`);
      await runDrawLoop(state.drawCost || 100);
      return;
    }

    logStatus(
      `⚠️ 뽑기 도중 페이지가 새로고침되었습니다. (${done}/${CFG.DRAW_COUNT}회 기록) ` +
        '중복 차감을 막기 위해 남은 뽑기는 건너뛰고 다음 단계로 진행합니다.'
    );

    setMain({ phase: 'capsule_rewards', drawStopReason: '페이지 새로고침으로 뽑기 중단' });
    await dispatchPhase({ forced: true });
  }

  /**
   * @param {string} url        이동할 주소
   * @param {string} phaseHint  이동 후 수행할 단계 (무한 이동 감지에 사용)
   * @param {{reloadIfSame?: boolean}} [options]
   *        이미 같은 주소에 있을 때 새로고침할지 여부.
   *        DOM 이 낡아 있으면 다음 단계가 오작동하므로 단계 전환 직후에는 true 를 쓴다.
   */
  function navigate(url, phaseHint, { reloadIfSame = false } = {}) {
    const state = getMain();
    const samePhase = state.navPhase === phaseHint;
    const navCount = samePhase ? (state.navCount || 0) + 1 : 1;

    if (navCount > CFG.MAX_NAV_PER_PHASE) {
      handleFatal(
        new Error(`'${PHASE_LABEL[phaseHint] || phaseHint}' 단계에서 페이지 이동이 반복되어 중단했습니다.`)
      );
      return;
    }

    setMain({ navPhase: phaseHint, navCount, navAt: Date.now() });

    if (location.href === url) {
      if (reloadIfSame) {
        location.reload();
        return;
      }

      // 이미 목적지에 있으면 이동 대신 바로 실행한다.
      void dispatchPhase({ forced: true });
      return;
    }

    location.href = url;
  }

  let running = false;

  async function dispatchPhase({ forced = false } = {}) {
    const state = getMain();

    if (!state.active) return;

    if (running && !forced) return;

    const plan = PHASE_PLAN[state.phase];

    if (!plan) {
      logStatus(`⚠️ 알 수 없는 단계(${state.phase}) — 자동화를 정리합니다.`);
      stopAutomation('알 수 없는 단계라 중단했습니다.');
      return;
    }

    // 담당 페이지가 아니면 이동시킨다.
    if (location.hostname !== plan.host) {
      logStatus(`➡️ '${PHASE_LABEL[state.phase]}' 단계 페이지로 이동합니다.`);
      navigate(plan.url(), state.phase);
      return;
    }

    running = true;
    beat();

    try {
      await withTimeout(
        Promise.resolve(plan.run()),
        CFG.STEP_TIMEOUT_MS,
        PHASE_LABEL[state.phase] || state.phase
      );
    } catch (error) {
      handleFatal(error);
    } finally {
      running = false;
    }
  }

  // ===========================================================================
  // 15. 워치독
  // ===========================================================================

  function startWatchdog() {
    clearInterval(window.__stovePanelTimer);
    clearInterval(window.__stoveWatchdog);

    // 패널은 값이 바뀐 경우에만 다시 그린다 (renderStatusPanel 내부에서 판단).
    window.__stovePanelTimer = setInterval(renderStatusPanel, 1000);

    window.__stoveWatchdog = setInterval(() => {
      const state = getMain();

      if (!state.active) return;
      if (running) return;

      const idleFor = Date.now() - (state.updatedAt || 0);

      if (idleFor < CFG.STALL_TIMEOUT_MS) return;

      const plan = PHASE_PLAN[state.phase];

      if (!plan) {
        stopAutomation(`알 수 없는 단계(${state.phase})에서 멈춰 중단했습니다.`);
        return;
      }

      logStatus(
        `🩺 ${Math.round(idleFor / 1000)}초간 진행이 없어 '${PHASE_LABEL[state.phase]}' 단계를 다시 시도합니다.`
      );

      beat();
      void dispatchPhase({ forced: true });
    }, CFG.WATCHDOG_INTERVAL_MS);
  }

  // ===========================================================================
  // 16. 부트스트랩
  // ===========================================================================

  async function bootIdlePage() {
    armRetryTimer();

    // Daily Shop 페이지에서 재시도가 진행 중이면 그것부터 처리
    if (location.hostname === HOST.dailyshop) {
      const shop = currentDailyShop();
      const retryItem = shop ? getRetries()[shop.code] : null;

      if (shop && retryItem?.inProgress && retryItem.date === kstDateKey()) {
        await runDailyRetry(shop);
        armRetryTimer();
        return;
      }
    }

    if (findDueRetry()) launchDueRetry();
  }

  async function main() {
    try {
      createStatusPanel();
      createDrawPanel();
      cleanupOldRetries();
      startWatchdog();

      const state = getMain();

      if (!state.active) {
        updateDrawPanel();
        await bootIdlePage();
        return;
      }

      updateDrawPanel();
      await dispatchPhase({ forced: true });
    } catch (error) {
      handleFatal(error);
    }
  }

  // 페이지 이탈 시 실행 플래그가 남지 않도록 정리
  window.addEventListener('beforeunload', () => {
    running = false;
  });

  if (typeof GM_registerMenuCommand === 'function') {
    GM_registerMenuCommand('STOVE 자동화 강제 초기화', () => {
      stopAutomation('메뉴에서 강제 초기화했습니다.');
    });

    GM_registerMenuCommand('STOVE 로그 지우기', () => {
      clearStatusLog();
      renderStatusPanel();
    });
  }

  void main();
})();
