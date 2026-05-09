from PIL import Image
import os

frames_dir = r"c:\Users\click\OneDrive\Documents\New project\assets\frames"
png_files = sorted([f for f in os.listdir(frames_dir) if f.startswith('frame-cleaned')])

for filename in png_files:
    path = os.path.join(frames_dir, filename)
    img = Image.open(path)
    print(f"{filename}: {img.width} x {img.height}")
