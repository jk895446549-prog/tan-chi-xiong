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

    const oldScore = Number(existing?.score || 0);
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
