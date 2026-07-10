import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const MAX_NAME_LENGTH = 12;
const NICKNAME_COOLDOWN_DAYS = 30;
const SUBMIT_COOLDOWN_MS = 5000;
const MAX_SCORE = 999999;
const MAX_PROOF_EVENTS = 5000;
const SCORE_PER_SECOND_LIMIT = 20;
const SCORE_BURST_ALLOWANCE = 100;

type ProofEvent = { t: number; type: string; m: number; p: number };

function checksumSource(proof: Record<string, unknown>, events: ProofEvent[]) {
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

function fnv1a32(value: string) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function validateScoreProof(rawProof: unknown, submittedScore: number) {
  if (!rawProof || typeof rawProof !== "object") return "缺少本局成绩记录。";
  const proof = rawProof as Record<string, unknown>;
  const seed = Number(proof.seed);
  const durationMs = Number(proof.duration_ms);
  const gameTime = Number(proof.gameTime);
  const foods = Number(proof.foods);
  const boss = Number(proof.boss);
  const coffee = Number(proof.coffee);
  const version = String(proof.version ?? "");
  const crc = String(proof.crc ?? "").toLowerCase();
  const events = Array.isArray(proof.events) ? proof.events as ProofEvent[] : [];

  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) return "本局随机标识无效。";
  if (!Number.isInteger(durationMs) || durationMs < 0 || durationMs > 24 * 60 * 60 * 1000) return "游戏时长无效。";
  if (!Number.isInteger(gameTime) || Math.abs(gameTime - Math.round(durationMs / 1000)) > 1) return "游戏时长记录不一致。";
  if (![foods, boss, coffee].every((value) => Number.isInteger(value) && value >= 0)) return "吃取统计无效。";
  if (!/^1\.9\.4[a-z0-9.-]*$/i.test(version)) return "游戏版本不支持提交。";
  if (events.length > MAX_PROOF_EVENTS) return "本局事件数量异常。";
  if (!/^[0-9a-f]{8}$/.test(crc) || fnv1a32(checksumSource(proof, events)) !== crc) return "成绩记录校验码不一致。";

  const baseScores: Record<string, number> = {
    normal: 1,
    triple: 2,
    azhu: 3,
    ai: 4,
    dog: -1,
  };
  const zeroScoreTypes = new Set(["speed", "hr", "pot", "dice", "bomb"]);
  const employeeTypes = new Set(["normal", "triple", "azhu", "ai", "intern", "dog"]);
  let calculatedScore = 0;
  let lastEventAt = 0;
  let countedFoods = 0;
  let countedBoss = 0;
  let countedCoffee = 0;

  for (const event of events) {
    if (!event || typeof event !== "object") return "成绩事件格式无效。";
    const t = Number(event.t);
    const type = String(event.type ?? "");
    const multiplier = Number(event.m);
    const points = Number(event.p);
    if (!Number.isInteger(t) || t < lastEventAt || t > durationMs + 2500) return "成绩事件时间异常。";
    if (!Number.isInteger(multiplier) || !Number.isInteger(points)) return "成绩事件数值无效。";
    lastEventAt = t;

    if (type === "bomb") countedBoss += 1;
    else countedFoods += 1;
    if (type === "speed") countedCoffee += 1;

    if (zeroScoreTypes.has(type)) {
      if (points !== 0 || multiplier !== 0) return "特殊物品得分异常。";
      continue;
    }
    if (!employeeTypes.has(type)) return "存在未知食物类型。";

    // 裁员状态下吃员工会记 0 分；其余员工按基础分和当时倍率复算。
    if (points === 0 && multiplier === 0) continue;
    if (![1, 2, 3, 4].includes(multiplier)) return "得分倍率异常。";
    const supportedMultiplier = countedCoffee >= 5 ? 4 : countedCoffee >= 4 ? 3 : countedCoffee >= 2 ? 2 : 1;
    if (multiplier > supportedMultiplier) return "咖啡数量不足以达到该倍率。";

    if (type === "intern") {
      if (points !== 5 * multiplier && points !== -3 * multiplier) return "实习生得分无法复算。";
    } else if (points !== baseScores[type] * multiplier) {
      return "员工得分无法复算。";
    }
    calculatedScore += points;
  }

  if (countedFoods !== foods || countedBoss !== boss || countedCoffee !== coffee) return "吃取统计与事件顺序不一致。";
  if (calculatedScore !== submittedScore) return "上传分数与本局事件复算结果不一致。";
  if (submittedScore > 0 && durationMs < 1000) return "游戏时长过短。";
  const durationSeconds = Math.max(1, durationMs / 1000);
  if (submittedScore > durationSeconds * SCORE_PER_SECOND_LIMIT + SCORE_BURST_ALLOWANCE) return "分数增长速度异常。";
  if (events.length > durationSeconds * 8 + 30) return "吃取速度异常。";
  return "";
}

function json(status: number, payload: Record<string, unknown>) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
  });
}

function sanitizeName(value: unknown) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060\ufeff]/g, "")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[^\p{Script=Han}A-Za-z0-9_· .-]/gu, "")
    .slice(0, MAX_NAME_LENGTH);
}

function validateName(name: string) {
  if (!name) return "先取一个昵称，才能提交排行榜。";
  if (name.length > MAX_NAME_LENGTH) return `昵称不能超过 ${MAX_NAME_LENGTH} 个字符。`;
  if (/^(管理员|系统|官方|admin|administrator|system|official)$/i.test(name)) return "这个昵称不能使用，请换一个。";
  if (/(https?:\/\/|www\.|@|微信|vx|v信|qq|群|加我|联系)/i.test(name)) return "昵称不能包含网址或联系方式。";
  if (/(傻逼|操你|妈的|草泥马|垃圾游戏)/i.test(name)) return "昵称包含不合适的内容，请修改。";
  return "";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { ok: false, code: "METHOD_NOT_ALLOWED", message: "只允许 POST 请求。" });

  try {
    const body = await req.json();
    const deviceId = String(body?.device_id ?? "").trim();
    const nickname = sanitizeName(body?.nickname);
    const score = Number(body?.score);

    if (!/^[A-Za-z0-9_-]{12,128}$/.test(deviceId)) {
      return json(400, { ok: false, code: "INVALID_DEVICE_ID", message: "玩家身份无效。" });
    }

    const nameError = validateName(nickname);
    if (nameError) return json(400, { ok: false, code: "INVALID_NICKNAME", message: nameError });

    if (!Number.isInteger(score) || score < 0 || score > MAX_SCORE) {
      return json(400, { ok: false, code: "INVALID_SCORE", message: "分数格式不正确。" });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceRoleKey) {
      return json(500, { ok: false, code: "SERVER_CONFIG_ERROR", message: "云函数配置缺失。" });
    }

    const db = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const now = new Date();
    const nowIso = now.toISOString();

    const { data: guard } = await db
      .from("leaderboard_submit_guard")
      .select("last_submit_at")
      .eq("device_id", deviceId)
      .maybeSingle();

    if (guard?.last_submit_at) {
      const elapsed = now.getTime() - new Date(guard.last_submit_at).getTime();
      if (elapsed < SUBMIT_COOLDOWN_MS) {
        const waitSeconds = Math.max(1, Math.ceil((SUBMIT_COOLDOWN_MS - elapsed) / 1000));
        return json(429, {
          ok: false,
          code: "RATE_LIMITED",
          message: `提交太频繁，请 ${waitSeconds} 秒后再试。`,
        });
      }
    }

    await db.from("leaderboard_submit_guard").upsert(
      { device_id: deviceId, last_submit_at: nowIso },
      { onConflict: "device_id" },
    );

    const { data: existing, error: existingError } = await db
      .from("leaderboard")
      .select("device_id,nickname,score,nickname_updated_at,created_at")
      .eq("device_id", deviceId)
      .maybeSingle();

    if (existingError) throw existingError;

    const oldScore = Number(existing?.score || 0);
    if (!existing || score > oldScore) {
      const proofError = validateScoreProof(body?.proof, score);
      if (proofError) {
        return json(422, {
          ok: false,
          code: "CHEAT_DETECTED",
          message: `成绩校验未通过：${proofError}`,
        });
      }
    }

    const { data: nameOwner, error: nameOwnerError } = await db
      .from("leaderboard")
      .select("device_id")
      .ilike("nickname", nickname)
      .neq("device_id", deviceId)
      .limit(1)
      .maybeSingle();

    if (nameOwnerError) throw nameOwnerError;
    if (nameOwner) {
      return json(409, { ok: false, code: "NICKNAME_CONFLICT", message: "昵称已被占用，请换一个昵称。" });
    }

    if (existing && existing.nickname !== nickname) {
      const lastChanged = new Date(existing.nickname_updated_at || existing.created_at || 0).getTime();
      const cooldownMs = NICKNAME_COOLDOWN_DAYS * 24 * 60 * 60 * 1000;
      if (Number.isFinite(lastChanged) && now.getTime() - lastChanged < cooldownMs) {
        return json(409, {
          ok: false,
          code: "NICKNAME_COOLDOWN",
          message: `昵称 ${NICKNAME_COOLDOWN_DAYS} 天只能修改一次。当前昵称：${existing.nickname}`,
        });
      }
    }

    const scoreUpdated = score > oldScore;
    const nicknameChanged = Boolean(existing && existing.nickname !== nickname);

    if (!existing) {
      const { error } = await db.from("leaderboard").insert({
        device_id: deviceId,
        nickname,
        score,
        nickname_updated_at: nowIso,
        updated_at: nowIso,
      });
      if (error) throw error;
      return json(200, {
        ok: true,
        updated: true,
        created: true,
        score_updated: true,
        nickname_changed: false,
        nickname,
        score,
      });
    }

    if (!scoreUpdated && !nicknameChanged) {
      return json(200, {
        ok: true,
        updated: false,
        created: false,
        score_updated: false,
        nickname_changed: false,
        nickname: existing.nickname,
        score: oldScore,
        message: "历史最高分未突破，本次未更新排行榜",
      });
    }

    const updatePayload: Record<string, unknown> = {
      nickname,
      score: scoreUpdated ? score : oldScore,
      updated_at: scoreUpdated ? nowIso : undefined,
    };
    if (nicknameChanged) updatePayload.nickname_updated_at = nowIso;
    Object.keys(updatePayload).forEach((key) => updatePayload[key] === undefined && delete updatePayload[key]);

    const { error: updateError } = await db
      .from("leaderboard")
      .update(updatePayload)
      .eq("device_id", deviceId);
    if (updateError) throw updateError;

    return json(200, {
      ok: true,
      updated: true,
      created: false,
      score_updated: scoreUpdated,
      nickname_changed: nicknameChanged,
      nickname,
      score: scoreUpdated ? score : oldScore,
    });
  } catch (error) {
    console.error("submit-score failed", error);
    const message = error instanceof Error ? error.message : "服务器处理失败。";
    return json(500, { ok: false, code: "SERVER_ERROR", message });
  }
});
