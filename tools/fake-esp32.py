#!/usr/bin/env python3
"""
Creates a pseudo-terminal pair and plays the part of the ESP32-C3:
streams 17-byte binary pose frames at 100 Hz plus a few log lines.

Used by tools/integration-test.js to exercise the whole host pipeline
(server -> socket.io -> client) without the real hardware attached.

Prints the slave device path on stdout, then streams forever.
"""

import os
import pty
import struct
import sys
import time
import tty

FRAME_SIZE = 17


def crc8(data):
    c = 0
    for b in data:
        c ^= b
        for _ in range(8):
            c = ((c << 1) ^ 0x07) & 0xFF if c & 0x80 else (c << 1) & 0xFF
    return c


master, slave = pty.openpty()

# raw mode: no echo, no newline translation, binary safe
tty.setraw(slave)
tty.setraw(master)

slave_name = os.ttyname(slave)
print(slave_name, flush=True)


def log(msg):
    body = msg.encode("utf8")
    os.write(master, bytes([0xA5, 0x5B]) + body + b"\n")


def frame(seq, pitch, roll, yaw, flags=0x01):
    payload = struct.pack("<fff", pitch, roll, yaw)
    head = bytes([0xA5, 0x5A, seq & 0xFF, flags])
    body = head + payload
    return body + bytes([crc8(body)])


log("fake ESP32 starting")
time.sleep(0.4)
log("MPU6050 found on SDA=GPIO4 SCL=GPIO5")
log("calibrated: biasX=0.12 biasY=-0.31 biasZ=0.04 deg/s  neutral pitch=0.00 roll=0.00")

seq = 0
t0 = time.time()
next_tx = t0

while True:
    now = time.time()
    if now >= next_tx:
        next_tx += 0.01  # 100 Hz
        el = now - t0
        pitch = 30.0 * __import__("math").sin(el * 1.7)
        roll = 25.0 * __import__("math").sin(el * 0.9 + 1.0)
        yaw = 45.0 * __import__("math").sin(el * 0.4)
        os.write(master, frame(seq, pitch, roll, yaw))
        seq += 1
        if seq % 100 == 0:
            log("stream ok seq=%d" % seq)
    time.sleep(0.001)
