# Бухлоплан — Telegram Mini App

Тот же «Бухлоплан» (тусовки, план вечера, чат, бар, кондиция, фото, рейтинг, афиша, места), только внутри Telegram.
Вход автоматический по Telegram-аккаунту, данные общие для всех участников.

```
index.html        — приложение (интерфейс без изменений)
tg-shim.js        — прослойка: вход через Telegram + база Supabase вместо claude.ai
config.js         — адрес и публичный ключ Supabase (заполнить)
data/docs.json    — афиша и места (81 акция, 42 заведения на 23.10.2026)
supabase/schema.sql               — таблицы, права, хранилище фото
supabase/functions/tg-auth/       — проверка подписи Telegram и выдача токена
scripts/upload_docs.py            — заливка афиши в базу
.github/workflows/sync.yml        — автозаливка data/docs.json при каждом изменении
```

Всё бесплатно: Supabase Free + GitHub Pages. На всё уходит около 30 минут.

---

## 1. Бот

1. В Telegram откройте **@BotFather** → `/newbot` → придумайте имя и username.
2. Сохраните **токен бота** (вида `123456:ABC...`).

## 2. Supabase

1. Зарегистрируйтесь на supabase.com → **New project** (регион — Frankfurt или ближайший).
2. **SQL Editor → New query** → вставьте весь `supabase/schema.sql` → **Run**.
3. **Project Settings → API**: скопируйте **Project URL** и ключ **anon / publishable**.
   Там же — ключ **service_role** (секретный, понадобится в шаге 4).
4. **Project Settings → JWT Keys → Legacy JWT Secret**: скопируйте секрет.
5. Разверните функцию входа. Проще всего через CLI (`npm i -g supabase`):
   ```bash
   supabase login
   supabase link --project-ref <ID-проекта>
   supabase secrets set BOT_TOKEN="<токен бота>" JWT_SECRET="<Legacy JWT Secret>"
   # необязательно — пускать только своих (Telegram ID через запятую, узнать свой: @userinfobot)
   supabase secrets set ALLOWED_TG_IDS="11111111,22222222"
   supabase functions deploy tg-auth --no-verify-jwt
   ```
   Без CLI: **Edge Functions → Deploy a new function → Via editor**, имя `tg-auth`,
   вставить код из `supabase/functions/tg-auth/index.ts`, выключить **Verify JWT**,
   а секреты добавить в **Edge Functions → Secrets**.

## 3. GitHub Pages

1. Создайте репозиторий (например, `buhloplan`) и загрузите в него все файлы этой папки.
2. В `config.js` впишите Project URL и anon-ключ, закоммитьте.
3. **Settings → Pages → Source: Deploy from a branch → main / (root)** → Save.
   Через минуту сайт будет по адресу `https://<логин>.github.io/buhloplan/`.
4. **Settings → Secrets and variables → Actions → New repository secret**:
   `SUPABASE_URL` и `SUPABASE_SERVICE_KEY` (service_role).
5. **Actions → Sync data to Supabase → Run workflow** — афиша и места зальются в базу.

## 4. Подключить мини-апп к боту

В @BotFather:
- `/mybots` → ваш бот → **Bot Settings → Menu Button** → URL `https://<логин>.github.io/buhloplan/`, текст «Бухлоплан».
- По желанию: `/newapp` → тот же URL — появится ссылка вида `t.me/<бот>/<app>`, которую можно кидать в рабочий чат.

Готово: откройте бота → кнопка «Бухлоплан».

---

## Как обновляется афиша

Афишу берёт `data/docs.json`. При каждом изменении этого файла GitHub Action сам заливает его в Supabase
(акции и места, которых нет в файле, удаляются).
Ежедневная задача Claude может обновлять этот файл в репозитории — для этого ей нужен доступ к GitHub
(fine-grained token с правом Contents: Read and write на этот репозиторий).

Вручную: `SUPABASE_URL=... SUPABASE_SERVICE_KEY=... python3 scripts/upload_docs.py data/docs.json --prune promos,venues`

## Что важно знать

- **Кто видит данные.** Читать и писать могут только те, кто открыл приложение через бота (подпись Telegram проверяется на сервере).
  Если бот попадёт к посторонним — включите `ALLOWED_TG_IDS`.
- **Фото** лежат в публичном бакете под случайными именами: без ссылки их не найти, но по ссылке откроются у любого.
- **Права:** тусовку и фото удаляет только автор, статус «перерыва» — только свой; афишу и места меняет только сервисный ключ.
- **Вне Telegram** (обычный браузер) открывается демо с выдуманными коллегами.
- **Возраст 18+.** В приложении есть возрастной барьер. Не публикуйте бота в публичных каталогах Telegram — там строже к теме стриптиза и алкоголя.
- Старые тусовки, чат и фото из версии на claude.ai не переносятся — переехали только афиша и места.

## Если что-то не работает

| Симптом | Что проверить |
|---|---|
| «Не удалось войти через Telegram» | Функция `tg-auth` развёрнута с `--no-verify-jwt`; `BOT_TOKEN` от того же бота, что открывает приложение |
| Вход есть, но данные не грузятся, ошибка JWT | `JWT_SECRET` = Legacy JWT Secret, и этот ключ не отозван в JWT Keys |
| Афиша пустая | Запустите Action «Sync data to Supabase», проверьте секреты репозитория |
| Новые сообщения появляются с задержкой | Realtime: в Supabase **Database → Publications → supabase_realtime** должна быть таблица `docs` (резервное обновление — раз в 30 секунд) |
