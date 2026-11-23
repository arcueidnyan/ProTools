"""Build the portable Windows x64 executable using Python and Go."""
from pathlib import Path
from urllib.request import urlopen
from io import BytesIO
import hashlib
import os
import shutil
import subprocess
import sys
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parents[1]
PYTHON_URL = 'https://www.python.org/ftp/python/3.13.9/python-3.13.9-embed-amd64.zip'
PYTHON_SHA256 = '91d828c2da3a029b41699e918674a0cb379c02cf20dab9c501306885f837402a'


def build(output):
    with urlopen(PYTHON_URL, timeout=60) as response:
        runtime = response.read()
    if hashlib.sha256(runtime).hexdigest() != PYTHON_SHA256:
        raise ValueError('Embedded Python checksum mismatch')
    with tempfile.TemporaryDirectory() as directory:
        work = Path(directory)
        shutil.copyfile(ROOT / 'windows/main.go', work / 'main.go')
        with zipfile.ZipFile(BytesIO(runtime)) as source, zipfile.ZipFile(
            work / 'payload.zip', 'w', zipfile.ZIP_DEFLATED
        ) as payload:
            for entry in source.infolist():
                if not entry.is_dir():
                    payload.writestr(entry.filename, source.read(entry))
            for name in ('server.py', 'index.html', 'app.js', 'style.css'):
                payload.write(ROOT / name, name)
        env = dict(os.environ, GOOS='windows', GOARCH='amd64', CGO_ENABLED='0')
        subprocess.run(
            ['go', 'build', '-trimpath', '-ldflags=-s -w -H=windowsgui', '-o', str(output), 'main.go'],
            cwd=work, env=env, check=True,
        )


if __name__ == '__main__':
    build(Path(sys.argv[1]).resolve())
