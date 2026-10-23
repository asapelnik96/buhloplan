// Бухлоплан: вход через Telegram Mini App.
// Проверяет подпись initData токеном бота и выдаёт JWT для Supabase.
// Секреты (supabase secrets set ...):
//   BOT_TOKEN          — токен бота от @BotFather
//   JWT_SECRET         — Legacy JWT secret проекта (Settings → JWT Keys → Legacy JWT Secret)
//   ALLOWED_TG_IDS     — необязательно: telegram id через запятую; пусто = пускать всех
// SUPABASE_URL и SUPABASE_SERVICE_ROLE_KEY Supabase подставляет сам.
import { createClient } from "npm:@supabase/supabase-js@2.49.4";
import { create, getNumericDate } from "https://deno.land/x/djwt@v3.0.2/mod.ts";

const enc = new TextEncoder();
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

async function hmac(key: ArrayBuffer | Uint8Array, msg: string) {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(msg)));
}
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

// Детерминированный UUID из telegram id (чтобы auth.uid() работал везде)
async function uuidFor(tgId: string) {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode("buhloplan:" + tgId)));
  h[6] = (h[6] & 0x0f) | 0x50; h[8] = (h[8] & 0x3f) | 0x80;
  const s = hex(h.slice(0, 16));
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`;
}
const COLORS = ["#E44D63", "#E58B23", "#6B2146", "#3F8A5A", "#C8294F", "#86636F", "#3DA5E0", "#B5401F"];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const { initData } = await req.json();
    if (!initData || typeof initData !== "string") return json({ error: "no_init_data" }, 400);

    const p = new URLSearchParams(initData);
    const hash = p.get("hash");
    p.delete("hash");
    const check = [...p.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join("\n");
    const secret = await hmac(enc.encode("WebAppData"), Deno.env.get("BOT_TOKEN")!);
    if (!hash || hex(await hmac(secret, check)) !== hash) return json({ error: "bad_signature" }, 401);

    const authDate = Number(p.get("auth_date") || 0);
    if (Date.now() / 1000 - authDate > 86400) return json({ error: "expired" }, 401);

    const tg = JSON.parse(p.get("user") || "{}");
    const tgId = String(tg.id || "");
    if (!tgId) return json({ error: "no_user" }, 400);

    const allowed = (Deno.env.get("ALLOWED_TG_IDS") || "").split(",").map((s) => s.trim()).filter(Boolean);
    if (allowed.length && !allowed.includes(tgId)) return json({ error: "not_allowed" }, 403);

    const sub = await uuidFor(tgId);
    const name = [tg.first_name, tg.last_name].filter(Boolean).join(" ") || tg.username || "Коллега";
    const color = COLORS[Number(tgId) % COLORS.length];

    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    await admin.from("profiles").upsert({ id: sub, name, avatar_url: tg.photo_url || null, color, updated_at: new Date().toISOString() });

    const key = await crypto.subtle.importKey("raw", enc.encode(Deno.env.get("JWT_SECRET")!), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
    const exp = getNumericDate(60 * 60 * 12);
    const token = await create({ alg: "HS256", typ: "JWT" }, {
      sub, role: "authenticated", aud: "authenticated", exp, iat: getNumericDate(0), tg_id: tgId,
    }, key);

    return json({ token, exp, user: { id: sub, name, avatarUrl: tg.photo_url || null, color } });
  } catch (e) {
    return json({ error: "server", message: String(e) }, 500);
  }
});
