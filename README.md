# PostgreSQL API

Минимальный сервис для технического собеседования: API выполняет `INSERT` и `SELECT` в PostgreSQL. При запуске сам создаёт таблицу `records`.

## API

| Method | Path | Result |
| --- | --- | --- |
| `POST` | `/api/v1/records` | Создаёт запись: `{"value":"text"}`; ответ `201` |
| `GET` | `/api/v1/records` | Возвращает до 100 последних записей |
| `POST` | `/api/v1/load` | Запускает ограниченную фоновую нагрузку: `INSERT` + `SELECT count(*)` |
| `GET` | `/healthz` | Проверка процесса |

## Локальный запуск

Нужны Docker и Docker Compose:

```bash
docker compose up --build -d
curl http://127.0.0.1:18080/healthz
curl -X POST http://127.0.0.1:18080/api/v1/records \
  -H 'Content-Type: application/json' -d '{"value":"first record"}'
curl http://127.0.0.1:18080/api/v1/records
```

В Kubernetes приложение слушает HTTP на порту `8080`. TLS завершают Ingress NGINX и cert-manager; `Service` должен направлять HTTP-трафик на `targetPort: 8080`.

Приложение стартует и отвечает `200` на `/healthz`, даже если PostgreSQL ещё не поднят или `DATABASE_URL` не задан. В этом состоянии эндпоинты записей корректно вернут `503 database unavailable`; после запуска БД сервис автоматически попробует подключиться снова на следующем запросе.

## Нагрузка из приложения

`POST /api/v1/load` запускает один фоновый прогон: каждый воркер непрерывно выполняет `INSERT`, затем `SELECT count(*)` до окончания времени. Параллельный запуск вернёт `409`, чтобы нагрузка не стала неограниченной. Лимиты: до 50 воркеров, 300 секунд, до 900 байт полезной нагрузки записи. Используйте ручку только в тестовом окружении и ограничьте к ней доступ на уровне Ingress.

```bash
curl -X POST http://127.0.0.1:18080/api/v1/load \
  -H 'Content-Type: application/json' \
  -d '{"workers":20,"duration_seconds":120,"value_size_bytes":512}'
```

## Нагрузочный тест

Тест использует [k6](https://grafana.com/docs/k6/latest/). Он создаёт запись и читает список; пороги: ошибок меньше 1%, p95 меньше 500 мс. Профиль `standard` предназначен для быстрого демо. `stress` создаёт 256-байтные записи, поднимается до 20 VU, держит их 2 минуты и делает два `SELECT` на каждый `INSERT`.

```bash
# локально
BASE_URL=http://127.0.0.1:18080 k6 run k6/load-test.js

# усиленная нагрузка на API и PostgreSQL
LOAD_PROFILE=stress BASE_URL=http://127.0.0.1:18080 k6 run k6/load-test.js

# через внешний Ingress
BASE_URL=https://api.example.com k6 run k6/load-test.js

# только доступность API, БД не требуется
TEST_MODE=health BASE_URL=http://127.0.0.1:18080 k6 run k6/load-test.js
```

## GitHub Container Registry

После создания репозитория и push в `main`, workflow публикует образ в GHCR:

```text
ghcr.io/<github-owner>/devops-test-service:main
```

Для тегов `v*` публикуется тег версии и SHA. После первого запуска workflow откройте **Packages → package settings** и при необходимости измените видимость пакета.
