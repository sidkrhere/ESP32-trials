# ESP32-C3 3D Rectangle Console

Real-time tilt-controlled 3D rectangle. An **ESP32-C3 Super Mini** reads an
**MPU6050** over I²C, fuses the accelerometer and gyroscope, and streams
pitch/roll to a **Three.js** page in your browser.

```
MPU6050 ──I²C──> ESP32-C3 Super Mini ──USB CDC (17-byte binary @100 Hz)──> Node server
                                                                              │
                                                              Socket.IO (binary) │ WebSocket
                                                                              ▼
                                                                     Three.js rectangle
```

Measured on this machine: **99.8 Hz** sensor rate, **0.1 ms** average
ESP32→browser latency, **60 fps** render.

---

## Run it

### 1. Flash the firmware (once, or after changing it)

Open the sketch in the Arduino IDE:

```
~/Documents/Arduino/3d_box/3d_box.ino
```

IDE settings (Tools menu):

| Setting | Value |
|---|---|
| Board | `ESP32C3 Dev Module` |
| USB CDC On Boot | **Enabled** |
| Flash Size | `4MB (32Mb)` |
| Flash Mode | `QIO` |
| Upload Speed | `921600` |

Then press **Upload**.

> The firmware probes **SDA=GPIO8 / SCL=GPIO9** first and falls back to
> **GPIO4 / GPIO5**, at 400 kHz then 100 kHz — so it works with either
> wiring without a recompile. The boot log tells you what it found:
>
> ```
> [esp] MPU6050 FOUND on SDA=GPIO8 SCL=GPIO9 @400000Hz (WHO_AM_I=0x70)
> [esp] calibrated: biasX=-5.87 biasY=0.22 biasZ=-0.54 deg/s  neutral pitch=2.63 roll=-0.06
> [esp] resting accel (g) = -0.047 -0.001 1.026   |a|=1.027
> ```

Hold the sensor still for ~1 s at boot — it uses that moment to measure the
gyro zero-rate offset and to set your "level" reference pose.

### 2. Start the host

```bash
cd ~/esp32-3d-viewer
npm install     # first time only
npm start
```

Then open **http://localhost:3000**

> **Close the Arduino IDE Serial Monitor first** — it holds
> `/dev/cu.usbmodem1101` exclusively and the server cannot open the port
> while it is open. The server prints a clear message if it is busy.

---

## The HUD

| Field | Meaning |
|---|---|
| `PITCH` / `ROLL` | Live tilt in degrees (relative to the pose captured at boot) |
| `YAW` | Gyro-integrated heading — drifts, shown for information only |
| `STATUS` | Link state: `CONNECTED` / `WAITING` / `ERROR` |
| `SENSOR` | Rate of the pose stream coming off the ESP32 (should be ~100 Hz) |
| `RENDER` | Browser render rate (~60 fps) |
| `LATENCY` | True end-to-end USB→browser latency |
| `I²C ERR` | Count of failed sensor transactions — should stay at 0 |

### Controls

* **Smoothing** (0–100 ms, default 25) — exponential smoothing of the
  rotation. 0 = raw, lowest latency.
* **Invert pitch / Invert roll** — flip a direction if it feels reversed.
  Saved to `localStorage`, no reflashing needed.
* **Apply yaw to rectangle** — off by default (yaw drifts).
* **Recalibrate neutral** — re-levels the rectangle against however you're
  holding the sensor *right now*.
* Drag to orbit the camera, scroll to zoom.

---

## Tools

```bash
npm run check:firmware    # parse the raw ESP32 stream: rate, CRC, pose
npm test                  # end-to-end test against the real ESP32
npm run test:fake         # end-to-end test against a simulated ESP32
npm run check:browser     # drive headless Chrome and print the HUD
```

`tools/firmware-check.js` also accepts `--no-recal` to skip the
recalibration it normally triggers.

---

## Notes on the hardware

**The module reports `WHO_AM_I = 0x70`, not `0x68`.** That is an
MPU-6500-class part (many "MPU6050" modules are actually MPU-6500 silicon).
The register map and scaling used here are identical for both, so no code
change is needed — but it does mean the AD0 pin must be **low** for the
address to be `0x68`.

**GPIO8 carries the onboard blue LED and GPIO9 is the boot-mode strapping
pin.** They work for I²C (proven above), but **GPIO4 / GPIO5 are the
better long-term choice**. To move: unplug `SDA` from `GPIO8` → `GPIO4`,
and `SCL` from `GPIO9` → `GPIO5`. The firmware will find it there
automatically — no reflashing.

**Bus speed:** the module works at both 400 kHz and 100 kHz, so the
firmware negotiates automatically. If you ever see I²C errors in the HUD,
drop to 100 kHz by removing the `400000UL` entry from `BUS_SPEEDS` in
`3d_box.ino`.

---

## Troubleshooting

**Server says the port is BUSY**
The Arduino IDE Serial Monitor has the port open. Close it.

**HUD shows `SENSOR -- Hz` but STATUS is CONNECTED**
No frames arriving. Check the firmware is flashed and the sensor is
detected (see the boot log lines above). The server prints `[esp] …` lines
for every message the ESP32 sends.

**Rectangle tilts the wrong way**
Tick *Invert pitch* / *Invert roll* in the UI. If it rotates in the wrong
axis, the sensor is mounted 90° off — re-orient the module so its **Z axis
points up** (the long edge of the GY-521 running away from you).

**Values drift when the sensor is still**
Re-run the calibration: power-cycle the ESP32, or press *Recalibrate
neutral* in the UI (keep the sensor still for the 1 s it takes).
