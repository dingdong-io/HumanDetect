"""
独立鼠标连点器（可迁移脚本）

特性：
1) 默认每 10 秒左键点击 1 次（间隔最小 10 秒）；
2) 启动后先等待一个间隔，再进行首次点击（便于你先把鼠标移到目标位置）；
3) 支持全局右键停止（可关）；
4) 支持热键停止（默认 F8）；
5) 也可 Ctrl+C 停止。

用法示例：
  py -3 auto_clicker.py
  py -3 auto_clicker.py --interval-sec 10 --stop-key f8 --stop-on-right-click true
"""

from __future__ import annotations

import argparse
import threading
import time
from typing import Optional

from pynput import keyboard, mouse


def parse_bool(v: str) -> bool:
    return str(v).strip().lower() in {"1", "true", "yes", "y", "on"}


class AutoClicker:
    def __init__(self, interval_sec: float, stop_key_name: str, stop_on_right_click: bool) -> None:
        self.interval_sec = max(10.0, float(interval_sec))
        sk = stop_key_name.strip().lower()
        self.stop_key_name = "" if sk in {"", "none", "off", "false"} else sk
        self.stop_on_right_click = bool(stop_on_right_click)

        self._stop_event = threading.Event()
        self._mouse_controller = mouse.Controller()
        self._mouse_listener: Optional[mouse.Listener] = None
        self._keyboard_listener: Optional[keyboard.Listener] = None
        self._click_count = 0

    def _resolve_stop_key(self):
        # 兼容 F1~F12 和 esc
        if self.stop_key_name == "esc":
            return keyboard.Key.esc
        if self.stop_key_name.startswith("f"):
            n = self.stop_key_name[1:]
            if n.isdigit():
                k = getattr(keyboard.Key, f"f{n}", None)
                if k is not None:
                    return k
        return keyboard.Key.f8

    def _on_mouse_click(self, _x, _y, button, pressed):
        if not self.stop_on_right_click:
            return
        if pressed and button == mouse.Button.right:
            print("[auto-clicker] 检测到右键，准备停止...")
            self.stop()

    def _on_key_press(self, key):
        if key == self._resolve_stop_key():
            print(f"[auto-clicker] 检测到停止热键({self.stop_key_name})，准备停止...")
            self.stop()

    def start(self):
        print(
            f"[auto-clicker] 已启动：每 {self.interval_sec:.1f}s 左键点击 1 次；"
            f"首次点击将等待 {self.interval_sec:.1f}s。"
        )
        hotkey_part = f"热键({self.stop_key_name}) / " if self.stop_key_name else ""
        print(
            f"[auto-clicker] 停止方式："
            f"{'右键 / ' if self.stop_on_right_click else ''}{hotkey_part}Ctrl+C"
        )

        if self.stop_on_right_click:
            self._mouse_listener = mouse.Listener(on_click=self._on_mouse_click)
            self._mouse_listener.start()
        if self.stop_key_name:
            self._keyboard_listener = keyboard.Listener(on_press=self._on_key_press)
            self._keyboard_listener.start()

        try:
            # 核心：先等待 interval，再点击（满足“开始不点”）
            while not self._stop_event.wait(self.interval_sec):
                self._mouse_controller.click(mouse.Button.left, 1)
                self._click_count += 1
                print(f"[auto-clicker] clicked #{self._click_count}")
        finally:
            self._cleanup()
            print("[auto-clicker] 已停止。")

    def stop(self):
        self._stop_event.set()

    def _cleanup(self):
        if self._mouse_listener is not None:
            self._mouse_listener.stop()
            self._mouse_listener = None
        if self._keyboard_listener is not None:
            self._keyboard_listener.stop()
            self._keyboard_listener = None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--interval-sec", type=float, default=10.0, help="点击间隔（秒）")
    ap.add_argument("--stop-key", default="f8", help="全局停止热键（如 f8 / esc）")
    ap.add_argument(
        "--stop-on-right-click",
        type=parse_bool,
        default=True,
        help="是否启用全局右键停止（true/false）",
    )
    args = ap.parse_args()

    clicker = AutoClicker(
        interval_sec=args.interval_sec,
        stop_key_name=args.stop_key,
        stop_on_right_click=args.stop_on_right_click,
    )

    try:
        clicker.start()
    except KeyboardInterrupt:
        print("\n[auto-clicker] 收到 Ctrl+C，准备停止...")
        clicker.stop()


if __name__ == "__main__":
    main()

