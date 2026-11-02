/**
 * 验证码 ONNX 识别（Node.js 原生实现，替代 Python 子进程）
 *
 * 加载 models/captcha_model.onnx，对验证码图片做推理，输出 4 位数字。
 * 与原 Python captcha_solver.py 逻辑一致：
 *   1. 打开图片 → 转 RGB → resize (80, 20)
 *   2. 转 Float32 数组，归一化 /255
 *   3. 转置为 (C, H, W)，添加 batch 维度 → (1, 3, 20, 80)
 *   4. ONNX 推理 → argmax → 拼接数字字符串
 *
 * 返回 Promise<{ok: boolean, code?: string, error?: string}>
 */

import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import onnx from "onnxruntime-node";
const { InferenceSession } = onnx;
import Jimp from "jimp";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODEL_PATH = path.join(HERE, "..", "models", "captcha_model.onnx");

let session = null;

/** 懒加载 ONNX 推理会话 */
async function getSession() {
  if (!session) {
    session = await InferenceSession.create(MODEL_PATH, {
      executionProviders: ["cpu"],
    });
  }
  return session;
}

/** 将图片预处理为 ONNX 输入张量：Float32Array, shape (1, 3, 20, 80) */
function preprocessImage(imageBuffer) {
  return Jimp.read(imageBuffer).then((img) => {
    img.resize(80, 20);
    const bitmap = img.bitmap; // { data: Uint8ClampedArray, width, height }
    const { data, width, height } = bitmap;
    const channels = 3;
    const tensor = new Float32Array(1 * channels * height * width);
    let idx = 0;
    for (let c = 0; c < channels; c++) {
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const pixelIdx = (y * width + x) * 4;
          // Jimp 数据顺序是 RGBA，取对应通道，归一化到 [0,1]
          let val;
          if (c === 0) val = data[pixelIdx] / 255.0;     // R
          else if (c === 1) val = data[pixelIdx + 1] / 255.0; // G
          else val = data[pixelIdx + 2] / 255.0;          // B
          tensor[idx++] = val;
        }
      }
    }
    return tensor;
  });
}

/** 对验证码图片做 ONNX 推理，返回 {ok, code} */
export async function solveCaptcha(imageBuffer) {
  try {
    const sess = await getSession();
    const inputName = sess.inputNames[0];
    const inputTensor = await preprocessImage(imageBuffer);

    const feeds = {};
    feeds[inputName] = {
      dims: [1, 3, 20, 80],
      data: inputTensor,
      type: "float32",
    };

    const results = await sess.run(feeds);
    const outputName = sess.outputNames[0];
    const output = results[outputName];
    const data = output.data;

    // data 是 Float32Array，shape 为 (1, 4, 10) 或类似，对每个位置取 argmax
    // 假设输出 shape: [batch, numDigits, numClasses]
    const numDigits = Math.floor(data.length / 10);
    const digits = [];
    for (let i = 0; i < numDigits; i++) {
      let maxIdx = 0;
      let maxVal = data[i * 10];
      for (let j = 1; j < 10; j++) {
        if (data[i * 10 + j] > maxVal) {
          maxVal = data[i * 10 + j];
          maxIdx = j;
        }
      }
      digits.push(String(maxIdx));
    }

    const code = digits.join("");
    return { ok: true, code };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** 对图片文件路径做验证码识别（保持与原 Python 接口兼容的调用方式） */
export async function solveCaptchaFile(imagePath, log) {
  try {
    const buffer = fs.readFileSync(imagePath);
    const result = await solveCaptcha(buffer);
    if (result.ok) {
      log?.("info", `验证码识别结果：${result.code}`);
    } else {
      log?.("warn", `验证码识别失败：${result.error || "未知错误"}`);
    }
    return result;
  } catch (err) {
    log?.("warn", `读取验证码图片失败：${err.message}`);
    return { ok: false, error: err.message };
  }
}
