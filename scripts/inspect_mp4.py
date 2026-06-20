path = r"F:\DCIM\DJI_001\DJI_20260603081425_0111_D_1.MP4"
with open(path, "rb") as f:
    data = f.read(5_000_000)
for kw in [b"GPS", b"gps", b"latitude", b"longitude", b"djmd", b"dbgi", b"moov", b"udta", b"\xa9xyz", b"location"]:
    idx = data.find(kw)
    print(kw, idx)
