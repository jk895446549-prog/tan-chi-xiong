// 贪吃经理排行榜模块
(function () {
  "use strict";

  const cfg = window.CONFIG || {};
  const storageKeys = cfg.STORAGE_KEYS || {};
  const SUPABASE_URL = cfg.SUPABASE_URL || "";
  const SUPABASE_PUBLISHABLE_KEY = cfg.SUPABASE_PUBLISHABLE_KEY || "";
  const LEADERBOARD_TABLE = cfg.LEADERBOARD_TABLE || "leaderboard";
  const LEADERBOARD_PUBLIC_VIEW = cfg.LEADERBOARD_PUBLIC_VIEW || "leaderboard_public";
  const SCORE_SUBMIT_FUNCTION = cfg.SCORE_SUBMIT_FUNCTION || "submit-score";
  const LEADERBOARD_ENDPOINT = SUPABASE_URL ? `${SUPABASE_URL}/rest/v1/${LEADERBOARD_PUBLIC_VIEW}` : "";
  const SCORE_SUBMIT_ENDPOINT = SUPABASE_URL ? `${SUPABASE_URL}/functions/v1/${SCORE_SUBMIT_FUNCTION}` : "";
  const LEADERBOARD_STORAGE_KEY = storageKeys.leaderboardBackup || "greedyManagerLeaderboardLocalBackup";
  const PLAYER_ID_STORAGE_KEY = storageKeys.playerId || "greedyManagerPlayerId";
  const PLAYER_NAME_STORAGE_KEY = storageKeys.playerName || "greedyManagerPlayerName";
  const AUTO_SUBMIT_STORAGE_KEY = storageKeys.autoSubmit || "greedyManagerAutoSubmitBestScore";
  const SUPPRESS_POPUP_STORAGE_KEY = storageKeys.suppressPopup || "greedyManagerSuppressLeaderboardPopup";
  const LAST_SUBMITTED_SCORE_KEY = storageKeys.lastSubmittedScore || "greedyManagerLastSubmittedScore";
  const MAX_PLAYER_NAME_LENGTH = cfg.MAX_PLAYER_NAME_LENGTH || 12;
  const LEADERBOARD_LIMIT = cfg.LEADERBOARD_LIMIT || 20;
  const NICKNAME_CHANGE_COOLDOWN_DAYS = cfg.NICKNAME_CHANGE_COOLDOWN_DAYS || 30;
  const REQUEST_TIMEOUT_MS = cfg.REQUEST_TIMEOUT_MS || 8000;
  const SUBMIT_COOLDOWN_MS = cfg.SUBMIT_COOLDOWN_MS || 5000;
  const LEADERBOARD_CACHE_MS = cfg.LEADERBOARD_CACHE_MS || 15000;
  const PENDING_UPLOAD_STORAGE_KEY = storageKeys.pendingUpload || "greedyManagerPendingLeaderboardUpload";
  const LAST_SUBMIT_AT_STORAGE_KEY = storageKeys.lastSubmitAt || "greedyManagerLastLeaderboardSubmitAt";

  let elements = {};
  let api = {};
  let playerId = getOrCreatePlayerId();
  let playerName = localStorage.getItem(PLAYER_NAME_STORAGE_KEY) || "";
  let lastSubmittedScore = Number(localStorage.getItem(LAST_SUBMITTED_SCORE_KEY) || 0);
  let leaderboardOpenBeforePause = false;
  let lastRenderedRows = [];
  let lastRemoteLoadAt = 0;
  let activeLoadController = null;
  let activeSubmitController = null;
  let submitInFlight = false;
  let focusTimer = null;
  let recordSequenceToken = 0;
  let recordSequenceActive = false;
  let lastRankTransition = null;
  let lastLoadSucceeded = false;
  const recordSequenceWaiters = new Map();

  function init(options) {
    elements = options.elements || {};
    api = options.api || {};
    bindEvents();
    if (elements.playerNameInput) elements.playerNameInput.value = playerName;
    validateConfig();
    loadLeaderboard(false, { silent: true });
    retryPendingUpload({ silent: true });
    window.addEventListener("online", () => retryPendingUpload({ silent: false }));
  }

  function bindTap(button, handler) {
    if (!button) return;
    button.addEventListener("click", handler);
    button.addEventListener(
      "touchstart",
      (e) => {
        e.preventDefault();
        e.stopPropagation();
        handler();
      },
      { passive: false },
    );
  }

  function bindEvents() {
    bindTap(elements.leaderboardBtn, () => openLeaderboard("manual"));
    bindTap(elements.leaderboardCloseBtn, closeLeaderboard);
    bindTap(elements.submitScoreBtn, () => submitCurrentScore(true));

    if (elements.leaderboardModal) {
      elements.leaderboardModal.addEventListener("click", (e) => {
        if (e.target === elements.leaderboardModal) closeLeaderboard();
      });
    }

    if (elements.leaderboardList) {
      ["wheel", "touchstart", "touchmove", "touchend"].forEach((eventName) => {
        elements.leaderboardList.addEventListener(
          eventName,
          (e) => e.stopPropagation(),
          { passive: true },
        );
      });
    }

    document.addEventListener("keydown", (e) => {
      if (!isLeaderboardOpen() || isTypingTarget(e.target)) return;
      if (e.key === "Escape" && !recordSequenceActive) {
        e.preventDefault();
        closeLeaderboard();
        return;
      }

      const scrollAmounts = {
        ArrowDown: 52,
        ArrowUp: -52,
        PageDown: Math.max(120, elements.leaderboardList ? elements.leaderboardList.clientHeight * 0.8 : 240),
        PageUp: -Math.max(120, elements.leaderboardList ? elements.leaderboardList.clientHeight * 0.8 : 240),
        Home: -Infinity,
        End: Infinity,
      };
      if (!Object.prototype.hasOwnProperty.call(scrollAmounts, e.key) || !elements.leaderboardList) return;
      e.preventDefault();
      const amount = scrollAmounts[e.key];
      elements.leaderboardList.scrollTop = amount === Infinity
        ? elements.leaderboardList.scrollHeight
        : amount === -Infinity
          ? 0
          : elements.leaderboardList.scrollTop + amount;
    });

    if (elements.playerNameInput) {
      elements.playerNameInput.value = playerName;
      ["touchstart", "touchmove", "touchend", "pointerdown", "pointerup", "click"].forEach((eventName) => {
        elements.playerNameInput.addEventListener(eventName, (e) => e.stopPropagation(), {
          passive: eventName === "touchmove",
        });
      });
      elements.playerNameInput.addEventListener("input", () => {
        elements.playerNameInput.value = sanitizePlayerName(elements.playerNameInput.value);
      });
    }

    if (elements.autoSubmitBestScoreCheckbox) {
      elements.autoSubmitBestScoreCheckbox.checked = localStorage.getItem(AUTO_SUBMIT_STORAGE_KEY) !== "0";
      elements.autoSubmitBestScoreCheckbox.addEventListener("change", () => {
        localStorage.setItem(AUTO_SUBMIT_STORAGE_KEY, elements.autoSubmitBestScoreCheckbox.checked ? "1" : "0");
      });
    }

    if (elements.suppressLeaderboardPopupCheckbox) {
      elements.suppressLeaderboardPopupCheckbox.checked = localStorage.getItem(SUPPRESS_POPUP_STORAGE_KEY) === "1";
      elements.suppressLeaderboardPopupCheckbox.addEventListener("change", () => {
        localStorage.setItem(SUPPRESS_POPUP_STORAGE_KEY, elements.suppressLeaderboardPopupCheckbox.checked ? "1" : "0");
      });
    }
  }

  function getOrCreatePlayerId() {
    let id = localStorage.getItem(PLAYER_ID_STORAGE_KEY);
    if (!id) {
      id = window.crypto && crypto.randomUUID ? crypto.randomUUID() : `player_${Date.now()}_${Math.random().toString(16).slice(2)}`;
      localStorage.setItem(PLAYER_ID_STORAGE_KEY, id);
    }
    return id;
  }

  function sanitizePlayerName(name) {
    return String(name || "")
      .normalize("NFKC")
      .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060\ufeff]/g, "")
      .trim()
      .replace(/\s+/g, " ")
      .replace(/[^\p{Script=Han}A-Za-z0-9_· .-]/gu, "")
      .slice(0, MAX_PLAYER_NAME_LENGTH);
  }

  function validatePlayerName(name) {
    const clean = sanitizePlayerName(name);
    if (!clean) return "先取一个昵称，才能提交排行榜。";
    if (clean.length > MAX_PLAYER_NAME_LENGTH) return `昵称不能超过 ${MAX_PLAYER_NAME_LENGTH} 个字符。`;
    if (/^(管理员|系统|官方|admin|administrator|system|official)$/i.test(clean)) return "这个昵称不能使用，请换一个。";
    if (/(https?:\/\/|www\.|@|微信|vx|v信|qq|群|加我|联系)/i.test(clean)) return "昵称不能包含网址或联系方式。";
    if (/(傻逼|操你|妈的|草泥马|垃圾游戏|妈妈|爸爸|父亲|鸡巴)/i.test(clean)) return "昵称包含不合适的内容，请修改。";
    return "";
  }

  function savePlayerName() {
    const cleanName = sanitizePlayerName(elements.playerNameInput ? elements.playerNameInput.value : playerName);
    const validationError = validatePlayerName(cleanName);
    if (validationError) {
      showLeaderboardToast(validationError, true);
      return false;
    }
    playerName = cleanName;
    if (elements.playerNameInput) elements.playerNameInput.value = playerName;
    localStorage.setItem(PLAYER_NAME_STORAGE_KEY, playerName);
    return true;
  }

  function isAutoSubmitEnabled() {
    return !elements.autoSubmitBestScoreCheckbox || elements.autoSubmitBestScoreCheckbox.checked;
  }

  function isSuppressLeaderboardPopupEnabled() {
    return Boolean(elements.suppressLeaderboardPopupCheckbox && elements.suppressLeaderboardPopupCheckbox.checked);
  }

  function isTypingTarget(target) {
    return Boolean(target && target.closest && target.closest("input, textarea, select"));
  }

  function isLeaderboardOpen() {
    return Boolean(
      elements.leaderboardModal &&
      elements.leaderboardModal.style.display === "flex",
    );
  }

  function isInputCaptured() {
    return isLeaderboardOpen() || recordSequenceActive;
  }

  function getBestScoreToSubmit() {
    const bestScore = Number(api.getBestScore ? api.getBestScore() : 0);
    const score = Number(api.getCurrentScore ? api.getCurrentScore() : 0);
    return Math.max(bestScore, score, 0);
  }

  function getProofChecksumSource(proof) {
    const events = Array.isArray(proof && proof.events) ? proof.events : [];
    return [
      proof.seed,
      proof.duration_ms,
      proof.gameTime,
      proof.foods,
      proof.boss,
      proof.coffee,
      proof.version,
      events.map((event) => `${event.t},${event.type},${event.m},${event.p}`).join(";"),
    ].join("|");
  }

  function fnv1a32(value) {
    let hash = 0x811c9dc5;
    const textValue = String(value || "");
    for (let i = 0; i < textValue.length; i += 1) {
      hash ^= textValue.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
  }

  function prepareRunProof(proof) {
    if (!proof || typeof proof !== "object") return null;
    const prepared = {
      seed: Number(proof.seed),
      duration_ms: Number(proof.duration_ms),
      gameTime: Number(proof.gameTime),
      foods: Number(proof.foods),
      boss: Number(proof.boss),
      coffee: Number(proof.coffee),
      version: String(proof.version || ""),
      events: Array.isArray(proof.events) ? proof.events : [],
    };
    prepared.crc = fnv1a32(getProofChecksumSource(prepared));
    return prepared;
  }

  function openLeaderboard(reason = "manual", options = {}) {
    if (!isLeaderboardOpen()) {
      leaderboardOpenBeforePause = Boolean(api.isGamePaused && api.isGamePaused());
      if (
        api.isGameStarted && api.isGameStarted() &&
        !(api.isGameOver && api.isGameOver()) &&
        !(api.isDeathPending && api.isDeathPending()) &&
        !(api.isGamePaused && api.isGamePaused())
      ) {
        api.togglePause && api.togglePause();
      }
    }

    if (elements.leaderboardModal) {
      elements.leaderboardModal.style.display = "flex";
      elements.leaderboardModal.setAttribute("aria-hidden", "false");
    }
    document.body.classList.add("leaderboardOpen");
    if (elements.playerNameInput) elements.playerNameInput.value = playerName;
    clearLeaderboardToast();
    if (elements.leaderboardList && !options.preserveScroll) {
      elements.leaderboardList.scrollTop = 0;
    }
    if (!options.skipLoad) loadLeaderboard(reason === "manual");

    if (!options.skipFocus) {
      if (focusTimer !== null) clearTimeout(focusTimer);
      focusTimer = setTimeout(() => {
        focusTimer = null;
        if (elements.leaderboardModal && elements.leaderboardModal.style.display === "flex" && !playerName && elements.playerNameInput) {
          elements.playerNameInput.focus({ preventScroll: true });
        }
      }, 120);
    }
  }

  function closeLeaderboard(options = {}) {
    if (recordSequenceActive && !options.force) return;
    const wasOpen = isLeaderboardOpen();
    if (focusTimer !== null) {
      clearTimeout(focusTimer);
      focusTimer = null;
    }
    if (elements.leaderboardModal) {
      elements.leaderboardModal.style.display = "none";
      elements.leaderboardModal.setAttribute("aria-hidden", "true");
    }
    document.body.classList.remove("leaderboardOpen");
    restoreLeaderboardInteraction();
    if (
      api.isGameStarted && api.isGameStarted() &&
      !(api.isGameOver && api.isGameOver()) &&
      api.isGamePaused && api.isGamePaused() &&
      !leaderboardOpenBeforePause
    ) {
      api.togglePause && api.togglePause();
    }
    leaderboardOpenBeforePause = false;
    if (wasOpen && api.onLeaderboardClosed) api.onLeaderboardClosed();
  }

  function handleGameOverLeaderboard(details = {}) {
    const bestScore = Number(api.getBestScore ? api.getBestScore() : 0);
    if (bestScore <= 0) return;
    if (details.isNewRecord) {
      runNewRecordSequence(details);
      return;
    }
    if (isAutoSubmitEnabled() && playerName) submitCurrentScore(false);
    if (!isSuppressLeaderboardPopupEnabled()) openLeaderboard("gameover");
  }

  function setRecordOverlayVisible(visible, oldScore = 0, newScore = 0) {
    if (elements.newRecordOldScore) elements.newRecordOldScore.textContent = String(oldScore);
    if (elements.newRecordBestScore) elements.newRecordBestScore.textContent = String(newScore);
    if (!elements.newRecordOverlay) return;
    elements.newRecordOverlay.style.display = visible ? "flex" : "none";
    elements.newRecordOverlay.setAttribute("aria-hidden", visible ? "false" : "true");
  }

  function lockLeaderboardInteraction() {
    if (elements.leaderboardCard) elements.leaderboardCard.classList.add("recordSequence");
    if (elements.leaderboardCloseBtn) elements.leaderboardCloseBtn.disabled = true;
    if (elements.submitScoreBtn) elements.submitScoreBtn.disabled = true;
  }

  function restoreLeaderboardInteraction() {
    if (elements.leaderboardCard) elements.leaderboardCard.classList.remove("recordSequence");
    if (elements.leaderboardCloseBtn) elements.leaderboardCloseBtn.disabled = false;
    if (elements.submitScoreBtn) elements.submitScoreBtn.disabled = submitInFlight;
    const mine = elements.leaderboardList && elements.leaderboardList.querySelector(".leaderboardItem.mine");
    if (mine) {
      mine.classList.remove("leaderboardRankRise", "leaderboardRankPulse");
      mine.style.removeProperty("--rank-shift");
    }
  }

  function waitForRecordSequence(ms, token) {
    return new Promise((resolve) => {
      const timerId = setTimeout(() => {
        recordSequenceWaiters.delete(timerId);
        resolve(token === recordSequenceToken);
      }, ms);
      recordSequenceWaiters.set(timerId, resolve);
    });
  }

  function clearRecordSequenceWaiters() {
    recordSequenceWaiters.forEach((resolve, timerId) => {
      clearTimeout(timerId);
      resolve(false);
    });
    recordSequenceWaiters.clear();
  }

  function locatePlayer(behavior = "smooth") {
    if (!elements.leaderboardList) return null;
    const mine = elements.leaderboardList.querySelector(".leaderboardItem.mine");
    if (!mine) return null;
    scrollLeaderboardTo(getCenteredScrollTop(mine), behavior);
    return mine;
  }

  function getCenteredScrollTop(item) {
    if (!item || !elements.leaderboardList) return 0;
    const itemTop = getItemScrollOffset(item);
    const maxScrollTop = Math.max(
      0,
      elements.leaderboardList.scrollHeight - elements.leaderboardList.clientHeight,
    );
    const targetTop = Math.min(
      maxScrollTop,
      Math.max(
        0,
        itemTop - elements.leaderboardList.clientHeight / 2 + item.offsetHeight / 2,
      ),
    );
    return targetTop;
  }

  function scrollLeaderboardTo(targetTop, behavior = "smooth") {
    if (!elements.leaderboardList) return;
    if (typeof elements.leaderboardList.scrollTo === "function") {
      elements.leaderboardList.scrollTo({ top: targetTop, behavior });
    } else {
      elements.leaderboardList.scrollTop = targetTop;
    }
  }

  function getItemScrollOffset(item) {
    if (!item || !elements.leaderboardList) return 0;
    const listRect = elements.leaderboardList.getBoundingClientRect();
    const itemRect = item.getBoundingClientRect();
    return itemRect.top - listRect.top + elements.leaderboardList.scrollTop;
  }

  function playRankRiseAnimation(oldRank, newRank, oldOffsetTop = null) {
    if (!newRank) return;
    const mine = elements.leaderboardList && elements.leaderboardList.querySelector(".leaderboardItem.mine");
    if (!mine) return;
    mine.classList.remove("leaderboardRankPulse", "leaderboardRankRise");
    // 必须在 transform 动画生效前计算最终滚动目标，否则会误用旧排名的视觉坐标。
    const finalTargetTop = getCenteredScrollTop(mine);
    if (oldRank && newRank >= oldRank) {
      void mine.offsetWidth;
      mine.classList.add("leaderboardRankPulse");
      scrollLeaderboardTo(finalTargetTop, "smooth");
      return;
    }
    const rankGain = oldRank && newRank ? oldRank - newRank : 2;
    const newOffsetTop = getItemScrollOffset(mine);
    const measuredShift = Number.isFinite(oldOffsetTop)
      ? oldOffsetTop - newOffsetTop
      : rankGain * 54;
    mine.style.setProperty(
      "--rank-shift",
      `${Math.max(70, measuredShift)}px`,
    );
    void mine.offsetWidth;
    mine.classList.add("leaderboardRankRise");
    scrollLeaderboardTo(finalTargetTop, "smooth");
  }

  async function runNewRecordSequence(details) {
    resetTransientState({ keepModal: true });
    const token = ++recordSequenceToken;
    recordSequenceActive = true;
    lockLeaderboardInteraction();
    setRecordOverlayVisible(true, details.previousBestScore, details.newBestScore);

    if (!(await waitForRecordSequence(1450, token))) return;
    setRecordOverlayVisible(false);
    openLeaderboard("record", { skipLoad: true, skipFocus: true });
    lockLeaderboardInteraction();

    lastRankTransition = null;
    await loadLeaderboard(false, { force: true, simplifiedFailure: true });
    if (token !== recordSequenceToken) return;
    if (!playerName) {
      finishRecordSequenceWithFailure("请输入昵称");
      return;
    }
    if (!lastLoadSucceeded || !isAutoSubmitEnabled()) {
      finishRecordSequenceWithFailure();
      return;
    }

    const currentRankRow = locatePlayer("smooth");
    const currentRankOffset = currentRankRow
      ? getItemScrollOffset(currentRankRow)
      : elements.leaderboardList
        ? elements.leaderboardList.scrollHeight
        : null;
    if (!currentRankRow && elements.leaderboardList) {
      const bottom = elements.leaderboardList.scrollHeight;
      if (typeof elements.leaderboardList.scrollTo === "function") {
        elements.leaderboardList.scrollTo({ top: bottom, behavior: "smooth" });
      } else {
        elements.leaderboardList.scrollTop = bottom;
      }
    }
    if (!(await waitForRecordSequence(350, token))) return;

    showLeaderboardToast("正在上传新纪录...", false);
    const submission = await submitCurrentScore(false, {
      deferRender: true,
      simplifiedFailure: true,
    });
    if (token !== recordSequenceToken) return;
    if (!submission || !lastRankTransition || !lastRankTransition.afterRows) {
      finishRecordSequenceWithFailure();
      return;
    }

    const transition = lastRankTransition || {};
    renderLeaderboard(transition.afterRows, false);
    playRankRiseAnimation(
      transition.oldRank,
      transition.newRank,
      currentRankOffset,
    );
    if (!(await waitForRecordSequence(1150, token))) return;

    recordSequenceActive = false;
    restoreLeaderboardInteraction();
    // 动画对象清理后再做一次无动画定位，确保最终定格在最新排名。
    locatePlayer("auto");
    showLeaderboardToast(
      buildRankToast(transition.oldRank, transition.newRank, true),
      false,
    );
    // 新纪录流程结束后保留排行榜，玩家可查看排名并自行关闭。
  }

  function finishRecordSequenceWithFailure(message = "上传失败") {
    recordSequenceActive = false;
    restoreLeaderboardInteraction();
    showLeaderboardToast(message, true);
  }

  function resetTransientState(options = {}) {
    recordSequenceToken += 1;
    recordSequenceActive = false;
    clearRecordSequenceWaiters();
    setRecordOverlayVisible(false);
    restoreLeaderboardInteraction();
    lastRankTransition = null;
    if (activeLoadController) {
      activeLoadController.__abortReason = "reset";
      activeLoadController.abort();
      activeLoadController = null;
    }
    if (activeSubmitController) {
      activeSubmitController.__abortReason = "reset";
      activeSubmitController.abort();
      activeSubmitController = null;
    }
    if (!options.keepModal) closeLeaderboard({ force: true });
  }

  function showLeaderboardToast(text, isError = false) {
    if (!elements.leaderboardToast) return;
    elements.leaderboardToast.textContent = text || "";
    elements.leaderboardToast.style.color = isError ? "#ff8585" : "#ffdf6e";
    elements.leaderboardToast.style.opacity = text ? "1" : "0";
  }

  function clearLeaderboardToast() {
    showLeaderboardToast("");
  }

  function renderLoadingState() {
    if (!elements.leaderboardList) return;
    elements.leaderboardList.innerHTML = `<div class="leaderboardState">🏆 正在加载排行榜...</div>`;
  }

  function renderErrorState() {
    if (!elements.leaderboardList) return;
    elements.leaderboardList.innerHTML = `<div class="leaderboardState">⚠ 排行榜加载失败<br><span class="leaderboardRetry">点击重试</span></div>`;
    const retry = elements.leaderboardList.querySelector(".leaderboardRetry");
    if (retry) retry.addEventListener("click", () => loadLeaderboard(false));
  }

  function renderEmptyState() {
    if (!elements.leaderboardList) return;
    elements.leaderboardList.innerHTML = `<div class="leaderboardState">🏆<br>还没有人上榜<br>快成为第一名吧！</div>`;
  }

  function sortRows(rows) {
    return (rows || [])
      .filter((item) => item && Number.isFinite(Number(item.score)))
      .sort((a, b) => {
        const scoreDiff = Number(b.score) - Number(a.score);
        if (scoreDiff !== 0) return scoreDiff;
        return new Date(a.updatedAt || a.updated_at || 0) - new Date(b.updatedAt || b.updated_at || 0);
      })
      .slice(0, LEADERBOARD_LIMIT);
  }

  function renderLeaderboard(rows = [], pulseMine = false) {
    if (!elements.leaderboardList) return;
    const sortedRows = sortRows(rows);
    lastRenderedRows = sortedRows;

    if (sortedRows.length === 0) {
      renderEmptyState();
      return;
    }

    elements.leaderboardList.innerHTML = sortedRows
      .map((item, index) => {
        const itemName = item.nickname || item.name || "匿名打工人";
        const isMine = Boolean(playerName) && itemName.toLocaleLowerCase() === playerName.toLocaleLowerCase();
        const rank = index + 1;
        const medal = rank === 1 ? "🥇" : rank === 2 ? "🥈" : rank === 3 ? "🥉" : rank;
        return `<div class="leaderboardItem ${isMine ? "mine" : ""} ${isMine && pulseMine ? "leaderboardRankPulse" : ""}">
          <div class="leaderboardRank">${medal}</div>
          <div class="leaderboardName">${escapeHtml(itemName)}${isMine ? '<span class="leaderboardMeTag">👈你</span>' : ""}</div>
          <div class="leaderboardScore">${Number(item.score) || 0}</div>
        </div>`;
      })
      .join("");
  }

  function getRankFromRows(rows) {
    const sorted = sortRows(rows);
    const index = sorted.findIndex((item) => {
      const itemName = item.nickname || item.name || "";
      return Boolean(playerName) && itemName.toLocaleLowerCase() === playerName.toLocaleLowerCase();
    });
    return index >= 0 ? index + 1 : null;
  }

  function buildRankToast(oldRank, newRank, didScoreUpdate) {
    if (!didScoreUpdate) return "✅ 已更新排行榜";
    if (newRank === 1) return "👑 恭喜登顶排行榜！";
    if (newRank && oldRank && newRank < oldRank) return `🎉 排名提升至第 ${newRank} 名！`;
    if (newRank && !oldRank) return `🎉 成功上榜，第 ${newRank} 名！`;
    if (newRank && newRank <= 3) return `🥉 排名提升至第 ${newRank} 名！`;
    return "✅ 已刷新历史最高分";
  }

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function validateConfig() {
    const problems = [];
    if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(SUPABASE_URL)) problems.push("SUPABASE_URL");
    if (!SUPABASE_PUBLISHABLE_KEY || !SUPABASE_PUBLISHABLE_KEY.startsWith("sb_publishable_")) problems.push("SUPABASE_PUBLISHABLE_KEY");
    if (!LEADERBOARD_PUBLIC_VIEW) problems.push("LEADERBOARD_PUBLIC_VIEW");
    if (!SCORE_SUBMIT_FUNCTION) problems.push("SCORE_SUBMIT_FUNCTION");
    if (problems.length) console.error("排行榜配置异常:", problems.join(", "));
    return problems.length === 0;
  }

  function getPendingUpload() {
    try { return JSON.parse(localStorage.getItem(PENDING_UPLOAD_STORAGE_KEY) || "null"); } catch (e) { return null; }
  }

  function savePendingUpload(payload) {
    localStorage.setItem(PENDING_UPLOAD_STORAGE_KEY, JSON.stringify({ ...payload, savedAt: Date.now() }));
  }

  function clearPendingUpload() {
    localStorage.removeItem(PENDING_UPLOAD_STORAGE_KEY);
  }

  function getSubmitCooldownRemaining() {
    const lastAt = Number(localStorage.getItem(LAST_SUBMIT_AT_STORAGE_KEY) || 0);
    return Math.max(0, SUBMIT_COOLDOWN_MS - (Date.now() - lastAt));
  }

  async function retryPendingUpload(options = {}) {
    const pending = getPendingUpload();
    if (!pending || !navigator.onLine || submitInFlight) return false;
    if (!options.silent) showLeaderboardToast("网络已恢复，正在补传最高分...", false);
    const oldName = playerName;
    playerName = sanitizePlayerName(pending.nickname || oldName);
    if (elements.playerNameInput) elements.playerNameInput.value = playerName;
    try {
      const success = await submitScoreValue(Number(pending.score || 0), {
        manual: false,
        isRetry: true,
        proof: pending.proof || null,
      });
      if (!success) return false;
      clearPendingUpload();
      if (!options.silent) showLeaderboardToast("✅ 最高分已自动补传", false);
      return true;
    } catch (e) {
      console.warn("待上传成绩补传失败", e);
      playerName = oldName;
      return false;
    }
  }

  function getSupabaseHeaders(extra = {}) {
    return {
      apikey: SUPABASE_PUBLISHABLE_KEY,
      Authorization: `Bearer ${SUPABASE_PUBLISHABLE_KEY}`,
      "Content-Type": "application/json",
      ...extra,
    };
  }

  async function supabaseRequest(url, options = {}) {
    if (!validateConfig() || !LEADERBOARD_ENDPOINT) throw new Error("排行榜云配置缺失");
    const controller = options.controller || new AbortController();
    const timer = setTimeout(() => {
      controller.__abortReason = "timeout";
      controller.abort();
    }, REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        ...options,
        controller: undefined,
        signal: controller.signal,
        headers: getSupabaseHeaders(options.headers || {}),
      });
      if (!res.ok) {
        let message = `${res.status}`;
        let code = "";
        try {
          const data = await res.json();
          message = data.message || data.details || message;
          code = data.code || "";
        } catch (e) {}
        const error = new Error(message);
        error.status = res.status;
        error.code = code;
        throw error;
      }
      if (res.status === 204) return null;
      return res.json().catch(() => null);
    } catch (e) {
      const abortReason = controller.__abortReason || controller.signal.reason;
      if (controller.signal.aborted && abortReason !== "timeout") {
        const cancelledError = new Error("请求已取消");
        cancelledError.code = "REQUEST_CANCELLED";
        throw cancelledError;
      }
      if (controller.signal.aborted || (e && e.name === "AbortError")) {
        const timeoutError = new Error("请求超时，请检查网络后重试");
        timeoutError.code = "REQUEST_TIMEOUT";
        throw timeoutError;
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  function encodeFilterValue(value) {
    return encodeURIComponent(String(value).replace(/"/g, '\\"'));
  }

  async function loadLeaderboard(manual = false, options = {}) {
    const cacheFresh = lastRenderedRows.length > 0 && Date.now() - lastRemoteLoadAt < LEADERBOARD_CACHE_MS;
    if (cacheFresh && !options.force) {
      lastLoadSucceeded = true;
      renderLeaderboard(lastRenderedRows);
      return lastRenderedRows;
    }
    if (!options.silent) renderLoadingState();
    if (activeLoadController) {
      activeLoadController.__abortReason = "replaced";
      activeLoadController.abort();
    }
    const loadController = new AbortController();
    activeLoadController = loadController;
    try {
      const rows = await fetchRemoteLeaderboard(loadController);
      lastLoadSucceeded = true;
      lastRemoteLoadAt = Date.now();
      renderLeaderboard(rows);
      saveLocalLeaderboardRows(rows);
      if (manual) showLeaderboardToast("联网排行榜已更新。", false);
      return rows;
    } catch (e) {
      lastLoadSucceeded = false;
      if (e && (e.name === "AbortError" || e.code === "REQUEST_CANCELLED")) return lastRenderedRows;
      console.warn("排行榜读取失败", e);
      const backupRows = getLocalLeaderboardRows();
      if (options.simplifiedFailure) {
        if (backupRows.length > 0) {
          renderLeaderboard(backupRows);
        } else if (elements.leaderboardList) {
          elements.leaderboardList.innerHTML = `<div class="leaderboardState">上传失败</div>`;
        }
        showLeaderboardToast("上传失败", true);
        return backupRows;
      }
      if (backupRows.length > 0) {
        renderLeaderboard(backupRows);
        showLeaderboardToast("联网排行榜读取失败，已显示本机备份榜。", true);
      } else {
        renderErrorState();
        showLeaderboardToast("联网排行榜读取失败。", true);
      }
      return backupRows;
    } finally {
      if (activeLoadController === loadController) activeLoadController = null;
    }
  }

  async function submitCurrentScore(manual = false, options = {}) {
    const scoreToSubmit = getBestScoreToSubmit();
    if (scoreToSubmit <= 0) {
      if (manual) showLeaderboardToast("还没有有效最高分。", true);
      return;
    }
    const pendingName = sanitizePlayerName(
      elements.playerNameInput ? elements.playerNameInput.value : playerName,
    );
    if (options.simplifiedFailure && !pendingName) {
      showLeaderboardToast("请输入昵称", true);
      return false;
    }
    if (!savePlayerName()) {
      if (options.simplifiedFailure) showLeaderboardToast("上传失败", true);
      return false;
    }
    const remaining = getSubmitCooldownRemaining();
    if (remaining > 0 && manual) {
      showLeaderboardToast(`提交太频繁，请 ${Math.ceil(remaining / 1000)} 秒后再试。`, true);
      return;
    }
    return submitScoreValue(scoreToSubmit, { manual, ...options });
  }

  async function submitScoreValue(
    scoreToSubmit,
    {
      manual = false,
      isRetry = false,
      deferRender = false,
      simplifiedFailure = false,
      proof = null,
    } = {},
  ) {
    if (submitInFlight) return false;
    submitInFlight = true;
    if (elements.submitScoreBtn) elements.submitScoreBtn.disabled = true;
    if (!isRetry) localStorage.setItem(LAST_SUBMIT_AT_STORAGE_KEY, String(Date.now()));

    const beforeRows = lastRenderedRows.length
      ? lastRenderedRows
      : await fetchRemoteLeaderboard().catch(() => getLocalLeaderboardRows());
    const oldRank = getRankFromRows(beforeRows);
    const runProof = prepareRunProof(
      proof || (api.getRunProof ? api.getRunProof() : null),
    );

    try {
      const result = await edgeFunctionRequest({
        device_id: playerId,
        nickname: playerName,
        score: Math.floor(Number(scoreToSubmit) || 0),
        proof: runProof,
      });

      if (result && result.nickname) {
        playerName = sanitizePlayerName(result.nickname);
        if (elements.playerNameInput) elements.playerNameInput.value = playerName;
        localStorage.setItem(PLAYER_NAME_STORAGE_KEY, playerName);
      }

      clearPendingUpload();
      lastSubmittedScore = Math.max(lastSubmittedScore, scoreToSubmit);
      localStorage.setItem(LAST_SUBMITTED_SCORE_KEY, String(lastSubmittedScore));

      const rows = await fetchRemoteLeaderboard();
      lastRemoteLoadAt = Date.now();
      if (!deferRender) renderLeaderboard(rows, true);
      saveLocalLeaderboardRows(rows);
      const newRank = getRankFromRows(rows);
      lastRankTransition = {
        oldRank,
        newRank,
        beforeRows,
        afterRows: rows,
      };

      if (deferRender) {
        // 新纪录演出会在旧排名定位完成后自行渲染最新榜单。
      } else if (result && result.updated === false) {
        showLeaderboardToast(result.message || "历史最高分未突破，本次未更新排行榜", false);
      } else if (result && result.nickname_changed && !result.score_updated) {
        showLeaderboardToast("✅ 昵称已更新", false);
      } else {
        showLeaderboardToast(buildRankToast(oldRank, newRank, true), false);
      }
      return { success: true, oldRank, newRank };
    } catch (e) {
      console.warn("分数提交失败", e);
      const errorCode = e && e.code ? String(e.code) : "";
      if (errorCode === "REQUEST_CANCELLED") return false;
      if (simplifiedFailure) {
        showLeaderboardToast("上传失败", true);
        return false;
      }
      if (errorCode === "NICKNAME_CONFLICT") {
        showLeaderboardToast("昵称已被占用，请换一个昵称。", true);
        return false;
      }
      if (errorCode === "NICKNAME_COOLDOWN") {
        showLeaderboardToast(e.message || "昵称 30 天只能修改一次。", true);
        return false;
      }
      if (errorCode === "RATE_LIMITED") {
        showLeaderboardToast(e.message || "提交太频繁，请稍后再试。", true);
        return false;
      }
      if (errorCode === "INVALID_NICKNAME" || errorCode === "INVALID_SCORE") {
        showLeaderboardToast(e.message || "提交内容不符合规则。", true);
        return false;
      }

      if (errorCode === "INVALID_PROOF" || errorCode === "CHEAT_DETECTED") {
        showLeaderboardToast(e.message || "成绩校验未通过。", true);
        return false;
      }

      savePendingUpload({
        device_id: playerId,
        nickname: playerName,
        score: scoreToSubmit,
        proof: runProof,
      });
      saveLocalLeaderboardScore({
        playerId,
        device_id: playerId,
        name: playerName,
        nickname: playerName,
        score: scoreToSubmit,
        updatedAt: Date.now(),
        updated_at: new Date().toISOString(),
      });
      const localRows = getLocalLeaderboardRows();
      renderLeaderboard(localRows, true);
      lastRankTransition = {
        oldRank,
        newRank: getRankFromRows(localRows),
      };
      showLeaderboardToast(
        errorCode === "REQUEST_TIMEOUT"
          ? "提交超时，已保存，联网后会自动补传。"
          : "联网提交失败，已保存，联网后会自动补传。",
        true,
      );
      return false;
    } finally {
      submitInFlight = false;
      if (elements.submitScoreBtn) elements.submitScoreBtn.disabled = false;
    }
  }

  async function edgeFunctionRequest(payload) {
    if (!validateConfig() || !SCORE_SUBMIT_ENDPOINT) {
      const error = new Error("排行榜云函数配置缺失");
      error.code = "CONFIG_ERROR";
      throw error;
    }

    const controller = new AbortController();
    activeSubmitController = controller;
    const timer = setTimeout(() => {
      controller.__abortReason = "timeout";
      controller.abort();
    }, REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(SCORE_SUBMIT_ENDPOINT, {
        method: "POST",
        signal: controller.signal,
        headers: getSupabaseHeaders(),
        body: JSON.stringify(payload),
      });

      let data = null;
      try { data = await res.json(); } catch (e) {}
      if (!res.ok || (data && data.ok === false)) {
        const error = new Error((data && data.message) || `提交失败（${res.status}）`);
        error.status = res.status;
        error.code = (data && data.code) || `HTTP_${res.status}`;
        throw error;
      }
      return data || { ok: true };
    } catch (e) {
      const abortReason = controller.__abortReason || controller.signal.reason;
      if (controller.signal.aborted && abortReason !== "timeout") {
        const cancelledError = new Error("请求已取消");
        cancelledError.code = "REQUEST_CANCELLED";
        throw cancelledError;
      }
      if (controller.signal.aborted || (e && e.name === "AbortError")) {
        const timeoutError = new Error("请求超时，请检查网络后重试");
        timeoutError.code = "REQUEST_TIMEOUT";
        throw timeoutError;
      }
      throw e;
    } finally {
      clearTimeout(timer);
      if (activeSubmitController === controller) activeSubmitController = null;
    }
  }

  async function fetchRemoteLeaderboard(controller = null) {
    const url = `${LEADERBOARD_ENDPOINT}?select=nickname,score,updated_at&order=score.desc,updated_at.asc&limit=${LEADERBOARD_LIMIT}`;
    const data = await supabaseRequest(url, { method: "GET", controller });
    return (Array.isArray(data) ? data : []).map((row) => ({
      name: row.nickname,
      nickname: row.nickname,
      score: row.score,
      updatedAt: row.updated_at,
      updated_at: row.updated_at,
    }));
  }

  async function fetchMyLeaderboardRow() {
    const url = `${LEADERBOARD_ENDPOINT}?select=*&device_id=eq.${encodeFilterValue(playerId)}&limit=1`;
    const data = await supabaseRequest(url, { method: "GET" });
    return Array.isArray(data) && data.length ? data[0] : null;
  }

  async function ensureNicknameAvailable(name) {
    const url = `${LEADERBOARD_ENDPOINT}?select=device_id,nickname&nickname=ilike.${encodeFilterValue(name)}&limit=1`;
    const data = await supabaseRequest(url, { method: "GET" });
    const row = Array.isArray(data) && data.length ? data[0] : null;
    if (row && row.device_id !== playerId) {
      const error = new Error("nickname conflict");
      error.code = "NICKNAME_CONFLICT";
      throw error;
    }
  }

  function canChangeNickname(existingRow, newName) {
    if (!existingRow || existingRow.nickname === newName) return true;
    const lastChanged = existingRow.nickname_updated_at || existingRow.created_at || 0;
    const elapsed = Date.now() - new Date(lastChanged).getTime();
    return elapsed >= NICKNAME_CHANGE_COOLDOWN_DAYS * 24 * 60 * 60 * 1000;
  }

  async function insertRemoteScore(nickname, scoreValue) {
    const now = new Date().toISOString();
    return supabaseRequest(LEADERBOARD_ENDPOINT, {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({
        device_id: playerId,
        nickname,
        score: scoreValue,
        nickname_updated_at: now,
        updated_at: now,
      }),
    });
  }

  async function updateRemoteScore(existingRow, { nickname, score, nicknameChanged }) {
    const now = new Date().toISOString();
    const body = {
      nickname,
      score,
      updated_at: now,
    };
    if (nicknameChanged) body.nickname_updated_at = now;
    const url = `${LEADERBOARD_ENDPOINT}?device_id=eq.${encodeFilterValue(playerId)}`;
    return supabaseRequest(url, {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify(body),
    });
  }

  function isNicknameConflictError(e) {
    return e && (e.code === "NICKNAME_CONFLICT" || e.status === 409 || String(e.message || "").includes("leaderboard_nickname_idx"));
  }

  function getLocalLeaderboardRows() {
    try {
      return JSON.parse(localStorage.getItem(LEADERBOARD_STORAGE_KEY) || "[]");
    } catch (e) {
      return [];
    }
  }

  function saveLocalLeaderboardRows(rows) {
    try {
      localStorage.setItem(LEADERBOARD_STORAGE_KEY, JSON.stringify((rows || []).slice(0, 50)));
    } catch (e) {}
  }

  function saveLocalLeaderboardScore(payload) {
    const rows = getLocalLeaderboardRows();
    const index = rows.findIndex((item) => item.playerId === payload.playerId || item.device_id === payload.playerId);
    if (index >= 0) {
      if (Number(payload.score) > Number(rows[index].score || 0)) rows[index] = { ...rows[index], ...payload };
    } else {
      rows.push(payload);
    }
    rows.sort((a, b) => Number(b.score) - Number(a.score));
    localStorage.setItem(LEADERBOARD_STORAGE_KEY, JSON.stringify(rows.slice(0, 50)));
  }

  window.GreedyLeaderboard = {
    init,
    open: openLeaderboard,
    close: closeLeaderboard,
    submit: submitCurrentScore,
    load: loadLeaderboard,
    handleGameOver: handleGameOverLeaderboard,
    retryPending: retryPendingUpload,
    resetTransientState,
    isInputCaptured,
  };
})();
