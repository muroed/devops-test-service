# PostgreSQL API

Минимальный сервис для технического собеседования: API выполняет `INSERT` и `SELECT` в PostgreSQL. При запуске сам создаёт таблицу `records`.

## API

| Method | Path | Result |
| --- | --- | --- |
| `POST` | `/api/v1/records` | Создаёт запись: `{"value":"text"}`; ответ `201` |
| `GET` | `/api/v1/records` | Возвращает до 100 последних записей |
| `GET` | `/healthz` | Проверка процесса |

## Локальный запуск

Нужны Docker и Docker Compose:

```bash
docker compose up --build -d
curl http://localhost:8080/healthz
curl -X POST http://localhost:8080/api/v1/records \
  -H 'Content-Type: application/json' -d '{"value":"first record"}'
curl http://localhost:8080/api/v1/records
```

В Kubernetes приложение слушает HTTP на порту `8080`. TLS завершают Ingress NGINX и cert-manager; `Service` должен направлять HTTP-трафик на `targetPort: 8080`. `DATABASE_URL` обязателен и не должен попадать в Git.

## Нагрузочный тест

Тест использует [k6](https://grafana.com/docs/k6/latest/). Он создаёт запись, затем читает список; пороги: ошибок меньше 1%, p95 меньше 500 мс.

```bash
# локально
BASE_URL=http://localhost:8080 k6 run k6/load-test.js

# через внешний Ingress
BASE_URL=https://api.example.com k6 run k6/load-test.js
```

## GitHub Container Registry

После создания репозитория и push в `main`, workflow публикует образ в GHCR:

```text
ghcr.io/<github-owner>/postgres-api:main
```

Для тегов `v*` публикуется тег версии и SHA. После первого запуска workflow откройте **Packages → package settings** и при необходимости измените видимость пакета.
