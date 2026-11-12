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

Shënim: `GF_SECURITY_ADMIN_PASSWORD` vlen vetëm në inicializimin e PARË të
volumit `grafana_data` — nëse fjalëkalimi ndryshohet në UI, ai i ri mbetet.

Grafana lidhet automatikisht me Prometheus (provisioning) dhe ngarkon
**10 dashboard-e** në dosjen *Parkimi* (tema e bardhë, refresh 15s, time picker):

| UID | Dashboard | Përmbajtja |
|---|---|---|
| `parkimi-sys` | System Overview | uptime, databaza, HTTP req/5xx/p50-p95 (origjinali, i paprekur) |
| `parking-overview` | Parking Overview | zënia totale, sektorët, barriera, hyrje/dalje |
| `sector-a-monitoring` | Sector A — Physical Prototype | statuset nga sensorët, distancat, freskia e sinjalit |
| `sector-b-monitoring` | Sector B — Online Parking | zënia + rezervimet e sektorit B |
| `sector-c-monitoring` | Sector C — Online Parking | zënia + rezervimet e sektorit C |
| `arduino-monitoring` | Arduino Sensor Monitoring | vjetërsia e sinjalit, ritmi i matjeve, defektet |
| `reservations-analytics` | Reservations Analytics | rezervimet aktive, suksesi/dështimet, trendet |
| `api-performance` | API Performance | req/s, statuset, metodat, p50/p95, 5xx |
| `database-health` | Database Health | db_up, madhësia e skedarit, rritja e tabelave |
| `security-admin` | Security & Admin Activity | hyrjet/dështimet, veprimet administrative, sesionet |

Ndarja e të dhënave: Sektori A (prototipi fizik Arduino) ka vetëm metrika
sensorësh; sektorët B/C (online) kanë vetëm zënie + rezervime — pa përzierje.

## Alertet (devops/prometheus/alerts.yml)

8 rregulla në 4 grupe, të dukshme te http://localhost:9090/alerts —
`BackendOffline`, `DatabaseUnavailable`, `MetricsMissing`, `SensorOffline`,
`SectorASpotsUnknown`, `Http5xxSpike`, `ApiLatencyHigh`, `ReservationErrors`.
Pa Alertmanager alertet vetëm shfaqen në Prometheus (s'dërgohen njoftime).

## Metrikat e backend-it

`GET /metrics` (formati i tekstit të Prometheus-it, pa varësi të jashtme):

- `parkimi_http_requests_total{method,status}` — numëruesi i kërkesave
- `parkimi_http_request_errors_total` — përgjigjet 5xx
- `parkimi_http_request_duration_seconds` — histogram i kohëzgjatjes
- `parkimi_uptime_seconds` — uptime i procesit
- `parkimi_db_up` — 1 nëse databaza përgjigjet, 0 ndryshe
- `parkimi_spots_total{sector}` / `parkimi_spot_status{sector,status}` — vendet
- `parkimi_reservations_active{sector}` / `parkimi_reservation_requests_total{outcome}` — rezervimet
- `parkimi_parking_sessions_active{sector}` / `_completed` — qëndrimet
- `parkimi_sensor_distance_cm{spot}` / `_last_reading_age_seconds{spot}` / `_readings_total` / `_faults_total` — sensorët e Sektorit A
- `parkimi_barrier_state{status}` / `parkimi_gate_events_total{type}` / `parkimi_qr_scans_total` — porta/QR
- `parkimi_audit_events_total{action}` / `parkimi_admin_sessions_active` / `parkimi_admin_users_total` / `parkimi_visitor_tokens_total` — siguria
- `parkimi_db_size_bytes` — madhësia e SQLite

Metrikat janë vetëm numërues anonimë — asnjë kredencial, token, targë apo
e dhënë personale. Dështimi i monitorimit nuk e prek aplikacionin.

## Ndalja

```bash
docker compose --profile monitoring down   # të dhënat e Prometheus/Grafana RUHEN në volume
```
