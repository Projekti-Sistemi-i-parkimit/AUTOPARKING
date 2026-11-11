/*
 * PARKIMI INTELIGJENT — Firmware për Arduino Uno (ATmega328P)
 * ----------------------------------------------------------
 * Harduer:
 *   - 6 × HC-SR04  : vendet e parkimit A-P1 … A-P6
 *   - 1 × HC-SR04  : sensori i hyrjes (para barrierës)
 *   - 1 × Servo    : barriera e hyrjes (SG90 ose i ngjashëm)
 *
 * Skema e pinave (shih docs/HARDWARE.md për kabllimin e plotë):
 *   Vendi   TRIG  ECHO
 *   P1      D2    D3
 *   P2      D4    D5
 *   P3      D6    D7
 *   P4      D8    D9
 *   P5      D10   D11
 *   P6      D12   D13
 *   HYRJA   A0    A1
 *   SERVO   A2    (sinjali; ushqimi NGA BURIM I JASHTËM 5V, jo nga Arduino!)
 *   Të lira A3, A4, A5 (p.sh. LCD I2C në A4/A5 në të ardhmen)
 *
 * KUJDES USHQIMI: servoja dhe 7 sensorët NUK ushqehen nga pini 5V i
 * Arduino-s — përdor burim të jashtëm 5V (≥2A) me GND TË PËRBASHKËT.
 *
 * Protokolli serial (9600 baud, një objekt JSON për rresht):
 *   {"t":"spots","d":[{"s":1,"cm":4.2,"ok":1}, …]}   çdo cikël leximi
 *   {"t":"gate","e":"entry"}                          veturë u fut nga hyrja
 *   {"t":"barrier","s":"open"} / {"s":"closed"}       gjendja e barrierës
 *
 * Teknika kundër leximeve të gabuara:
 *   - mediana e 3 matjeve për sensor (filtrim i pikëve ekstreme)
 *   - histerezë: zihet në ≤ 3.0 cm, lirohet në ≥ 4.0 cm (zonë e vdekur)
 *   - debounce: gjendja ndryshon vetëm pas 2 cikleve të njëpasnjëshme
 *   - sensorët lexohen një nga një me pauzë, që të mos interferojnë
 */

#include <Servo.h>

// ---------- Konfigurimi ----------
const uint8_t NUM_SPOTS = 6;
const uint8_t TRIG[NUM_SPOTS] = {2, 4, 6, 8, 10, 12};
const uint8_t ECHO[NUM_SPOTS] = {3, 5, 7, 9, 11, 13};
const uint8_t ENTRY_TRIG = A0;
const uint8_t ENTRY_ECHO = A1;
const uint8_t SERVO_PIN  = A2;

const float OCC_ON_CM    = 3.0;   // ≤ → i zënë (hyrja e histerezës)
const float OCC_OFF_CM   = 4.0;   // ≥ → i lirë  (dalja e histerezës)
const float MAX_RANGE_CM = 10.0;  // > → jashtë rrezes së maketës
const float ENTRY_CM     = 5.0;   // veturë para barrierës

const uint8_t  DEBOUNCE_CYCLES   = 2;     // cikle të njëpasnjëshme para ndryshimit
const uint16_t SENSOR_GAP_MS     = 50;    // pauzë ndërmjet sensorëve
const uint16_t CYCLE_GAP_MS      = 150;   // pauzë ndërmjet cikleve të plota
const uint32_t ECHO_TIMEOUT_US   = 25000; // ~4.3 m maksimum
const uint16_t BARRIER_HOLD_MS   = 4000;  // qëndron hapur pasi hyrja lirohet
const uint8_t  SERVO_CLOSED_DEG  = 0;
const uint8_t  SERVO_OPEN_DEG    = 90;

// ---------- Gjendja ----------
Servo barrier;

struct SpotState {
  float   cm;        // matja e fundit e filtruar (-1 = pa echo)
  bool    occupied;  // gjendja e qëndrueshme (pas debounce)
  uint8_t pending;   // sa cikle rresht ka kandidaturë për ndryshim
};
SpotState spots[NUM_SPOTS];

enum GateState { GATE_CLOSED, GATE_OPEN, GATE_HOLDING };
GateState gateState = GATE_CLOSED;
uint8_t  entryPending = 0;      // debounce i sensorit të hyrjes
uint32_t gateClearSince = 0;    // kur u lirua hyrja (për vonesën e mbylljes)

// ---------- Matja ----------
float readDistanceOnce(uint8_t trigPin, uint8_t echoPin) {
  digitalWrite(trigPin, LOW);
  delayMicroseconds(3);
  digitalWrite(trigPin, HIGH);
  delayMicroseconds(10);
  digitalWrite(trigPin, LOW);
  unsigned long us = pulseIn(echoPin, HIGH, ECHO_TIMEOUT_US);
  if (us == 0) return -1.0;             // pa echo brenda kohës
  return us * 0.0343 / 2.0;
}

// Mediana e 3 matjeve — heq pikët ekstreme pa kosto memorieje.
float readDistanceMedian(uint8_t trigPin, uint8_t echoPin) {
  float a = readDistanceOnce(trigPin, echoPin); delay(10);
  float b = readDistanceOnce(trigPin, echoPin); delay(10);
  float c = readDistanceOnce(trigPin, echoPin);
  // nëse ndonjëra dështoi, kthe maksimumin e të vlefshmeve ose -1
  if (a < 0 || b < 0 || c < 0) {
    float best = max(a, max(b, c));
    return best;                        // -1 nëse të tria dështuan
  }
  if (a > b) { float t = a; a = b; b = t; }
  if (b > c) { float t = b; b = c; c = t; }
  if (a > b) { float t = a; a = b; b = t; }
  return b;
}

// ---------- Logjika e vendeve ----------
void updateSpot(uint8_t i) {
  float d = readDistanceMedian(TRIG[i], ECHO[i]);
  spots[i].cm = d;

  bool candidate = spots[i].occupied;
  if (d >= 0) {
    if (!spots[i].occupied && d <= OCC_ON_CM)  candidate = true;   // histereza: ndez
    if ( spots[i].occupied && d >= OCC_OFF_CM) candidate = false;  // histereza: fik
  }
  // pa echo (d < 0) → mbaj gjendjen; backend-i e shënon "unknown" nga ok:0

  if (candidate != spots[i].occupied) {
    if (++spots[i].pending >= DEBOUNCE_CYCLES) {
      spots[i].occupied = candidate;
      spots[i].pending = 0;
    }
  } else {
    spots[i].pending = 0;
  }
}

// ---------- Barriera (makinë gjendjesh) ----------
void setBarrier(bool open) {
  barrier.write(open ? SERVO_OPEN_DEG : SERVO_CLOSED_DEG);
  Serial.print(F("{\"t\":\"barrier\",\"s\":\""));
  Serial.print(open ? F("open") : F("closed"));
  Serial.println(F("\"}"));
}

void updateGate() {
  float d = readDistanceMedian(ENTRY_TRIG, ENTRY_ECHO);
  bool vehicle = (d >= 0 && d <= ENTRY_CM);

  switch (gateState) {
    case GATE_CLOSED:
      if (vehicle) {
        if (++entryPending >= DEBOUNCE_CYCLES) {
          entryPending = 0;
          gateState = GATE_OPEN;
          Serial.println(F("{\"t\":\"gate\",\"e\":\"entry\"}"));
          setBarrier(true);
        }
      } else entryPending = 0;
      break;

    case GATE_OPEN:                      // hapur, vetura ende para sensorit
      if (!vehicle) {
        gateState = GATE_HOLDING;
        gateClearSince = millis();
      }
      break;

    case GATE_HOLDING:                   // vetura kaloi — prit pak, pastaj mbyll
      if (vehicle) { gateState = GATE_OPEN; break; }
      if (millis() - gateClearSince >= BARRIER_HOLD_MS) {
        gateState = GATE_CLOSED;
        setBarrier(false);
      }
      break;
  }
}

// ---------- Dalja serial ----------
void printSpots() {
  Serial.print(F("{\"t\":\"spots\",\"d\":["));
  for (uint8_t i = 0; i < NUM_SPOTS; i++) {
    if (i) Serial.print(',');
    Serial.print(F("{\"s\":"));
    Serial.print(i + 1);
    Serial.print(F(",\"cm\":"));
    if (spots[i].cm < 0) Serial.print(F("-1"));
    else Serial.print(spots[i].cm, 1);
    Serial.print(F(",\"ok\":"));
    Serial.print(spots[i].cm < 0 ? 0 : 1);
    Serial.print('}');
  }
  Serial.println(F("]}"));
}

// ---------- Nisja dhe cikli ----------
void setup() {
  Serial.begin(9600);
  for (uint8_t i = 0; i < NUM_SPOTS; i++) {
    pinMode(TRIG[i], OUTPUT);
    pinMode(ECHO[i], INPUT);
    digitalWrite(TRIG[i], LOW);
    spots[i] = {-1.0, false, 0};
  }
  pinMode(ENTRY_TRIG, OUTPUT);
  pinMode(ENTRY_ECHO, INPUT);
  digitalWrite(ENTRY_TRIG, LOW);

  barrier.attach(SERVO_PIN);
  setBarrier(false);                     // nis i mbyllur, gjendje e njohur
}

void loop() {
  for (uint8_t i = 0; i < NUM_SPOTS; i++) {
    updateSpot(i);
    delay(SENSOR_GAP_MS);                // shmang interferencën ultrasonike
  }
  updateGate();
  printSpots();
  delay(CYCLE_GAP_MS);
}
