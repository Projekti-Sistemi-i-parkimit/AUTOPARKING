# Hardueri — Arduino Uno, 7 × HC-SR04, Servo (Barriera)

Konfigurimi i plotë i prototipit: **6 vende parkimi me sensorë** (A-P1 … A-P6),
**1 sensor hyrjeje** para barrierës dhe **1 servo** që ngre/ul barrierën.
Firmware: [`arduino/parkimi-7-sensore/parkimi-7-sensore.ino`](../arduino/parkimi-7-sensore/parkimi-7-sensore.ino).

## 1. Skema e pinave (Arduino Uno, ATmega328P)

| Funksioni            | TRIG | ECHO | Shënim |
|----------------------|:----:|:----:|--------|
| Vendi **A-P1**       | D2   | D3   | |
| Vendi **A-P2**       | D4   | D5   | |
| Vendi **A-P3**       | D6   | D7   | |
| Vendi **A-P4**       | D8   | D9   | |
| Vendi **A-P5**       | D10  | D11  | |
| Vendi **A-P6**       | D12  | D13  | D13 ndan LED-in e bordit — s'pengon ECHO-n si hyrje |
| **Sensori i hyrjes** | A0   | A1   | pinat analogë përdoren si digjitalë |
| **Servo (sinjali)**  | A2   | —    | libraria `Servo` punon në çdo pin |
| Të lira              | A3, A4, A5 | | A4/A5 = I²C, të rezervuara për LCD në të ardhmen |

D0/D1 mbeten të lira — i përdor komunikimi USB Serial (9600 baud).
**Bilanci i pinave:** 14 (7 sensorë × 2) + 1 (servo) = 15 nga 18 pina I/O të përdorshëm.

## 2. Ushqimi elektrik — ANALIZË E DETYRUESHME

| Komponenti | Rryma tipike | Rryma maksimale |
|---|---|---|
| HC-SR04 (×7) | ~15 mA secili ≈ 105 mA | ~140 mA |
| Servo SG90 në lëvizje | 100–250 mA | **deri ~650 mA në bllokim (stall)** |
| Arduino vetë | ~50 mA | — |

Porti USB jep maksimumi ~500 mA dhe rregullatori 5V i Uno-s nxehet shpejt.
**Përfundimi: servoja NUK lidhet kurrë te pini 5V i Arduino-s.** Një servo e
bllokuar mund ta rrëzojë tensionin dhe të shkaktojë rindezje (reset) ose dëmtim.

**Lidhja e rekomanduar:**

```
Burim i jashtëm 5V ≥ 2A (adapter ose 4×AA)
 ├── Servo  VCC (tela e kuqe)
 ├── HC-SR04 VCC (të 7-të, përmes shinës + të breadboard-it)
 └── GND ───┬── Servo GND ──┬── HC-SR04 GND (×7)
            └── Arduino GND  ← GND I PËRBASHKËT — I DETYRUESHËM!
Arduino ushqehet veçmas nga USB (i cili jep edhe serialin te kompjuteri).
```

Rregulla sigurie:
- **GND i përbashkët** mes burimit të jashtëm dhe Arduino-s — pa të, sinjalet
  TRIG/ECHO/servo s'kanë referencë dhe sillen në mënyrë kaotike.
- Mos e lidh kurrë 5V-në e jashtme me pinin **5V** të Arduino-s njëkohësisht me USB-në.
- Kondensator 470–1000 µF paralel me ushqimin e servos zbut pikun e nisjes.
- Kontrollo polaritetin para ndezjes; telat e kuq/zi konsistentë në breadboard.

## 3. Breadboard-i dhe kabllimi

1. Shina **+** e breadboard-it → 5V e burimit të jashtëm; shina **–** → GND e përbashkët.
2. Çdo HC-SR04: VCC → shina +, GND → shina –, TRIG/ECHO → pinat sipas tabelës.
3. Sensorët montohen horizontalisht në nivelin e "veturave" (miniaturave), me
   fushëpamje të lirë — pa kabllo apo mure para membranës.
4. Servo: kafe → GND, e kuqe → 5V e jashtme, portokalli → A2.
5. Distanca mes sensorëve fqinjë ≥ 8–10 cm për të ulur interferencën; firmware-i
   gjithsesi i lexon një nga një me pauzë 50 ms.

## 4. Si funksionon firmware-i

- **Filtrim:** mediana e 3 matjeve për çdo sensor (heq pikat ekstreme).
- **Histerezë:** zihet në ≤ 3.0 cm, lirohet vetëm në ≥ 4.0 cm — pa dridhje
  gjendjeje kur objekti është saktësisht te pragu.
- **Debounce:** gjendja ndryshon vetëm pas 2 cikleve të njëpasnjëshme konsistente.
- **Makina e gjendjeve e barrierës:** `CLOSED → (veturë e detektuar 2 cikle) →
  OPEN (servo 90°) → (hyrja lirohet) → HOLDING (4 s) → CLOSED (servo 0°)`;
  çdo kalim raportohet në serial.
- **Pa echo** = "Problem teknik" (`ok:0`) — backend-i e shënon vendin `unknown`,
  kurrë "i lirë".

## 5. Protokolli serial (9600 baud, një JSON për rresht)

```json
{"t":"spots","d":[{"s":1,"cm":4.2,"ok":1},{"s":2,"cm":-1,"ok":0}, ...]}
{"t":"gate","e":"entry"}
{"t":"barrier","s":"open"}
{"t":"barrier","s":"closed"}
```

- `s` = numri i vendit (1–6 → `A-P1` … `A-P6`), `cm` = distanca e filtruar
  (−1 = pa echo), `ok` = matje e vlefshme.
- Ura (faqja **Admin → Lidhja Arduino**, Web Serial) i përkthen këto në thirrje
  drejt backend-it me çelësin API: `POST /api/sensor`, `POST /api/events`,
  `POST /api/barrier`. Formati i vjetër tekstual i prototipit me 2 sensorë
  mbështetet ende (ura i njeh të dy formatet).

## 6. Modalitetet e punës

| Modaliteti | Si aktivizohet | Burimi i të dhënave |
|---|---|---|
| **REAL** | Admin → Lidhja Arduino → *Lidh USB* | Firmware-i përmes Web Serial |
| **DEMO** | Admin → Lidhja Arduino → *Fillo demon* | Simulim (valë sinusoidale, 6 vendet) |

Demo shënohet qartë: në log (`[demo]`), te statusi i faqes dhe me shenjën
**⚠ DEMO** në shiritin e navigimit në çdo faqe. Kalimi mes modaliteteve s'kërkon
rindërtim — janë dy butona. Të dhënat e simuluara nuk paraqiten kurrë si matje reale.

## 7. Komponentët që duhen blerë/siguruar ende

- 5 × HC-SR04 shtesë (ekzistojnë 2 nga prototipi i parë)
- 1 × servo SG90 + zgjatuese krahu për barrierën
- Burim 5V ≥ 2A (ose mbajtëse 4×AA) + kondensator 470–1000 µF
- Breadboard i dytë dhe ~30 tela jumper shtesë