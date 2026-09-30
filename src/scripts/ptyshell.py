#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
diskwebui 终端用的极小 PTY 桥（零第三方依赖，只用 Python 标准库）。

作用：Node 侧没有原生 openpty，本脚本给交互式 shell 分配一个**真伪终端**，
并把两边的原始字节对通，让前端 xterm.js 能拿到真终端行为
（Tab 补全 / Ctrl+C / Ctrl+R / 方向键 / vim / top / 颜色 / 光标 / 窗口大小）。

协议（Node → 本进程 stdin，均为一行一帧，前缀 \\x01\\x02）：
    IN <base64>       把数据写进 pty（用户按键、命令、粘贴内容；base64 保证二进制安全）
    RS <cols> <rows>  调整 pty 窗口大小（会向子进程发 SIGWINCH）
    QT                退出：挂断并结束

输出（本进程 → stdout）：pty 的**原始字节**，不做任何加工。

用法：ptyshell.py <cols> <rows> <shell-binary> [rcfile]
"""
import base64
import errno
import fcntl
import os
import pty
import select
import signal
import struct
import sys
import termios

MARK = b"\x01\x02"


def set_winsize(fd, rows, cols):
    try:
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", int(rows), int(cols), 0, 0))
    except Exception:
        pass


def main():
    argv = sys.argv[1:]
    try:
        cols = int(argv[0])
        rows = int(argv[1])
    except Exception:
        cols, rows = 120, 36
    shell = argv[2] if len(argv) > 2 else "/bin/bash"
    rcfile = argv[3] if len(argv) > 3 else ""

    env = dict(os.environ)
    env.setdefault("TERM", "xterm-256color")
    env.setdefault("LANG", "C.UTF-8")

    pid, fd = pty.fork()
    if pid == 0:  # 子进程
        try:
            if rcfile and os.path.exists(rcfile):
                os.execvpe(shell, [shell, "--rcfile", rcfile, "-i"], env)
            else:
                os.execvpe(shell, [shell, "-i"], env)
        except Exception:
            pass
        os._exit(1)

    set_winsize(fd, rows, cols)
    try:
        os.kill(pid, signal.SIGWINCH)
    except Exception:
        pass

    in_fd = sys.stdin.fileno()
    out_fd = sys.stdout.fileno()
    buf = b""

    def die():
        try:
            os.kill(pid, signal.SIGHUP)
        except Exception:
            pass
        try:
            os.waitpid(pid, os.WNOHANG)
        except Exception:
            pass

    while True:
        try:
            ready, _, _ = select.select([fd, in_fd], [], [], 3600)
        except (OSError, select.error) as e:
            if getattr(e, "errno", None) == errno.EINTR:
                continue
            break
        if not ready:  # 长时间无事件，探一下子进程是否还活着
            try:
                if os.waitpid(pid, os.WNOHANG)[0]:
                    break
            except Exception:
                pass
            continue

        if fd in ready:
            try:
                data = os.read(fd, 65536)
            except OSError:
                data = b""
            if not data:  # 子进程退出 / pty 关闭
                break
            try:
                os.write(out_fd, data)
            except OSError:
                break

        if in_fd in ready:
            try:
                chunk = os.read(in_fd, 65536)
            except OSError:
                chunk = b""
            if not chunk:  # Node 侧关闭 → 收工
                break
            buf += chunk
            while True:
                i = buf.find(MARK)
                if i < 0:
                    if len(buf) > 1 << 20:
                        buf = buf[-4096:]
                    break
                j = buf.find(b"\n", i)
                if j < 0:
                    break
                frame = buf[i + len(MARK):j]
                buf = buf[:i] + buf[j + 1:]
                parts = frame.split(b" ", 2)
                verb = parts[0] if parts else b""
                if verb == b"IN" and len(parts) >= 2:
                    try:
                        os.write(fd, base64.b64decode(parts[1]))
                    except Exception:
                        pass
                elif verb == b"RS" and len(parts) >= 3:
                    try:
                        c = int(parts[1])
                        r = int(parts[2])
                        set_winsize(fd, r, c)
                        os.kill(pid, signal.SIGWINCH)
                    except Exception:
                        pass
                elif verb == b"QT":
                    die()
                    return
    die()


if __name__ == "__main__":
    try:
        main()
    except Exception:
        sys.exit(0)
