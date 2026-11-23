import { createServer } from 'node:http'
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { DatabaseSync } from 'node:sqlite'
import { starter } from './public/starter.js'

const root = fileURLToPath(new URL('./public/', import.meta.url))
const file = resolve(process.env.DATA_FILE || 'data/pole.sqlite')
mkdirSync(dirname(file), { recursive: true })
const db = new DatabaseSync(file)
db.exec(`PRAGMA journal_mode=WAL;
  CREATE TABLE IF NOT EXISTS boards (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, items TEXT NOT NULL,
    updated INTEGER NOT NULL, revision INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY)`)
const insert = db.prepare('INSERT INTO boards (id,title,items,updated) VALUES (?,?,?,?)')
db.exec('BEGIN IMMEDIATE')
if (db.prepare("INSERT OR IGNORE INTO settings VALUES ('initialized')").run().changes) {
  insert.run(randomUUID(), 'Первые идеи', JSON.stringify(starter), Date.now())
}
db.exec('COMMIT')

const password = process.env.POLE_PASSWORD
const digest = value => createHash('sha256').update(value).digest()
const auth = password && digest('Basic ' + Buffer.from('pole:' + password).toString('base64'))
const mime = { html: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8', woff2: 'font/woff2' }
const getBoard = db.prepare('SELECT * FROM boards WHERE id=?')
const fonts = ['Manrope', 'Golos Text', 'PT Serif', 'Comfortaa', 'IBM Plex Mono']
const colors = ['violet', 'green', 'peach', 'blue', 'white']
const kinds = ['note', 'text', 'rect', 'ellipse']
function validItem(item) {
  return item && typeof item.id === 'string' && item.id.length <= 64 &&
    kinds.includes(item.kind) && colors.includes(item.color) && fonts.includes(item.font) &&
    typeof item.text === 'string' && item.text.length <= 4000 &&
    [item.x, item.y].every(value => Number.isFinite(value) && Math.abs(value) <= 1e7) &&
    [item.w, item.h].every(value => Number.isFinite(value) && value >= 28 && value <= 5000) &&
    Number.isFinite(item.size) && item.size >= 12 && item.size <= 120
}
function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(value))
}
function problem(status, message) { return Object.assign(new Error(message), { status }) }
async function payload(req) {
  if (req.headers['content-type']?.split(';')[0] !== 'application/json') {
    throw problem(415, 'Ожидается JSON')
  }
  const chunks = []
  let bytes = 0
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    bytes += chunk.length
    if (bytes > 8 * 1024 * 1024) {
      req.resume()
      throw problem(413, 'Доска слишком велика для сохранения')
    }
    chunks.push(chunk)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString()) }
  catch { throw problem(400, 'Некорректный JSON') }
}
const decode = row => ({ ...row, items: JSON.parse(row.items) })
const server = createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'")
  if (auth && !timingSafeEqual(auth, digest(req.headers.authorization || ''))) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Pole"')
    return json(res, 401, { error: 'Введите пароль' })
  }
  const path = new URL(req.url, 'http://localhost').pathname
  try {
    if (path === '/api/boards') {
      if (req.method === 'GET') return json(res, 200, db.prepare('SELECT id,title,updated FROM boards ORDER BY updated DESC').all())
      if (req.method === 'POST') {
        await payload(req)
        const id = randomUUID()
        insert.run(id, 'Без названия', '[]', Date.now())
        return json(res, 201, decode(getBoard.get(id)))
      }
    }
    const match = path.match(/^\/api\/boards\/([a-f0-9-]{36})$/)
    if (match) {
      const [, id] = match
      if (req.method === 'GET') {
        const board = getBoard.get(id)
        return board ? json(res, 200, decode(board)) : json(res, 404, { error: 'Доска не найдена' })
      }
      if (req.method === 'PUT') {
        const input = await payload(req)
        if (!input || typeof input.title !== 'string' || !input.title.trim() || input.title.length > 120 ||
          !Array.isArray(input.items) || !input.items.every(validItem) ||
          new Set(input.items.map(item => item.id)).size !== input.items.length ||
          !Number.isSafeInteger(input.revision)) {
          throw problem(400, 'Некорректные данные доски')
        }
        const updated = Date.now()
        const result = db.prepare('UPDATE boards SET title=?,items=?,updated=?,revision=revision+1 WHERE id=? AND revision=?')
          .run(input.title, JSON.stringify(input.items), updated, id, input.revision)
        if (!result.changes) throw problem(409, 'Доска изменилась в другой вкладке')
        return json(res, 200, { revision: input.revision + 1, updated })
      }
      if (req.method === 'DELETE') {
        const revision = Number(req.headers['if-match'] ?? NaN)
        if (!Number.isSafeInteger(revision) || revision < 0) throw problem(400, 'Укажите версию доски')
        const result = db.prepare('DELETE FROM boards WHERE id=? AND revision=?').run(id, revision)
        if (!result.changes) throw problem(409, 'Доска изменилась в другой вкладке')
        return json(res, 200, { deleted: true })
      }
    }
    if (['GET', 'HEAD'].includes(req.method)) {
      const asset = path === '/' ? 'index.html' : path.slice(1)
      if (/^(?:[a-z][a-z0-9-]*\.(?:html|js|css)|fonts\/[a-z0-9-]+\.woff2)$/.test(asset)) {
        let data
        try { data = readFileSync(resolve(root, asset)) }
        catch (error) { if (error.code !== 'ENOENT') throw error }
        if (data) {
          res.writeHead(200, { 'Content-Type': mime[asset.split('.').at(-1)], 'Content-Length': data.length })
          return res.end(req.method === 'HEAD' ? undefined : data)
        }
      }
    }
    return json(res, 404, { error: 'Страница не найдена' })
  } catch (error) {
    if (!error.status) console.error(error)
    return json(res, error.status || 500, { error: error.status ? error.message : 'Ошибка сервера' })
  }
})
const { values: options } = parseArgs({ options: {
  host: { type: 'string' }, port: { type: 'string' }, strictPort: { type: 'boolean' }
} })
const host = options.host || process.env.HOST || '127.0.0.1'
const port = Number(options.port || process.env.PORT || 8080)
server.listen(port, host, () => console.log('Поле запущено на ' + host + ':' + port))
