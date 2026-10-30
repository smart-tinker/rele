#!/usr/bin/python3
"""One exact native-only SIGHUP through pidfd; no wait, restart or force path."""
import hashlib
import json
import os
import re
import signal
import stat
import sys


def require(value):
    if not value:
        raise ValueError('identity-unconfirmed')


def supported():
    require(hasattr(os, 'pidfd_open') and hasattr(signal, 'pidfd_send_signal'))
    fd = os.pidfd_open(os.getpid())
    try:
        signal.pidfd_send_signal(fd, 0)
    finally:
        os.close(fd)


def peers(pid, endpoint):
    require(str(pid).isdigit() and int(pid) > 1 and os.path.isabs(endpoint))
    require(os.stat('/proc/' + str(pid)).st_uid == os.getuid())
    def endpoint_identity():
        published = os.lstat(endpoint)
        require(published.st_uid == os.getuid() and (stat.S_ISLNK(published.st_mode) or stat.S_ISSOCK(published.st_mode)))
        link = os.readlink(endpoint) if stat.S_ISLNK(published.st_mode) else None
        canonical = os.path.realpath(endpoint)
        target = os.lstat(canonical)
        require(target.st_uid == os.getuid() and stat.S_ISSOCK(target.st_mode))
        return canonical, (published.st_dev, published.st_ino, published.st_mode, published.st_uid, published.st_mtime_ns, published.st_ctime_ns, link, target.st_dev, target.st_ino, target.st_mode, target.st_uid, target.st_ctime_ns)
    bound_path, identity = endpoint_identity()
    sockets = set()
    for entry in os.scandir('/proc/' + str(pid) + '/fd'):
        try:
            value = os.readlink(entry.path)
            match = re.fullmatch(r'socket:\[(\d+)\]', value)
            if match:
                sockets.add(match[1])
        except FileNotFoundError:
            pass
    listeners, connected = set(), set()
    with open('/proc/net/unix') as stream:
        for line in stream:
            fields = line.split(None, 7)
            if len(fields) == 8 and fields[6] in sockets and fields[7].strip() == bound_path:
                if fields[5] == '01' and int(fields[3], 16) & 0x10000:
                    listeners.add(fields[6])
                elif fields[5] == '03':
                    connected.add(fields[6])
    require(len(listeners) == 1)
    require(endpoint_identity() == (bound_path, identity))
    return len(connected)


def main():
    supported()
    if sys.argv[1:] == ['--check']:
        print(json.dumps({'supported': True}))
        return
    if len(sys.argv) == 4 and sys.argv[1] == '--peers':
        print(json.dumps({'listener': True, 'peers': peers(sys.argv[2], sys.argv[3])}))
        return
    require(len(sys.argv) == 7 and sys.argv[1] == '--signal')
    pid, start, uid, executable, expected = sys.argv[2:]
    require(pid.isdigit() and int(pid) > 1 and start.isdigit() and uid.isdigit() and int(uid) == os.getuid() and os.path.isabs(executable) and re.fullmatch('[a-f0-9]{64}', expected))
    root = '/proc/' + pid
    fd = os.pidfd_open(int(pid))
    try:
        require(os.stat(root).st_uid == int(uid))
        with open(root + '/stat') as stream:
            require(stream.read().rsplit(')', 1)[1].split()[19] == start)
        require(os.readlink(root + '/exe') == executable)
        h = hashlib.sha256()
        with open(root + '/exe', 'rb') as stream:
            for block in iter(lambda: stream.read(1024 * 1024), b''):
                h.update(block)
        require(h.hexdigest() == expected)
        with open(root + '/stat') as stream:
            require(stream.read().rsplit(')', 1)[1].split()[19] == start)
        require(peers(pid, os.path.join(os.environ['CODEX_HOME'], 'app-server-control/app-server-control.sock')) == 0)
        signal.pidfd_send_signal(fd, signal.SIGHUP)
        print(json.dumps({'status': 'signalSent'}))
    finally:
        os.close(fd)


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print(json.dumps({'status': 'refused'}))
        sys.exit(1)
