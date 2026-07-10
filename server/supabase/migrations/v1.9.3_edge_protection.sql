-- 贪吃经理 v1.9.3：服务端提交保护

create table if not exists public.leaderboard_submit_guard (
  device_id text primary key,
  last_submit_at timestamptz not null default now()
);

alter table public.leaderboard_submit_guard enable row level security;

-- 公共排行榜视图：不暴露 device_id，避免他人拿到设备身份后伪造更新。
create or replace view public.leaderboard_public
with (security_invoker = true)
as
select nickname, score, updated_at
from public.leaderboard;

grant select on public.leaderboard_public to anon, authenticated;

-- 公开客户端只能读排行榜视图，不能直接读写排行榜原表。
revoke all on public.leaderboard from anon, authenticated;
revoke all on public.leaderboard_submit_guard from anon, authenticated;

-- 删除旧的匿名写入策略。名称与之前创建的策略一致。
drop policy if exists "Allow public insert leaderboard" on public.leaderboard;
drop policy if exists "Allow public update leaderboard" on public.leaderboard;

-- 如果之前存在公开读取原表的策略，也删除；公开读取改走 leaderboard_public。
drop policy if exists "Allow public read leaderboard" on public.leaderboard;

-- 视图使用 security_invoker，因此需要给底表 SELECT 权限，但只允许通过视图列读取。
-- PostgREST 对视图的访问依赖底表权限；重新只授予必要列。
grant select (nickname, score, updated_at) on public.leaderboard to anon, authenticated;

-- 保留 RLS 开启状态。
alter table public.leaderboard enable row level security;

-- 仅允许匿名/登录用户读取公开列；写入只由 Edge Function 的 service_role 执行。
create policy "Public leaderboard read only"
on public.leaderboard
for select
to anon, authenticated
using (true);
