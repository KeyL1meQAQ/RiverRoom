"""Build the small, Python-ABI-independent exact enumeration library.

Run `.venv/bin/python -m backend.build_odds` after installing dependencies.
The production Docker build compiles this in a separate stage.
"""
from pathlib import Path
import subprocess
import sys


def build():
    root = Path(__file__).resolve().parent
    output = root / '_runout_odds.so'
    flags = ['-dynamiclib'] if sys.platform == 'darwin' else ['-shared', '-fPIC']
    subprocess.run(['cc', '-O3', '-std=c99', *flags, str(root / 'runout_odds.c'), '-o', str(output)], check=True)
    print(output)


if __name__ == '__main__':
    build()
