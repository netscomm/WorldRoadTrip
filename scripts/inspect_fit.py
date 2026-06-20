import os
import fitparse

d = r"F:\DCIM\FIT files"
files = os.listdir(d)
print(files)

fp = fitparse.FitFile(os.path.join(d, files[0]))
count = 0
last = None
for rec in fp.get_messages("record"):
    vals = rec.get_values()
    last = vals
    print(vals.get("timestamp"), vals.get("position_lat"), vals.get("position_long"))
    count += 1
    if count > 5:
        break
print("fields:", list(last.keys()) if last else None)

for rec in fp.get_messages("session"):
    print("session:", rec.get_values())
    break
