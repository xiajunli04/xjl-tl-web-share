"""图片预处理与 bbox 换算（design D10）。

- 解码与校验：JPG/PNG/WEBP/BMP，宽高 32–8192 px，不合法时 A0450
- EXIF 方向校正（浏览器默认按 EXIF 显示图片，原图坐标即校正后的坐标）
- 长边缩放到不超过 image_max_side，记录缩放比，重新编码为 JPEG 送给视觉模型
- 视觉模型返回的像素 bbox：校验、裁剪越界坐标，按缩放比还原为原图坐标，再归一化到 0–1
"""

import base64
import binascii
import io
import logging
import math
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

from PIL import Image, ImageOps, UnidentifiedImageError

from app.core.errors import BizException, ErrorCode

log = logging.getLogger("app.image.preprocess")

ALLOWED_FORMATS = {"JPEG": "image/jpeg", "PNG": "image/png", "WEBP": "image/webp", "BMP": "image/bmp"}
MIN_SIDE = 32
MAX_SIDE = 8192
MAX_BYTES = 10 * 1024 * 1024
JPEG_QUALITY = 90
MIN_BOX_PX = 1.0  # 裁剪后宽或高不足 1 px 的框视为无效
NORM_DIGITS = 4

Bbox = tuple[float, float, float, float]


@dataclass
class PreparedImage:
    """预处理结果。width/height 为送入模型的图像尺寸，orig_* 为 EXIF 校正后的原图尺寸。"""

    data: bytes  # 送入视觉模型的 JPEG
    mime: str
    width: int
    height: int
    orig_width: int
    orig_height: int
    source_format: str  # 原图格式：JPEG / PNG / WEBP / BMP

    @property
    def scale(self) -> float:
        """缩放比 = 模型图像尺寸 / 原图尺寸（≤ 1）。"""
        return self.width / self.orig_width

    @property
    def data_url(self) -> str:
        return to_data_url(self.data, self.mime)


def to_data_url(data: bytes, mime: str) -> str:
    return f"data:{mime};base64,{base64.b64encode(data).decode('ascii')}"


def decode_base64(image_base64: str) -> bytes:
    """解码 base64（兼容带 data URL 前缀的写法）；为空或非法时 A0450。"""
    s = (image_base64 or "").strip()
    if s.startswith("data:") and "," in s:
        s = s.split(",", 1)[1]
    if not s:
        raise BizException(ErrorCode.IMAGE_INVALID, "图片为空")
    try:
        raw = base64.b64decode(s, validate=False)
    except (binascii.Error, ValueError):
        raise BizException(ErrorCode.IMAGE_INVALID, "图片数据不是合法的 base64") from None
    if not raw:
        raise BizException(ErrorCode.IMAGE_INVALID, "图片为空")
    if len(raw) > MAX_BYTES:
        raise BizException(ErrorCode.IMAGE_INVALID, "图片不能超过 10 MB")
    return raw


def open_image(raw: bytes) -> tuple[Image.Image, str]:
    """打开并校验图片，返回 EXIF 校正后的 RGB 图像与原始格式。"""
    try:
        img = Image.open(io.BytesIO(raw))
        img.load()
    except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError):
        raise BizException(ErrorCode.IMAGE_INVALID, "无法识别的图片格式") from None
    fmt = (img.format or "").upper()
    if fmt not in ALLOWED_FORMATS:
        raise BizException(ErrorCode.IMAGE_INVALID, f"不支持的图片格式：{fmt or '未知'}（仅支持 JPG/PNG/WEBP/BMP）")
    w, h = img.size
    if min(w, h) < MIN_SIDE or max(w, h) > MAX_SIDE:
        raise BizException(ErrorCode.IMAGE_INVALID, f"图片宽高须在 {MIN_SIDE}–{MAX_SIDE} px 之间（当前 {w}×{h}）")
    img = ImageOps.exif_transpose(img)
    return _to_rgb(img), fmt


def _to_rgb(img: Image.Image) -> Image.Image:
    """透明背景合成到白底，其余模式统一转 RGB（JPEG 不支持透明通道）。"""
    if img.mode in ("RGBA", "LA") or (img.mode == "P" and "transparency" in img.info):
        rgba = img.convert("RGBA")
        bg = Image.new("RGB", rgba.size, (255, 255, 255))
        bg.paste(rgba, mask=rgba.getchannel("A"))
        return bg
    return img.convert("RGB") if img.mode != "RGB" else img


def encode_jpeg(img: Image.Image) -> bytes:
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=JPEG_QUALITY)
    return buf.getvalue()


def prepare_image(raw: bytes, max_side: int) -> PreparedImage:
    """EXIF 旋转 → 长边缩放到不超过 max_side → JPEG。"""
    img, fmt = open_image(raw)
    orig_w, orig_h = img.size
    longest = max(orig_w, orig_h)
    if longest > max_side:
        ratio = max_side / longest
        size = (max(1, round(orig_w * ratio)), max(1, round(orig_h * ratio)))
        img = img.resize(size, Image.Resampling.LANCZOS)
    w, h = img.size
    return PreparedImage(
        data=encode_jpeg(img),
        mime="image/jpeg",
        width=w,
        height=h,
        orig_width=orig_w,
        orig_height=orig_h,
        source_format=fmt,
    )


def _as_numbers(bbox: Any) -> list[float] | None:
    if not isinstance(bbox, Sequence) or isinstance(bbox, str) or len(bbox) != 4:
        return None
    try:
        values = [float(v) for v in bbox]
    except (TypeError, ValueError):
        return None
    return values if all(math.isfinite(v) for v in values) else None


def clamp_bbox(bbox: Any, width: int, height: int) -> Bbox | None:
    """校验模型返回的像素 bbox [x0,y0,x1,y1]：坐标颠倒时交换，越界部分裁剪到图像范围内；
    非 4 个数字、或裁剪后宽/高不足 1 px 时返回 None。

    模型偶尔会忽略要求返回 0–1 的相对坐标，四个值都不超过 1 时按相对坐标换算为像素。
    """
    values = _as_numbers(bbox)
    if values is None:
        return None
    if max(abs(v) for v in values) <= 1.0 and max(width, height) > 1:
        values = [values[0] * width, values[1] * height, values[2] * width, values[3] * height]
    x0, x1 = sorted((values[0], values[2]))
    y0, y1 = sorted((values[1], values[3]))
    x0, x1 = min(max(x0, 0.0), width), min(max(x1, 0.0), width)
    y0, y1 = min(max(y0, 0.0), height), min(max(y1, 0.0), height)
    if x1 - x0 < MIN_BOX_PX or y1 - y0 < MIN_BOX_PX:
        return None
    return x0, y0, x1, y1


def to_original(bbox: Bbox, image: PreparedImage) -> Bbox:
    """模型图像坐标 → 原图坐标（缩放时宽高各自取整，按两个方向分别还原）。"""
    sx = image.orig_width / image.width
    sy = image.orig_height / image.height
    x0, y0, x1, y1 = bbox
    return x0 * sx, y0 * sy, x1 * sx, y1 * sy


def normalize_bbox(bbox: Bbox, width: int, height: int) -> list[float]:
    """原图像素坐标 → 0–1 归一化坐标（保留 4 位小数，保证 x0<x1、y0<y1）。"""
    x0, y0, x1, y1 = bbox
    nx0, nx1 = _ordered(_norm(x0, width), _norm(x1, width))
    ny0, ny1 = _ordered(_norm(y0, height), _norm(y1, height))
    return [nx0, ny0, nx1, ny1]


def _norm(v: float, size: int) -> float:
    return round(min(max(v / size, 0.0), 1.0), NORM_DIGITS)


def _ordered(a: float, b: float) -> tuple[float, float]:
    """四舍五入后两端可能相等：向外扩一个最小单位。"""
    step = 10**-NORM_DIGITS
    if b > a:
        return a, b
    if b + step <= 1.0:
        return a, round(b + step, NORM_DIGITS)
    return round(a - step, NORM_DIGITS), b


def restore_bbox(bbox: Any, image: PreparedImage) -> list[float] | None:
    """模型返回的像素 bbox → 原图归一化 bbox；无效时返回 None。"""
    clamped = clamp_bbox(bbox, image.width, image.height)
    if clamped is None:
        return None
    return normalize_bbox(to_original(clamped, image), image.orig_width, image.orig_height)
