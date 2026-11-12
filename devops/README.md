# DevOps — Monitorimi lokal (Prometheus + Grafana)

Monitorimi është **vetëm lokal** (profil i veçantë i Docker Compose, i lidhur në
127.0.0.1) dhe **nuk deployohet në Render**.

## Nisja

```bash
docker compose --profile monitoring up -d
```

| Shërbimi   | URL                     | Shënime                                        |
|------------|-------------------------|------------------------------------------------|
| Prometheus | http://localhost:9090   | skrapon `backend:3000/metrics` çdo 15s          |
| Grafana    | http://localhost:3001   | login: `admin` / `GRAFANA_ADMIN_PASSWORD` nga `.env` (default `admin`) |

Grafana lidhet automatikisht me Prometheus (provisioning) dhe ngarkon
dashboard-in **"Parkimi Inteligjent — Sistemi"** në dosjen *Parkimi*:
kërkesat HTTP sipas statusit/metodës, p50/p95 e kohëzgjatjes, gabimet 5xx,
uptime dhe shëndeti i databazës.

## Metrikat e backend-it

`GET /metrics` (formati i tekstit të Prometheus-it, pa varësi të jashtme):

- `parkimi_http_requests_total{method,status}` — numëruesi i kërkesave
- `parkimi_http_request_errors_total` — përgjigjet 5xx
- `parkimi_http_request_duration_seconds` — histogram i kohëzgjatjes
- `parkimi_uptime_seconds` — uptime i procesit
- `parkimi_db_up` — 1 nëse databaza përgjigjet, 0 ndryshe

Metrikat janë vetëm numërues anonimë — asnjë kredencial, token, targë apo
e dhënë personale. Dështimi i monitorimit nuk e prek aplikacionin.

## Ndalja

```bash
docker compose --profile monitoring down   # të dhënat e Prometheus/Grafana RUHEN në volume
```
