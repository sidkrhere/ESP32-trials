#include <Arduino.h>
#include <Wire.h>

// Does a FAILED bus attempt poison the next one?
// (2,3) has nothing attached; (8,9) has the MPU6050.
static bool probe(uint8_t addr) {
  Wire.beginTransmission(addr);
  return Wire.endTransmission(true) == 0;
}

static void attempt(const char *label, int sda, int scl, uint32_t freq) {
  Wire.end();
  delay(20);
  bool began = Wire.begin(sda, scl, freq);
  Wire.setTimeOut(100);
  delay(20);
  Serial.printf("%-20s begin=%d  0x68=%s\n", label, began, probe(0x68) ? "ACK" : "---");
}

void setup() {
  Serial.begin(115200);
  delay(300);
  Serial.println("\n===== POISONING TEST =====");
}

void loop() {
  attempt("8/9 (baseline)", 8, 9, 400000);
  attempt("2/3 (empty)", 2, 3, 400000);
  attempt("8/9 (after fail)", 8, 9, 400000);
  attempt("2/3 (empty)", 2, 3, 100000);
  attempt("8/9 (after fail2)", 8, 9, 400000);
  Serial.println("===== END =====\n");
  delay(3000);
}
