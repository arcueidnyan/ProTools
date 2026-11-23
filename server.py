from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlencode, urlsplit, parse_qs
from urllib.request import Request, urlopen
from urllib.error import URLError
from html.parser import HTMLParser
from threading import Lock
import json
import os
import re
import shutil
import subprocess
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parent
COMMUNITY = 'https://steamcommunity.com'
DETAILS = 'https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/'
DOWNLOAD_LOCK = Lock()
STATIC = {'/': ('index.html', 'text/html'), '/app.js': ('app.js', 'text/javascript'),
          '/style.css': ('style.css', 'text/css')}


class Problem(Exception):
    def __init__(self, status, message):
        self.status = status
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
    app = identifier(query.get('app', '294100'))
    raw_page = query.get('page', '1')
    if not re.fullmatch(r'[1-9][0-9]{0,3}', raw_page):
        raise Problem(400, 'Неверный номер страницы.')
    sort = query.get('sort', 'trend')
    if sort not in {'trend', 'mostrecent', 'totaluniquesubscribers'}:
        raise Problem(400, 'Неизвестная сортировка.')
    params = {'appid': app, 'searchtext': query.get('q', '')[:120], 'browsesort': sort,
              'section': 'readytouseitems', 'p': raw_page, 'numperpage': 18}
    parser = WorkshopLinks()
    html = steam(f'{COMMUNITY}/workshop/browse/?{urlencode(params)}').decode(errors='replace')
    parser.feed(html)
    page_count = re.search(r'total_pages\\?"\s*:\s*([0-9]+)', html)
    ids = list(parser.ids)
    found = details(ids[:50]) if ids else {}
    return {'items': [found[item] for item in ids if item in found and found[item]['app'] == app],
            'more': int(raw_page) < int(page_count[1]) if page_count else len(ids) >= 18}


def get_item(item_id):
    item = details([identifier(item_id)]).get(item_id)
    if not item:
        raise Problem(404, 'Steam не нашёл публичный предмет с таким ID.')
    return item


def download(item, archive):
    executable = shutil.which(os.environ.get('STEAMCMD', 'steamcmd'))
    if not executable:
        raise Problem(503, 'Установите SteamCMD и добавьте его в PATH или задайте переменную STEAMCMD.')
    app, item_id = identifier(item['app']), item['id']
    executable = Path(executable).absolute()
    with tempfile.TemporaryDirectory(prefix='workshop-dock-') as directory:
        destination = Path(directory)
        try:
            result = subprocess.run(
                [str(executable), '+@ShutdownOnFailedCommand', '1', '+@NoPromptForPassword', '1',
                 '+force_install_dir', directory, '+login', 'anonymous',
                 '+workshop_download_item', app, item_id, 'validate', '+quit'],
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, errors='replace', timeout=900,
            )
        except subprocess.TimeoutExpired as exc:
            raise Problem(504, 'SteamCMD не завершил загрузку за 15 минут.') from exc
        match = re.search(r'Success\. Downloaded item ' + item_id + r' to "([^"\r\n]+)"', result.stdout)
        if not match:
            print(result.stdout[-2500:], flush=True)
            if re.search(r'Failure|Access Denied|No subscription|Not Logged On', result.stdout, re.I):
                raise Problem(502, 'SteamCMD отклонил загрузку. Эта игра может требовать аккаунт или лицензию.')
            raise Problem(502, 'SteamCMD не подтвердил загрузку. Подробности в консоли сервера.')
        raw_path = Path(match[1])
        source = (raw_path if raw_path.is_absolute() else destination / raw_path).resolve()
        if source.parts[-4:] != ('workshop', 'content', app, item_id) or not source.is_dir():
            raise Problem(502, 'Папка скачанного мода не найдена.')
        with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED, compresslevel=3) as output:
            for path in source.rglob('*'):
                if path.is_file() and not path.is_symlink() and path.resolve().is_relative_to(source):
                    output.write(path, path.relative_to(source).as_posix())
            if not output.namelist():
                raise Problem(502, 'В папке мода нет файлов.')


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
            if address.path != '/api/download':
                raise Problem(404, 'Страница не найдена.')
            port = self.server.server_port
            allowed = {f'127.0.0.1:{port}', f'localhost:{port}'}
            host = self.headers.get('Host')
            if host not in allowed or self.headers.get('Origin') != f'http://{host}':
                raise Problem(403, 'Запустите загрузку со страницы Workshop Dock.')
            item = get_item(parse_qs(address.query).get('id', [''])[0])
            if item['file']:
                return self.json({'url': item['file']})
            if not DOWNLOAD_LOCK.acquire(blocking=False):
                raise Problem(409, 'Дождитесь завершения текущей загрузки.')
            try:
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
            self.json({'error': str(exc)}, exc.status)
        except (BrokenPipeError, ConnectionResetError):
            pass


if __name__ == '__main__':
    port = int(os.environ.get('PORT', '8765'))
    with ThreadingHTTPServer(('127.0.0.1', port), Handler) as server:
        print(f'Workshop Dock · http://127.0.0.1:{port}', flush=True)
        server.serve_forever()
