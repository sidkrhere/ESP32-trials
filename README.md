# ESP32-C3 3D Rectangle Console

Real-time, tilt-controlled 3D rectangle. An **ESP32-C3 Super Mini** reads an
**MPU6050** over I²C, fuses the accelerometer and gyroscope into a stable
pitch/roll, and streams it to a **Three.js** page in your browser.

```
  MPU6050 / MPU-6500                ESP32-C3 Super Mini
  ┌──────────────┐                  ┌──────────────────────┐
  │  GY-521      │   SDA ──────────►│ GPIO8 (or GPIO4)    │
  │  module      │   SCL ──────────►│ GPIO9 (or GPIO5)    │
  │  addr 0x68   │   3V3 ◄──────────│ 3V3                 │
  │  WHO_AM_I    │   GND ───────────│ GND                 │
  │    = 0x70    │                  └──────────┬───────────┘
  └──────────────┘                             │ USB-C
                                     native USB Serial/JTAG
                                     17-byte binary frames @ 100 Hz
                                                 │
                                                 ▼
                                    ┌────────────────────────┐
                                    │  Node host (server.js) │
                                    │  Express + Socket.IO   │
                                    └───────────┬────────────┘
                                                │ WebSocket (binary)
                                                ▼
                                    ┌────────────────────────┐
                                    │  Three.js rectangle    │
                                    │  60 fps, ~0.1 ms lag   │
                                    └────────────────────────┘
```

**Measured on an M-series MacBook Air:**

| Metric | Value |
|---|---|
| Sensor stream rate | **99.8 Hz** |
| Latency, ESP32 → browser | **0.11 ms** avg, 0.60 ms max |
| Render rate | **60 fps** |
| CRC errors / I²C errors | **0 / 0** |
| Firmware footprint | 24 % flash, 4 % RAM |

---

## Table of contents

1. [Hardware](#hardware)
2. [Installation](#installation)
3. [Running it](#running-it)
4. [Using the viewer](#using-the-viewer)
5. [Wire protocol](#wire-protocol)
6. [How the fusion works](#how-the-fusion-works)
7. [Project layout](#project-layout)
8. [Troubleshooting](#troubleshooting)

---

## Hardware

### ESP32-C3 Super Mini

The board exposes 16 castellated pins (2.54 mm pitch, 22.5 × 18 mm):

| Pin | GPIO | Function | Notes |
|---|---|---|---|
| 1 | — | `5V` | power input (5 V from USB VBUS) |
| 2 | — | `GND` | ground |
| 3 | — | `3V3` | 3.3 V output from the LDO |
| 4 | 0 | `IO0` | safe; ADC1_CH0; boot button |
| 5 | 1 | `IO1` | safe; ADC1_CH1 |
| 6 | 2 | `IO2` | **strapping**; ADC1_CH2 |
| 7 | 3 | `IO3` | safe; ADC1_CH3 |
| 8 | 4 | `IO4` | ADC1_CH4; JTAG (MTMS) |
| 9 | 5 | `IO5` | ADC2_CH0; JTAG (MTDI) |
| 10 | 6 | `IO6` | SPI; JTAG (MTCK) |
| 11 | 7 | `IO7` | SPI; JTAG (MTDO) |
| 12 | 8 | `IO8` `SDA` | **strapping**; onboard blue LED (active-low) |
| 13 | 9 | `IO9` `SCL` | **strapping**; BOOT button |
| 14 | 10 | `IO10` | safe; SPI CS |
| 15 | 21 | `TX` | UART0 TX |
| 16 | 20 | `RX` | UART0 RX |

Key facts that shape this project:

* **Native USB.** The USB-C connector goes straight to the chip's
  USB-Serial/JTAG peripheral (GPIO18/19) — there is no CP2102 bridge.
  It enumerates as `USB JTAG/serial debug unit`, VID:PID `303a:1001`, and
  appears as `/dev/cu.usbmodemXXXX`. The "baud rate" is meaningless here;
  USB defines the rate.
* **No FPU.** The C3 is RV32IMC, so all floating point is soft. The
  firmware avoids `double` and heavy trig in the hot loop, and the browser
  does the pretty maths.
* **Strapping pins** are GPIO2, GPIO8 and GPIO9. GPIO9 additionally
  selects the boot mode (LOW = UART download), so keep it high at reset.
* **Onboard blue LED is on GPIO8**, active-low. It does not stop the pin
  working as I²C, but the LED does light up during bus traffic.
* **GPIO4/GPIO5 are the chip's default JTAG pins** (MTMS/MTDI). Keep
  *JTAG Adapter: Disabled* in the Arduino IDE if you use them for I²C.
* **4 MB flash, 400 KB SRAM, 160 MHz** single core.

### MPU6050 module (GY-521 style)

| Property | Value |
|---|---|
| I²C address | `0x68` (AD0 low) / `0x69` (AD0 high) |
| `WHO_AM_I` observed | **`0x70`** |
| Pull-ups | 4.7 kΩ to 3.3 V, on the module |
| Supply | 3.3 V or 5 V (onboard LDO) |

> ⚠️ **`WHO_AM_I = 0x70` means the chip is MPU-6500-class silicon**, not a
> true MPU-6050 — many modules sold as "MPU6050" are actually MPU-6500.
> The register map, scaling and I²C address used by this firmware are
> identical for both, so nothing needs changing; it simply confirms that
> AD0 must be **low** for the address to be `0x68`.

Registers used by the firmware:

| Register | Value | Effect |
|---|---|---|
| `0x6B` PWR_MGMT_1 | `0x80` → `0x01` | reset, then wake using the X-gyro PLL as clock reference |
| `0x1A` CONFIG | `0x03` | DLPF: 41 Hz accel / 44 Hz gyro, Fs = 1 kHz |
| `0x19` SMPLRT_DIV | `0x04` | 1000/(1+4) = **200 Hz** output data rate |
| `0x1B` GYRO_CONFIG | `0x08` | ±500 °/s → **65.5 LSB per °/s** |
| `0x1C` ACCEL_CONFIG | `0x08` | ±4 g → **8192 LSB per g** |
| `0x3B` | — | 14-byte burst read: accel(6) + temp(2) + gyro(6) |
| `0x75` WHO_AM_I | — | chip identification |

### Wiring

**Currently in use** (works out of the box, no reflash needed):

```
   GY-521 module                     ESP32-C3 Super Mini
   ┌────────────┐
   │  VCC  3.3V ├──────────────────► 3V3
   │  GND       ├──────────────────► GND
   │  SDA       ├──────────────────► GPIO8   (silkscreen "SDA")
   │  SCL       ├──────────────────► GPIO9   (silkscreen "SCL")
   └────────────┘
```

**Recommended** (moves the bus off the LED and the boot strapping pin):

```
   │  SDA       ├──────────────────► GPIO4   (silkscreen "IO4" / "A4")
   │  SCL       ├──────────────────► GPIO5   (silkscreen "IO5" / "A5")
```

The firmware probes **GPIO8/9 first, then GPIO4/5**, at **400 kHz then
100 kHz**, and uses whichever combination answers. A failed probe does not
poison the next one. So **no reflash is needed when you move the wires** —
just unplug and replug. The server console tells you what was found:

```
[esp] MPU6050 FOUND on SDA=GPIO8 SCL=GPIO9 @400000Hz (WHO_AM_I=0x70)
```

### Mounting orientation

The accelerometer measures *gravity*, so the sensor's **Z axis should point
up** when the rectangle should appear flat — i.e. lay the module flat with
the chip face up, long edge running away from you.

If the rectangle rotates about the wrong axis, the module is mounted 90°
off; rotate it in the breadboard until Z points up.

The firmware captures your *actual* resting pose at boot as the neutral
reference, so a module sitting at a slight angle still starts flat.

### Bus speed

The module works at both 400 kHz and 100 kHz, so the firmware negotiates
automatically. If you ever see I²C errors in the HUD, remove the
`400000UL` entry from `BUS_SPEEDS` in `firmware/3d_box/3d_box.ino` to
force 100 kHz.

---

## Installation

### Requirements

* macOS / Linux (the host uses a POSIX serial device path)
* **Node.js ≥ 18** — `node --version`
* **Arduino IDE 2.x** with the *esp32 by Espressif Boards* core (tested
  with **3.3.12**), *or* standalone `arduino-cli`
* An ESP32-C3 Super Mini and an MPU6050/6500 module on a breadboard

### 1. Host

```bash
git clone <this-repo> esp32-3d-viewer
cd esp32-3d-viewer
npm install
```

### 2. Firmware

**Option A — one command** (needs the Arduino IDE's core installed, or
`arduino-cli`):

```bash
./tools/flash.sh
```

**Option B — Arduino IDE**

1. *File → Open* → `firmware/3d_box/3d_box.ino`
   (or open the symlink `~/Documents/Arduino/3d_box`)
2. *Tools* menu:

   | Setting | Value |
   |---|---|
   | Board | `ESP32C3 Dev Module` |
   | USB CDC On Boot | **Enabled** |
   | JTAG Adapter | Disabled |
   | Flash Size | `4MB (32Mb)` |
   | Flash Mode | `QIO` |
   | Upload Speed | `921600` |

3. Press **Upload**.

**Option C — `arduino-cli`**

```bash
arduino-cli compile --fqbn esp32:esp32:esp32c3:CDCOnBoot=cdc firmware/3d_box
arduino-cli upload  --fqbn esp32:esp32:esp32c3:CDCOnBoot=cdc \
                    -p /dev/cu.usbmodem1101 firmware/3d_box
```

After flashing, the boot log (visible in the server console or the
Arduino IDE Serial Monitor) should read:

```
[esp] MPU6050 FOUND on SDA=GPIO8 SCL=GPIO9 @400000Hz (WHO_AM_I=0x70)
[esp] MPU6050 ready. Calibrating...
[esp] Hold the sensor perfectly still for 1 second...
[esp] calibrated: biasX=-5.87 biasY=0.22 biasZ=-0.54 deg/s  neutral pitch=2.63 roll=-0.06
[esp] resting accel (g) = -0.047 -0.001 1.026   |a|=1.027
[esp] Streaming pitch/roll at 100 Hz. Open the host viewer.
```

> **Hold the sensor perfectly still for the first second after boot.** That
> window is used to measure the gyroscope zero-rate offset (the MPU's ZRO
> tolerance is ±20 °/s) and to capture your level reference pose.

---

## Running it

```bash
cd esp32-3d-viewer
npm start
```

Then open **<http://localhost:3000>**.

> ⚠️ **Close the Arduino IDE Serial Monitor first.** It holds
> `/dev/cu.usbmodem1101` exclusively, and the host cannot open the port
> while it is open. The server prints a clear message if the port is busy.

The server auto-detects the port (by known path, then by scanning
`/dev/cu.usbmodem*`), and auto-reconnects if the ESP32 is unplugged or
reset — including when it re-enumerates under a new name.

To point it at a specific device:

```bash
ESP32_PORT=/dev/cu.usbmodem1401 npm start
```

---

## Using the viewer

### HUD

| Field | Meaning |
|---|---|
| `PITCH` / `ROLL` | Live tilt in degrees, relative to the pose captured at boot |
| `YAW` | Gyro-integrated heading — drifts, shown for information only |
| `STATUS` | `CONNECTED` / `WAITING` / `ERROR` |
| `SENSOR` | Rate of the pose stream coming off the ESP32 (expect ~100 Hz) |
| `RENDER` | Browser render rate (expect ~60 fps) |
| `LATENCY` | True end-to-end USB → browser latency |
| `I²C ERR` | Failed sensor transactions — should stay at 0 |

### Controls

* **Smoothing** (0–100 ms, default 25) — exponential smoothing of the
  rotation. 0 = raw, lowest latency; higher = smoother but laggier.
* **Invert pitch / Invert roll** — flip a direction if it feels reversed.
  Saved to `localStorage`; no reflashing needed.
* **Apply yaw to rectangle** — off by default (yaw drifts without a
  magnetometer).
* **Recalibrate neutral** — re-level the rectangle against however you are
  holding the sensor *right now*. Keep it still for the ~1 s it takes.
* Drag to orbit the camera, scroll to zoom.

### Diagnostics

```bash
npm run check:firmware    # parse the raw ESP32 stream: rate, CRC, pose values
npm test                  # end-to-end test against the real ESP32
npm run test:fake         # end-to-end test against a simulated ESP32 (pty)
npm run check:browser     # drive headless Chrome and print the HUD
./tools/flash.sh mpu_diag # flash the pin/speed sweep diagnostic sketch
```

`tools/firmware-check.js` accepts `--no-recal` to skip the recalibration
it normally triggers.

---

## Wire protocol

**ESP32 → host**, over USB CDC. Fixed 17-byte frames, little-endian:

| Offset | Type | Field |
|---|---|---|
| 0 | `uint8` | `0xA5` (sync) |
| 1 | `uint8` | `0x5A` = data frame, `0x5B` = log line |
| 2 | `uint8` | sequence number (wraps at 256) |
| 3 | `uint8` | flags: bit0 = sensor valid, bits 2-7 = I²C error count (0-63) |
| 4 | `float32` | pitch, degrees |
| 8 | `float32` | roll, degrees |
| 12 | `float32` | yaw, degrees (gyro-integrated, drifts) |
| 16 | `uint8` | CRC-8 (poly 0x07) over bytes 0-15 |

A log frame is `0xA5 0x5B <utf-8 text> '\n'` — a separate magic byte means
debug text can never corrupt the data stream.

**Host → ESP32**: a single ASCII byte.

* `C` — redo the startup calibration (re-level against the current pose)

**host → browser**, over Socket.IO, a 22-byte binary packet:

| Offset | Type | Field |
|---|---|---|
| 0 | `uint8` | sequence number |
| 1 | `uint8` | flags (same as above) |
| 2 | `float32` | pitch |
| 6 | `float32` | roll |
| 10 | `float32` | yaw |
| 14 | `float64` | host `performance.now()` stamp, for latency |

Latency is measured by comparing the browser's `performance.now()` against
the host stamp; the running minimum absorbs the constant offset between
the two clock epochs.

---

## How the fusion works

A pure accelerometer cannot measure *rotation* — any hand movement reads
as tilt, and the result lags badly. A pure gyroscope integrates smoothly
but drifts. The firmware fuses them with a complementary filter whose
gyro signs are derived from the accelerometer angle formulas, so the two
sources always agree:

```
accRoll  = atan2(ay, az)
accPitch = atan2(-ax, sqrt(ay² + az²))

predRoll  = roll  - gx·dt        // gyro X drives roll
predPitch = pitch - gy·dt        // gyro Y drives pitch

roll  = α·predRoll  + (1-α)·accRoll
pitch = α·predPitch + (1-α)·accPitch
```

with `α = τ / (τ + dt)`, `τ = 40 ms`. The filter runs at 200 Hz (the
sensor's output data rate) while transmission runs at 100 Hz.

Two robustness details:

* **Adaptive trust.** If `|a|` drifts more than 0.15 g from 1 g, the
  accelerometer is being disturbed by linear acceleration, so `α` is
  raised towards 0.98 and the gyro takes over.
* **Bias calibration.** The zero-rate offset is measured during the first
  second of stillness and subtracted, which is what keeps the resting
  angle from creeping.

The browser then applies ~25 ms of frame-rate-independent smoothing along
the shortest rotational path (`Quaternion.slerp`), which keeps the motion
smooth without gimbal artefacts.

---

## Project layout

```
esp32-3d-viewer/
├── firmware/
│   ├── 3d_box/3d_box.ino      # main firmware: sensor, fusion, binary stream
│   └── mpu_diag/mpu_diag.ino   # pin-pair / bus-speed sweep diagnostic
├── public/
│   ├── index.html              # HUD markup + import map
│   ├── main.js                 # Three.js scene, socket handling, smoothing
│   └── styles.css              # HUD styling
├── tools/
│   ├── flash.sh                # compile + upload helper
│   ├── firmware-check.js       # raw stream parser / health check
│   ├── integration-test.js     # end-to-end test (real device or --fake)
│   ├── browser-check.js        # drives headless Chrome via DevTools
│   └── fake-esp32.py           # simulated ESP32 on a pseudo-terminal
├── server.js                   # Express + Socket.IO host
├── package.json
└── README.md
```

The sketchbook folders `~/Documents/Arduino/3d_box` and `~/Documents/Arduino/mpu_diag`
are symlinks into `firmware/`, so the Arduino IDE and the repository never
drift apart.

---

## Troubleshooting

**Server says the port is BUSY**
The Arduino IDE Serial Monitor has the port open. Close it, then restart
the server.

**HUD shows `SENSOR -- Hz` but STATUS is CONNECTED**
No frames are arriving. Check the firmware is flashed and the sensor was
detected — the server prints every `[esp] …` message the device sends.
Re-flash with `./tools/flash.sh`.

**`I²C ERR` climbing**
The bus is marginal. Force 100 kHz by removing `400000UL` from
`BUS_SPEEDS` in `firmware/3d_box/3d_box.ino`, and re-flash. Also check
that the module's `VCC` really is connected.

**The rectangle tilts the wrong way**
Tick *Invert pitch* / *Invert roll* in the UI. No reflashing needed.

**The rectangle rotates about the wrong axis**
The module is mounted 90° off. Re-orient it so its Z axis points up.

**Values drift while the sensor is still**
Recalibrate: power-cycle the ESP32 and keep it still for the first
second, or press *Recalibrate neutral* in the UI.

**The page is blank / `Three.js` fails to load**
`three` is served from `node_modules` at `/vendor/three`. Run
`npm install` in the project root.
