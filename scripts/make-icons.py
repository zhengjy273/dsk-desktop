"""从 assets/source/haofeiyu.png 生成应用图标与托盘图标。

为什么用脚本而不是手工切图：图标需要多尺寸（.ico 多帧），手工做不可复现；
这个脚本入库后，换图只要替换 assets/source/ 下的源图再跑一次。

用法（用 DSH 内置 Python，Pillow 已随附）：
  & "<dsh-install>\\resources\\runtime\\primary-runtime\\dependencies\\python\\python.exe" scripts\\make-icons.py

产出：
  assets/icon.ico        多尺寸应用图标（16/24/32/48/64/128/256），Windows 窗口与托盘共用
  assets/icon-256.png    窗口图标（大尺寸）
  assets/tray-32.png     托盘图标（32px 备选）
  assets/tray-16.png     托盘图标（16px 备选）

品牌合规（R4）：该图像为用户自备素材，**不得**包含 DeepSeek 商标/LOGO；
本项目仅本机自用，公开分发前必须确认素材权利并更换。
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "assets" / "source" / "haofeiyu.png"
OUT = ROOT / "assets"

ICO_SIZES = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]


def main() -> int:
    if not SRC.exists():
        print(f"[icons] 找不到源图：{SRC}")
        return 1

    OUT.mkdir(parents=True, exist_ok=True)
    img = Image.open(SRC).convert("RGBA")

    # 居中裁成正方形（源图若不是正方形，直接缩放会变形）
    w, h = img.size
    side = min(w, h)
    img = img.crop(((w - side) // 2, (h - side) // 2, (w - side) // 2 + side, (h - side) // 2 + side))

    img.resize((256, 256), Image.LANCZOS).save(OUT / "icon-256.png")
    img.resize((32, 32), Image.LANCZOS).save(OUT / "tray-32.png")
    img.resize((16, 16), Image.LANCZOS).save(OUT / "tray-16.png")
    img.save(OUT / "icon.ico", sizes=ICO_SIZES)

    made = []
    for name in ("icon.ico", "icon-256.png", "tray-32.png", "tray-16.png"):
        p = OUT / name
        made.append(f"{name}({p.stat().st_size}B)")
    print(f"[icons] 源图 {SRC.name} {w}x{h} → 输出：" + ", ".join(made))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
