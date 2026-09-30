#!/usr/bin/env python3
"""Generate app-icon candidates for Cursor 工作台.

Philosophy: Cursor-like dark IDE chrome + multi-channel AI (not locked to one vendor).

Usage:
  python3 scripts/make-icon.py              # all candidates → build/candidates/
  python3 scripts/make-icon.py workbench    # one variant → build/icon.png
  python3 scripts/make-icon.py --list
"""
from __future__ import annotations

import math
import struct
import sys
import zlib
from pathlib import Path

# Brand (client/src/styles.css), lifted slightly for icon legibility
BG = (24, 24, 24)
WINDOW = (36, 36, 36)
BORDER = (55, 55, 55)
LINE = (92, 92, 92)
LINE_DIM = (72, 72, 72)
ACCENT = (91, 156, 246)  # --accent #5b9cf6
ACCENT2 = (129, 140, 248)  # indigo channel
ACCENT3 = (52, 211, 153)  # mint channel (multi-AI hint)
BUBBLE = (78, 78, 78)
TITLE = (42, 42, 42)
DOT = (110, 110, 110)


# ── PNG / geometry primitives ───────────────────────────────────────────────


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


def clamp01(v: float) -> float:
    return 0.0 if v < 0 else 1.0 if v > 1 else v


def mix(a: tuple[int, int, int], b: tuple[int, int, int], t: float) -> tuple[int, int, int]:
    t = clamp01(t)
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))  # type: ignore[return-value]


def cover(dst: list[int], color: tuple[int, int, int], alpha: float) -> None:
    a = clamp01(alpha)
    if a <= 0:
        return
    if a >= 1:
        dst[0], dst[1], dst[2], dst[3] = color[0], color[1], color[2], 255
        return
    oa = dst[3] / 255.0
    na = a + oa * (1 - a)
    if na <= 0:
        dst[0] = dst[1] = dst[2] = dst[3] = 0
        return
    for i in range(3):
        dst[i] = int((color[i] * a + dst[i] * oa * (1 - a)) / na)
    dst[3] = int(na * 255)


def rounded_rect_sdf(px: float, py: float, x0: float, y0: float, x1: float, y1: float, r: float) -> float:
    cx = (x0 + x1) * 0.5
    cy = (y0 + y1) * 0.5
    hw = (x1 - x0) * 0.5
    hh = (y1 - y0) * 0.5
    r = min(r, hw, hh)
    dx = abs(px - cx) - (hw - r)
    dy = abs(py - cy) - (hh - r)
    ax = max(dx, 0.0)
    ay = max(dy, 0.0)
    return math.hypot(ax, ay) + min(max(dx, dy), 0.0) - r


def circle_sdf(px: float, py: float, cx: float, cy: float, r: float) -> float:
    return math.hypot(px - cx, py - cy) - r


def segment_sdf(px: float, py: float, ax: float, ay: float, bx: float, by: float, thick: float) -> float:
    abx, aby = bx - ax, by - ay
    apx, apy = px - ax, py - ay
    den = abx * abx + aby * aby
    t = 0.0 if den == 0 else clamp01((apx * abx + apy * aby) / den)
    qx, qy = ax + abx * t, ay + aby * t
    return math.hypot(px - qx, py - qy) - thick * 0.5


def new_buf(n: int) -> list[list[list[int]]]:
    return [[[0, 0, 0, 0] for _ in range(n)] for _ in range(n)]


def fill_sdf(buf: list[list[list[int]]], n: int, sdf_fn, color: tuple[int, int, int], edge: float = 1.0) -> None:
    for y in range(n):
        py = y + 0.5
        row = buf[y]
        for x in range(n):
            px = x + 0.5
            d = sdf_fn(px, py)
            a = clamp01(0.5 - d / edge)
            if a > 0:
                cover(row[x], color, a)


def fill_round_rect(
    buf: list[list[list[int]]],
    n: int,
    x0: float,
    y0: float,
    x1: float,
    y1: float,
    r: float,
    color: tuple[int, int, int],
    edge: float = 1.2,
) -> None:
    y_lo = max(0, int(y0 - edge - r - 2))
    y_hi = min(n, int(y1 + edge + r + 3))
    x_lo = max(0, int(x0 - edge - r - 2))
    x_hi = min(n, int(x1 + edge + r + 3))
    for y in range(y_lo, y_hi):
        py = y + 0.5
        row = buf[y]
        for x in range(x_lo, x_hi):
            px = x + 0.5
            d = rounded_rect_sdf(px, py, x0, y0, x1, y1, r)
            a = clamp01(0.5 - d / edge)
            if a > 0:
                cover(row[x], color, a)


def fill_circle(
    buf: list[list[list[int]]],
    n: int,
    cx: float,
    cy: float,
    r: float,
    color: tuple[int, int, int],
    edge: float = 1.0,
) -> None:
    y_lo = max(0, int(cy - r - edge - 2))
    y_hi = min(n, int(cy + r + edge + 3))
    x_lo = max(0, int(cx - r - edge - 2))
    x_hi = min(n, int(cx + r + edge + 3))
    for y in range(y_lo, y_hi):
        py = y + 0.5
        row = buf[y]
        for x in range(x_lo, x_hi):
            px = x + 0.5
            d = circle_sdf(px, py, cx, cy, r)
            a = clamp01(0.5 - d / edge)
            if a > 0:
                cover(row[x], color, a)


def fill_segment(
    buf: list[list[list[int]]],
    n: int,
    ax: float,
    ay: float,
    bx: float,
    by: float,
    thick: float,
    color: tuple[int, int, int],
    edge: float = 1.0,
) -> None:
    pad = thick + edge + 2
    y_lo = max(0, int(min(ay, by) - pad))
    y_hi = min(n, int(max(ay, by) + pad + 1))
    x_lo = max(0, int(min(ax, bx) - pad))
    x_hi = min(n, int(max(ax, bx) + pad + 1))
    for y in range(y_lo, y_hi):
        py = y + 0.5
        row = buf[y]
        for x in range(x_lo, x_hi):
            px = x + 0.5
            d = segment_sdf(px, py, ax, ay, bx, by, thick)
            a = clamp01(0.5 - d / edge)
            if a > 0:
                cover(row[x], color, a)


def fill_rect(
    buf: list[list[list[int]]],
    n: int,
    x0: float,
    y0: float,
    x1: float,
    y1: float,
    color: tuple[int, int, int],
    edge: float = 0.9,
) -> None:
    for y in range(max(0, int(y0 - 2)), min(n, int(y1 + 3))):
        py = y + 0.5
        row = buf[y]
        for x in range(max(0, int(x0 - 2)), min(n, int(x1 + 3))):
            px = x + 0.5
            dx = max(x0 - px, 0.0, px - x1)
            dy = max(y0 - py, 0.0, py - y1)
            d = math.hypot(dx, dy) if dx > 0 or dy > 0 else -min(px - x0, x1 - px, py - y0, y1 - py)
            a = clamp01(0.5 - d / edge)
            if a > 0:
                cover(row[x], color, a)


def flatten(buf: list[list[list[int]]], n: int) -> bytes:
    out = bytearray()
    for y in range(n):
        for x in range(n):
            out.extend(buf[y][x])
    return bytes(out)


def scale_nearest(rgba: bytes, src: int, dst: int) -> bytes:
    out = bytearray(dst * dst * 4)
    for y in range(dst):
        sy = min(src - 1, int((y + 0.5) * src / dst))
        for x in range(dst):
            sx = min(src - 1, int((x + 0.5) * src / dst))
            si = (sy * src + sx) * 4
            di = (y * dst + x) * 4
            out[di : di + 4] = rgba[si : si + 4]
    return bytes(out)


def body_tile(buf: list[list[list[int]]], n: int) -> tuple[float, float, float]:
    """Draw dark rounded app tile. Returns (body0, body1, body_r)."""
    m = 0.06 * n
    body0, body1 = m, n - m
    body_r = 0.22 * (body1 - body0)
    fill_round_rect(buf, n, body0, body0, body1, body1, body_r, BG, edge=1.5)
    return body0, body1, body_r


def window_frame(
    buf: list[list[list[int]]],
    n: int,
    body0: float,
    body1: float,
    pad: float = 0.10,
    with_title: bool = True,
) -> tuple[float, float, float, float, float]:
    """Inner IDE window. Returns win0, win1, content_top, content_bot, title_h."""
    win0 = body0 + pad * n
    win1 = body1 - pad * n
    win_r = 0.09 * (win1 - win0)
    ring = 0.010 * n
    fill_round_rect(buf, n, win0 - ring, win0 - ring, win1 + ring, win1 + ring, win_r + ring, BORDER, edge=1.0)
    fill_round_rect(buf, n, win0, win0, win1, win1, win_r, WINDOW, edge=1.0)

    title_h = 0.09 * (win1 - win0) if with_title else 0.0
    if with_title:
        fill_rect(buf, n, win0 + 1, win0 + 1, win1 - 1, win0 + title_h, TITLE, edge=0.8)
        dot_y = win0 + title_h * 0.5
        dot_r = 0.014 * n
        for i, col in enumerate((DOT, (90, 90, 90), (90, 90, 90))):
            dx = win0 + 0.05 * n + i * 0.045 * n
            fill_circle(buf, n, dx, dot_y, dot_r, col, edge=0.7)

    content_top = win0 + title_h + 0.025 * n
    content_bot = win1 - 0.04 * n
    return win0, win1, content_top, content_bot, title_h


# ── Variants ────────────────────────────────────────────────────────────────


def paint_workbench(n: int) -> bytes:
    """A · 三栏工作台 — files | editor+caret | chat. Pure Cursor-layout mark."""
    buf = new_buf(n)
    body0, body1, _ = body_tile(buf, n)
    win0, win1, ct, cb, _ = window_frame(buf, n, body0, body1)

    cl, cr = win0 + 0.035 * n, win1 - 0.035 * n
    cw, ch = cr - cl, cb - ct
    g = 0.022 * n
    left_w, mid_w = cw * 0.18, cw * 0.44
    x_l0, x_l1 = cl, cl + left_w
    x_m0, x_m1 = x_l1 + g, x_l1 + g + mid_w
    x_r0, x_r1 = x_m1 + g, cr

    fill_rect(buf, n, x_l1 + g * 0.3, ct, x_l1 + g * 0.55, cb, BORDER, edge=0.6)
    fill_rect(buf, n, x_m1 + g * 0.3, ct, x_m1 + g * 0.55, cb, BORDER, edge=0.6)

    line_h = max(4.0, ch * 0.07)
    gap = ch * 0.09
    tree_x0 = x_l0 + cw * 0.015
    for i, (ind, wf) in enumerate(((0.0, 0.82), (0.18, 0.72), (0.18, 0.64), (0.0, 0.76), (0.18, 0.58))):
        y = ct + ch * 0.06 + i * (line_h + gap)
        if y + line_h > cb:
            break
        x0 = tree_x0 + ind * left_w
        fill_round_rect(buf, n, x0, y, x0 + wf * left_w, y + line_h, line_h * 0.45, LINE if i % 2 == 0 else LINE_DIM)

    code_x0 = x_m0 + cw * 0.012
    code_r = x_m1 - cw * 0.015
    for i, wf in enumerate((0.90, 0.74, 0.82, 0.58, 0.70, 0.45)):
        y = ct + ch * 0.06 + i * (line_h + gap * 0.82)
        if y + line_h > cb - ch * 0.04:
            break
        fill_round_rect(buf, n, code_x0, y, code_x0 + wf * (code_r - code_x0), y + line_h, line_h * 0.4, LINE_DIM)

    caret_y = ct + ch * 0.06 + 2 * (line_h + gap * 0.82)
    caret_x = code_x0 + 0.46 * (code_r - code_x0)
    caret_w, caret_h = max(4.0, 0.018 * n), line_h * 2.4
    glow = 0.022 * n
    fill_round_rect(
        buf, n, caret_x - glow, caret_y - glow * 0.25, caret_x + caret_w + glow, caret_y + caret_h + glow * 0.25,
        (caret_w + glow * 2) * 0.4, mix(ACCENT, WINDOW, 0.45), edge=1.2,
    )
    fill_round_rect(buf, n, caret_x, caret_y, caret_x + caret_w, caret_y + caret_h, caret_w * 0.4, ACCENT)

    bx0, bx1 = x_r0 + cw * 0.008, x_r1 - cw * 0.008
    bw = bx1 - bx0
    b1y, b1h = ct + ch * 0.08, ch * 0.24
    fill_round_rect(buf, n, bx0, b1y, bx0 + bw * 0.80, b1y + b1h, b1h * 0.30, BUBBLE)
    b2y, b2h = b1y + b1h + ch * 0.07, ch * 0.30
    fill_round_rect(buf, n, bx0 + bw * 0.10, b2y, bx1, b2y + b2h, b2h * 0.30, ACCENT)
    b3y, b3h = b2y + b2h + ch * 0.06, ch * 0.15
    if b3y + b3h < cb:
        fill_round_rect(buf, n, bx0, b3y, bx0 + bw * 0.58, b3y + b3h, b3h * 0.35, LINE_DIM)

    return flatten(buf, n)


def paint_hub(n: int) -> bytes:
    """B · AI 枢纽 — center editor caret, three channel nodes (Claude/Grok/API) linked in."""
    buf = new_buf(n)
    body0, body1, _ = body_tile(buf, n)

    # Soft inner disc
    cx = cy = n * 0.5
    fill_circle(buf, n, cx, cy, n * 0.34, WINDOW, edge=1.5)
    fill_circle(buf, n, cx, cy, n * 0.34, BORDER, edge=1.5)  # will be overwritten
    # ring
    for y in range(n):
        py = y + 0.5
        row = buf[y]
        for x in range(n):
            px = x + 0.5
            d = abs(math.hypot(px - cx, py - cy) - n * 0.34)
            a = clamp01(0.5 - (d - 0.008 * n) / 1.2) * 0.9
            if a > 0:
                cover(row[x], BORDER, a)
    fill_circle(buf, n, cx, cy, n * 0.32, WINDOW, edge=1.2)

    # Center "code block" mark
    block_w, block_h = n * 0.18, n * 0.22
    fill_round_rect(
        buf, n, cx - block_w * 0.5, cy - block_h * 0.5, cx + block_w * 0.5, cy + block_h * 0.5,
        n * 0.025, mix(WINDOW, BG, 0.4),
    )
    # code lines
    for i, wf in enumerate((0.78, 0.62, 0.70, 0.48)):
        ly = cy - block_h * 0.32 + i * block_h * 0.20
        lx0 = cx - block_w * 0.35
        fill_round_rect(buf, n, lx0, ly, lx0 + wf * block_w * 0.7, ly + n * 0.014, n * 0.007, LINE_DIM)
    # caret
    fill_round_rect(
        buf, n, cx + block_w * 0.05, cy - block_h * 0.18, cx + block_w * 0.05 + n * 0.018, cy + block_h * 0.22,
        n * 0.008, ACCENT,
    )

    # Three channel nodes around the hub
    channels = [
        (-0.72, -0.55, ACCENT),   # top-left blue
        (0.78, -0.40, ACCENT2),   # top-right indigo
        (0.05, 0.82, ACCENT3),    # bottom mint
    ]
    node_r = n * 0.055
    for nx, ny, col in channels:
        px = cx + nx * n * 0.28
        py = cy + ny * n * 0.28
        # link line into center
        fill_segment(buf, n, px, py, cx, cy, n * 0.012, mix(col, BORDER, 0.45), edge=1.0)
        # outer glow
        fill_circle(buf, n, px, py, node_r * 1.35, mix(col, WINDOW, 0.55), edge=1.4)
        fill_circle(buf, n, px, py, node_r, col, edge=1.0)
        # inner highlight
        fill_circle(buf, n, px - node_r * 0.15, py - node_r * 0.15, node_r * 0.28, mix(col, (255, 255, 255), 0.35), edge=0.8)

    return flatten(buf, n)


def paint_gateway(n: int) -> bytes:
    """C · 网关 — bold caret/portal mark + three stream ribbons (multi-backend)."""
    buf = new_buf(n)
    body0, body1, _ = body_tile(buf, n)

    # Soft panel behind mark
    pad = 0.16 * n
    fill_round_rect(
        buf, n, body0 + pad, body0 + pad, body1 - pad, body1 - pad,
        0.12 * (body1 - body0 - 2 * pad), WINDOW, edge=1.2,
    )

    cx = n * 0.42
    cy = n * 0.50

    # Large vertical caret / portal (Cursor-like glyph, original geometry)
    caret_w = n * 0.07
    caret_h = n * 0.42
    # chevron-ish: thick left bar + angled tip feel via two rects
    fill_round_rect(
        buf, n, cx - caret_w * 0.5, cy - caret_h * 0.5, cx + caret_w * 0.5, cy + caret_h * 0.5,
        caret_w * 0.35, ACCENT, edge=1.2,
    )
    # soft glow
    fill_round_rect(
        buf, n,
        cx - caret_w * 0.5 - n * 0.02, cy - caret_h * 0.5 - n * 0.015,
        cx + caret_w * 0.5 + n * 0.02, cy + caret_h * 0.5 + n * 0.015,
        caret_w * 0.5, mix(ACCENT, WINDOW, 0.55), edge=2.0,
    )
    # redraw solid caret on top
    fill_round_rect(
        buf, n, cx - caret_w * 0.5, cy - caret_h * 0.5, cx + caret_w * 0.5, cy + caret_h * 0.5,
        caret_w * 0.35, ACCENT, edge=1.0,
    )

    # Three horizontal stream ribbons flowing right (channels)
    streams = [
        (cy - n * 0.14, ACCENT, 0.92),
        (cy + n * 0.00, ACCENT2, 0.78),
        (cy + n * 0.14, ACCENT3, 0.64),
    ]
    x0 = cx + caret_w * 0.7
    x1_base = body1 - pad - n * 0.06
    thick = n * 0.028
    for sy, col, length in streams:
        x1 = x0 + (x1_base - x0) * length
        # tapered end via shorter + node
        fill_round_rect(buf, n, x0, sy - thick * 0.5, x1, sy + thick * 0.5, thick * 0.45, col, edge=1.0)
        fill_circle(buf, n, x1, sy, thick * 0.85, col, edge=0.9)

    # tiny origin dots on caret (sources feeding in)
    for i, col in enumerate((mix(ACCENT, (255, 255, 255), 0.25), ACCENT2, ACCENT3)):
        fill_circle(buf, n, cx, cy - n * 0.14 + i * n * 0.14, n * 0.018, col, edge=0.7)

    return flatten(buf, n)


def paint_switch(n: int) -> bytes:
    """D · 通道开关 — dual-pane IDE with a switch/toggle routing to colored AI rails."""
    buf = new_buf(n)
    body0, body1, _ = body_tile(buf, n)
    win0, win1, ct, cb, _ = window_frame(buf, n, body0, body1, pad=0.11)

    cl, cr = win0 + 0.04 * n, win1 - 0.04 * n
    cw, ch = cr - cl, cb - ct

    # Left: compact file/editor stack
    left_w = cw * 0.48
    fill_round_rect(buf, n, cl, ct, cl + left_w, cb, n * 0.02, mix(WINDOW, BG, 0.25), edge=1.0)
    line_h = max(4.0, ch * 0.065)
    for i, wf in enumerate((0.85, 0.70, 0.78, 0.55, 0.66, 0.42)):
        y = ct + ch * 0.08 + i * (line_h + ch * 0.08)
        fill_round_rect(
            buf, n, cl + left_w * 0.08, y, cl + left_w * 0.08 + wf * left_w * 0.84, y + line_h,
            line_h * 0.4, LINE if i < 2 else LINE_DIM,
        )
    # caret
    cy_c = ct + ch * 0.08 + 2 * (line_h + ch * 0.08)
    fill_round_rect(
        buf, n, cl + left_w * 0.55, cy_c - line_h * 0.2, cl + left_w * 0.55 + n * 0.016, cy_c + line_h * 2.0,
        n * 0.006, ACCENT,
    )

    # Center vertical switch track
    track_x = cl + left_w + cw * 0.06
    track_w = cw * 0.07
    fill_round_rect(buf, n, track_x, ct + ch * 0.12, track_x + track_w, cb - ch * 0.12, track_w * 0.45, BORDER, edge=1.0)
    # knob (active channel)
    knob_y = ct + ch * 0.28
    fill_round_rect(
        buf, n, track_x - n * 0.008, knob_y, track_x + track_w + n * 0.008, knob_y + ch * 0.18,
        track_w * 0.5, ACCENT, edge=1.0,
    )

    # Right: three AI channel rails
    rail_x0 = track_x + track_w + cw * 0.06
    rail_x1 = cr - cw * 0.02
    rails = [
        (ct + ch * 0.14, ACCENT, "long"),
        (ct + ch * 0.42, ACCENT2, "mid"),
        (ct + ch * 0.70, ACCENT3, "short"),
    ]
    rh = ch * 0.14
    for i, (ry, col, _) in enumerate(rails):
        length = (0.95, 0.78, 0.62)[i]
        fill_round_rect(
            buf, n, rail_x0, ry, rail_x0 + (rail_x1 - rail_x0) * length, ry + rh,
            rh * 0.35, col, edge=1.0,
        )
        # connector from track
        fill_segment(buf, n, track_x + track_w, knob_y + ch * 0.09 if i == 0 else (ct + ch * (0.28 + i * 0.28)),
                     rail_x0, ry + rh * 0.5, n * 0.01, mix(col, BORDER, 0.3), edge=0.8)

    return flatten(buf, n)


def paint_orbit(n: int) -> bytes:
    """E · 轨道 — minimal IDE window glyph orbited by multi-AI satellites."""
    buf = new_buf(n)
    body0, body1, _ = body_tile(buf, n)

    cx = cy = n * 0.5

    # Orbit ring (dashed feel via alpha arc segments approximated as thin ring)
    orbit_r = n * 0.30
    for y in range(n):
        py = y + 0.5
        row = buf[y]
        for x in range(n):
            px = x + 0.5
            dist = math.hypot(px - cx, py - cy)
            d = abs(dist - orbit_r)
            # dash by angle
            ang = math.atan2(py - cy, px - cx)
            dash = 1.0 if (math.sin(ang * 6) > -0.15) else 0.15
            a = clamp01(0.5 - (d - 0.006 * n) / 1.1) * 0.85 * dash
            if a > 0:
                cover(row[x], BORDER, a)

    # Central mini window
    ww, wh = n * 0.34, n * 0.30
    fill_round_rect(buf, n, cx - ww * 0.5, cy - wh * 0.5, cx + ww * 0.5, cy + wh * 0.5, n * 0.035, WINDOW, edge=1.2)
    fill_round_rect(
        buf, n, cx - ww * 0.5 - n * 0.006, cy - wh * 0.5 - n * 0.006,
        cx + ww * 0.5 + n * 0.006, cy + wh * 0.5 + n * 0.006, n * 0.04, BORDER, edge=1.0,
    )
    fill_round_rect(buf, n, cx - ww * 0.5, cy - wh * 0.5, cx + ww * 0.5, cy + wh * 0.5, n * 0.035, WINDOW, edge=1.0)
    # title
    fill_rect(buf, n, cx - ww * 0.5 + 1, cy - wh * 0.5 + 1, cx + ww * 0.5 - 1, cy - wh * 0.5 + wh * 0.18, TITLE, edge=0.7)
    # three panes hint
    pane_top = cy - wh * 0.5 + wh * 0.24
    pane_bot = cy + wh * 0.5 - wh * 0.08
    pw = ww * 0.88
    px0 = cx - pw * 0.5
    # left lines
    for i in range(3):
        y = pane_top + i * (pane_bot - pane_top) * 0.28
        fill_round_rect(buf, n, px0, y, px0 + pw * 0.22, y + n * 0.012, n * 0.005, LINE_DIM)
    # mid lines + caret
    for i, wf in enumerate((0.9, 0.7, 0.8)):
        y = pane_top + i * (pane_bot - pane_top) * 0.28
        fill_round_rect(buf, n, px0 + pw * 0.30, y, px0 + pw * 0.30 + wf * pw * 0.32, y + n * 0.012, n * 0.005, LINE)
    fill_round_rect(
        buf, n, px0 + pw * 0.48, pane_top + (pane_bot - pane_top) * 0.15,
        px0 + pw * 0.48 + n * 0.014, pane_top + (pane_bot - pane_top) * 0.55, n * 0.005, ACCENT,
    )
    # right bubble
    fill_round_rect(
        buf, n, px0 + pw * 0.70, pane_top, px0 + pw * 0.98, pane_top + (pane_bot - pane_top) * 0.35,
        n * 0.015, BUBBLE,
    )
    fill_round_rect(
        buf, n, px0 + pw * 0.74, pane_top + (pane_bot - pane_top) * 0.45,
        px0 + pw * 0.98, pane_top + (pane_bot - pane_top) * 0.85, n * 0.015, ACCENT,
    )

    # Satellites on orbit
    sats = [
        (-math.pi * 0.72, ACCENT, 1.0),
        (-math.pi * 0.15, ACCENT2, 0.9),
        (math.pi * 0.45, ACCENT3, 0.95),
        (math.pi * 0.95, mix(ACCENT, ACCENT2, 0.5), 0.75),
    ]
    for ang, col, scale in sats:
        sx = cx + math.cos(ang) * orbit_r
        sy = cy + math.sin(ang) * orbit_r
        r = n * 0.048 * scale
        fill_circle(buf, n, sx, sy, r * 1.3, mix(col, WINDOW, 0.5), edge=1.3)
        fill_circle(buf, n, sx, sy, r, col, edge=0.9)

    return flatten(buf, n)


def paint_bridge(n: int) -> bytes:
    """F · 桥接 — left workbench strip, right multi-AI bubbles, bridge beams between."""
    buf = new_buf(n)
    body0, body1, _ = body_tile(buf, n)
    win0, win1, ct, cb, _ = window_frame(buf, n, body0, body1, pad=0.11)

    cl, cr = win0 + 0.04 * n, win1 - 0.04 * n
    cw, ch = cr - cl, cb - ct

    # Left workbench column (files + code stacked)
    left_w = cw * 0.38
    fill_round_rect(buf, n, cl, ct, cl + left_w, cb, n * 0.018, mix(WINDOW, BG, 0.3))
    line_h = max(4.0, ch * 0.06)
    for i, (ind, wf) in enumerate(((0.0, 0.7), (0.15, 0.6), (0.0, 0.75), (0.15, 0.5), (0.0, 0.65), (0.15, 0.45))):
        y = ct + ch * 0.08 + i * (line_h + ch * 0.07)
        x0 = cl + left_w * (0.1 + ind)
        fill_round_rect(buf, n, x0, y, x0 + wf * left_w * 0.75, y + line_h, line_h * 0.4, LINE if i % 2 == 0 else LINE_DIM)
    # accent caret mid
    fill_round_rect(
        buf, n, cl + left_w * 0.55, ct + ch * 0.32, cl + left_w * 0.55 + n * 0.016, ct + ch * 0.52,
        n * 0.006, ACCENT,
    )

    # Bridge beams (3 channels)
    bx0 = cl + left_w + cw * 0.02
    bx1 = cl + cw * 0.58
    beams = [
        (ct + ch * 0.22, ACCENT),
        (ct + ch * 0.48, ACCENT2),
        (ct + ch * 0.74, ACCENT3),
    ]
    for by, col in beams:
        fill_segment(buf, n, bx0, by, bx1, by, n * 0.016, mix(col, BORDER, 0.25), edge=0.9)
        # small arrow head
        fill_circle(buf, n, bx1, by, n * 0.012, col, edge=0.7)

    # Right: multi-AI reply cards stacked with channel colors
    rx0 = bx1 + cw * 0.03
    cards = [
        (ct + ch * 0.10, ch * 0.22, ACCENT),
        (ct + ch * 0.38, ch * 0.22, ACCENT2),
        (ct + ch * 0.66, ch * 0.22, ACCENT3),
    ]
    for ry, rh, col in cards:
        fill_round_rect(buf, n, rx0, ry, cr, ry + rh, rh * 0.28, mix(col, WINDOW, 0.15), edge=1.0)
        # color bar on left of card
        fill_round_rect(buf, n, rx0, ry, rx0 + n * 0.014, ry + rh, n * 0.006, col, edge=0.8)
        # text lines
        for j, wf in enumerate((0.7, 0.5)):
            ly = ry + rh * (0.28 + j * 0.32)
            fill_round_rect(
                buf, n, rx0 + n * 0.03, ly, rx0 + n * 0.03 + wf * (cr - rx0 - n * 0.05), ly + n * 0.012,
                n * 0.005, mix(col, LINE, 0.5),
            )

    return flatten(buf, n)


VARIANTS: dict[str, tuple[str, callable]] = {
    "workbench": ("A · 三栏工作台 — 文件|编辑|对话（纯布局）", paint_workbench),
    "hub": ("B · AI 枢纽 — 中心编辑器 + 三色渠道节点", paint_hub),
    "gateway": ("C · 网关 — 光标门 + 三色流出通道", paint_gateway),
    "switch": ("D · 通道开关 — 编辑器|拨杆|多 AI 轨", paint_switch),
    "orbit": ("E · 轨道 — 迷你工作台 + 多 AI 卫星", paint_orbit),
    "bridge": ("F · 桥接 — 工作台桥接多色 AI 卡片", paint_bridge),
}


def write_icon(rgba: bytes, n: int, path: Path, previews: bool = False) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(png(n, n, rgba))
    print("wrote", path)
    if previews:
        for size in (128, 32, 16):
            p = path.with_name(f"{path.stem}-{size}{path.suffix}")
            p.write_bytes(png(size, size, scale_nearest(rgba, n, size)))
            print("wrote", p)


def main() -> None:
    n = 1024
    root = Path(__file__).resolve().parents[1]
    build = root / "build"
    args = [a for a in sys.argv[1:] if not a.startswith("-")]
    flags = {a for a in sys.argv[1:] if a.startswith("-")}

    if "--list" in flags or "-l" in flags:
        for key, (desc, _) in VARIANTS.items():
            print(f"  {key:12}  {desc}")
        return

    if args:
        name = args[0]
        if name not in VARIANTS:
            print(f"unknown variant {name!r}; choose from: {', '.join(VARIANTS)}")
            sys.exit(1)
        desc, fn = VARIANTS[name]
        print(desc)
        rgba = fn(n)
        write_icon(rgba, n, build / "icon.png", previews=True)
        # also keep a named copy
        write_icon(rgba, n, build / "candidates" / f"{name}.png", previews=False)
        return

    # default: generate all candidates
    out = build / "candidates"
    out.mkdir(parents=True, exist_ok=True)
    print("Generating all candidates →", out)
    for key, (desc, fn) in VARIANTS.items():
        print(f"\n[{key}] {desc}")
        rgba = fn(n)
        write_icon(rgba, n, out / f"{key}.png", previews=False)
        # 128 preview next to it
        (out / f"{key}-128.png").write_bytes(png(128, 128, scale_nearest(rgba, n, 128)))
        print("wrote", out / f"{key}-128.png")

    print("\nPick one, then run:")
    print("  python3 scripts/make-icon.py <name>   # installs build/icon.png")
    print("names:", ", ".join(VARIANTS))


if __name__ == "__main__":
    main()
