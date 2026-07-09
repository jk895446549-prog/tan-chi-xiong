// 贪吃经理 v1.9.1 配置文件
// Project URL 和 Publishable Key 可以放在前端；不要把 Secret/Service Role Key 放到代码里。
window.CONFIG = {
  VERSION: "v1.9.1-online-leaderboard",

  SUPABASE_URL: "https://pzidluoutepwfirotfay.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_CMmDdUwGw59JV5MePWDnrg_UDLWxU4J",
  LEADERBOARD_TABLE: "leaderboard",

  LEADERBOARD_LIMIT: 20,
  MAX_PLAYER_NAME_LENGTH: 12,
  NICKNAME_CHANGE_COOLDOWN_DAYS: 30,

  STORAGE_KEYS: {
    leaderboardBackup: "greedyManagerLeaderboardLocalBackup",
    playerId: "greedyManagerPlayerId",
    playerName: "greedyManagerPlayerName",
    autoSubmit: "greedyManagerAutoSubmitBestScore",
    suppressPopup: "greedyManagerSuppressLeaderboardPopup",
    lastSubmittedScore: "greedyManagerLastSubmittedScore",
  },

  DEBUG: false,
};
