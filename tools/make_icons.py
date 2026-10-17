"""Рисует иконки расширения (16/32/48/128 px) в папку icons/."""
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "extension" / "icons"
SIZES = (16, 32, 48, 128)

S = 1024
TOP = (78, 168, 250)
BOTTOM = (28, 104, 200)


def gradient(size: int) -> Image.Image:
    image = Image.new("RGBA", (size, size))
    draw = ImageDraw.Draw(image)
    for y in range(size):
        t = y / (size - 1)
        color = tuple(round(TOP[i] + (BOTTOM[i] - TOP[i]) * t) for i in range(3))
        draw.line([(0, y), (size, y)], fill=color + (255,))
    return image


def build() -> Image.Image:
    base = gradient(S)

    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [0, 0, S - 1, S - 1], radius=int(S * 0.235), fill=255
    )
    canvas = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    canvas.paste(base, (0, 0), mask)

    draw = ImageDraw.Draw(canvas)
    cx = cy = S * 0.435
    radius = S * 0.2
    stroke = int(S * 0.095)
    draw.ellipse(
        [cx - radius, cy - radius, cx + radius, cy + radius],
        outline=(255, 255, 255, 255),
        width=stroke,
    )

    start = (cx + radius * 0.7, cy + radius * 0.7)
    end = (S * 0.79, S * 0.79)
    draw.line([start, end], fill=(255, 255, 255, 255), width=stroke)
    for x, y in (start, end):
        draw.ellipse(
            [x - stroke / 2, y - stroke / 2, x + stroke / 2, y + stroke / 2],
            fill=(255, 255, 255, 255),
        )

    return canvas


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    icon = build()
    for size in SIZES:
        icon.resize((size, size), Image.LANCZOS).save(OUT / f"icon{size}.png")
    print("icons:", ", ".join(f"icon{s}.png" for s in SIZES))


if __name__ == "__main__":
    main()
