"""Local OCR worker. stdout contains only the page-and-box JSON protocol."""

import json
import sys
from contextlib import closing
from pathlib import Path

import cv2
import numpy as np
import pypdfium2 as pdfium
from rapidocr_onnxruntime import RapidOCR


def images(path, extension, pages):
    if extension == ".pdf":
        with pdfium.PdfDocument(path) as pdf:
            for n in pages:
                with closing(pdf[n - 1]) as page, closing(page.render(scale=2.5)) as bitmap:
                    image = cv2.cvtColor(np.array(bitmap.to_pil().convert("RGB")), cv2.COLOR_RGB2BGR)
                yield n, image
    else:
        yield 1, cv2.imdecode(np.frombuffer(Path(path).read_bytes(), dtype=np.uint8), cv2.IMREAD_COLOR)


def analyze(ocr, image):
    best = (0, [])
    for angle in (None, cv2.ROTATE_90_CLOCKWISE, cv2.ROTATE_90_COUNTERCLOCKWISE, cv2.ROTATE_180):
        rotated = image if angle is None else cv2.rotate(image, angle)
        if max(rotated.shape[:2]) > 3200:
            ratio = 3200 / max(rotated.shape[:2])
            rotated = cv2.resize(rotated, None, fx=ratio, fy=ratio, interpolation=cv2.INTER_AREA)
        result, _ = ocr(rotated, use_cls=False, text_score=0.4)
        if result is None:
            continue
        boxes = []
        score = 0
        for corners, value, conf in result:
            x, y = np.mean(corners, axis=0)
            boxes.append({"x": round(float(x), 1), "y": round(float(y), 1), "text": value, "confidence": round(float(conf), 3)})
            score += (len(value) if any("\u4e00" <= char <= "\u9fff" for char in value) else 0.2) * conf
        if score > best[0]:
            best = (score, boxes)
        if {"序号", "学号", "姓名", "备注"}.issubset({b["text"] for b in boxes}) and any("成绩" in b["text"] for b in boxes):
            return boxes
    return best[1]


def main():
    path, extension, pages = sys.argv[1:]
    ocr = RapidOCR(intra_op_num_threads=2, inter_op_num_threads=2, limit_side_len=3200, limit_type="max")
    result = [{"page": n, "boxes": analyze(ocr, image)} for n, image in images(path, extension, json.loads(pages))]
    sys.stdout.buffer.write(json.dumps(result, ensure_ascii=False).encode("utf-8"))


if __name__ == "__main__":
    main()
