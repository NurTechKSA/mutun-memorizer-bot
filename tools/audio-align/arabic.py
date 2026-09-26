"""Arabic text normalization shared by the alignment scripts."""

from __future__ import annotations

import re

DIACRITICS = re.compile(r"[ؐ-ًؚ-ٰٟۖ-ۭـ]")
NON_ARABIC = re.compile(r"[^ء-ي ]+")
LETTERS = str.maketrans(
    {
        "أ": "ا",
        "إ": "ا",
        "آ": "ا",
        "ٱ": "ا",
        "ى": "ي",
        "ئ": "ي",
        "ؤ": "و",
        "ة": "ه",
        "ء": "",
    }
)


def normalize(text: str) -> str:
    """Letters-only skeleton: no harakat, unified alef/ya/ta marbuta, single spaces."""
    text = text.replace("ٱ", "ا")
    text = DIACRITICS.sub("", text)
    text = text.translate(LETTERS)
    text = NON_ARABIC.sub(" ", text)
    return " ".join(text.split())


def compact(text: str) -> str:
    """Normalized text without spaces: word splits differ between print and ASR."""
    return normalize(text).replace(" ", "")


# Honorifics the reciter says in full where the print has a ligature (ﷺ, ؓ, ﷻ ...). Matching ignores them on
# both sides, so "قال النبي ﷺ" in the book and "قال النبي صلى الله عليه وسلم" in the audio line up.
HONORIFICS = [
    normalize(phrase).split()
    for phrase in [
        "صلى الله عليه وعلى آله وسلم",
        "صلى الله عليه وسلم",
        "عليه الصلاة والسلام",
        "عليه السلام",
        "عليهما السلام",
        "رضي الله عنهما",
        "رضي الله عنهم",
        "رضي الله عنها",
        "رضي الله عنه",
        "رحمه الله تعالى",
        "رحمه الله",
        "عز وجل",
        "جل وعلا",
        "سبحانه وتعالى",
        "تبارك وتعالى",
    ]
]


def honorific_mask(words: list[str]) -> list[bool]:
    """True for words that are part of an honorific formula (words are already normalized)."""
    mask = [False] * len(words)
    i = 0
    while i < len(words):
        for phrase in HONORIFICS:
            if words[i : i + len(phrase)] == phrase:
                for j in range(i, i + len(phrase)):
                    mask[j] = True
                i += len(phrase) - 1
                break
        i += 1
    return mask


def anchor_key(text: str) -> str:
    """Anchor text for matching: normalized, honorifics removed, no spaces."""
    words = normalize(text).split()
    mask = honorific_mask(words)
    return "".join(w for w, drop in zip(words, mask) if not drop)
