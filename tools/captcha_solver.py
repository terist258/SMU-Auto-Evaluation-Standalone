import sys
import json
from pathlib import Path
import onnxruntime as ort
import numpy as np
from PIL import Image


def solve(image_path):
    """对验证码图片做 ONNX 推理，输出 JSON: {"ok": true, "code": "1234"}"""
    try:
        root = Path(__file__).resolve().parent.parent
        model_path = root / "models" / "captcha_model.onnx"

        session = ort.InferenceSession(str(model_path), providers=["CPUExecutionProvider"])

        img = Image.open(image_path).convert("RGB").resize((80, 20), Image.BILINEAR)
        arr = np.array(img, dtype=np.float32) / 255.0
        arr = arr.transpose(2, 0, 1)
        arr = arr[np.newaxis, ...]

        outputs = session.run(None, {"image": arr})[0]
        digits = outputs[0].argmax(axis=1)
        code = "".join(str(d) for d in digits)

        print(json.dumps({"ok": True, "code": code}, ensure_ascii=False))
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)}, ensure_ascii=False))
        sys.exit(1)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"ok": False, "error": "usage: captcha_solver.py <image_path>"}, ensure_ascii=False))
        sys.exit(1)
    solve(sys.argv[1])
