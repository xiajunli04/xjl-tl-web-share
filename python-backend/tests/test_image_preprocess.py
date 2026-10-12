"""4.1：图片预处理（EXIF 旋转、超大图缩放、格式与尺寸校验、越界 bbox 裁剪与归一化）。"""

import io

import pytest
from PIL import Image

from app.core.errors import BizException, ErrorCode
from app.image.preprocess import (
    clamp_bbox,
    decode_base64,
    normalize_bbox,
    prepare_image,
    restore_bbox,
    to_data_url,
)
from tests.image_fakes import b64, make_image


def _size(data: bytes) -> tuple[int, int]:
    return Image.open(io.BytesIO(data)).size


def test_exif_rotation_is_applied():
    # orientation=6：拍摄时顺时针旋转 90°，显示时宽高互换
    raw = make_image(200, 100, "JPEG", orientation=6)
    img = prepare_image(raw, 2048)
    assert (img.orig_width, img.orig_height) == (100, 200)
    assert (img.width, img.height) == (100, 200)
    assert _size(img.data) == (100, 200)
    assert img.scale == 1.0
    assert img.mime == "image/jpeg"
    assert img.source_format == "JPEG"


def test_large_image_is_downscaled_and_scale_recorded():
    raw = make_image(4000, 3000, "PNG")
    img = prepare_image(raw, 2048)
    assert (img.orig_width, img.orig_height) == (4000, 3000)
    assert (img.width, img.height) == (2048, 1536)
    assert _size(img.data) == (2048, 1536)
    assert img.scale == pytest.approx(0.512)
    assert img.data_url.startswith("data:image/jpeg;base64,")


def test_transparent_png_is_flattened_to_white():
    im = Image.new("RGBA", (64, 64), (0, 0, 0, 0))
    buf = io.BytesIO()
    im.save(buf, "PNG")
    img = prepare_image(buf.getvalue(), 2048)
    px = Image.open(io.BytesIO(img.data)).convert("RGB").getpixel((10, 10))
    assert all(c > 245 for c in px)


@pytest.mark.parametrize(
    "raw,fragment",
    [
        (b"not an image", "无法识别"),
        (make_image(31, 100), "32–8192"),
        (make_image(100, 100, "GIF"), "不支持的图片格式"),
    ],
)
def test_invalid_images_raise_a0450(raw, fragment):
    with pytest.raises(BizException) as ei:
        prepare_image(raw, 2048)
    assert ei.value.error == ErrorCode.IMAGE_INVALID
    assert fragment in ei.value.message


def test_decode_base64_accepts_data_url_and_rejects_empty():
    raw = make_image(40, 40)
    assert decode_base64(b64(raw)) == raw
    assert decode_base64(to_data_url(raw, "image/png")) == raw
    for bad in ("", "   ", "data:image/png;base64,"):
        with pytest.raises(BizException) as ei:
            decode_base64(bad)
        assert ei.value.error == ErrorCode.IMAGE_INVALID


def test_clamp_bbox_clips_out_of_range_and_swaps():
    assert clamp_bbox([-10, 5, 120, 40], 100, 50) == (0.0, 5.0, 100.0, 40.0)
    assert clamp_bbox([80, 40, 20, 10], 100, 50) == (20.0, 10.0, 80.0, 40.0)  # 坐标颠倒时交换
    assert clamp_bbox([90, 10, 200, 60], 100, 50) == (90.0, 10.0, 100.0, 50.0)


@pytest.mark.parametrize(
    "bbox",
    [None, "1,2,3,4", [1, 2, 3], [1, 2, "x", 4], [float("nan"), 0, 10, 10], [150, 10, 200, 20], [10, 10, 10.5, 30]],
)
def test_clamp_bbox_rejects_invalid(bbox):
    assert clamp_bbox(bbox, 100, 50) is None


def test_clamp_bbox_relative_coordinates_are_converted():
    assert clamp_bbox([0.1, 0.2, 0.5, 0.6], 200, 100) == pytest.approx((20.0, 20.0, 100.0, 60.0))


def test_normalize_bbox_keeps_order_after_rounding():
    assert normalize_bbox((0, 0, 50, 25), 100, 50) == [0.0, 0.0, 0.5, 0.5]
    x0, y0, x1, y1 = normalize_bbox((100, 49.99999, 100, 50), 100, 50)
    assert x0 < x1 and y0 < y1 and x1 <= 1.0 and y1 <= 1.0


def test_restore_bbox_maps_back_to_original_and_normalizes():
    img = prepare_image(make_image(4000, 3000), 2048)  # 缩放比 0.512
    # 模型坐标 (1024,768)-(2048,1536)：原图 (2000,1500)-(4000,3000)，归一化 (0.5,0.5)-(1,1)
    assert restore_bbox([1024, 768, 2048, 1536], img) == [0.5, 0.5, 1.0, 1.0]
    # 越界部分裁剪
    assert restore_bbox([-50, -50, 512, 384], img) == [0.0, 0.0, 0.25, 0.25]
    assert restore_bbox([3000, 10, 3100, 20], img) is None
