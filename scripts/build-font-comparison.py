"""Download self-hosted Latin font specimens for the isolated Pepper comparison."""
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import json
import re
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parents[1] / 'public' / 'font-comparison'
FONTS = [
    ('Geist', 'geist', 'Precise and restrained', 'My first pick'),
    ('Manrope', 'manrope', 'Open, geometric shapes', ''),
    ('DM Sans', 'dmsans', 'Soft, understated curves', ''),
    ('Public Sans', 'publicsans', 'Clear and utilitarian', 'For legibility'),
    ('Figtree', 'figtree', 'Friendly and balanced', ''),
    ('Open Sans', 'opensans', 'Open counters and familiar shapes', ''),
    ('Noto Sans', 'notosans', 'Quiet and familiar', ''),
    ('Roboto', 'roboto', 'Compact and functional', ''),
    ('Work Sans', 'worksans', 'A little more character', ''),
    ('Plus Jakarta Sans', 'plusjakartasans', 'Rounded, contemporary geometry', ''),
]
UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

def read(url):
    return urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': UA}), timeout=45).read()

def download_font(entry):
    family, slug, description, pick = entry
    folder = ROOT / 'fonts' / slug
    folder.mkdir(parents=True, exist_ok=True)
    url = 'https://fonts.googleapis.com/css2?family=' + urllib.parse.quote(family) + ':wght@400;500;600&display=swap'
    css = read(url).decode()
    faces = []
    for weight in (400, 500, 600):
        blocks = [b for b in re.findall(r'@font-face\s*\{([^}]+)\}', css) if re.search(r'font-weight:\s*' + str(weight) + r'\s*;', b)]
        if not blocks:
            raise RuntimeError(f'{family}: missing weight {weight}')
        # Google puts the Latin subset last; it includes Western European accents.
        font_url = re.search(r'url\(([^)]+)\)', blocks[-1]).group(1)
        payload = read(font_url)
        if payload[:4] != b'wOF2':
            raise RuntimeError(f'{family}: expected WOFF2')
        (folder / f'{weight}.woff2').write_bytes(payload)
        faces.append(f'@font-face{{font-family:"{family}";font-style:normal;font-weight:{weight};font-display:swap;src:url("fonts/{slug}/{weight}.woff2") format("woff2")}}')
    license_url = f'https://raw.githubusercontent.com/google/fonts/main/ofl/{slug}/OFL.txt'
    (folder / 'OFL.txt').write_bytes(read(license_url))
    return '\n'.join(faces), dict(family=family, slug=slug, description=description, pick=pick, source='https://fonts.google.com/specimen/' + urllib.parse.quote(family))

if __name__ == '__main__':
    ROOT.mkdir(parents=True, exist_ok=True)
    with ThreadPoolExecutor(max_workers=5) as pool:
        results = list(pool.map(download_font, FONTS))
    (ROOT / 'fonts.css').write_text('\n'.join(r[0] for r in results) + '\n', encoding='utf-8')
    (ROOT / 'fonts.js').write_text('window.pepperFonts = ' + json.dumps([r[1] for r in results]) + ';\n', encoding='utf-8')
    print(f'Prepared {len(results)} families, 3 weights each, with licenses in {ROOT}')
