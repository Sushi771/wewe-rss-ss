"""Independent full decoder for synthetic archive acceptance (existing Pillow).

No acquisition code or application parser is imported. Failure is fatal, including
missing Pillow; never silently replace decoding with a file-header check.
"""
import json
import sys
from PIL import Image, ImageFile

ImageFile.LOAD_TRUNCATED_IMAGES = False
with Image.open(sys.argv[1]) as image:
    image.verify()
with Image.open(sys.argv[1]) as image:
    image.load()
    print(json.dumps({"width": image.width, "height": image.height,
                      "rgba": image.convert("RGBA").tobytes().hex()}))
