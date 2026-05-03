"""
子进程工具：枚举窗口、区域截屏、YOLO 人形检测。
Microsoft OmniParser 面向 UI 图标/控件解析；人体出现使用本文件的 detect / tick（COCO person）。
"""
from __future__ import annotations

import argparse
import base64
import json
import sys
from pathlib import Path

MODEL_PATH = Path(__file__).with_name("yolov8n.pt")

try:
    # Windows 下避免打印窗口标题时 gbk 编码报错（如包含特殊符号）
    sys.stdout.reconfigure(encoding="utf-8", line_buffering=True)
except Exception:
    pass


def list_windows() -> list[dict]:
    import pygetwindow as gw

    wins: list[dict] = []
    for w in gw.getAllWindows():
        if not w.title or w.width < 2 or w.height < 2:
            continue
        wins.append(
            {
                "title": w.title,
                "left": w.left,
                "top": w.top,
                "width": w.width,
                "height": w.height,
            }
        )
    return wins


def _find_window(substr: str):
    import pygetwindow as gw

    matches = []
    for w in gw.getAllWindows():
        if not w.title or w.width < 2 or w.height < 2:
            continue
        if substr in w.title:
            matches.append(w)
    return matches


def _window_hwnd(win) -> int | None:
    """PyGetWindow Win32Window：句柄字段因版本而异。"""
    for attr in ("_hWnd", "hWnd", "_hwnd"):
        h = getattr(win, attr, None)
        if h is None:
            continue
        if hasattr(h, "value"):
            h = h.value
        try:
            return int(h) if h is not None else None
        except (TypeError, ValueError):
            continue
    return None


def set_target_topmost(substr: str, topmost: bool) -> dict:
    """
    Win32 真·置顶：WS_EX 层级上等价于 HWND_TOPMOST / NOTOPMOST。
    使用 SetWindowPos + SWP_NOACTIVATE，尽量不抢键盘焦点；仅 Windows。
    """
    import ctypes
    import sys
    from ctypes import wintypes

    if sys.platform != "win32":
        return {"ok": True, "skipped": True, "reason": "non_windows"}

    if not (substr or "").strip():
        return {"ok": False, "error": "empty_substr"}

    matches = _find_window(substr)
    if not matches:
        return {"ok": False, "error": "no_window_match", "substr": substr}

    w = matches[0]
    if len(matches) > 1:
        w = max(matches, key=lambda x: x.width * x.height)

    title = getattr(w, "title", "") or ""
    hwnd = _window_hwnd(w)
    if not hwnd:
        return {"ok": False, "error": "no_hwnd", "title": title}

    try:
        user32 = ctypes.WinDLL("user32", use_last_error=True)
        SWP_NOMOVE = 0x0002
        SWP_NOSIZE = 0x0001
        SWP_SHOWWINDOW = 0x0040
        SWP_NOACTIVATE = 0x0010
        flags = SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW | SWP_NOACTIVATE
        insert_after = -1 if topmost else -2

        user32.SetWindowPos.argtypes = [
            wintypes.HWND,
            wintypes.HWND,
            ctypes.c_int,
            ctypes.c_int,
            ctypes.c_int,
            ctypes.c_int,
            ctypes.c_uint,
        ]
        user32.SetWindowPos.restype = wintypes.BOOL

        ok = user32.SetWindowPos(
            wintypes.HWND(hwnd),
            wintypes.HWND(insert_after),
            0,
            0,
            0,
            0,
            flags,
        )
        if not ok:
            return {
                "ok": False,
                "error": "setwindowpos_failed",
                "winerror": int(ctypes.get_last_error()),
                "title": title,
            }
        return {"ok": True, "title": title, "topmost": topmost}
    except Exception as e:
        return {"ok": False, "error": "topmost_failed", "detail": str(e), "title": title}


def capture_window_frame(substr: str):
    import mss
    import numpy as np
    import cv2

    matches = _find_window(substr)
    if not matches:
        return {"ok": False, "error": "no_window_match", "substr": substr}, None
    w = matches[0]
    if len(matches) > 1:
        w = max(matches, key=lambda x: x.width * x.height)
    region = {
        "left": int(w.left),
        "top": int(w.top),
        "width": int(w.width),
        "height": int(w.height),
    }
    with mss.mss() as sct:
        shot = sct.grab(region)
    rgb = np.frombuffer(shot.rgb, dtype=np.uint8).reshape((shot.height, shot.width, 3))
    frame_bgr = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
    cap = {
        "ok": True,
        "title": w.title,
        "region": region,
    }
    return cap, frame_bgr


def capture_window(substr: str, out_path: str) -> dict:
    import cv2

    cap, frame_bgr = capture_window_frame(substr)
    if not cap.get("ok"):
        return cap
    out = Path(out_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(out), frame_bgr)
    cap["path"] = str(out.resolve())
    return cap


def detect_person(model, image_path: str, conf: float) -> dict:
    p = Path(image_path)
    if not p.is_file():
        return {"ok": False, "error": "file_not_found", "path": str(p)}
    results = model.predict(str(p), conf=conf, verbose=False)
    r0 = results[0]
    best = None
    if r0.boxes is not None and len(r0.boxes):
        for b in r0.boxes:
            cls = int(b.cls[0])
            if cls != 0:
                continue
            c = float(b.conf[0])
            if best is None or c > best:
                best = c
    return {"ok": True, "person": best is not None, "confidence": best, "cocoClass": 0}


def detect_person_frame(model, frame_bgr, conf: float) -> dict:
    results = model.predict(frame_bgr, conf=conf, verbose=False)
    r0 = results[0]
    best = None
    if r0.boxes is not None and len(r0.boxes):
        for b in r0.boxes:
            cls = int(b.cls[0])
            if cls != 0:
                continue
            c = float(b.conf[0])
            if best is None or c > best:
                best = c
    return {"ok": True, "person": best is not None, "confidence": best, "cocoClass": 0}


def frame_to_png_base64(frame_bgr) -> str:
    import cv2

    ok, buf = cv2.imencode(".png", frame_bgr)
    if not ok:
        return ""
    return base64.b64encode(buf.tobytes()).decode("ascii")


def save_frame_png(frame_bgr, out_path: str) -> str:
    import cv2

    out = Path(out_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(out), frame_bgr)
    return str(out.resolve())


def cmd_list() -> None:
    print(json.dumps(list_windows(), ensure_ascii=False))


def cmd_capture(substr: str, out_path: str) -> None:
    cap = capture_window(substr, out_path)
    print(json.dumps(cap, ensure_ascii=False))
    if not cap.get("ok"):
        sys.exit(2)


def cmd_detect(image_path: str, conf: float) -> None:
    from ultralytics import YOLO

    model = YOLO(str(MODEL_PATH))
    det = detect_person(model, image_path, conf)
    print(json.dumps(det, ensure_ascii=False))
    if not det.get("ok"):
        sys.exit(2)


def cmd_server() -> None:
    """每行一条 JSON 请求，stdout 每行一条 JSON 响应（复用 YOLO 模型）。"""
    try:
        sys.stdout.reconfigure(encoding="utf-8", line_buffering=True)
    except Exception:
        pass
    try:
        sys.stdin.reconfigure(encoding="utf-8", line_buffering=True)
    except Exception:
        pass

    model = None

    def ensure_yolo():
        nonlocal model
        if model is None:
            from ultralytics import YOLO

            model = YOLO(str(MODEL_PATH))
        return model

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError as e:
            print(json.dumps({"ok": False, "error": "bad_json", "detail": str(e)}), flush=True)
            continue
        cmd = req.get("cmd")
        if cmd == "list":
            print(json.dumps({"ok": True, "windows": list_windows()}, ensure_ascii=False), flush=True)
        elif cmd == "raise_target":
            substr = req.get("substr", "")
            topmost = req.get("topmost", True)
            out = set_target_topmost(substr, bool(topmost))
            print(json.dumps({"ok": True, "raise": out}, ensure_ascii=False), flush=True)
        elif cmd == "lower_target":
            substr = req.get("substr", "")
            out = set_target_topmost(substr, False)
            print(json.dumps({"ok": True, "lower": out}, ensure_ascii=False), flush=True)
        elif cmd == "tick":
            substr = req.get("substr", "")
            out_path = req.get("out", "")
            conf = float(req.get("conf", 0.35))
            include_png = bool(req.get("includePngBase64", False))
            write_last = bool(req.get("writeLastFrame", False))
            cap, frame_bgr = capture_window_frame(substr)
            if not cap.get("ok"):
                print(json.dumps({"ok": True, "capture": cap, "detect": None}), flush=True)
                continue
            if write_last and out_path:
                cap["path"] = save_frame_png(frame_bgr, out_path)
            det = detect_person_frame(ensure_yolo(), frame_bgr, conf)
            resp = {"ok": True, "capture": cap, "detect": det}
            if include_png:
                resp["framePngBase64"] = frame_to_png_base64(frame_bgr)
            print(json.dumps(resp, ensure_ascii=False), flush=True)
        else:
            print(json.dumps({"ok": False, "error": "unknown_cmd", "cmd": cmd}), flush=True)


def main() -> None:
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)

    sub.add_parser("list")
    sub.add_parser("server")

    p_cap = sub.add_parser("capture")
    p_cap.add_argument("substr")
    p_cap.add_argument("out_path")

    p_det = sub.add_parser("detect")
    p_det.add_argument("image_path")
    p_det.add_argument("--conf", type=float, default=0.35)

    args = ap.parse_args()
    if args.cmd == "list":
        cmd_list()
    elif args.cmd == "server":
        cmd_server()
    elif args.cmd == "capture":
        cmd_capture(args.substr, args.out_path)
    elif args.cmd == "detect":
        cmd_detect(args.image_path, args.conf)


if __name__ == "__main__":
    main()
