"""
离线视频人形检测 + 轻量跟踪（CPU 可跑）。

用途：
1) 对 mp4/监控录像做 person 检测；
2) 输出事件（enter/exit）和统计信息；
3) 可选导出标注视频，便于复核。
"""
from __future__ import annotations

import argparse
import json
import time
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np
from ultralytics import YOLO


def iou_xyxy(a: np.ndarray, b: np.ndarray) -> float:
    x1 = max(a[0], b[0])
    y1 = max(a[1], b[1])
    x2 = min(a[2], b[2])
    y2 = min(a[3], b[3])
    inter_w = max(0.0, x2 - x1)
    inter_h = max(0.0, y2 - y1)
    inter = inter_w * inter_h
    if inter <= 0:
        return 0.0
    area_a = max(0.0, (a[2] - a[0])) * max(0.0, (a[3] - a[1]))
    area_b = max(0.0, (b[2] - b[0])) * max(0.0, (b[3] - b[1]))
    union = area_a + area_b - inter
    return float(inter / union) if union > 0 else 0.0


@dataclass
class Track:
    track_id: int
    box: np.ndarray
    conf: float
    first_frame: int
    last_frame: int
    age_lost: int = 0


class IoUTracker:
    def __init__(self, iou_thres: float = 0.3, max_lost: int = 15) -> None:
        self.iou_thres = iou_thres
        self.max_lost = max_lost
        self.next_id = 1
        self.tracks: dict[int, Track] = {}

    def update(self, boxes: list[np.ndarray], confs: list[float], frame_idx: int) -> tuple[list[Track], list[Track]]:
        active_before = set(self.tracks.keys())
        assigned_tracks = set()
        assigned_dets = set()

        # 贪心匹配：按 IoU 从大到小
        candidates = []
        for tid, tr in self.tracks.items():
            for d_i, box in enumerate(boxes):
                candidates.append((iou_xyxy(tr.box, box), tid, d_i))
        candidates.sort(key=lambda x: x[0], reverse=True)

        for iou, tid, d_i in candidates:
            if iou < self.iou_thres:
                break
            if tid in assigned_tracks or d_i in assigned_dets:
                continue
            tr = self.tracks[tid]
            tr.box = boxes[d_i]
            tr.conf = confs[d_i]
            tr.last_frame = frame_idx
            tr.age_lost = 0
            assigned_tracks.add(tid)
            assigned_dets.add(d_i)

        # 新建未匹配检测
        entered = []
        for d_i, box in enumerate(boxes):
            if d_i in assigned_dets:
                continue
            tid = self.next_id
            self.next_id += 1
            tr = Track(track_id=tid, box=box, conf=confs[d_i], first_frame=frame_idx, last_frame=frame_idx)
            self.tracks[tid] = tr
            entered.append(tr)

        # 未匹配轨迹衰减并删除
        exited = []
        for tid in list(active_before):
            if tid in assigned_tracks:
                continue
            tr = self.tracks.get(tid)
            if tr is None:
                continue
            tr.age_lost += 1
            if tr.age_lost > self.max_lost:
                exited.append(tr)
                del self.tracks[tid]

        return entered, exited


def draw_box(img: np.ndarray, trk: Track) -> None:
    x1, y1, x2, y2 = trk.box.astype(int).tolist()
    cv2.rectangle(img, (x1, y1), (x2, y2), (50, 205, 50), 2)
    label = f"id={trk.track_id} conf={trk.conf:.2f}"
    cv2.putText(img, label, (x1, max(20, y1 - 8)), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (50, 205, 50), 2)


def parse_args() -> argparse.Namespace:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True, help="输入视频路径（mp4 等）")
    ap.add_argument("--output-json", default="video_person_events.json", help="输出事件 JSON 路径")
    ap.add_argument("--output-video", default="", help="可选，输出标注视频路径")
    ap.add_argument("--model", default=str(Path(__file__).with_name("yolov8n.pt")), help="YOLO 模型权重")
    ap.add_argument("--conf", type=float, default=0.35, help="person 置信度阈值")
    ap.add_argument("--iou-track", type=float, default=0.3, help="IoU 跟踪阈值")
    ap.add_argument("--max-lost", type=int, default=15, help="轨迹最多丢失帧数")
    ap.add_argument("--frame-step", type=int, default=1, help="每隔 N 帧处理一帧（>=1）")
    ap.add_argument("--max-width", type=int, default=960, help="处理时最大宽度，0 表示不缩放")
    return ap.parse_args()


def main() -> None:
    args = parse_args()
    in_path = Path(args.input)
    if not in_path.is_file():
        raise FileNotFoundError(f"输入视频不存在: {in_path}")

    model = YOLO(args.model)
    cap = cv2.VideoCapture(str(in_path))
    if not cap.isOpened():
        raise RuntimeError(f"无法打开视频: {in_path}")

    fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
    src_w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    src_h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))

    writer = None
    out_video = Path(args.output_video) if args.output_video else None
    if out_video:
        out_video.parent.mkdir(parents=True, exist_ok=True)
        fourcc = cv2.VideoWriter_fourcc(*"mp4v")
        writer = cv2.VideoWriter(str(out_video), fourcc, fps / max(1, args.frame_step), (src_w, src_h))

    tracker = IoUTracker(iou_thres=args.iou_track, max_lost=args.max_lost)
    events: list[dict] = []
    peak_people = 0
    processed = 0
    frame_idx = -1

    t0 = time.time()
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        frame_idx += 1
        if frame_idx % max(1, args.frame_step) != 0:
            continue
        processed += 1

        work = frame
        scale = 1.0
        if args.max_width > 0 and frame.shape[1] > args.max_width:
            scale = args.max_width / frame.shape[1]
            nh = int(frame.shape[0] * scale)
            work = cv2.resize(frame, (args.max_width, nh), interpolation=cv2.INTER_AREA)

        results = model.predict(work, conf=args.conf, verbose=False)
        r0 = results[0]
        boxes = []
        confs = []
        if r0.boxes is not None and len(r0.boxes):
            for b in r0.boxes:
                cls = int(b.cls[0])
                if cls != 0:  # COCO person
                    continue
                c = float(b.conf[0])
                xyxy = b.xyxy[0].cpu().numpy().astype(float)
                if scale != 1.0:
                    xyxy = xyxy / scale
                boxes.append(xyxy)
                confs.append(c)

        entered, exited = tracker.update(boxes, confs, frame_idx)
        for tr in entered:
            events.append(
                {
                    "type": "enter",
                    "track_id": tr.track_id,
                    "frame": frame_idx,
                    "time_sec": round(frame_idx / fps, 3),
                    "confidence": round(tr.conf, 4),
                    "box": [round(float(x), 1) for x in tr.box.tolist()],
                }
            )
        for tr in exited:
            events.append(
                {
                    "type": "exit",
                    "track_id": tr.track_id,
                    "frame": frame_idx,
                    "time_sec": round(frame_idx / fps, 3),
                }
            )

        alive = len(tracker.tracks)
        peak_people = max(peak_people, alive)

        if writer is not None:
            for tr in tracker.tracks.values():
                draw_box(frame, tr)
            cv2.putText(
                frame,
                f"alive={alive} peak={peak_people} frame={frame_idx}",
                (12, 28),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.8,
                (0, 255, 255),
                2,
            )
            writer.write(frame)

    elapsed = max(1e-6, time.time() - t0)
    cap.release()
    if writer is not None:
        writer.release()

    summary = {
        "input": str(in_path.resolve()),
        "fps": fps,
        "source_size": [src_w, src_h],
        "total_frames": total_frames,
        "processed_frames": processed,
        "frame_step": args.frame_step,
        "conf_threshold": args.conf,
        "peak_people": peak_people,
        "events_count": len(events),
        "processing_fps": round(processed / elapsed, 3),
        "elapsed_sec": round(elapsed, 3),
    }

    out_json = Path(args.output_json)
    out_json.parent.mkdir(parents=True, exist_ok=True)
    out_json.write_text(
        json.dumps({"summary": summary, "events": events}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    print(json.dumps(summary, ensure_ascii=False))


if __name__ == "__main__":
    main()
