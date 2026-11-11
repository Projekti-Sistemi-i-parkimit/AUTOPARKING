# Si kontribuojmë — Rrjedha e punës me Git

Rregullat e ekipit për modulet STC & SEW. Qëllimi: askush s'ia prish punën tjetrit.

## Degët

- **`main`** — gjithmonë funksionale; këtu futet kod VETËM përmes Pull Request-eve.
- **Dega personale / e veçorisë** — e gjithë puna bëhet aty:
  ```bash
  git checkout main && git pull
  git checkout -b <emri>/<veçoria>     # p.sh. emir/backend-m1-m6, isra/qr-faqja
  ```

## Commit-et

- Commit-e të vogla e të shpeshta; mesazhi tregon ÇFARË dhe PSE:
  - ✅ `Add admin gate control endpoint and serve frontend/ directory`
  - ❌ `fix`, `ndryshime`, `test2`
- Mos commit-o kurrë: `.env`, `backend/data/`, `node_modules/` (janë në `.gitignore`).
- Para çdo push-i: `cd backend && npm test` — të 40 testet duhet të kalojnë.

## Pull Request-et

1. Push degën tënde: `git push -u origin <dega>`.
2. Hap PR drejt `main` me përshkrim: çfarë u bë, si testohet, çfarë prek.
3. Të paktën **një anëtar tjetër** e shikon para merge-it (Erblin koordinon).
4. Pas merge-it, fshije degën dhe bëj `git pull` në `main`.

## E NDALUAR

- `git push --force` në `main` ose në degën e dikujt tjetër.
- Reset/fshirje commit-esh të publikuara.
- Ndryshime në skemat e databazës së tjetrit pa koordinim
  (parking → Erdi, qr → Isra, auth → Emir).
- Merge i degës së vet pa review.

## Pronësia e moduleve

| Zona | Pronari | Ku ndodhet |
|---|---|---|
| Arduino / firmware | Erblin | `arduino/` |
| Frontend / QR | Isra | `frontend/` |
| Skema parking e DB | Erdi | `backend/src/db/schema.sql` (grupi parking) |
| Backend / API / auth / DevOps | Emir | `backend/` |
| Rrjeti / hardueri fizik / deploy | Blend | `docs/HARDWARE.md` |
| Dokumentimi / testimi | Loresa | `docs/` |

Ndryshimet ndërkufitare diskutohen paraprakisht në grupin e ekipit.

## Mjedisi lokal

```bash
cd backend
npm install
cp .env.example .env    # plotëso ADMIN_PASSWORD
npm run seed            # admini + çelësi API i urës (shfaqet vetëm një herë)
npm start               # http://localhost:3000
npm test                # 40 teste
```