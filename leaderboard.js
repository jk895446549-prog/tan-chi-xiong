// 贪吃经理排行榜模块
(function () {
  "use strict";

  const cfg = window.CONFIG || {};
  const storageKeys = cfg.STORAGE_KEYS || {};
  const SUPABASE_URL = cfg.SUPABASE_URL || "";
  const SUPABASE_PUBLISHABLE_KEY = cfg.SUPABASE_PUBLISHABLE_KEY || "";
  const LEADERBOARD_TABLE = cfg.LEADERBOARD_TABLE || "leaderboard";
  const LEADERBOARD_ENDPOINT = SUPABASE_URL ? `${SUPABASE_URL}/rest/v1/${LEADERBOARD_TABLE}` : "";
  const LEADERBOARD_STORAGE_KEY = storageKeys.leaderboardBackup || "greedyManagerLeaderboardLocalBackup";
  const PLAYER_ID_STORAGE_KEY = storageKeys.playerId || "greedyManagerPlayerId";
  const PLAYER_NAME_STORAGE_KEY = storageKeys.playerName || "greedyManagerPlayerName";
  const AUTO_SUBMIT_STORAGE_KEY = storageKeys.autoSubmit || "greedyManagerAutoSubmitBestScore";
  const SUPPRESS_POPUP_STORAGE_KEY = storageKeys.suppressPopup || "greedyManagerSuppressLeaderboardPopup";
  const LAST_SUBMITTED_SCORE_KEY = storageKeys.lastSubmittedScore || "greedyManagerLastSubmittedScore";
  const MAX_PLAYER_NAME_LENGTH = cfg.MAX_PLAYER_NAME_LENGTH || 12;
  const LEADERBOARD_LIMIT = cfg.LEADERBOARD_LIMIT || 20;
  const NICKNAME_CHANGE_COOLDOWN_DAYS = cfg.NICKNAME_CHANGE_COOLDOWN_DAYS || 30;

  let elements = {};
  let api = {};
  let playerId = getOrCreatePlayerId();
  let playerName = localStorage.getItem(PLAYER_NAME_STORAGE_KEY) || "";
  let lastSubmittedScore = Number(localStorage.getItem(LAST_SUBMITTED_SCORE_KEY) || 0);
  let leaderboardOpenBeforePause = false;
  let lastRenderedRows = [];

  function init(options) {
    elements = options.elements || {};
    api = options.api || {};
    bindEvents();
    if (elements.playerNameInput) elements.playerNameInput.value = playerName;
    loadLeaderboard(false, { silent: true });
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
      .trim()
      .replace(/[<>"'`\\]/g, "")
      .replace(/\s+/g, " ")
      .slice(0, MAX_PLAYER_NAME_LENGTH);
  }

  function savePlayerName() {
    const cleanName = sanitizePlayerName(elements.playerNameInput ? elements.playerNameInput.value : playerName);
    if (!cleanName) {
      showLeaderboardToast("先取一个昵称，才能提交排行榜。", true);
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

  function getBestScoreToSubmit() {
    const bestScore = Number(api.getBestScore ? api.getBestScore() : 0);
    const score = Number(api.getCurrentScore ? api.getCurrentScore() : 0);
    return Math.max(bestScore, score, 0);
  }

  function openLeaderboard() {
    leaderboardOpenBeforePause = Boolean(api.isGamePaused && api.isGamePaused());
    if (
      api.isGameStarted && api.isGameStarted() &&
      !(api.isGameOver && api.isGameOver()) &&
      !(api.isDeathPending && api.isDeathPending()) &&
      !(api.isGamePaused && api.isGamePaused())
    ) {
      api.togglePause && api.togglePause();
    }

    if (elements.leaderboardModal) elements.leaderboardModal.style.display = "flex";
    if (elements.playerNameInput) elements.playerNameInput.value = playerName;
    clearLeaderboardToast();
    loadLeaderboard(false);

    setTimeout(() => {
      if (elements.leaderboardModal && elements.leaderboardModal.style.display === "flex" && !playerName && elements.playerNameInput) {
        elements.playerNameInput.focus({ preventScroll: true });
      }
    }, 120);
  }

  function closeLeaderboard() {
    if (elements.leaderboardModal) elements.leaderboardModal.style.display = "none";
    if (
      api.isGameStarted && api.isGameStarted() &&
      !(api.isGameOver && api.isGameOver()) &&
      api.isGamePaused && api.isGamePaused() &&
      !leaderboardOpenBeforePause
    ) {
      api.togglePause && api.togglePause();
    }
  }

  function handleGameOverLeaderboard() {
    const bestScore = Number(api.getBestScore ? api.getBestScore() : 0);
    if (bestScore <= 0) return;
    if (isAutoSubmitEnabled() && playerName) submitCurrentScore(false);
    if (!isSuppressLeaderboardPopupEnabled()) openLeaderboard("gameover");
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
        const itemId = item.device_id || item.playerId;
        const itemName = item.nickname || item.name || "匿名打工人";
        const isMine = itemId === playerId;
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
    const index = sorted.findIndex((item) => (item.device_id || item.playerId) === playerId);
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

  function getSupabaseHeaders(extra = {}) {
    return {
      apikey: SUPABASE_PUBLISHABLE_KEY,
      Authorization: `Bearer ${SUPABASE_PUBLISHABLE_KEY}`,
      "Content-Type": "application/json",
      ...extra,
    };
  }

  async function supabaseRequest(url, options = {}) {
    if (!LEADERBOARD_ENDPOINT || !SUPABASE_PUBLISHABLE_KEY) throw new Error("排行榜云配置缺失");
    const res = await fetch(url, { ...options, headers: getSupabaseHeaders(options.headers || {}) });
    if (!res.ok) {
      let message = `${res.status}`;
      try {
        const data = await res.json();
        message = data.message || data.details || message;
      } catch (e) {}
      const error = new Error(message);
      error.status = res.status;
      throw error;
    }
    if (res.status === 204) return null;
    return res.json().catch(() => null);
  }

  function encodeFilterValue(value) {
    return encodeURIComponent(String(value).replace(/"/g, '\\"'));
  }

  async function loadLeaderboard(manual = false, options = {}) {
    if (!options.silent) renderLoadingState();
    try {
      const rows = await fetchRemoteLeaderboard();
      renderLeaderboard(rows);
      saveLocalLeaderboardRows(rows);
      if (manual) showLeaderboardToast("联网排行榜已更新。", false);
      return rows;
    } catch (e) {
      console.warn("排行榜读取失败", e);
      const backupRows = getLocalLeaderboardRows();
      if (backupRows.length > 0) {
        renderLeaderboard(backupRows);
        showLeaderboardToast("联网排行榜读取失败，已显示本机备份榜。", true);
      } else {
        renderErrorState();
        showLeaderboardToast("联网排行榜读取失败。", true);
      }
      return backupRows;
    }
  }

  async function submitCurrentScore(manual = false) {
    const scoreToSubmit = getBestScoreToSubmit();
    if (scoreToSubmit <= 0) {
      if (manual) showLeaderboardToast("还没有有效最高分。", true);
      return;
    }
    if (!savePlayerName()) return;

    if (elements.submitScoreBtn) elements.submitScoreBtn.disabled = true;
    const beforeRows = lastRenderedRows.length ? lastRenderedRows : await fetchRemoteLeaderboard().catch(() => getLocalLeaderboardRows());
    const oldRank = getRankFromRows(beforeRows);

    try {
      const existingRow = await fetchMyLeaderboardRow();
      await ensureNicknameAvailable(playerName);

      if (existingRow && !canChangeNickname(existingRow, playerName)) {
        showLeaderboardToast(`昵称 30 天只能修改一次。当前昵称：${existingRow.nickname}`, true);
        playerName = existingRow.nickname;
        if (elements.playerNameInput) elements.playerNameInput.value = playerName;
        localStorage.setItem(PLAYER_NAME_STORAGE_KEY, playerName);
        return;
      }

      const oldScore = Number(existingRow?.score || 0);
      const oldName = existingRow?.nickname || "";
      const shouldCreate = !existingRow;
      const shouldUpdateScore = scoreToSubmit > oldScore;
      const shouldUpdateName = existingRow && playerName !== oldName;

      if (!shouldCreate && !shouldUpdateScore && !shouldUpdateName) {
        showLeaderboardToast("历史最高分未突破，本次未更新排行榜", false);
        await loadLeaderboard(false);
        return;
      }

      if (shouldCreate) {
        await insertRemoteScore(playerName, scoreToSubmit);
      } else {
        await updateRemoteScore(existingRow, {
          nickname: playerName,
          score: shouldUpdateScore ? scoreToSubmit : oldScore,
          nicknameChanged: shouldUpdateName,
        });
      }

      lastSubmittedScore = Math.max(lastSubmittedScore, scoreToSubmit);
      localStorage.setItem(LAST_SUBMITTED_SCORE_KEY, lastSubmittedScore);

      const rows = await fetchRemoteLeaderboard();
      renderLeaderboard(rows, true);
      saveLocalLeaderboardRows(rows);
      const newRank = getRankFromRows(rows);
      showLeaderboardToast(shouldUpdateName && !shouldUpdateScore ? "✅ 昵称已更新" : buildRankToast(oldRank, newRank, shouldCreate || shouldUpdateScore), false);
    } catch (e) {
      console.warn("分数提交失败", e);
      if (isNicknameConflictError(e)) {
        showLeaderboardToast("昵称已被占用，请换一个昵称。", true);
        return;
      }
      if (e.status === 403 || e.status === 401) {
        showLeaderboardToast("云端拒绝更新：请确认 Supabase 已添加 UPDATE 策略。", true);
        return;
      }
      saveLocalLeaderboardScore({ playerId, device_id: playerId, name: playerName, nickname: playerName, score: scoreToSubmit, updatedAt: Date.now(), updated_at: new Date().toISOString() });
      renderLeaderboard(getLocalLeaderboardRows(), true);
      showLeaderboardToast("联网提交失败，已先保存到本机备份。", true);
    } finally {
      if (elements.submitScoreBtn) elements.submitScoreBtn.disabled = false;
    }
  }

  async function fetchRemoteLeaderboard() {
    const url = `${LEADERBOARD_ENDPOINT}?select=device_id,nickname,score,updated_at&order=score.desc,updated_at.asc&limit=${LEADERBOARD_LIMIT}`;
    const data = await supabaseRequest(url, { method: "GET" });
    return (Array.isArray(data) ? data : []).map((row) => ({
      playerId: row.device_id,
      device_id: row.device_id,
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
        play_count: 1,
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
      play_count: Number(existingRow.play_count || 0) + 1,
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
  };
})();
