// ==UserScript==
// @name         STOVE 플레이크 전체 자동화 + 상태 패널
// @namespace    https://github.com/supsupsupsupsu/stove-auto
// @version      4.0.1
// @description  캡슐 뽑기 30회 → 캡슐 누적 보상 → Daily Shop → 미션 → 인기 게시글 → 라운지 → 모든 받을 수 있는 보상을 자동 처리하고 진행 상태를 표시합니다.
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
// @run-at       document-idle
// ==/UserScript==

(() => {
  'use strict';

  const MAIN_KEY = '__stove_auto_main_v4';
  const RETRY_KEY = '__stove_daily_retry_v4';
  const LOG_KEY = '__stove_auto_status_log_v4';

  const DRAW_COUNT = 30;

  // 오늘의 아이템 재시도: 4시간
  const RETRY_INTERVAL_MS = 4 * 60 * 60 * 1000;

  // 당일 최종 재시도 시간
  const FINAL_RETRY_TIME = '23:50:00';

  const VISIT_WAIT = 4000;

  // =====================================================
  // 라운지 글/댓글
  // =====================================================

  const BODY = '오늘도 좋은 하루 보내세요!';
  const COMMENT = '좋은 글 잘 봤습니다';

  const LOUNGE_URL =
    'https://lounge.onstove.com/feed/%ED%94%8C%EB%A0%88%EC%9D%B4%ED%81%AC%EB%AF%B8%EC%85%98';

  // =====================================================
  // Daily Shop
  // =====================================================

  const DAILY_SHOPS = [
    {
      code: 'RIICHICITY_IND',
      label: '마작일번가',
      url: 'https://event.onstove.com/ko/dailyshop/RIICHICITY_IND/202512',
    },
    {
      code: 'STOVEINDIE',
      label: '스토브 스토어',
      url: 'https://event.onstove.com/ko/dailyshop/STOVEINDIE/202512',
    },
  ];

  // =====================================================
  // 방문 미션
  // =====================================================

  const VISIT_MISSIONS = [
    '365일 특가 게임 구경하기',
    'MY홈 방문하기',
    '스토브 메인 방문하기',
  ];

  // =====================================================
  // 라운지 미션
  // =====================================================

  const LOUNGE_MISSIONS = [
    '라운지 글쓰기',
    '라운지 좋아요 누르기',
    '라운지 댓글 쓰기',
  ];

  // =====================================================
  // 캡슐 누적 보상
  // =====================================================

  const CAPSULE_REWARDS = [
    '2,000 플레이크 받기',
    '5,000 플레이크 받기',
    '20,000 플레이크 받기',
  ];

  const delay = ms =>
    new Promise(resolve => setTimeout(resolve, ms));

  const random = (min, max) =>
    Math.floor(Math.random() * (max - min + 1)) + min;

  const normalize = text =>
    String(text || '')
      .replace(/,/g, '')
      .replace(/\s+/g, ' ')
      .trim();

  // =====================================================
  // 메인 상태
  // =====================================================

  function getMain() {
    return GM_getValue(MAIN_KEY, {
      active: false,
      phase: 'idle',
      progress: {},
    });
  }

  function setMain(patch) {
    const next = {
      ...getMain(),
      ...patch,
      updatedAt: Date.now(),
    };

    GM_setValue(MAIN_KEY, next);

    queueMicrotask(renderStatusPanel);

    return next;
  }

  function patchProgress(patch) {
    const current = getMain();

    return setMain({
      progress: {
        ...(current.progress || {}),
        ...patch,
      },
    });
  }

  function clearMain() {
    GM_deleteValue(MAIN_KEY);
  }

  // =====================================================
  // Daily Shop 재시도 상태
  // =====================================================

  function getRetries() {
    return GM_getValue(RETRY_KEY, {});
  }

  function setRetries(value) {
    GM_setValue(RETRY_KEY, value);
    queueMicrotask(renderStatusPanel);
  }

  // =====================================================
  // 상태 로그
  // =====================================================

  function getStatusLog() {
    return GM_getValue(LOG_KEY, []);
  }

  function clearStatusLog() {
    GM_deleteValue(LOG_KEY);
  }

  function addStatusLog(message) {
    if (!message) {
      return;
    }

    const logs = getStatusLog();

    logs.push({
      time: Date.now(),
      message: String(message),
    });

    while (logs.length > 60) {
      logs.shift();
    }

    GM_setValue(LOG_KEY, logs);

    queueMicrotask(renderStatusPanel);
  }

  // =====================================================
  // console.log를 상태 패널에도 기록
  // =====================================================

  function installConsoleStatusCapture() {
    if (window.__stoveConsoleCaptured) {
      return;
    }

    window.__stoveConsoleCaptured = true;

    const originalLog = console.log.bind(console);

    console.log = (...args) => {
      originalLog(...args);

      const text = args
        .map(value => {
          if (typeof value === 'string') {
            return value;
          }

          try {
            return JSON.stringify(value);
          } catch (_) {
            return String(value);
          }
        })
        .join(' ');

      if (
        /^[🎯🎁✅⚠️⏭️🔗📰✍️💬👍🔁⏳⏰▶️📊🛍️➡️💰🖱️]/u.test(
          text
        )
      ) {
        addStatusLog(text);
      }
    };
  }

  // =====================================================
  // 한국 날짜
  // =====================================================

  function getKstDateKey(nowMs = Date.now()) {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Seoul',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(nowMs));
  }

  // =====================================================
  // 전날 재시도 삭제
  // =====================================================

  function cleanupOldRetries() {
    const today = getKstDateKey();
    const retries = getRetries();

    let changed = false;

    for (const [code, item] of Object.entries(retries)) {
      if (!item || item.date !== today) {
        delete retries[code];
        changed = true;
      }
    }

    if (changed) {
      setRetries(retries);
    }

    return retries;
  }

  // =====================================================
  // 당일 23:50
  // =====================================================

  function getFinalRetryMs(dateKey = getKstDateKey()) {
    return new Date(
      `${dateKey}T${FINAL_RETRY_TIME}+09:00`
    ).getTime();
  }

  // =====================================================
  // 다음 재시도
  // 4시간 후 또는 23:50
  // =====================================================

  function getNextRetryAt() {
    const now = Date.now();
    const finalMs = getFinalRetryMs();

    if (now >= finalMs) {
      return null;
    }

    return Math.min(
      now + RETRY_INTERVAL_MS,
      finalMs
    );
  }

  // =====================================================
  // 재시도 예약
  // =====================================================

  function scheduleDailyRetry(shopCode) {
    const retries = cleanupOldRetries();
    const nextAt = getNextRetryAt();
    const today = getKstDateKey();

    const prev = retries[shopCode] || {};

    if (nextAt === null) {
      delete retries[shopCode];

      setRetries(retries);

      console.log(
        `⏭️ ${shopCode}: 오늘 23:50 최종 시도 시간이 지나 재시도 예약을 종료합니다.`
      );

      return null;
    }

    retries[shopCode] = {
      pending: true,
      date: today,
      nextAt,
      retryCount: (prev.retryCount || 0) + 1,
      inProgress: false,
      returnUrl: prev.returnUrl || '',
    };

    setRetries(retries);

    const when = new Date(nextAt).toLocaleString(
      'ko-KR',
      {
        timeZone: 'Asia/Seoul',
        hour12: false,
      }
    );

    console.log(
      `⏰ ${shopCode}: 오늘의 아이템 재시도 예약 → ${when}`
    );

    return nextAt;
  }

  function clearDailyRetry(shopCode) {
    const retries = getRetries();

    delete retries[shopCode];

    setRetries(retries);
  }

  function findDueRetry() {
    const retries = cleanupOldRetries();
    const now = Date.now();

    return (
      Object.entries(retries)
        .filter(
          ([, item]) =>
            item?.pending &&
            item.nextAt <= now
        )
        .sort(
          (a, b) =>
            a[1].nextAt -
            b[1].nextAt
        )[0] || null
    );
  }

  // =====================================================
  // Toast
  // =====================================================

  function toast(message, ms = 7000) {
    let box =
      document.getElementById(
        '__stove_auto_toast'
      );

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

    box._timer =
      setTimeout(
        () => box.remove(),
        ms
      );

    console.log(message);
  }

  function isVisible(el) {
    if (
      !el ||
      !document.contains(el)
    ) {
      return false;
    }

    const style =
      getComputedStyle(el);

    if (
      style.display === 'none' ||
      style.visibility === 'hidden'
    ) {
      return false;
    }

    const rect =
      el.getBoundingClientRect();

    return (
      rect.width > 0 &&
      rect.height > 0
    );
  }

  // =====================================================
  // 기다리기
  // =====================================================

  async function waitFor(
    getter,
    timeout = 12000,
    interval = 250
  ) {
    const end =
      Date.now() + timeout;

    while (Date.now() < end) {
      const value = getter();

      if (value) {
        return value;
      }

      await delay(interval);
    }

    return null;
  }

  function findButtonExact(text) {
    const expected =
      normalize(text);

    return (
      [...document.querySelectorAll('button')]
        .find(
          btn =>
            !btn.disabled &&
            isVisible(btn) &&
            normalize(btn.innerText) ===
              expected
        ) || null
    );
  }

  // =====================================================
  // 플레이크 보유량
  // =====================================================

  function getFlakeCount() {
    const el =
      document.querySelector(
        'span.whitespace-nowrap.block.overflow-ellipsis'
      );

    if (!el) {
      return null;
    }

    const raw =
      el.innerText.replace(
        /[^\d]/g,
        ''
      );

    const num =
      parseInt(
        raw || '0',
        10
      );

    return Number.isNaN(num)
      ? null
      : num;
  }

  // =====================================================
  // 글 제목
  // =====================================================

  function makeRunTitle() {
    const d = new Date();

    const pad = n =>
      String(n).padStart(2, '0');

    return (
      `오늘의 한 줄 ` +
      `${d.getFullYear()}-` +
      `${pad(d.getMonth() + 1)}-` +
      `${pad(d.getDate())} ` +
      `${pad(d.getHours())}:` +
      `${pad(d.getMinutes())}:` +
      `${pad(d.getSeconds())}`
    );
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // =====================================================
  // 단계 라벨
  // =====================================================

  function getPhaseLabel(phase) {
    const labels = {
      idle: '대기',
      draw_start: '뽑기 시작',
      draw_running: '캡슐 뽑기',
      capsule_rewards:
        '캡슐 누적 보상',
      daily_shop:
        'Daily Shop',
      missions_start:
        '플레이크 미션 준비',
      missions_running:
        '플레이크 미션',
      go_lounge:
        '라운지 이동',
      lounge_running:
        '라운지 미션',
      return_reward:
        '리워드 페이지 복귀',
      reward_finalize:
        '최종 보상 수령',
      done:
        '전체 완료',
      error:
        '오류 발생',
    };

    return (
      labels[phase] ||
      phase ||
      '대기'
    );
  }

  function getStageStatus(
    stage,
    phase
  ) {
    const order = {
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

    if (
      phase === 'error'
    ) {
      return '❌';
    }

    const current =
      order[phase];

    if (
      phase === 'done'
    ) {
      return '✅';
    }

    if (
      current === undefined
    ) {
      return '⬜';
    }

    if (
      current > stage
    ) {
      return '✅';
    }

    if (
      current === stage
    ) {
      return '⏳';
    }

    return '⬜';
  }

  // =====================================================
  // 재시도 표시
  // =====================================================

  function getRetryDisplay() {
    const retries =
      cleanupOldRetries();

    const today =
      getKstDateKey();

    const rows = [];

    for (
      const [code, item]
      of Object.entries(retries)
    ) {
      if (
        !item?.pending ||
        item.date !== today
      ) {
        continue;
      }

      const shop =
        DAILY_SHOPS.find(
          x => x.code === code
        );

      const time =
        new Date(
          item.nextAt
        ).toLocaleTimeString(
          'ko-KR',
          {
            timeZone: 'Asia/Seoul',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
          }
        );

      rows.push(
        `${shop?.label || code} → ${time}`
      );
    }

    return rows;
  }

  function formatTodayItemStatus(
    value,
    code
  ) {
    const retry =
      getRetries()[code];

    if (
      value === 'success'
    ) {
      return '✅ 완료';
    }

    if (
      value === 'unavailable'
    ) {
      return '⏭️ 이미 완료/버튼 없음';
    }

    if (
      value === 'retry' &&
      retry?.nextAt
    ) {
      const time =
        new Date(
          retry.nextAt
        ).toLocaleTimeString(
          'ko-KR',
          {
            timeZone: 'Asia/Seoul',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
          }
        );

      return `🔁 ${time} 재시도`;
    }

    if (
      value === 'retry'
    ) {
      return '🔁 재시도 예정';
    }

    return '⬜ 대기';
  }

  // =====================================================
  // 상태 패널 생성
  // =====================================================

  function createStatusPanel() {
    if (
      document.getElementById(
        '__stove_status_panel'
      )
    ) {
      renderStatusPanel();
      return;
    }

    const panel =
      document.createElement(
        'div'
      );

    panel.id =
      '__stove_status_panel';

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

    document.body.appendChild(
      panel
    );

    renderStatusPanel();
  }

  // =====================================================
  // 상태 패널 갱신
  // =====================================================

  function renderStatusPanel() {
    const panel =
      document.getElementById(
        '__stove_status_panel'
      );

    if (!panel) {
      return;
    }

    const state = getMain();

    const progress =
      state.progress || {};

    const phase =
      state.phase || 'idle';

    const recentLogs =
      getStatusLog().slice(-9);

    const currentFlake =
      getFlakeCount();

    const retryRows =
      getRetryDisplay();

    const capsule =
      progress.capsuleRewards || {};

    const daily =
      progress.dailyShop || {};

    const lounge =
      progress.lounge || {};

    const capsuleReceived =
      Object.values(capsule)
        .filter(
          v =>
            v === 'received'
        ).length;

    const daily1 =
      daily.RIICHICITY_IND || {};

    const daily2 =
      daily.STOVEINDIE || {};

    const stageRows = [
      ['캡슐 뽑기', 0],
      ['캡슐 누적 보상', 1],
      ['Daily Shop', 2],
      ['플레이크 미션', 3],
      ['라운지 미션', 4],
      ['최종 보상', 5],
    ]
      .map(
        ([name, no]) =>
          `<div>${getStageStatus(
            no,
            phase
          )} ${no + 1}. ${name}</div>`
      )
      .join('');

    const logsHtml =
      recentLogs.length
        ? recentLogs
            .map(
              log => {
                const time =
                  new Date(
                    log.time
                  ).toLocaleTimeString(
                    'ko-KR',
                    {
                      timeZone:
                        'Asia/Seoul',
                      hour:
                        '2-digit',
                      minute:
                        '2-digit',
                      second:
                        '2-digit',
                      hour12:
                        false,
                    }
                  );

                return (
                  `<div style="padding:2px 0;border-bottom:1px solid rgba(255,255,255,.05)">` +
                  `<span style="opacity:.5;margin-right:5px">${time}</span>` +
                  `${escapeHtml(log.message)}` +
                  `</div>`
                );
              }
            )
            .join('')
        : '<div style="opacity:.55">아직 실행 기록이 없습니다.</div>';

    panel.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:9px">

        <div style="font-size:15px;font-weight:800">
          STOVE 자동화 현황
        </div>

        <div style="font-size:11px;opacity:.65">
          ${
            state.active
              ? '실행 중'
              : phase === 'done'
                ? '완료'
                : phase === 'error'
                  ? '오류'
                  : '대기'
          }
        </div>
      </div>

      <div style="background:rgba(255,255,255,.07);padding:9px 10px;border-radius:9px;margin-bottom:10px">

        <div>
          📍 현재 단계:
          <strong>
            ${escapeHtml(
              getPhaseLabel(phase)
            )}
          </strong>
        </div>

        <div>
          🎯 선택:
          <strong>
            ${
              state.drawCost
                ? state.drawCost.toLocaleString() +
                  ' 뽑기'
                : '-'
            }
          </strong>
        </div>

        <div>
          🔢 뽑기:
          <strong>
            ${state.drawsCompleted || 0} / ${DRAW_COUNT}
          </strong>
        </div>

        ${
          currentFlake !== null
            ? `
              <div>
                💰 현재 플레이크:
                <strong>
                  ${currentFlake.toLocaleString()}
                </strong>
              </div>
            `
            : ''
        }
      </div>

      <div style="margin-bottom:10px">
        ${stageRows}
      </div>

      <div style="border-top:1px solid rgba(255,255,255,.12);padding-top:9px">

        <div style="font-weight:700;margin-bottom:5px">
          결과 요약
        </div>

        <div>
          🎁 캡슐 누적 보상:
          ${capsuleReceived}개 수령
        </div>

        <div>
          🛍️ 마작일번가 오늘 아이템:
          ${formatTodayItemStatus(
            daily1.todayItem,
            'RIICHICITY_IND'
          )}
        </div>

        <div>
          　└ 보상 받기:
          ${daily1.rewardCount || 0}개
        </div>

        <div>
          🛍️ 스토브 스토어 오늘 아이템:
          ${formatTodayItemStatus(
            daily2.todayItem,
            'STOVEINDIE'
          )}
        </div>

        <div>
          　└ 보상 받기:
          ${daily2.rewardCount || 0}개
        </div>

        <div>
          🔗 방문 미션:
          ${progress.visitMissionCount || 0}/${VISIT_MISSIONS.length}개 처리
        </div>

        <div>
          📰 인기 게시글:
          ${progress.popularVisited || 0}/3개 방문
        </div>

        <div>
          ✍️ 글쓰기:
          ${lounge.post ? '✅' : '⬜'}
          　
          💬 댓글:
          ${lounge.comment ? '✅' : '⬜'}
          　
          👍 좋아요:
          ${lounge.like ? '✅' : '⬜'}
        </div>

        <div>
          🎁 일반 [받기]:
          ${progress.genericRewardCount || 0}개
        </div>
      </div>

      ${
        retryRows.length
          ? `
            <div style="margin-top:10px;padding-top:9px;border-top:1px solid rgba(255,255,255,.12)">

              <div style="font-weight:700">
                🔁 오늘의 아이템 재시도
              </div>

              ${retryRows
                .map(
                  x =>
                    `<div>• ${escapeHtml(x)}</div>`
                )
                .join('')}

              <div style="font-size:11px;opacity:.6">
                4시간 간격 / 마지막 23:50 / 자정 이후 폐기
              </div>
            </div>
          `
          : ''
      }

      <div style="margin-top:10px;padding-top:9px;border-top:1px solid rgba(255,255,255,.12)">

        <div style="font-weight:700;margin-bottom:5px">
          최근 작업
        </div>

        ${logsHtml}
      </div>
    `;

    panel.style.bottom =
      (
        location.hostname ===
          'reward.onstove.com' &&
        location.pathname.startsWith(
          '/ko/event'
        )
      )
        ? '90px'
        : '18px';
  }

  // =====================================================
  // 뽑기 보상 문구
  // =====================================================

  async function getRewardText(
    timeout = 4000
  ) {
    const el =
      await waitFor(
        () => {
          const node =
            document.querySelector(
              '.l1l2-flakehub-popup-common-received_reward'
            );

          return (
            node &&
            node.innerText.trim()
          )
            ? node
            : null;
        },
        timeout,
        100
      );

    return el
      ? el.innerText.trim()
      : '';
  }

  // =====================================================
  // 첫 뽑기 버튼
  // =====================================================

  function findInitialDrawButton(
    cost
  ) {
    const expected =
      `${cost} 뽑기`;

    return (
      [...document.querySelectorAll('button')]
        .find(
          btn => {
            const span =
              btn.querySelector(
                'span.button-draw-hover-text'
              );

            return (
              !btn.disabled &&
              span &&
              normalize(
                span.innerText
              ) === expected
            );
          }
        ) || null
    );
  }

  // =====================================================
  // 한번 더 버튼
  // =====================================================

  function findRepeatDrawButton(
    cost
  ) {
    const expected =
      `${cost} 뽑기 한번 더!`;

    const span =
      [
        ...document.querySelectorAll(
          'span.block.whitespace-nowrap'
        ),
      ].find(
        node =>
          normalize(
            node.innerText
          ) === expected
      );

    if (!span) {
      return null;
    }

    const button =
      span.closest('button');

    return (
      button &&
      !button.disabled
    )
      ? button
      : span;
  }

  // =====================================================
  // 캡슐 30회
  // =====================================================

  async function runDrawLoop(
    cost
  ) {
    console.clear();

    const startFlake =
      getFlakeCount();

    if (
      startFlake === null
    ) {
      throw new Error(
        '시작 플레이크 보유량을 찾을 수 없습니다.'
      );
    }

    setMain({
      phase: 'draw_running',
      drawCost: cost,
      drawStartFlake:
        startFlake,
      drawsCompleted: 0,
    });

    toast(
      `🎯 ${cost.toLocaleString()} 뽑기 ${DRAW_COUNT}회를 시작합니다.`,
      10000
    );

    const initial =
      await waitFor(
        () =>
          findInitialDrawButton(
            cost
          ),
        10000,
        250
      );

    if (!initial) {
      throw new Error(
        `"${cost.toLocaleString()} 뽑기" 버튼을 찾을 수 없거나 활성화되지 않았습니다.`
      );
    }

    initial.click();

    console.log(
      `🎯 1/${DRAW_COUNT}회차 클릭`
    );

    let completed = 0;

    for (
      let drawNo = 1;
      drawNo <= DRAW_COUNT;
      drawNo++
    ) {
      await delay(
        drawNo === 1
          ? random(
              3800,
              4200
            )
          : random(
              2600,
              3000
            )
      );

      const rewardText =
        await getRewardText();

      console.log(
        rewardText
          ? `🎁 ${drawNo}/${DRAW_COUNT}회차 보상: ${rewardText}`
          : `⚠️ ${drawNo}/${DRAW_COUNT}회차: 보상 텍스트를 찾지 못했습니다.`
      );

      completed =
        drawNo;

      setMain({
        drawsCompleted:
          completed,
      });

      if (
        drawNo ===
        DRAW_COUNT
      ) {
        break;
      }

      const repeat =
        await waitFor(
          () =>
            findRepeatDrawButton(
              cost
            ),
          5000,
          100
        );

      if (!repeat) {
        console.log(
          `⚠️ ${drawNo}회차 후 "${cost.toLocaleString()} 뽑기 한번 더!" 버튼이 없어 뽑기를 종료합니다.`
        );

        break;
      }

      repeat.click();

      console.log(
        `🎯 ${drawNo + 1}/${DRAW_COUNT}회차 클릭`
      );
    }

    const endFlake =
      getFlakeCount();

    setMain({
      phase:
        'capsule_rewards',
      drawEndFlake:
        endFlake,
      missionStartFlake:
        endFlake,
      drawsCompleted:
        completed,
    });

    toast(
      `✅ 뽑기 ${completed}/${DRAW_COUNT}회 완료\n➡️ 캡슐 누적 보상을 확인합니다.`,
      9000
    );

    await delay(1000);

    location.reload();
  }

  // =====================================================
  // 팝업 닫기
  // =====================================================

  async function closeVisiblePopup() {
    const labels = [
      '확인',
      '닫기',
      'Close',
      'OK',
    ];

    for (
      const label of labels
    ) {
      const button =
        [
          ...document.querySelectorAll(
            'button'
          ),
        ].find(
          btn =>
            !btn.disabled &&
            isVisible(btn) &&
            btn.innerText.trim() ===
              label
        );

      if (button) {
        button.click();

        await delay(500);

        return true;
      }
    }

    const ariaButton =
      [
        ...document.querySelectorAll(
          'button[aria-label]'
        ),
      ].find(
        btn =>
          !btn.disabled &&
          isVisible(btn) &&
          /close|닫기/i.test(
            btn.getAttribute(
              'aria-label'
            ) || ''
          )
      );

    if (ariaButton) {
      ariaButton.click();

      await delay(500);

      return true;
    }

    return false;
  }

  // =====================================================
  // 캡슐 누적 보상
  // =====================================================

  async function claimCapsuleMilestoneRewards() {
    let count = 0;
    const result = {};

    for (
      const title of
        CAPSULE_REWARDS
    ) {
      const button =
        findButtonExact(
          title
        );

      if (!button) {
        result[title] =
          'unavailable';

        console.log(
          `⏭️ 캡슐 누적 보상 미활성/완료: ${title}`
        );

        continue;
      }

      button.scrollIntoView({
        behavior: 'smooth',
        block: 'center',
      });

      await delay(250);

      button.click();

      count++;

      result[title] =
        'received';

      patchProgress({
        capsuleRewards: {
          ...(
            getMain()
              .progress
              ?.capsuleRewards ||
            {}
          ),
          ...result,
        },
      });

      console.log(
        `🎁 캡슐 누적 보상 수령: ${title}`
      );

      await delay(1200);

      await closeVisiblePopup();
    }

    patchProgress({
      capsuleRewards:
        result,
    });

    return count;
  }

  // =====================================================
  // 현재 Daily Shop
  // =====================================================

  function currentDailyShop() {
    return (
      DAILY_SHOPS.find(
        shop =>
          location.href.includes(
            `/dailyshop/${shop.code}/`
          )
      ) || null
    );
  }

  // =====================================================
  // 플레이 기록 없음 메시지
  // =====================================================

  function hasNoPlayRecordMessage() {
    const text =
      document.body
        ?.innerText ||
      '';

    return (
      text.includes(
        '당일 플레이 기록이 있는 회원만'
      ) &&
      text.includes(
        '게임 플레이 기록'
      )
    );
  }

  function updateDailyProgress(
    shopCode,
    patch
  ) {
    const current =
      getMain();

    const daily =
      current.progress
        ?.dailyShop ||
      {};

    patchProgress({
      dailyShop: {
        ...daily,

        [shopCode]: {
          ...(
            daily[
              shopCode
            ] ||
            {}
          ),
          ...patch,
        },
      },
    });
  }

  // =====================================================
  // 오늘의 아이템 받기
  // =====================================================

  async function claimTodayItem(
    shop,
    isRetry = false
  ) {
    const button =
      await waitFor(
        () =>
          findButtonExact(
            '오늘의 아이템 받기'
          ),
        8000,
        250
      );

    if (!button) {
      console.log(
        `⏭️ ${shop.code}: 오늘의 아이템 받기 버튼이 없거나 이미 처리되었습니다.`
      );

      clearDailyRetry(
        shop.code
      );

      updateDailyProgress(
        shop.code,
        {
          todayItem:
            'unavailable',
        }
      );

      return {
        status:
          'unavailable',
      };
    }

    button.scrollIntoView({
      behavior: 'smooth',
      block: 'center',
    });

    await delay(250);

    button.click();

    console.log(
      `🎁 ${shop.code}: 오늘의 아이템 받기 클릭${isRetry ? ' (재시도)' : ''}`
    );

    await delay(1300);

    if (
      hasNoPlayRecordMessage()
    ) {
      console.log(
        `⏳ ${shop.code}: 당일 플레이 기록이 없어 오늘의 아이템 수령 실패.`
      );

      await closeVisiblePopup();

      const nextAt =
        scheduleDailyRetry(
          shop.code
        );

      updateDailyProgress(
        shop.code,
        {
          todayItem:
            'retry',
        }
      );

      if (nextAt) {
        const when =
          new Date(
            nextAt
          ).toLocaleTimeString(
            'ko-KR',
            {
              timeZone:
                'Asia/Seoul',
              hour:
                '2-digit',
              minute:
                '2-digit',
              hour12:
                false,
            }
          );

        toast(
          `⏳ ${shop.label}: 플레이 기록 미반영\n오늘 ${when}에 오늘의 아이템만 다시 시도합니다.`,
          9000
        );
      }

      return {
        status: 'retry',
      };
    }

    clearDailyRetry(
      shop.code
    );

    updateDailyProgress(
      shop.code,
      {
        todayItem:
          'success',
      }
    );

    console.log(
      `✅ ${shop.code}: 오늘의 아이템 수령 처리 완료`
    );

    await closeVisiblePopup();

    return {
      status: 'success',
    };
  }

  // =====================================================
  // Daily Shop "보상 받기"
  // =====================================================

  async function collectDailyShopRewards(
    shop,
    maxClicks = 30
  ) {
    let count = 0;

    for (
      let i = 0;
      i < maxClicks;
      i++
    ) {
      const button =
        findButtonExact(
          '보상 받기'
        );

      if (!button) {
        break;
      }

      button.scrollIntoView({
        behavior: 'smooth',
        block: 'center',
      });

      await delay(250);

      button.click();

      count++;

      console.log(
        `🎁 ${shop.code}: [보상 받기] 자동 수령 (${count})`
      );

      updateDailyProgress(
        shop.code,
        {
          rewardCount:
            count,
        }
      );

      await delay(1300);

      await closeVisiblePopup();
    }

    updateDailyProgress(
      shop.code,
      {
        rewardCount:
          count,
      }
    );

    return count;
  }

  // =====================================================
  // 메인 Daily Shop
  // =====================================================

  async function runMainDailyShop(
    shop
  ) {
    const main = getMain();

    toast(
      `🛍️ Daily Shop 처리 중\n${shop.label}`,
      8000
    );

    await delay(1200);

    await claimTodayItem(
      shop,
      false
    );

    await collectDailyShopRewards(
      shop
    );

    const index =
      DAILY_SHOPS.findIndex(
        item =>
          item.code ===
          shop.code
      );

    if (
      index >= 0 &&
      index <
        DAILY_SHOPS.length - 1
    ) {
      setMain({
        phase: 'daily_shop',
        dailyIndex:
          index + 1,
      });

      location.href =
        DAILY_SHOPS[
          index + 1
        ].url;

      return;
    }

    setMain({
      phase:
        'missions_start',
      dailyIndex:
        DAILY_SHOPS.length,
    });

    location.href =
      main.rewardUrl ||
      'https://reward.onstove.com/ko/event';
  }

  // =====================================================
  // 오늘의 아이템 단독 재시도
  // =====================================================

  async function runDailyRetry(
    shop
  ) {
    const retries =
      cleanupOldRetries();

    const item =
      retries[shop.code];

    if (
      !item ||
      !item.inProgress ||
      item.date !==
        getKstDateKey()
    ) {
      return;
    }

    toast(
      `🔁 ${shop.label}\n오늘의 아이템 받기만 재시도합니다.`,
      8000
    );

    await delay(1200);

    const result =
      await claimTodayItem(
        shop,
        true
      );

    const updated =
      getRetries();

    if (
      updated[
        shop.code
      ]
    ) {
      updated[
        shop.code
      ].inProgress =
        false;

      setRetries(updated);
    }

    if (
      result.status ===
        'success' ||
      result.status ===
        'unavailable'
    ) {
      toast(
        `✅ ${shop.label}: 오늘의 아이템 재시도 종료`,
        7000
      );
    }

    const returnUrl =
      item.returnUrl;

    if (
      returnUrl &&
      returnUrl !==
        location.href
    ) {
      await delay(900);

      location.href =
        returnUrl;
    }
  }

  // =====================================================
  // 재시도 타이머
  // =====================================================

  function armRetryTimer() {
    cleanupOldRetries();

    if (
      getMain().active
    ) {
      return;
    }

    const pending =
      Object.entries(
        getRetries()
      )
        .filter(
          ([, item]) =>
            item?.pending &&
            item.date ===
              getKstDateKey()
        )
        .sort(
          (a, b) =>
            a[1].nextAt -
            b[1].nextAt
        )[0];

    if (!pending) {
      return;
    }

    const wait =
      Math.max(
        0,
        pending[1].nextAt -
          Date.now()
      );

    clearTimeout(
      window.__stoveRetryTimer
    );

    window.__stoveRetryTimer =
      setTimeout(
        () =>
          launchDueRetry(),
        Math.min(
          wait,
          2147483647
        )
      );
  }

  function launchDueRetry() {
    if (
      getMain().active
    ) {
      return;
    }

    const due =
      findDueRetry();

    if (!due) {
      armRetryTimer();
      return;
    }

    const [code] = due;

    const shop =
      DAILY_SHOPS.find(
        item =>
          item.code === code
      );

    if (!shop) {
      clearDailyRetry(code);
      return;
    }

    const retries =
      getRetries();

    retries[code] = {
      ...retries[code],
      inProgress: true,
      returnUrl:
        location.href,
    };

    setRetries(retries);

    location.href =
      shop.url;
  }

  // =====================================================
  // Reward 미션 찾기
  // =====================================================

  function findMissionButton(
    title
  ) {
    const nodes =
      [
        ...document.querySelectorAll(
          '*'
        ),
      ].filter(
        el =>
          el.children.length === 0 &&
          el.textContent.trim() ===
            title
      );

    for (
      const node of nodes
    ) {
      let current = node;

      for (
        let i = 0;
        i < 10 &&
        current;
        i++
      ) {
        current =
          current.parentElement;

        if (!current) {
          break;
        }

        const button =
          current.querySelector(
            'button'
          );

        if (button) {
          return button;
        }
      }
    }

    return null;
  }

  function tabButton(text) {
    return (
      [
        ...document.querySelectorAll(
          'button'
        ),
      ].find(
        button =>
          button.innerText.trim() ===
          text
      ) || null
    );
  }

  // =====================================================
  // 샵 → 미션 갱신
  // =====================================================

  async function refreshMissionList() {
    const shop =
      tabButton('샵');

    if (shop) {
      shop.click();

      await delay(1500);
    }

    const mission =
      await waitFor(
        () =>
          tabButton('미션'),
        6000,
        200
      );

    if (mission) {
      mission.click();

      await delay(2500);
    }
  }

  // =====================================================
  // 활성 "받기" 전체 수령
  // =====================================================

  async function collectAllAvailableRewards(
    maxClicks = 60
  ) {
    let total = 0;

    for (
      let i = 0;
      i < maxClicks;
      i++
    ) {
      const button =
        [
          ...document.querySelectorAll(
            'button'
          ),
        ].find(
          btn =>
            !btn.disabled &&
            isVisible(btn) &&
            normalize(
              btn.innerText
            ) === '받기'
        );

      if (!button) {
        break;
      }

      button.scrollIntoView({
        behavior: 'smooth',
        block: 'center',
      });

      await delay(250);

      button.click();

      total++;

      const currentCount =
        (
          getMain()
            .progress
            ?.genericRewardCount ||
          0
        ) + 1;

      patchProgress({
        genericRewardCount:
          currentCount,
      });

      console.log(
        `🎁 활성 [받기] 자동 수령 (${currentCount})`
      );

      await delay(1500);
    }

    return total;
  }

  // =====================================================
  // 인기 게시글 영역
  // =====================================================

  function popularSection() {
    const heading =
      [
        ...document.querySelectorAll(
          '*'
        ),
      ].find(
        el =>
          el.children.length === 0 &&
          el.textContent.trim() ===
            '인기 게시글 보고 플레이크 받기!'
      );

    if (!heading) {
      return null;
    }

    let section = heading;

    for (
      let i = 0;
      i < 10 &&
      section;
      i++
    ) {
      section =
        section.parentElement;

      if (
        section &&
        section.querySelector(
          'a[href*="page.onstove.com"]'
        )
      ) {
        return section;
      }
    }

    return null;
  }

  function isPopularComplete(
    anchor
  ) {
    let card = anchor;

    for (
      let i = 0;
      i < 8 &&
      card;
      i++
    ) {
      const badge =
        card.querySelector(
          '[class*="flakeshop-mission-badge"]'
        );

      if (
        badge &&
        /receive_complete/.test(
          badge.className
        )
      ) {
        return true;
      }

      if (
        /받기 완료|플레이크 받기 완료/.test(
          card.innerText || ''
        )
      ) {
        return true;
      }

      card =
        card.parentElement;
    }

    return false;
  }

  function pendingPopularPosts() {
    const section =
      popularSection();

    if (!section) {
      return [];
    }

    const unique =
      new Map();

    for (
      const anchor of
        section.querySelectorAll(
          'a[href*="page.onstove.com"]'
        )
    ) {
      if (
        !anchor.href ||
        unique.has(
          anchor.href
        ) ||
        isPopularComplete(
          anchor
        )
      ) {
        continue;
      }

      unique.set(
        anchor.href,
        anchor
      );
    }

    return [
      ...unique.values(),
    ].slice(0, 3);
  }

  async function collectPopular() {
    const section =
      popularSection();

    if (!section) {
      return 0;
    }

    let count = 0;

    const buttons =
      [
        ...section.querySelectorAll(
          'button'
        ),
      ].filter(
        btn =>
          !btn.disabled &&
          isVisible(btn) &&
          (
            /플레이크 받기$/.test(
              btn.innerText.trim()
            ) ||
            normalize(
              btn.innerText
            ) === '받기'
          )
      );

    for (
      const button of buttons
    ) {
      button.click();

      count++;

      console.log(
        `🎁 인기 게시글 보상 수령 (${count})`
      );

      await delay(1500);
    }

    return count;
  }

  async function runPopular() {
    const posts =
      pendingPopularPosts();

    if (!posts.length) {
      console.log(
        '⏭️ 인기 게시글 미션: 미완료 게시글 없음'
      );

      return 0;
    }

    console.log(
      `📰 인기 게시글 ${posts.length}/3개 자동 방문`
    );

    for (
      let i = 0;
      i < posts.length;
      i++
    ) {
      const opened =
        GM_openInTab(
          posts[i].href,
          {
            active: false,
            insert: true,
            setParent: true,
          }
        );

      console.log(
        `🔗 ${i + 1}/${posts.length}: ${posts[i].href}`
      );

      await delay(VISIT_WAIT);

      try {
        opened?.close();
      } catch (_) {}

      await delay(400);
    }

    patchProgress({
      popularVisited:
        posts.length,
    });

    await refreshMissionList();

    return collectPopular();
  }

  // =====================================================
  // 라운지 입력
  // =====================================================

  function setTextarea(
    el,
    text
  ) {
    const setter =
      Object
        .getOwnPropertyDescriptor(
          window
            .HTMLTextAreaElement
            .prototype,
          'value'
        )
        .set;

    el.click();
    el.focus();

    setter.call(
      el,
      text
    );

    el.dispatchEvent(
      new Event(
        'input',
        {
          bubbles: true,
        }
      )
    );

    el.dispatchEvent(
      new Event(
        'change',
        {
          bubbles: true,
        }
      )
    );
  }

  function setEditor(
    el,
    text
  ) {
    el.innerHTML =
      '<p><br></p>';

    el.focus();

    const range =
      document.createRange();

    range.selectNodeContents(el);
    range.collapse(false);

    const selection =
      window.getSelection();

    selection.removeAllRanges();
    selection.addRange(range);

    document.execCommand(
      'insertText',
      false,
      text
    );

    el.dispatchEvent(
      new Event(
        'input',
        {
          bubbles: true,
        }
      )
    );
  }

  async function waitAndClick(
    getter,
    label,
    timeout = 10000
  ) {
    const end =
      Date.now() + timeout;

    while (
      Date.now() < end
    ) {
      const el = getter();

      if (
        el &&
        !el.disabled
      ) {
        el.scrollIntoView({
          behavior: 'smooth',
          block: 'center',
        });

        await delay(250);

        el.click();

        console.log(
          `🖱️ 자동 클릭: ${label}`
        );

        return true;
      }

      await delay(250);
    }

    return false;
  }

  async function ensureLoungeEditor() {
    let title =
      document.querySelector(
        'textarea.sc-feed-editor-form-title'
      );

    if (title) {
      return title;
    }

    const writeButton =
      [
        ...document.querySelectorAll(
          'button'
        ),
      ].find(
        button =>
          button.innerText
            .trim()
            .includes('글쓰기')
      );

    if (writeButton) {
      writeButton.click();

      await delay(1200);
    }

    return waitFor(
      () =>
        document.querySelector(
          'textarea.sc-feed-editor-form-title'
        ),
      8000,
      200
    );
  }

  function findCreatedPostNow(
    title
  ) {
    const titleEl =
      [
        ...document.querySelectorAll(
          '.sc-feed-detail-header-title'
        ),
      ].find(
        el =>
          el.innerText.trim() ===
          title
      );

    if (!titleEl) {
      return null;
    }

    return (
      titleEl.closest(
        '.sc-feed'
      ) ||
      titleEl
        .closest(
          '.sc-feed-detail'
        )
        ?.parentElement ||
      null
    );
  }

  // =====================================================
  // 글쓰기
  // =====================================================

  async function fillPost(
    titleText
  ) {
    const title =
      await ensureLoungeEditor();

    if (!title) {
      throw new Error(
        '라운지 글쓰기 제목 입력창을 찾지 못했습니다.'
      );
    }

    setTextarea(
      title,
      titleText
    );

    const body =
      await waitFor(
        () =>
          document.querySelector(
            'div.fr-element.fr-view'
          ),
        10000,
        200
      );

    if (!body) {
      throw new Error(
        '라운지 본문 입력창을 찾지 못했습니다.'
      );
    }

    const submit =
      () =>
        document.querySelector(
          'button.sc-feed-editor-submit-button'
        );

    for (
      let i = 0;
      i < 3;
      i++
    ) {
      setEditor(
        body,
        BODY
      );

      await delay(500);

      if (
        submit() &&
        !submit().disabled
      ) {
        break;
      }
    }

    const posted =
      await waitAndClick(
        submit,
        '글 [등록]'
      );

    if (!posted) {
      throw new Error(
        '글 [등록] 자동 처리에 실패했습니다.'
      );
    }

    patchProgress({
      lounge: {
        ...(
          getMain()
            .progress
            ?.lounge ||
          {}
        ),
        post: true,
      },
    });

    console.log(
      '✍️ 라운지 글쓰기 완료'
    );

    await delay(2500);
  }

  // =====================================================
  // 댓글 + 좋아요
  // =====================================================

  async function fillCommentAndLike(
    titleText
  ) {
    const post =
      await waitFor(
        () =>
          findCreatedPostNow(
            titleText
          ),
        15000,
        400
      );

    if (!post) {
      throw new Error(
        `제목이 "${titleText}"인 방금 작성한 글을 찾지 못했습니다.`
      );
    }

    post.scrollIntoView({
      behavior: 'smooth',
      block: 'center',
    });

    await delay(500);

    const opener =
      post.querySelector(
        '.sc-feed-comment-editor-form-button'
      );

    if (opener) {
      opener.click();
      await delay(1000);
    }

    const editor =
      await waitFor(
        () => {
          for (
            const box of
              post.querySelectorAll(
                '.sc-feed-comment-editor-content'
              )
          ) {
            const ed =
              box.querySelector(
                '.fr-element.fr-view'
              );

            const sub =
              box.querySelector(
                '.sc-feed-comment-editor-submit-button'
              );

            if (
              ed &&
              sub
            ) {
              return {
                ed,
                sub,
              };
            }
          }

          return null;
        },
        10000,
        250
      );

    if (!editor) {
      throw new Error(
        '댓글 입력창을 찾지 못했습니다.'
      );
    }

    setEditor(
      editor.ed,
      COMMENT
    );

    await delay(500);

    const commentOK =
      await waitAndClick(
        () =>
          document.contains(
            editor.sub
          )
            ? editor.sub
            : post.querySelector(
                '.sc-feed-comment-editor-submit-button'
              ),
        '댓글 [등록]'
      );

    if (!commentOK) {
      throw new Error(
        '댓글 [등록] 자동 처리에 실패했습니다.'
      );
    }

    patchProgress({
      lounge: {
        ...(
          getMain()
            .progress
            ?.lounge ||
          {}
        ),
        comment: true,
      },
    });

    console.log(
      `💬 댓글 작성 완료: ${COMMENT}`
    );

    await delay(1000);

    const like =
      post.querySelector(
        '.sc-feed-detail-like-button'
      );

    if (!like) {
      throw new Error(
        '좋아요 버튼을 찾지 못했습니다.'
      );
    }

    const alreadyLiked =
      like.classList.contains(
        'active'
      ) ||
      like.getAttribute(
        'aria-pressed'
      ) === 'true' ||
      /좋아요 취소|좋아요 해제/.test(
        like.innerText.trim()
      );

    if (!alreadyLiked) {
      const likeOK =
        await waitAndClick(
          () =>
            post.querySelector(
              '.sc-feed-detail-like-button'
            ),
          '[좋아요]'
        );

      if (!likeOK) {
        throw new Error(
          '[좋아요] 자동 처리에 실패했습니다.'
        );
      }
    }

    patchProgress({
      lounge: {
        ...(
          getMain()
            .progress
            ?.lounge ||
          {}
        ),
        like: true,
      },
    });

    console.log(
      '👍 좋아요 처리 완료'
    );
  }

  // =====================================================
  // 라운지 미션 남음 확인
  // =====================================================

  function loungeMissionLeft() {
    return LOUNGE_MISSIONS.filter(
      title => {
        const button =
          findMissionButton(
            title
          );

        if (!button) {
          return false;
        }

        const text =
          normalize(
            button.innerText
          );

        return (
          text === '미션하기' ||
          text === '받기'
        );
      }
    );
  }

  // =====================================================
  // Reward 미션
  // =====================================================

  async function runRewardMissions() {
    setMain({
      phase:
        'missions_running',
    });

    toast(
      '▶️ Daily Shop 완료\n플레이크 미션을 자동 진행합니다.',
      9000
    );

    await refreshMissionList();

    let visitCount = 0;

    for (
      const title of
        VISIT_MISSIONS
    ) {
      const button =
        findMissionButton(
          title
        );

      if (!button) {
        continue;
      }

      const text =
        normalize(
          button.innerText
        );

      if (
        text === '미션하기'
      ) {
        button.click();

        visitCount++;

        patchProgress({
          visitMissionCount:
            visitCount,
        });

        console.log(
          `🔗 방문 미션: ${title}`
        );

        await delay(
          VISIT_WAIT
        );
      } else if (
        text === '받기' ||
        /완료/.test(text)
      ) {
        visitCount++;

        patchProgress({
          visitMissionCount:
            visitCount,
        });

        console.log(
          `⏭️ 방문 미션 이미 진행됨: ${title} [${text}]`
        );
      }
    }

    await refreshMissionList();

    // 활성화된 모든 받기
    await collectAllAvailableRewards();

    // 인기 게시글 최대 3개
    await runPopular();

    await delay(1000);

    await collectPopular();

    // 인기 게시글 이후 새로 활성화된 받기
    await collectAllAvailableRewards();

    const left =
      loungeMissionLeft();

    if (!left.length) {
      patchProgress({
        lounge: {
          post: true,
          comment: true,
          like: true,
        },
      });

      await finalizeReward();

      return;
    }

    setMain({
      phase:
        'go_lounge',
    });

    toast(
      '➡️ 라운지로 이동합니다.\n글쓰기 → 댓글 → 좋아요를 자동 처리합니다.',
      9000
    );

    await delay(1000);

    location.href =
      LOUNGE_URL;
  }

  // =====================================================
  // 라운지 자동화
  // =====================================================

  async function runLoungePhase() {
    const state =
      getMain();

    if (
      !state.active ||
      ![
        'go_lounge',
        'lounge_running',
      ].includes(
        state.phase
      )
    ) {
      return;
    }

    setMain({
      phase:
        'lounge_running',
    });

    toast(
      '✍️ 라운지 글쓰기 → 댓글 → 좋아요 자동 처리 중...',
      11000
    );

    const titleText =
      state.postTitle;

    if (!titleText) {
      throw new Error(
        '라운지 게시글 제목 정보가 없습니다.'
      );
    }

    let post =
      findCreatedPostNow(
        titleText
      );

    if (!post) {
      await fillPost(
        titleText
      );

      post =
        await waitFor(
          () =>
            findCreatedPostNow(
              titleText
            ),
          15000,
          400
        );
    }

    if (!post) {
      throw new Error(
        '작성한 게시글을 확인하지 못했습니다.'
      );
    }

    await fillCommentAndLike(
      titleText
    );

    setMain({
      phase:
        'return_reward',
    });

    toast(
      '✅ 라운지 미션 완료\n리워드 페이지로 자동 복귀합니다.',
      7000
    );

    await delay(1200);

    location.href =
      state.rewardUrl ||
      'https://reward.onstove.com/ko/event';
  }

  // =====================================================
  // 최종 보상
  // =====================================================

  async function finalizeReward() {
    const state =
      getMain();

    if (!state.active) {
      return;
    }

    setMain({
      phase:
        'reward_finalize',
    });

    toast(
      '🔄 완료된 미션의 활성 [받기]를 모두 수령합니다.',
      10000
    );

    for (
      let attempt = 1;
      attempt <= 4;
      attempt++
    ) {
      await refreshMissionList();

      await collectPopular();

      await collectAllAvailableRewards();

      const stillLeft =
        loungeMissionLeft();

      if (!stillLeft.length) {
        break;
      }

      console.log(
        `⏳ 라운지 미션 반영 대기 ${attempt}/4`
      );

      await delay(3500);
    }

    await refreshMissionList();

    await collectAllAvailableRewards();

    const finalFlake =
      getFlakeCount();

    const current =
      getMain();

    const overallChange =
      (
        current.drawStartFlake != null &&
        finalFlake != null
      )
        ? finalFlake -
          current.drawStartFlake
        : null;

    setMain({
      active: false,
      phase: 'done',
      finalFlake,
      overallChange,
      finishedAt:
        Date.now(),
    });

    console.log(
      '✅ STOVE 전체 자동화 완료'
    );

    if (
      finalFlake != null
    ) {
      console.log(
        `💰 최종 플레이크: ${finalFlake.toLocaleString()}`
      );
    }

    if (
      overallChange != null
    ) {
      console.log(
        `📊 시작 대비 최종 변화: ${overallChange.toLocaleString()}`
      );
    }

    toast(
      [
        '✅ 전체 자동화 완료',

        `🎯 뽑기: ${(current.drawCost || 0).toLocaleString()} × ${current.drawsCompleted || 0}/${DRAW_COUNT}회`,

        finalFlake != null
          ? `▶️ 최종 플레이크: ${finalFlake.toLocaleString()}`
          : '',

        overallChange != null
          ? `📊 시작 대비 최종 변화: ${overallChange.toLocaleString()}`
          : '',
      ]
        .filter(Boolean)
        .join('\n'),
      20000
    );

    updateDrawPanel();

    armRetryTimer();
  }

  // =====================================================
  // 시작 버튼
  // =====================================================

  function createDrawPanel() {
    if (
      location.hostname !==
        'reward.onstove.com' ||
      !location.pathname.startsWith(
        '/ko/event'
      )
    ) {
      return;
    }

    if (
      document.getElementById(
        '__stove_draw_panel'
      )
    ) {
      return;
    }

    const panel =
      document.createElement(
        'div'
      );

    panel.id =
      '__stove_draw_panel';

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

    for (
      const cost of [
        100,
        1000,
      ]
    ) {
      const button =
        document.createElement(
          'button'
        );

      button.type =
        'button';

      button.dataset.drawCost =
        String(cost);

      button.textContent =
        cost === 100
          ? '100 뽑기'
          : '1,000 뽑기';

      button.style.cssText = [
        'border:0',
        'border-radius:10px',
        'padding:10px 14px',
        'background:#fff',
        'color:#111',
        'font-weight:700',
        'cursor:pointer',
      ].join(';');

      button.addEventListener(
        'click',
        async () => {
          if (
            getMain().active
          ) {
            return;
          }

          clearMain();
          clearStatusLog();

          setMain({
            active: true,
            phase:
              'draw_start',
            drawCost:
              cost,
            drawsCompleted:
              0,
            rewardUrl:
              location.href,
            postTitle:
              makeRunTitle(),
            startedAt:
              Date.now(),

            progress: {
              capsuleRewards:
                {},
              dailyShop:
                {},
              visitMissionCount:
                0,
              popularVisited:
                0,

              lounge: {
                post: false,
                comment: false,
                like: false,
              },

              genericRewardCount:
                0,
            },
          });

          updateDrawPanel();
          renderStatusPanel();

          try {
            await runDrawLoop(
              cost
            );
          } catch (
            error
          ) {
            handleFatal(
              error
            );
          }
        }
      );

      panel.appendChild(
        button
      );
    }

    document.body.appendChild(
      panel
    );

    updateDrawPanel();
  }

  function updateDrawPanel() {
    const panel =
      document.getElementById(
        '__stove_draw_panel'
      );

    if (!panel) {
      return;
    }

    const active =
      Boolean(
        getMain().active
      );

    for (
      const button of
        panel.querySelectorAll(
          'button[data-draw-cost]'
        )
    ) {
      button.disabled =
        active;

      button.style.opacity =
        active
          ? '0.55'
          : '1';

      button.style.cursor =
        active
          ? 'default'
          : 'pointer';
    }
  }

  // =====================================================
  // 오류 처리
  // =====================================================

  function handleFatal(
    error
  ) {
    console.error(
      '❌ STOVE 자동화 오류:',
      error
    );

    setMain({
      active: false,
      phase: 'error',

      error:
        String(
          error?.message ||
          error
        ),
    });

    addStatusLog(
      `❌ ${error?.message || error}`
    );

    toast(
      `❌ 자동화가 중단되었습니다.\n${error?.message || error}`,
      20000
    );

    updateDrawPanel();

    armRetryTimer();
  }

  // =====================================================
  // reward.onstove.com
  // =====================================================

  async function bootReward() {
    createDrawPanel();
    createStatusPanel();
    cleanupOldRetries();

    const state =
      getMain();

    if (!state.active) {
      armRetryTimer();

      if (
        findDueRetry()
      ) {
        launchDueRetry();
      }

      return;
    }

    updateDrawPanel();

    if (
      state.phase ===
      'draw_running'
    ) {
      handleFatal(
        new Error(
          '뽑기 진행 중 페이지가 새로고침되었습니다. 중복 뽑기 방지를 위해 자동화를 중단했습니다.'
        )
      );

      return;
    }

    if (
      state.phase ===
      'capsule_rewards'
    ) {
      await delay(1500);

      await claimCapsuleMilestoneRewards();

      setMain({
        phase: 'daily_shop',
        dailyIndex: 0,
      });

      location.href =
        DAILY_SHOPS[0].url;

      return;
    }

    if (
      [
        'missions_start',
        'missions_running',
      ].includes(
        state.phase
      )
    ) {
      await delay(1500);

      await runRewardMissions();

      return;
    }

    if (
      [
        'return_reward',
        'reward_finalize',
      ].includes(
        state.phase
      )
    ) {
      await delay(1700);

      await finalizeReward();
    }
  }

  // =====================================================
  // Daily Shop 페이지
  // =====================================================

  async function bootDailyShop() {
    createStatusPanel();
    cleanupOldRetries();

    const shop =
      currentDailyShop();

    if (!shop) {
      return;
    }

    const state =
      getMain();

    if (
      state.active &&
      state.phase ===
        'daily_shop'
    ) {
      await runMainDailyShop(
        shop
      );

      return;
    }

    const retryItem =
      getRetries()[
        shop.code
      ];

    if (
      !state.active &&
      retryItem?.inProgress &&
      retryItem.date ===
        getKstDateKey()
    ) {
      await runDailyRetry(
        shop
      );

      armRetryTimer();

      return;
    }

    if (!state.active) {
      armRetryTimer();

      if (
        findDueRetry()
      ) {
        launchDueRetry();
      }
    }
  }

  // =====================================================
  // Lounge 페이지
  // =====================================================

  async function bootLounge() {
    createStatusPanel();
    cleanupOldRetries();

    const state =
      getMain();

    if (
      state.active
    ) {
      await runLoungePhase();
      return;
    }

    armRetryTimer();

    if (
      findDueRetry()
    ) {
      launchDueRetry();
    }
  }

  // =====================================================
  // 시작
  // =====================================================

  async function main() {
    try {
      if (
        location.hostname ===
        'reward.onstove.com'
      ) {
        await bootReward();

      } else if (
        location.hostname ===
        'event.onstove.com'
      ) {
        await bootDailyShop();

      } else if (
        location.hostname ===
        'lounge.onstove.com'
      ) {
        await bootLounge();
      }

    } catch (
      error
    ) {
      handleFatal(error);
    }
  }

  installConsoleStatusCapture();

  createStatusPanel();

  setInterval(
    renderStatusPanel,
    1000
  );

  void main();
})();