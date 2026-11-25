"""Start the Plumb bench bridge. Nothing to install by hand:

    python bridge/run.py              # starts the bridge for the Plumb page (the first run sets itself up)
    python bridge/run.py sim          # starts the simulated supply and device instead, for trying it with no bench
    python bridge/run.py run BENCH.json --tests PWR-01 --operator console    # runs tests with no browser

The first run makes a private Python environment beside this file (bridge/.venv) and installs the bridge's few
pinned packages into it (requirements.txt), so nothing touches the rest of the PC. Later runs start at once; a
changed requirements.txt is picked up by itself. Needs Python 3.10 or newer.
"""
import hashlib
import os
import subprocess
import sys
import venv

HERE = os.path.dirname(os.path.abspath(__file__))
VENV = os.path.join(HERE, '.venv')
REQ = os.path.join(HERE, 'requirements.txt')
PY = os.path.join(VENV, 'Scripts', 'python.exe') if os.name == 'nt' else os.path.join(VENV, 'bin', 'python')
STAMP = os.path.join(VENV, 'plumb-requirements.sha256')


def ready():
    want = hashlib.sha256(open(REQ, 'rb').read()).hexdigest()
    have = open(STAMP).read().strip() if os.path.exists(STAMP) else ''
    return want, os.path.exists(PY) and have == want


def setup():
    want, ok = ready()
    if ok:
        return
    if sys.version_info < (3, 10):
        sys.exit('The bench bridge needs Python 3.10 or newer (this is %d.%d).' % sys.version_info[:2])
    if not os.path.exists(PY):
        print('Setting up the bench bridge (once): a private Python environment in bridge/.venv ...', flush=True)
        venv.EnvBuilder(with_pip=True).create(VENV)
    print('Installing the bridge\'s packages into it (requirements.txt) ...', flush=True)
    subprocess.check_call([PY, '-m', 'pip', 'install', '--disable-pip-version-check', '-q', '-r', REQ])
    open(STAMP, 'w').write(want)
    print('Set up.', flush=True)


def main():
    setup()
    args = sys.argv[1:]
    if args[:1] == ['--setup-only']:
        return
    sys.exit(subprocess.call([PY, '-m', 'plumb_bridge'] + (args or ['serve']), cwd=HERE))


if __name__ == '__main__':
    main()
