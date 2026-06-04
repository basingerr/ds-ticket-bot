# Agents context: Discord Forum → Trello sync bot

## Цель

Нужно сделать маленького бота-мост между Discord и Trello.

Внешние тестеры создают баги в Discord Forum Channel. Команда работает с карточками в Trello. Бот синхронизирует создание тикета и изменение статуса обратно в Discord-тему.

Основная архитектура:

```text
Discord Forum Post = публичный тикет для тестера
Trello Card = внутренняя рабочая карточка команды
Bot = мост между ними
```

Тестеры не получают доступ к Trello. Trello остается внутренней доской команды. Discord остается публичной витриной тикета.

## Что нужно сделать

Бот должен уметь только базовую синхронизацию:

```text
1. Новый Discord Forum Post → создать Trello Card
2. Перемещение Trello Card → написать статус в Discord Thread
3. Хранить связку discordThreadId ↔ trelloCardId
```

Не нужно делать полноценную тикет-систему, личный кабинет, авто-модерацию, SLA, аналитику, сложные команды и двустороннее редактирование.

## Технологии

Рекомендуемый стек:

```text
Node.js
TypeScript
discord.js
Express или Fastify
Trello REST API
SQLite
dotenv
```

Хранилище на старте: SQLite. Postgres/Redis не нужны, если отдельно не попросили.

Деплой предполагается на сервис с публичным HTTPS URL, чтобы Trello webhook мог достучаться до бота.

## Env

Использовать `.env`.

```env
DISCORD_TOKEN=
DISCORD_GUILD_ID=
DISCORD_FORUM_CHANNEL_ID=

TRELLO_KEY=
TRELLO_TOKEN=
TRELLO_BOARD_ID=
TRELLO_INBOX_LIST_ID=

PUBLIC_BASE_URL=
DATABASE_URL=
```

`PUBLIC_BASE_URL` нужен для Trello webhook callback URL.

Пример:

```text
https://example.com
```

Webhook endpoint:

```text
POST /webhooks/trello
```

## Discord-логика

Целевой канал: Discord Forum Channel с баг-репортами.

Бот должен слушать создание новых forum posts.

Технически Discord Forum Post является thread. Поэтому бот должен обрабатывать создание thread/post в заданном forum channel.

При создании нового forum post:

1. Проверить, что thread создан внутри `DISCORD_FORUM_CHANNEL_ID`.
2. Получить:
   - thread id
   - thread title
   - author id
   - ссылку на thread/message, если доступна
   - текст стартового сообщения, если доступен

3. Создать карточку Trello в списке `TRELLO_INBOX_LIST_ID`.
4. Сохранить связку в БД.
5. Написать в Discord thread сообщение:

```text
Тикет принят.
Статус: New.
```

6. Если возможно, поставить forum tag `New`.

Если стартовый текст сообщения нельзя получить сразу, не падать. Создать карточку с тем, что есть: title, author, thread id, ссылка на Discord thread.

## Trello-логика

При создании Discord тикета бот создает карточку Trello.

Карточка создается в:

```text
Board: TRELLO_BOARD_ID
List: TRELLO_INBOX_LIST_ID
```

Название карточки:

```text
<title Discord forum post>
```

Описание карточки:

```text
Discord ticket

Автор Discord: <discord_user_id>
Discord thread id: <discord_thread_id>
Discord channel id: <discord_channel_id>
Discord guild id: <discord_guild_id>
Discord link: <discord_link>

Текст тикета:
<first_message_content>
```

Если данных нет, писать `not_available`, не выдумывать.

## Статусы

Trello lists мапятся в Discord statuses.

Базовый маппинг:

```text
Inbox → New
Accepted → Accepted
In Progress → In Progress
Ready for Retest → Ready for Retest
Verified → Verified
Rejected / Duplicate → Rejected / Duplicate
Need Info → Need Info
```

Названия списков могут отличаться, поэтому сделать конфиг маппинга в коде отдельным объектом.

Пример:

```ts
const TRELLO_LIST_TO_STATUS: Record<string, string> = {
  Inbox: "New",
  Accepted: "Accepted",
  "In Progress": "In Progress",
  "Ready for Retest": "Ready for Retest",
  Verified: "Verified",
  "Rejected / Duplicate": "Rejected / Duplicate",
  "Need Info": "Need Info",
};
```

Лучше использовать list id, если они известны. Если list id не заданы, можно временно мапить по имени списка.

## Trello webhook

Бот должен принимать Trello webhook.

При перемещении карточки между списками:

1. Получить `trello_card_id`.
2. Определить новый список.
3. Найти в БД связанный `discord_thread_id`.
4. Определить статус по маппингу.
5. Обновить статус в БД.
6. Написать сообщение в Discord thread:

```text
Статус изменен: <status>.
```

Если статус `Ready for Retest`, написать расширенное сообщение:

```text
Статус изменен: Ready for Retest.

Фикс готов к перепроверке. Проверьте заново и отпишите результат в этой теме:
- ок
- не исправлено
- проблема изменилась
```

Если статус `Need Info`:

```text
Статус изменен: Need Info.

Нужна дополнительная информация. Опишите детали в этой теме.
```

Если статус `Rejected / Duplicate`:

```text
Статус изменен: Rejected / Duplicate.
```

Не слать Trello-ссылку публично в Discord, если это не включено отдельным флагом.

## База данных

Создать таблицу:

```sql
CREATE TABLE IF NOT EXISTS ticket_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  discord_guild_id TEXT NOT NULL,
  discord_channel_id TEXT NOT NULL,
  discord_thread_id TEXT NOT NULL UNIQUE,
  discord_author_id TEXT,
  trello_card_id TEXT NOT NULL UNIQUE,
  trello_card_url TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

Нужные операции:

```text
createTicketLink()
findByDiscordThreadId()
findByTrelloCardId()
updateStatus()
```

## Idempotency

Бот не должен создавать дубль карточки, если событие Discord пришло повторно.

Перед созданием Trello card:

```text
findByDiscordThreadId(discord_thread_id)
```

Если запись уже есть:

- не создавать новую карточку;
- можно написать в лог;
- не спамить Discord.

Trello webhook тоже может приходить повторно. Если статус не изменился, не писать повторное сообщение в Discord.

## Discord forum tags

Если доступно через discord.js:

- при создании тикета поставить tag `New`;
- при смене статуса заменить старый статусный tag на новый.

Статусные tags:

```text
New
Accepted
In Progress
Ready for Retest
Verified
Rejected
Duplicate
Need Info
```

Если обновление тегов не получается быстро сделать, не блокировать основную задачу. Главное: сообщения в thread.

## Slash command

Добавить одну команду для ручной синхронизации:

```text
/sync-ticket
```

Поведение:

- вызывается внутри Discord thread;
- бот ищет запись по `discord_thread_id`;
- запрашивает текущую Trello card;
- определяет текущий Trello list;
- обновляет статус в БД;
- пишет в thread текущий статус.

Ответ:

```text
Тикет синхронизирован.
Текущий статус: <status>.
```

Если связка не найдена:

```text
Связка с Trello-карточкой не найдена.
```

Другие команды не делать.

## Логи

Нужны нормальные console logs без мусора.

Логировать:

```text
bot started
discord forum post detected
trello card created
ticket link saved
trello webhook received
trello card moved
discord thread updated
sync command executed
error
```

Ошибки должны логироваться с контекстом:

```text
discord_thread_id
trello_card_id
action
error message
```

## Ошибки и поведение

Если Trello card не создалась:

- написать ошибку в console;
- написать в Discord thread:

```text
Не удалось создать внутренний тикет. Команда проверит вручную.
```

Если Discord thread не найден при Trello webhook:

- не падать;
- залогировать ошибку;
- обновить БД не нужно, если невозможно подтвердить синхронизацию.

Если Trello webhook пришел по карточке без связки:

- игнорировать;
- залогировать как `unlinked trello card`.

## Что не делать

Не делать:

```text
- личный кабинет тестера
- веб-интерфейс
- авто-закрытие тикетов
- авто-парсинг ответов “ок / не ок”
- синхронизацию всех комментариев
- редактирование Trello card при изменении Discord post
- редактирование Discord post при изменении Trello card
- аналитику
- приоритеты
- SLA
- роли тестеров
- сложную модерацию
- AI-классификацию багов
- загрузку и проксирование файлов
```

Вложения Discord на старте не скачивать и не перезаливать. Если у сообщения есть attachment URLs, добавить ссылки в описание Trello card. Если не получилось получить вложения, не блокировать создание тикета.

## Минимальная структура проекта

```text
src/
  index.ts
  config.ts

  discord/
    client.ts
    handlers.ts
    commands.ts

  trello/
    client.ts
    webhook.ts
    statusMap.ts

  db/
    database.ts
    ticketLinks.ts

  utils/
    logger.ts
    dates.ts
```

## Acceptance criteria

Готово, когда работает такой флоу:

```text
1. Тестер создает Discord Forum Post в заданном канале.
2. Бот создает Trello card в Inbox.
3. Бот пишет в Discord thread: “Тикет принят. Статус: New.”
4. В БД появляется связка discordThreadId ↔ trelloCardId.
5. Команда двигает Trello card в Ready for Retest.
6. Trello webhook приходит в бота.
7. Бот находит Discord thread.
8. Бот пишет в thread, что статус изменен на Ready for Retest.
9. Повторный webhook с тем же статусом не создает дубль сообщения.
10. Команда `/sync-ticket` внутри thread подтягивает текущий Trello status.
```

## Главный принцип

Делать маленький надежный мост, а не новый баг-трекер.

Любое расширение, которое не требуется для флоу Discord Forum Post → Trello Card → Status back, не добавлять.
