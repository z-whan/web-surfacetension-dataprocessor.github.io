try:
    import chardet
except Exception:  # pragma: no cover - optional in browser runtime
    chardet = None

def detect_encoding(path, sample_bytes=131072):
    # 读取前 ~128KB 进行检测
    with open(path, "rb") as f:
        raw = f.read(sample_bytes)

    if chardet is None:
        enc = "utf-8"
    else:
        res = chardet.detect(raw) or {}
        enc = (res.get("encoding") or "utf-8").lower()

    # 常见带 BOM 的情况统一到 utf-8-sig 以避免首列名多出奇怪字符
    if enc in ("utf-8", "utf_8") and raw.startswith(b"\xef\xbb\xbf"):
        return "utf-8-sig"
    return enc
