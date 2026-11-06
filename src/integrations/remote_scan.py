"""WorkScene read-only SSH discovery, Python 3.8+, sent via stdin (never installed)."""
import base64
import json
import os
import subprocess
import sys

config = json.loads(base64.b64decode(sys.argv[1]))
found, errors, visited = {}, [], set()
budget = 15000

def git(directory, *args):
    env = dict(os.environ, GIT_OPTIONAL_LOCKS='0', GIT_TERMINAL_PROMPT='0')
    return subprocess.check_output(['git', '-C', directory, *args], stderr=subprocess.PIPE, timeout=8, env=env).decode('utf-8').rstrip('\n')

def optional(directory, fallback, *args):
    try:
        return git(directory, *args)
    except (OSError, subprocess.SubprocessError):
        return fallback

def checkout(directory):
    directory = os.path.realpath(directory)
    if directory in found:
        return
    item = {'path': directory, 'exists': os.path.isdir(directory)}
    found[directory] = item
    if not item['exists']:
        errors.append('Git 登记路径缺失：' + directory)
        return
    try:
        common = os.path.realpath(os.path.join(directory, git(directory, 'rev-parse', '--git-common-dir')))
        own = os.path.realpath(os.path.join(directory, git(directory, 'rev-parse', '--git-dir')))
        item['checkout'] = dict(commonDir=common, root=directory, kind='main' if own == common else 'worktree', branch=optional(directory, '(detached HEAD)', 'symbolic-ref', '--short', '-q', 'HEAD'), head=optional(directory, '(unborn)', 'rev-parse', '--verify', 'HEAD'), remote=optional(directory, None, 'remote', 'get-url', 'origin'))
        for entry in git(directory, 'worktree', 'list', '--porcelain', '-z').split('\0'):
            if entry.startswith('worktree '):
                checkout(entry[9:])
    except (OSError, subprocess.SubprocessError) as error:
        errors.append('Git 信息不可读取 ' + directory + ': ' + str(error))

def walk(directory, depth):
    global budget
    budget -= 1
    if budget < 0:
        raise RuntimeError('超过 15000 个目录扫描上限，请缩小范围')
    directory = os.path.realpath(directory)
    if directory in visited:
        return
    visited.add(directory)
    children = list(os.scandir(directory))
    if any(c.name == '.git' for c in children):
        checkout(directory)
    if depth > 0:
        for c in children:
            if c.is_dir(follow_symlinks=False) and not c.name.startswith('.') and c.name not in ('node_modules', 'vendor', 'Library'):
                try:
                    walk(c.path, depth - 1)
                except (OSError, RuntimeError) as error:
                    errors.append(c.path + ': ' + str(error))
                    if budget < 0:
                        return

for root in config['roots']:
    try:
        walk(root, config['depth'])
    except (OSError, RuntimeError) as error:
        errors.append(root + ': ' + str(error))
print(json.dumps(dict(locations=list(found.values()), errors=errors)))
