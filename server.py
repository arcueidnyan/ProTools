from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlencode, urlsplit, parse_qs
from urllib.request import Request, urlopen
from urllib.error import URLError
from html.parser import HTMLParser
from threading import Lock
from io import BytesIO
import json
import os
import re
import shutil
import subprocess
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parent
COMMUNITY = 'https://steamcommunity.com'
STEAMCMD_ZIP = 'https://steamcdn-a.akamaihd.net/client/installer/steamcmd.zip'
DETAILS = 'https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/'
DOWNLOAD_LOCK = Lock()
STATIC = {'/': ('index.html', 'text/html'), '/app.js': ('app.js', 'text/javascript'),
          '/style.css': ('style.css', 'text/css')}


class Problem(Exception):
    def __init__(self, status, message, details=None):
        self.status = status
        self.details = details
        super().__init__(message)


def identifier(value):
    if not re.fullmatch(r'[1-9][0-9]{0,19}', value) or int(value) >= 2**64:
        raise Problem(400, 'Укажите корректный числовой ID.')
    return value


def steam(url, data=None):
    try:
        with urlopen(Request(url, data, {'User-Agent': 'WorkshopDock/1.0'}), timeout=18) as response:
            return response.read(8_000_000)
    except (URLError, TimeoutError) as exc:
        raise Problem(502, 'Steam не ответил. Попробуйте ещё раз.') from exc


def https(value):
    return value if isinstance(value, str) and value.startswith('https://') else ''


def details(ids):
    fields = {'itemcount': len(ids)}
    fields.update({f'publishedfileids[{i}]': item for i, item in enumerate(ids)})
    try:
        data = json.loads(steam(DETAILS, urlencode(fields).encode()))['response']['publishedfiledetails']
    except (KeyError, ValueError) as exc:
        raise Problem(502, 'Steam вернул неожиданный ответ.') from exc
    return {
        item['publishedfileid']: {
            'id': item['publishedfileid'], 'app': str(item['consumer_app_id']),
            'title': item.get('title', ''), 'description': item.get('description', ''),
            'image': https(item.get('preview_url')), 'file': https(item.get('file_url')),
            'size': int(item.get('file_size') or 0), 'updated': item.get('time_updated'),
            'subscriptions': item.get('subscriptions', 0),
        }
        for item in data if item.get('result') == 1
    }


class WorkshopLinks(HTMLParser):
    def __init__(self):
        super().__init__()
        self.ids = {}
        self.item = None

    def handle_starttag(self, tag, attrs):
        if tag == 'a':
            href = dict(attrs).get('href') or ''
            match = re.match(r'^https://steamcommunity\.com/sharedfiles/filedetails/\?id=([0-9]+)(?:&|$)', href)
            self.item = match[1] if match else None
        elif tag == 'img' and self.item:
            self.ids[self.item] = None

    def handle_endtag(self, tag):
        if tag == 'a':
            self.item = None


def browse(query):
    app = identifier(query.get('app', '233860'))
    raw_page = query.get('page', '1')
    if not re.fullmatch(r'[1-9][0-9]{0,3}', raw_page):
        raise Problem(400, 'Неверный номер страницы.')
    sort = query.get('sort', 'toprated')
    if sort not in {'toprated', 'trend', 'mostrecent', 'totaluniquesubscribers'}:
        raise Problem(400, 'Неизвестная сортировка.')
    params = {'appid': app, 'searchtext': query.get('q', '')[:120], 'browsesort': sort,
              'section': 'readytouseitems', 'p': raw_page}
    parser = WorkshopLinks()
    html = steam(f'{COMMUNITY}/workshop/browse/?{urlencode(params)}').decode(errors='replace')
    parser.feed(html)
    page_count = re.search(r'total_pages\\?"\s*:\s*([0-9]+)', html)
    if not page_count:
        raise Problem(502, 'Steam не вернул число страниц. Попробуйте ещё раз.')
    ids = list(parser.ids)
    found = details(ids[:50]) if ids else {}
    return {'items': [found[item] for item in ids if item in found and found[item]['app'] == app],
            'totalPages': int(page_count[1])}


def get_item(item_id):
    item = details([identifier(item_id)]).get(item_id)
    if not item:
        raise Problem(404, 'Steam не нашёл публичный предмет с таким ID.')
    return item


def portable_windows():
    return os.name == 'nt' and os.environ.get('WORKSHOP_DOCK_PORTABLE') == '1'


def folder_config():
    return Path(os.environ['LOCALAPPDATA']) / 'Workshop Dock' / 'download-folder.txt'


def selected_folder():
    if not portable_windows():
        return None
    try:
        value = folder_config().read_text(encoding='utf-8').strip()
    except FileNotFoundError:
        return None
    except (OSError, UnicodeError) as exc:
        raise Problem(502, 'Не удалось прочитать сохранённую папку загрузок.') from exc
    return Path(value) if value else None


def steam_directory(path):
    path = path.resolve()
    if not str(path).isascii():
        raise Problem(400, 'Выберите папку, в полном пути к которой нет кириллицы, например C:\\Mods.')
    return path


def choose_folder():
    if not portable_windows():
        raise Problem(404, 'Выбор папки доступен в Windows EXE.')
    script = """
Add-Type -AssemblyName System.Windows.Forms
[Console]::OutputEncoding = [Text.UTF8Encoding]::new()
$picker = New-Object Windows.Forms.FolderBrowserDialog
$picker.Description = 'Workshop Dock: select a folder with an ASCII path'
$picker.ShowNewFolderButton = $true
try {
    if ($picker.ShowDialog() -eq [Windows.Forms.DialogResult]::OK) {
        [Console]::WriteLine($picker.SelectedPath)
    }
} finally { $picker.Dispose() }
"""
    powershell = Path(os.environ['SystemRoot']) / 'System32/WindowsPowerShell/v1.0/powershell.exe'
    try:
        result = subprocess.run(
            [str(powershell), '-NoProfile', '-STA', '-Command', script],
            capture_output=True, encoding='utf-8', errors='replace', check=True, timeout=300,
            creationflags=subprocess.CREATE_NO_WINDOW,
        )
        value = result.stdout.strip()
        if not value:
            try:
                return selected_folder()
            except Problem:
                return None
        folder = steam_directory(Path(value))
        with tempfile.TemporaryFile(dir=folder):
            pass
        config = folder_config()
        config.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(dir=config.parent, delete=False) as staged:
            pending = Path(staged.name)
            try:
                staged.write(str(folder).encode('utf-8'))
                staged.close()
                pending.replace(config)
            finally:
                staged.close()
                pending.unlink(missing_ok=True)
        return folder
    except (OSError, subprocess.SubprocessError) as exc:
        raise Problem(502, 'Не удалось выбрать папку. Проверьте, что в неё можно записывать файлы.') from exc


def steamcmd_path(folder=None):
    if folder is None:
        executable = shutil.which(os.environ.get('STEAMCMD', 'steamcmd'))
        if executable:
            return Path(executable).absolute()
        if not portable_windows():
            raise Problem(503, 'Установите SteamCMD и добавьте его в PATH или задайте переменную STEAMCMD.')
        folder = folder_config().parent
    directory = steam_directory(folder / 'SteamCMD')
    executable = directory / 'steamcmd.exe'
    if not executable.is_file():
        try:
            directory.mkdir(parents=True, exist_ok=True)
            with zipfile.ZipFile(BytesIO(steam(STEAMCMD_ZIP))) as bundle:
                with tempfile.NamedTemporaryFile(dir=directory, delete=False) as temp:
                    staged = Path(temp.name)
                    try:
                        temp.write(bundle.read('steamcmd.exe'))
                        temp.close()
                        staged.replace(executable)
                    finally:
                        temp.close()
                        staged.unlink(missing_ok=True)
        except (OSError, zipfile.BadZipFile, KeyError) as exc:
            raise Problem(502, 'Не удалось подготовить SteamCMD. Попробуйте скачать мод ещё раз.') from exc
    return executable


def steamcmd_failure(output, returncode):
    lines = [line.strip() for line in output.splitlines() if line.strip()]
    details = f'Код завершения: {returncode}\n' + '\n'.join(lines[-12:])
    if re.search(r'non-English characters|incompatible path', output, re.I):
        message = 'SteamCMD не поддерживает этот путь. Выберите папку без кириллицы в полном пути.'
    elif re.search(r'No subscription|Access Denied|Insufficient Privilege', output, re.I):
        message = 'Steam отказал в доступе. Для этого мода может требоваться аккаунт или лицензия.'
    elif re.search(r'No Connection|must be online|needs to be online|Could not connect|Connection failed|Timeout', output, re.I):
        message = 'SteamCMD не смог подключиться к Steam. Проверьте соединение и повторите загрузку.'
    elif re.search(r'failed to download item|download item .* failed', output, re.I):
        message = 'Steam отклонил загрузку мода в анонимном режиме.'
    else:
        message = 'SteamCMD завершился без подтверждения загрузки.'
    return Problem(502, message, details[-3000:])


def workshop_folder(output, destination, executable, app, item_id):
    match = re.search(
        rf'Success\.\s+Downloaded item {item_id}\s+to\s+([^\r\n]+)', output, re.I,
    )
    if not match:
        return None
    tail = ('workshop', 'content', app, item_id)
    reported = re.match(r'"([^"]+)"|(.+?)(?:\s*\(\s*\d+\s+bytes?\s*\))?$', match[1].strip())
    candidates = []
    if reported:
        folder = Path(reported[1] or reported[2])
        candidates.extend(root / folder for root in (destination, executable.parent, Path.cwd()))
    candidates.extend(root.joinpath('steamapps', *tail) for root in (destination, executable.parent))
    for candidate in candidates:
        source = candidate.resolve()
        if source.parts[-4:] == tail and source.is_dir():
            return source
    raise Problem(502, 'Steam подтвердил загрузку, но папка мода не найдена.')


def download(item, archive, folder=None):
    executable = steamcmd_path(folder)
    app, item_id = identifier(item['app']), identifier(item['id'])
    temp_root = executable.parent if portable_windows() else None
    with tempfile.TemporaryDirectory(prefix='workshop-dock-', dir=temp_root) as directory:
        destination = Path(directory)
        command = [
            str(executable), '+@ShutdownOnFailedCommand', '1', '+@NoPromptForPassword', '1',
            '+force_install_dir', directory, '+login', 'anonymous',
            '+workshop_download_item', app, item_id, 'validate', '+quit',
        ]
        for attempt in range(2):
            try:
                result = subprocess.run(
                    command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                    errors='replace', timeout=900,
                    cwd=executable.parent if os.environ.get('WORKSHOP_DOCK_PORTABLE') == '1' else None,
                    creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0,
                )
            except OSError as exc:
                raise Problem(502, 'Не удалось запустить SteamCMD.', str(exc)) from exc
            except subprocess.TimeoutExpired as exc:
                raise Problem(504, 'SteamCMD не завершил загрузку за 15 минут.') from exc
            source = workshop_folder(result.stdout, destination, executable, app, item_id)
            if source:
                break
            if attempt or not re.search(r'Restarting SteamCMD|SteamCMD needs to restart', result.stdout, re.I):
                raise steamcmd_failure(result.stdout, result.returncode)
        with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED, compresslevel=3) as output:
            for path in source.rglob('*'):
                if path.is_file() and not path.is_symlink() and path.resolve().is_relative_to(source):
                    output.write(path, path.relative_to(source).as_posix())
            if not output.namelist():
                raise Problem(502, 'В папке мода нет файлов.')


def save_download(item, folder):
    folder = steam_directory(folder)
    with tempfile.NamedTemporaryFile(dir=folder, suffix='.tmp', delete=False) as archive:
        staged = Path(archive.name)
        try:
            download(item, archive, folder)
            archive.close()
            stem = f'workshop-{identifier(item["id"])}'
            index = 0
            while True:
                suffix = f'-{index}' if index else ''
                destination = folder / f'{stem}{suffix}.zip'
                if destination.exists():
                    index += 1
                    continue
                try:
                    staged.rename(destination)  # Windows rename raises if the destination exists.
                    return destination
                except FileExistsError:
                    index += 1
        finally:
            archive.close()
            staged.unlink(missing_ok=True)


class Handler(BaseHTTPRequestHandler):
    def bytes(self, data, mime, status=200):
        self.send_response(status)
        self.send_header('Content-Type', mime + '; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.end_headers()
        self.wfile.write(data)

    def json(self, payload, status=200):
        self.bytes(json.dumps(payload, ensure_ascii=False).encode(), 'application/json', status)

    def do_GET(self):
        address = urlsplit(self.path)
        query = {key: values[0] for key, values in parse_qs(address.query).items()}
        try:
            if address.path in STATIC:
                name, mime = STATIC[address.path]
                self.bytes((ROOT / name).read_bytes(), mime)
            elif address.path == '/api/download-folder':
                enabled = portable_windows()
                try:
                    folder = selected_folder()
                except Problem:
                    folder = None
                self.json({'enabled': enabled, 'folder': str(folder) if folder else None})
            elif address.path == '/api/browse':
                self.json(browse(query))
            elif address.path == '/api/item':
                self.json(get_item(query.get('id', '')))
            else:
                raise Problem(404, 'Страница не найдена.')
        except Problem as exc:
            self.json({'error': str(exc)}, exc.status)

    def do_POST(self):
        try:
            address = urlsplit(self.path)
            if address.path not in {'/api/download', '/api/download-folder'}:
                raise Problem(404, 'Страница не найдена.')
            port = self.server.server_port
            allowed = {f'127.0.0.1:{port}', f'localhost:{port}'}
            host = self.headers.get('Host')
            if host not in allowed or self.headers.get('Origin') != f'http://{host}':
                raise Problem(403, 'Запустите загрузку со страницы Workshop Dock.')
            if address.path == '/api/download-folder':
                if not DOWNLOAD_LOCK.acquire(blocking=False):
                    raise Problem(409, 'Дождитесь завершения загрузки или выбора папки.')
                try:
                    folder = choose_folder()
                    return self.json({'folder': str(folder) if folder else None})
                finally:
                    DOWNLOAD_LOCK.release()
            item = get_item(parse_qs(address.query).get('id', [''])[0])
            if item['file']:
                return self.json({'url': item['file']})
            if not DOWNLOAD_LOCK.acquire(blocking=False):
                raise Problem(409, 'Дождитесь завершения текущей загрузки.')
            try:
                folder = selected_folder()
                if folder is not None:
                    try:
                        return self.json({'saved': str(save_download(item, folder))})
                    except OSError as exc:
                        raise Problem(502, 'Не удалось сохранить ZIP. Выберите доступную папку для загрузок.', str(exc)) from exc
                with tempfile.TemporaryFile() as archive:
                    download(item, archive)
                    size = archive.tell()
                    archive.seek(0)
                    self.send_response(200)
                    self.send_header('Content-Type', 'application/zip')
                    self.send_header('Content-Disposition', f'attachment; filename="workshop-{item["id"]}.zip"')
                    self.send_header('Content-Length', str(size))
                    self.end_headers()
                    shutil.copyfileobj(archive, self.wfile)
            finally:
                DOWNLOAD_LOCK.release()
        except Problem as exc:
            payload = {'error': str(exc)}
            if exc.details:
                payload['details'] = exc.details
            self.json(payload, exc.status)
        except (BrokenPipeError, ConnectionResetError):
            pass


if __name__ == '__main__':
    port = int(os.environ.get('PORT', '8765'))
    with ThreadingHTTPServer(('127.0.0.1', port), Handler) as server:
        ready = os.environ.get('WORKSHOP_DOCK_READY')
        if ready:
            marker = Path(ready)
            staged = marker.with_suffix('.tmp')
            staged.write_text(str(server.server_port), encoding='ascii')
            staged.replace(marker)
        print(f'Workshop Dock · http://127.0.0.1:{server.server_port}', flush=True)
        server.serve_forever()
