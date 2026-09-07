# HTTPS PostgreSQL API

Минимальный сервис для технического собеседования: HTTPS API выполняет `INSERT` и `SELECT` в PostgreSQL. При запуске сам создаёт таблицу `records`.

## API

| Method | Path | Result |
| --- | --- | --- |
| `POST` | `/api/v1/records` | Создаёт запись: `{"value":"text"}`; ответ `201` |
| `GET` | `/api/v1/records` | Возвращает до 100 последних записей |
| `GET` | `/healthz` | Проверка процесса |

## Локальный запуск с HTTPS

Нужны Docker и Docker Compose. Для демо создайте самоподписанный сертификат (сертификаты не коммитятся):

```bash
mkdir certs
openssl req -x509 -newkey rsa:2048 -nodes -days 7 \
  -keyout certs/tls.key -out certs/tls.crt -subj '/CN=localhost'
docker compose up --build -d
curl --cacert certs/tls.crt https://localhost:8443/healthz
curl --cacert certs/tls.crt -X POST https://localhost:8443/api/v1/records \
  -H 'Content-Type: application/json' -d '{"value":"first record"}'
curl --cacert certs/tls.crt https://localhost:8443/api/v1/records
```

В реальном окружении передайте сертификат от ingress/cert-manager или секретом Kubernetes в пути из `TLS_CERT_FILE` и `TLS_KEY_FILE`. `DATABASE_URL` обязателен и не должен попадать в Git.

## Нагрузочный тест

Тест использует [k6](https://grafana.com/docs/k6/latest/). Он по HTTPS создаёт запись, затем читает список; пороги: ошибок меньше 1%, p95 меньше 500 мс.

```bash
# самоподписанный сертификат только для локального прогона
INSECURE_TLS=true BASE_URL=https://localhost:8443 k6 run k6/load-test.js

# production: TLS проверяется по умолчанию
BASE_URL=https://api.example.com k6 run k6/load-test.js
```

## GitHub Container Registry

После создания репозитория и push в `main`, workflow публикует образ в GHCR:

```text
ghcr.io/<github-owner>/https-postgres-api:main
```

Для тегов `v*` публикуется тег версии и SHA. После первого запуска workflow откройте **Packages → package settings** и при необходимости измените видимость пакета.
