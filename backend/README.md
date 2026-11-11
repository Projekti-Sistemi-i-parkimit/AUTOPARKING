# Backend — Parkimi Inteligjent

REST API + komunikim në kohë reale (SSE) për sistemin e monitorimit të parkimit.
Teknologjitë: **Node.js (Express) + SQLite (better-sqlite3)** — sipas arkitekturës së README-së kryesore.

## Nisja lokale

Kërkohet Node.js 20+.

```bash
cd backend
npm install
cp .env.example .env        # vendos ADMIN_PASSWORD etj.
npm run seed                # krijon adminin + çelësin API të urës (shfaqet VETËM një herë)
npm start                   # http://localhost:3000
```

- Dashboard-i (shërbehet nga dosja `frontend/`): `http://localhost:3000/`
- Dokumentimi i API-së (Swagger UI): `http://localhost:3000/api/docs`
- Specifikimi OpenAPI: `http://localhost:3000/api/openapi.json`

Gjatë zhvillimit: `npm run dev` (rinis automatikisht në ndryshime).

## Testet

```bash
npm test
```

39 teste me `node:test` (pa varësi shtesë): vendet, sensorët, hyrje/dalje, barriera,
QR, autentikimi/RBAC, çelësat API, rezervimet dhe SSE.

## Variablat e mjedisit (.env)

| Variabla | Përshkrimi | Default |
|---|---|---|
| `PORT` | Porta e serverit | `3000` |
| `DB_PATH` | Skedari SQLite | `./data/parking.db` |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | Admini fillestar (vetëm për seed) | — |
| `BRIDGE_API_KEY` | Çelësi i urës; bosh = gjenerohet nga seed | — |
| `SESSION_TTL_HOURS` | Kohëzgjatja e sesionit të adminit | `12` |
| `OCC_THRESHOLD_CM` | Pragu "i zënë" | `3` |
| `MAX_RANGE_CM` | Rrezja maksimale "i lirë" | `10` |

`.env` nuk futet kurrë në Git; përdor `.env.example` si shabllon.

## Autentikimi

- **Adminët** (`/api/admin/*`): `POST /api/admin/login` → Bearer token (sesion në DB, ruhet si hash,
  skadon pas `SESSION_TTL_HOURS`). Rolet: `admin` (menaxhon përdoruesit, çelësat, audit log-un)
  dhe `operator` (qasje bazë). Fjalëkalimet me **scrypt**; veprimet regjistrohen në `audit_log`.
- **Ura e Arduino-s** (`POST /api/sensor|/api/events|/api/barrier`): header `x-api-key`.
  Në DB ruhet vetëm hash-i SHA-256 i çelësit; çelësi i plotë shfaqet vetëm në krijim.
- **Vizitorët** (`/api/login`, `/api/reserve`): token i thjeshtë për rezervime — kontrata
  ekzistuese e frontend-it.

## Në kohë reale (SSE)

`GET /api/realtime` — në frontend:

```js
const es = new EventSource("/api/realtime");  // rilidhje automatike
es.addEventListener("spot_update", (e) => console.log(JSON.parse(e.data)));
```

Ngjarjet: `spot_update`, `stats`, `gate_event`, `barrier_update`, `reservation`, `qr_scan`.
Dërgohen vetëm kur ka ndryshim real (dedupe në server).

## Ura e Arduino-s

Frontend-i ekzistues (Web Serial) vazhdon të punojë pa ndryshime: lexon serialin dhe
dërgon `POST /api/sensor` me `x-api-key`. Formati:

```json
{ "spots": [ { "key": "A-P1", "cm": 2.1 }, { "key": "A-P2", "status": "free" } ] }
```

Nëse dërgohet vetëm `cm`, statusi klasifikohet në server sipas pragjeve (≤3cm e zënë, ≤10cm e lirë,
ndryshe/pa echo `unknown`). Identifikuesi stabil ndërmjet komponentëve është `spot_key` (`A-P1`).

## Databaza

SQLite, krijohet automatikisht në nisje. Tri grupe tabelash me pronësi:

- **parking** (Erdi): `spots`, `spot_status`, `sensor_readings`, `parking_sessions`,
  `reservations`, `gate_events`, `barrier_state`, `barrier_events`
- **qr** (Isra): `qr_codes`, `qr_scans`
- **auth** (Emir): `admin_users`, `api_keys`, `audit_log`, `admin_sessions`, `visitor_tokens`

Skema: `src/db/schema.sql`. Ndryshimet në grupet e të tjerëve koordinohen paraprakisht.

## Deploy (koordinohet me Blendin)

1. Server me Node.js 20+ (ose një PaaS si Railway/Render/Fly.io).
2. `npm ci && npm run seed && npm start` me `.env` të konfiguruar (mos e përdor `.env` e zhvillimit).
3. SQLite ruhet në `DB_PATH` — sigurohu që disku të jetë i qëndrueshëm (volume).
4. Vendos HTTPS përpara (reverse proxy), sepse token-ët udhëtojnë në header.
5. Për QR nga telefonat, aplikacioni duhet të jetë i arritshëm në rrjet/publik —
   vendos URL-në publike te fusha "Linku publik i faqes" në dashboard.