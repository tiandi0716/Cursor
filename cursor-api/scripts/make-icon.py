#!/usr/bin/env python3
"""Write a 1024x1024 PNG app icon (dark tile + blue chevron)."""
from __future__ import annotations

import struct
import zlib
from pathlib import Path


def png(width: int, height: int, rgba: bytes) -> bytes:
    def chunk(tag: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    raw = b""
    stride = width * 4
    for y in range(height):
        raw += b"\x00" + rgba[y * stride : (y + 1) * stride]
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )


def pixel(x: int, y: int, n: int) -> bytes:
    nx = (x + 0.5) / n
    ny = (y + 0.5) / n
    # rounded-ish dark background
    m = 0.06
    inside = m < nx < 1 - m and m < ny < 1 - m
    r = g = b = 24 if inside else 0
    a = 255 if inside else 0
    # chevron: triangle pointing up, then a cut
    cx, cy = 0.5, 0.48
    dx, dy = nx - cx, ny - cy
    in_tri = dy > -0.28 and abs(dx) < 0.28 * (0.55 - dy) / 0.55 and dy < 0.22
    notch = dy > 0.02 and abs(dx) < 0.12 and dy < 0.22
    if inside and in_tri and not notch:
        r, g, b = 91, 156, 246
    return bytes((r, g, b, a))


def main() -> None:
    n = 1024
    buf = bytearray()
    for y in range(n):
        for x in range(n):
            buf.extend(pixel(x, y, n))
    out = Path(__file__).resolve().parents[1] / "build" / "icon.png"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(png(n, n, bytes(buf)))
    print("wrote", out)


if __name__ == "__main__":
    main()
