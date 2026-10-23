/* Бухлоплан для Telegram: прослойка вместо window.claude.
   Даёт приложению те же db / user / assets, но поверх Supabase и входа через Telegram.
   Вне Telegram (обычный браузер) прослойка не включается — приложение покажет демо-режим. */
(function () {
  const CFG = window.BUHLO_CONFIG || {};
  const TG = window.Telegram && window.Telegram.WebApp;
  const inTelegram = !!(TG && TG.initData);

  // ---------- оформление под Telegram ----------
  if (TG) {
    try {
      TG.ready(); TG.expand();
      TG.setHeaderColor && TG.setHeaderColor("#0D0509");
      TG.setBackgroundColor && TG.setBackgroundColor("#0D0509");
      TG.disableVerticalSwipes && TG.disableVerticalSwipes();
    } catch (e) {}
    // Внешние ссылки открываем через Telegram, а не внутри мини-аппа
    document.addEventListener("click", (e) => {
      const a = e.target.closest && e.target.closest("a[href]");
      if (!a) return;
      const href = a.getAttribute("href");
      if (!/^https?:/i.test(href)) return;
      e.preventDefault();
      if (/^https:\/\/t\.me\//i.test(href) && TG.openTelegramLink) TG.openTelegramLink(href);
      else TG.openLink(href);
    }, true);
    // Системная кнопка «Назад» — когда в интерфейсе есть кнопка .back
    const syncBack = () => {
      const has = !!document.querySelector("#view .back");
      try { has ? TG.BackButton.show() : TG.BackButton.hide(); } catch (e) {}
    };
    TG.BackButton && TG.BackButton.onClick(() => document.querySelector("#view .back")?.click());
    document.addEventListener("DOMContentLoaded", () => {
      const v = document.getElementById("view");
      if (v) new MutationObserver(syncBack).observe(v, { childList: true });
      syncBack();
    });
  }

  window.__blobUrl = (id) => (id && /^https?:/.test(id)) ? id
    : `${CFG.SUPABASE_URL}/storage/v1/object/public/photos/${id}`;

  if (!inTelegram || !CFG.SUPABASE_URL || !window.supabase) {
    window.claude = { use: async () => { throw new Error("not_in_telegram"); } };
    return;
  }

  // ---------- вход ----------
  let token = null, tokenExp = 0, me = null;
  async function login() {
    const r = await fetch(`${CFG.SUPABASE_URL}/functions/v1/tg-auth`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: CFG.SUPABASE_ANON_KEY },
      body: JSON.stringify({ initData: TG.initData }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(j.error || "auth_failed"); e.code = j.error; throw e; }
    token = j.token; tokenExp = j.exp; me = j.user;
    return token;
  }
  const ready = login();
  const getToken = async () => {
    await ready.catch(() => {});
    if (!token || tokenExp * 1000 - Date.now() < 5 * 60e3) await login();
    return token;
  };
  const sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, { accessToken: getToken });

  // ---------- db: Firestore-подобный API поверх таблицы docs ----------
  const split = (path) => { const i = path.lastIndexOf("/"); return [path.slice(0, i), path.slice(i + 1)]; };
  const newId = () => (Date.now().toString(36) + Math.random().toString(36).slice(2, 8));
  const err = (e) => { const x = new Error(e?.message || "db_error"); x.code = e?.code; return x; };
  const snapDoc = (row) => ({ id: row.id, exists: !!row, data: () => row ? row.data : undefined });

  // Одна подписка realtime на всю таблицу; слушатели фильтруют по коллекции
  const listeners = new Set();
  let channel = null;
  async function ensureChannel() {
    if (channel) return;
    await getToken();
    channel = sb.channel("docs-all")
      .on("postgres_changes", { event: "*", schema: "public", table: "docs" }, (p) => {
        const row = p.new && p.new.collection ? p.new : p.old;
        if (!row) return;
        listeners.forEach((l) => { if (l.collection === row.collection && (!l.id || l.id === row.id)) l.kick(); });
      })
      .subscribe();
  }
  // Резервное обновление, если realtime недоступен
  setInterval(() => listeners.forEach((l) => l.kick()), 30000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) listeners.forEach((l) => l.kick()); });

  function listen(collection, id, fetcher, cb, onErr) {
    let alive = true, timer = null, running = false, again = false;
    const run = async () => {
      if (running) { again = true; return; }
      running = true;
      try { const v = await fetcher(); if (alive) cb(v); }
      catch (e) { if (alive && onErr) onErr(err(e)); }
      running = false;
      if (again && alive) { again = false; run(); }
    };
    const l = { collection, id, kick: () => { clearTimeout(timer); timer = setTimeout(run, 120); } };
    listeners.add(l); ensureChannel(); run();
    return () => { alive = false; listeners.delete(l); };
  }

  function query(collection, opts = {}) {
    const api = {
      orderBy: (field, dir = "asc") => query(collection, { ...opts, order: [field, dir] }),
      limit: (n) => query(collection, { ...opts, limit: n }),
      async get() {
        await getToken();
        let q = sb.from("docs").select("id,data").eq("collection", collection);
        if (opts.order) q = q.order(`data->${opts.order[0]}`, { ascending: opts.order[1] !== "desc" });
        else q = q.order("created_at", { ascending: true });
        q = q.limit(opts.limit || 1000);
        const { data, error } = await q;
        if (error) throw err(error);
        return { docs: data.map(snapDoc), size: data.length, empty: !data.length };
      },
      onSnapshot(cb, onErr) { return listen(collection, null, () => api.get(), cb, onErr); },
      async add(data) {
        await getToken();
        const id = newId();
        const { error } = await sb.from("docs").insert({ collection, id, data });
        if (error) throw err(error);
        return { id };
      },
      doc: (id) => docRef(collection + "/" + id),
    };
    return api;
  }

  function docRef(path) {
    const [collection, id] = split(path);
    const api = {
      id,
      async get() {
        await getToken();
        const { data, error } = await sb.from("docs").select("id,data").eq("collection", collection).eq("id", id).maybeSingle();
        if (error) throw err(error);
        return data ? snapDoc(data) : { id, exists: false, data: () => undefined };
      },
      onSnapshot(cb, onErr) { return listen(collection, id, () => api.get(), cb, onErr); },
      async set(data) {
        await getToken();
        const { error } = await sb.from("docs").upsert({ collection, id, data, updated_at: new Date().toISOString() });
        if (error) throw err(error);
      },
      async update(patch) {
        await getToken();
        const { error } = await sb.rpc("doc_update", { p_collection: collection, p_id: id, p_patch: patch });
        if (error) throw err(error);
      },
      async delete() {
        await getToken();
        const { error } = await sb.from("docs").delete().eq("collection", collection).eq("id", id);
        if (error) throw err(error);
      },
    };
    return api;
  }

  const db = { collection: (p) => query(p), doc: (p) => docRef(p) };

  // ---------- user ----------
  const user = {
    async id() { await ready; return me.id; },
    async can() { try { await ready; return true; } catch (e) { return false; } },
    async me() { await ready; return { name: me.name, avatarUrl: me.avatarUrl, color: me.color }; },
    async profiles(ids) {
      await getToken();
      const { data } = await sb.from("profiles").select("id,name,avatar_url,color").in("id", ids);
      const out = {};
      (data || []).forEach((p) => out[p.id] = { name: p.name, avatarUrl: p.avatar_url, color: p.color });
      return out;
    },
  };

  // ---------- assets (фото) ----------
  const assets = {
    async upload(blob, opts = {}) {
      await getToken();
      if (blob.size > 20 * 1024 * 1024) { const e = new Error("too_large"); e.code = "too_large"; throw e; }
      const path = `${me.id}/${newId()}.jpg`;
      const { error } = await sb.storage.from("photos").upload(path, blob, { contentType: opts.type || "image/jpeg" });
      if (error) throw err(error);
      return { id: path };
    },
    async delete(id) { await getToken(); await sb.storage.from("photos").remove([id]); },
  };

  window.claude = {
    async use(name) {
      await ready; // если вход не удался — бросит ошибку, и приложение уйдёт в демо
      if (name === "db") return db;
      if (name === "user") return user;
      if (name === "assets") return assets;
      throw new Error("unknown_capability");
    },
  };

  ready.catch((e) => {
    const msg = e.code === "not_allowed"
      ? "Вас нет в списке участников. Попросите организатора добавить ваш Telegram ID."
      : "Не удалось войти через Telegram. Закройте и откройте приложение ещё раз.";
    const show = () => { try { TG.showAlert(msg); } catch (x) { alert(msg); } };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", show); else show();
  });
})();
