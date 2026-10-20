// =====================================================================
//  ESP32-C3 Super Mini  ->  MPU6050 tilt sensor -> USB CDC stream
//  Streams pitch / roll (degrees) to a host at 100 Hz as a binary frame.
//
//  Arduino IDE settings:
//    Board .............. ESP32C3 Dev Module
//    USB CDC On Boot .... Enabled
//    JTAG Adapter ....... Disabled   (GPIO4/GPIO5 are the chip's JTAG pins)
//    Flash Size ......... 4MB (32Mb)
//    Flash Mode ......... QIO
//    Upload Speed ....... 921600
//
//  NOTE: the Arduino IDE Serial Monitor locks the USB serial port.
//        Close it before running the Node host (npm start).
// =====================================================================

#include <Arduino.h>
#include <Wire.h>
#include <math.h>
#include <string.h>
#include <stdio.h>

// ------------------------------------------------------------------ PINS
// The MPU6050/6500 module is currently wired to SDA=GPIO8, SCL=GPIO9
// (the silkscreen SDA/SCL pads).  GPIO8 also carries the onboard LED and
// GPIO9 is the boot-mode strapping pin, so GPIO4/GPIO5 are the better
// long-term choice - the firmware probes both and uses whichever answers.
//
// NOTE: probe GPIO8/9 FIRST.  A failed probe of GPIO4/5 leaves the I2C
// peripheral in a state where the following GPIO8/9 attempt also fails,
// so the order matters.
static const uint8_t PIN_PAIRS[][2] = { { 8, 9 }, { 4, 5 } };
static const uint32_t BUS_SPEEDS[]  = { 400000UL, 100000UL };
static uint8_t activeSDA = 8;
static uint8_t activeSCL = 9;
static uint32_t activeSpeed = 400000UL;

#define MPU_ADDR     0x68

// --------------------------------------------------- MPU6050 REGISTERS
#define REG_SMPLRT_DIV   0x19
#define REG_CONFIG       0x1A
#define REG_GYRO_CONFIG  0x1B
#define REG_ACCEL_CONFIG 0x1C
#define REG_WHO_AM_I     0x75
#define REG_PWR_MGMT_1   0x6B
#define REG_ACCEL_XOUT_H 0x3B

// ---------------------------------------------- SENSOR SCALING / RANGES
// GYRO_CONFIG = 0x08 -> +/-500 deg/s -> 65.5 LSB per deg/s
// ACCEL_CONFIG= 0x08 -> +/-4 g        -> 8192 LSB per g
#define GYRO_LSB_PER_DPS  65.5f
#define ACCEL_LSB_PER_G   8192.0f

// ------------------------------------------------------- FILTER / TIMING
// Complementary filter: alpha = tau / (tau + dt).  tau is the time
// constant of the accel-correction path (smaller = tighter to the accel,
// larger = tighter to the gyro).
#define FILTER_TAU_S      0.040f
#define SENSOR_PERIOD_US  5000UL    // 200 Hz read + fuse
#define TX_PERIOD_US     10000UL    // 100 Hz transmit

// ------------------------------------------------------------- PROTOCOL
#define FRAME_MAGIC_DATA 0xA5
#define FRAME_MAGIC_LOG  0xA5
#define FRAME_MAGIC_LOG2 0x5B
#define FRAME_SIZE       17         // magic0 magic1 seq flags + 3*f32 + crc

// ---------------------------------------------------------------- STATE
static float    pitchDeg   = 0.0f;   // fused, absolute (gravity referenced)
static float    rollDeg    = 0.0f;
static float    yawDeg     = 0.0f;   // gyro integrated only -> drifts
static float    gyroBiasX  = 0.0f;   // deg/s
static float    gyroBiasY  = 0.0f;
static float    gyroBiasZ  = 0.0f;
static float    neutralPitch = 0.0f; // pose captured at calibration
static float    neutralRoll  = 0.0f;

static uint8_t  seq        = 0;
static uint8_t  i2cErrors  = 0;
static uint32_t lastSampleUs = 0;
static bool     haveSample = false;

// ---------------------------------------------------------- I2C HELPERS
static void writeReg(uint8_t reg, uint8_t val) {
  Wire.beginTransmission(MPU_ADDR);
  Wire.write(reg);
  Wire.write(val);
  if (Wire.endTransmission(true) != 0) {
    if (i2cErrors < 255) i2cErrors++;
  }
}

static uint8_t readReg(uint8_t reg) {
  Wire.beginTransmission(MPU_ADDR);
  Wire.write(reg);
  if (Wire.endTransmission(false) != 0) {
    if (i2cErrors < 255) i2cErrors++;
    return 0;
  }
  if (Wire.requestFrom(MPU_ADDR, (size_t)1, true) != 1) {
    if (i2cErrors < 255) i2cErrors++;
    return 0;
  }
  return (uint8_t)Wire.read();
}

// One 14-byte burst from 0x3B: accel(6) + temp(2) + gyro(6).
// Single transaction => accel and gyro come from the same sample instant.
static bool readBurst(uint8_t *buf, size_t n) {
  Wire.beginTransmission(MPU_ADDR);
  Wire.write(REG_ACCEL_XOUT_H);
  if (Wire.endTransmission(false) != 0) {
    if (i2cErrors < 255) i2cErrors++;
    return false;
  }
  if (Wire.requestFrom(MPU_ADDR, n, true) != n) {
    if (i2cErrors < 255) i2cErrors++;
    return false;
  }
  for (size_t i = 0; i < n; i++) buf[i] = (uint8_t)Wire.read();
  return true;
}

// -------------------------------------------------------------- CRC-8
static uint8_t crc8(const uint8_t *d, size_t n) {
  uint8_t c = 0;
  for (size_t i = 0; i < n; i++) {
    c ^= d[i];
    for (uint8_t b = 0; b < 8; b++) {
      c = (c & 0x80) ? (uint8_t)((c << 1) ^ 0x07) : (uint8_t)(c << 1);
    }
  }
  return c;
}

// ------------------------------------------------------- LOG FRAMING
// Debug output uses its own magic byte so it can never corrupt the
// binary pose stream.
static void logMsg(const char *msg) {
  char buf[160];
  size_t n = strlen(msg);
  if (n > 150) n = 150;
  buf[0] = (char)FRAME_MAGIC_LOG;
  buf[1] = (char)FRAME_MAGIC_LOG2;
  memcpy(buf + 2, msg, n);
  buf[2 + n] = '\n';
  Serial.write((const uint8_t *)buf, n + 3);
}

// ------------------------------------------------------- BUS DETECTION
// Try every (pin pair, bus speed) combination until the MPU6050 ACKs.
// Returns the WHO_AM_I value, or 0 if nothing answered.
static uint8_t detectMpu() {
  for (int p = 0; p < 2; p++) {
    for (int s = 0; s < 2; s++) {
      uint8_t sda = PIN_PAIRS[p][0];
      uint8_t scl = PIN_PAIRS[p][1];
      uint32_t speed = BUS_SPEEDS[s];

      Wire.end();
      delay(20);                       // let the peripheral manager settle
      Wire.begin(sda, scl, speed);
      Wire.setTimeOut(100);
      delay(20);

      // plain address probe first
      Wire.beginTransmission(MPU_ADDR);
      if (Wire.endTransmission(true) != 0) {
        char t[110];
        snprintf(t, sizeof(t), "SDA=GPIO%u SCL=GPIO%u @%luHz -> no ACK",
                 sda, scl, (unsigned long)speed);
        logMsg(t);
        continue;
      }

      // then read WHO_AM_I
      uint8_t who = readReg(REG_WHO_AM_I);
      if (who == 0) {
        logMsg("  ACK but WHO_AM_I read failed");
        continue;
      }

      activeSDA = sda;
      activeSCL = scl;
      activeSpeed = speed;

      char t[110];
      snprintf(t, sizeof(t), "MPU6050 FOUND on SDA=GPIO%u SCL=GPIO%u @%luHz (WHO_AM_I=0x%02X)",
               sda, scl, (unsigned long)speed, who);
      logMsg(t);
      return who;
    }
  }
  return 0;
}

// ---------------------------------------------------------- CALIBRATION
// Average the sensor while it is held still to get:
//   - the gyro zero-rate offset (MPU6050 ZRO is +/-20 deg/s)
//   - the "level" pose so the rectangle starts flat
static void calibrate() {
  logMsg("Hold the sensor perfectly still for 1 second...");

  const int N = 200;
  int32_t sumGx = 0, sumGy = 0, sumGz = 0;
  float    sumAccPitch = 0.0f, sumAccRoll = 0.0f;
  float    sumAx = 0.0f, sumAy = 0.0f, sumAz = 0.0f;
  int32_t  maxGyroMag = 0;

  for (int i = 0; i < N; i++) {
    uint8_t b[14];
    if (!readBurst(b, 14)) continue;
    int16_t gx = (int16_t)((b[8]  << 8) | b[9]);
    int16_t gy = (int16_t)((b[10] << 8) | b[11]);
    int16_t gz = (int16_t)((b[12] << 8) | b[13]);
    int16_t ax = (int16_t)((b[0]  << 8) | b[1]);
    int16_t ay = (int16_t)((b[2]  << 8) | b[3]);
    int16_t az = (int16_t)((b[4]  << 8) | b[5]);

    sumGx += gx; sumGy += gy; sumGz += gz;

    float axg = ax / ACCEL_LSB_PER_G;
    float ayg = ay / ACCEL_LSB_PER_G;
    float azg = az / ACCEL_LSB_PER_G;
    sumAx += axg; sumAy += ayg; sumAz += azg;
    sumAccPitch += atan2f(-axg, sqrtf(ayg * ayg + azg * azg)) * 57.29577951f;
    sumAccRoll  += atan2f(ayg, azg) * 57.29577951f;

    int32_t mag = abs(gx) + abs(gy) + abs(gz);
    if (mag > maxGyroMag) maxGyroMag = mag;

    delay(5);
  }

  gyroBiasX    = (sumGx / (float)N) / GYRO_LSB_PER_DPS;
  gyroBiasY    = (sumGy / (float)N) / GYRO_LSB_PER_DPS;
  gyroBiasZ    = (sumGz / (float)N) / GYRO_LSB_PER_DPS;
  neutralPitch = sumAccPitch / (float)N;
  neutralRoll  = sumAccRoll  / (float)N;
  sumAx /= (float)N; sumAy /= (float)N; sumAz /= (float)N;

  // seed the filter with the level pose so there is no startup transient
  pitchDeg = neutralPitch;
  rollDeg  = neutralRoll;
  yawDeg   = 0.0f;

  char m[200];
  snprintf(m, sizeof(m),
           "calibrated: biasX=%.2f biasY=%.2f biasZ=%.2f deg/s  neutral pitch=%.2f roll=%.2f",
           gyroBiasX, gyroBiasY, gyroBiasZ, neutralPitch, neutralRoll);
  logMsg(m);

  snprintf(m, sizeof(m),
           "resting accel (g) = %.3f %.3f %.3f   |a|=%.3f",
           sumAx, sumAy, sumAz,
           sqrtf(sumAx * sumAx + sumAy * sumAy + sumAz * sumAz));
  logMsg(m);

  if (maxGyroMag > 1200) {   // ~18 deg/s of movement during calibration
    logMsg("WARNING: sensor was moving during calibration - tilt offsets may be off.");
  }
}

// ------------------------------------------------------------ FUSION
// Complementary filter.  The gyro signs are derived from the accel
// angle formulas so both sources always agree:
//   rotation about X  ->  accRoll  = -theta_x   and  gx = +dtheta_x/dt
//   rotation about Y  ->  accPitch = -theta_y   and  gy = +dtheta_y/dt
static void fuse(const uint8_t *b, float dt) {
  int16_t ax = (int16_t)((b[0]  << 8) | b[1]);
  int16_t ay = (int16_t)((b[2]  << 8) | b[3]);
  int16_t az = (int16_t)((b[4]  << 8) | b[5]);
  int16_t gx = (int16_t)((b[8]  << 8) | b[9]);
  int16_t gy = (int16_t)((b[10] << 8) | b[11]);
  int16_t gz = (int16_t)((b[12] << 8) | b[13]);

  float gxd = gx / GYRO_LSB_PER_DPS - gyroBiasX;
  float gyd = gy / GYRO_LSB_PER_DPS - gyroBiasY;
  float gzd = gz / GYRO_LSB_PER_DPS - gyroBiasZ;

  float axg = ax / ACCEL_LSB_PER_G;
  float ayg = ay / ACCEL_LSB_PER_G;
  float azg = az / ACCEL_LSB_PER_G;

  float accRoll  = atan2f(ayg, azg) * 57.29577951f;
  float accPitch = atan2f(-axg, sqrtf(ayg * ayg + azg * azg)) * 57.29577951f;

  // adaptive trust: if |a| is far from 1g the accelerometer is being
  // disturbed by linear acceleration -> lean on the gyro instead
  float mag      = sqrtf(axg * axg + ayg * ayg + azg * azg);
  float disturb  = fabsf(mag - 1.0f);
  float t        = (disturb - 0.15f) / 0.35f;
  if (t < 0.0f) t = 0.0f;
  if (t > 1.0f) t = 1.0f;
  float alpha = FILTER_TAU_S / (FILTER_TAU_S + dt);
  alpha = alpha + (0.98f - alpha) * t;

  float predRoll  = rollDeg  - gxd * dt;
  float predPitch = pitchDeg - gyd * dt;

  rollDeg  = alpha * predRoll  + (1.0f - alpha) * accRoll;
  pitchDeg = alpha * predPitch + (1.0f - alpha) * accPitch;
  yawDeg  += gzd * dt;

  // keep yaw wrapped so it never grows unbounded
  if (yawDeg >  180.0f) yawDeg -= 360.0f;
  if (yawDeg < -180.0f) yawDeg += 360.0f;
}

// ----------------------------------------------------------- TX FRAME
static void sendFrame(bool valid) {
  uint8_t f[FRAME_SIZE];
  float   pitch = pitchDeg - neutralPitch;
  float   roll  = rollDeg  - neutralRoll;
  float   yaw   = yawDeg;

  f[0] = FRAME_MAGIC_DATA;
  f[1] = 0x5A;
  f[2] = seq++;
  f[3] = (uint8_t)((valid ? 0x01 : 0x00) |
                   (i2cErrors & 0x3F) << 2);   // bits 2..7 = error count (0..63)
  memcpy(f + 4,  &pitch, 4);
  memcpy(f + 8,  &roll,  4);
  memcpy(f + 12, &yaw,   4);
  f[16] = crc8(f, 16);

  Serial.write(f, FRAME_SIZE);
}

// ============================================================== SETUP
void setup() {
  Serial.setTxBufferSize(2048);   // must be set before begin()
  Serial.begin(115200);           // baud is ignored over native USB CDC
  Serial.setTimeout(10);

  // The WiFi/BT radio is never initialised (no WiFi.h), so it stays idle
  // and adds no interrupt jitter to the 200 Hz sensor loop.

  // ---- find the MPU6050 on whichever pin pair / bus speed answers
  uint8_t who = detectMpu();

  if (who == 0) {
    logMsg("ERROR: no MPU6050 responded on GPIO8/9 or GPIO4/5.");
    logMsg("Check: SDA, SCL, 3V3, GND.  Address 0x68 = AD0 pulled low.");
  }

  delay(120);

  // reset, then wake with the X gyro PLL as the clock reference
  writeReg(REG_PWR_MGMT_1, 0x80);
  delay(100);
  writeReg(REG_PWR_MGMT_1, 0x01);
  delay(10);

  writeReg(REG_CONFIG,       0x03);  // DLPF 44Hz accel / 42Hz gyro, Fs = 1kHz
  writeReg(REG_SMPLRT_DIV,   0x04);  // 1000/(1+4) = 200 Hz
  writeReg(REG_GYRO_CONFIG,  0x08);  // +/-500 deg/s
  writeReg(REG_ACCEL_CONFIG, 0x08);  // +/-4 g
  delay(10);

  logMsg("MPU6050 ready. Calibrating...");

  // let the sensor settle, then calibrate
  delay(300);
  calibrate();

  logMsg("Streaming pitch/roll at 100 Hz. Open the host viewer.");
  lastSampleUs = micros();
}

// =============================================================== LOOP
void loop() {
  static uint32_t nextSample = 0;
  static uint32_t nextTx     = 0;
  static uint32_t nextPoll   = 0;
  static bool     recalibReq = false;

  uint32_t now = micros();

  // ---- poll the host for commands (throttled to 20 ms)
  if ((int32_t)(now - nextPoll) >= 0) {
    nextPoll += 20000UL;
    if ((int32_t)(now - nextPoll) > 0) nextPoll = now + 20000UL;
    while (Serial.available() > 0) {
      int c = Serial.read();
      if (c == 'C' || c == 'c') recalibReq = true;
    }
  }

  // ---- host asked for a fresh level reference
  if (recalibReq) {
    recalibReq = false;
    logMsg("Recalibration requested by host.");
    calibrate();
    lastSampleUs = micros();
  }

  // ---- sample + fuse at 200 Hz
  if ((int32_t)(now - nextSample) >= 0) {
    nextSample += SENSOR_PERIOD_US;
    if ((int32_t)(now - nextSample) > 0) nextSample = now + SENSOR_PERIOD_US;

    uint8_t b[14];
    if (readBurst(b, 14)) {
      float dt = (lastSampleUs == 0) ? 0.005f
                : (float)(now - lastSampleUs) / 1000000.0f;
      lastSampleUs = now;
      if (dt < 0.0005f) dt = 0.0005f;
      if (dt > 0.100f) dt = 0.100f;
      fuse(b, dt);
      haveSample = true;
    } else {
      haveSample = false;
    }
  }

  // ---- transmit at 100 Hz
  if ((int32_t)(now - nextTx) >= 0) {
    nextTx += TX_PERIOD_US;
    if ((int32_t)(now - nextTx) > 0) nextTx = now + TX_PERIOD_US;
    sendFrame(haveSample);
  }
}
