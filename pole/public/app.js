const byId = id => document.getElementById(id)
const viewport = byId('viewport')
const world = byId('world')
const title = byId('title')
const status = byId('save-status')
const textField = byId('item-text')
const fontField = byId('item-font')
const sizeField = byId('item-size')
const fonts = ['Manrope', 'Golos Text', 'PT Serif', 'Comfortaa', 'IBM Plex Mono']
const palette = { violet: 'Сиреневый', green: 'Зелёный', peach: 'Персиковый', blue: 'Голубой', white: 'Белый' }
const labels = { note: 'Стикер', text: 'Текст', rect: 'Прямоугольник', ellipse: 'Овал' }
const gridStep = 24
const shortcuts = { KeyV: 'select', KeyH: 'pan', KeyN: 'note', KeyT: 'text', KeyR: 'rect', KeyO: 'ellipse' }

const viewOptions = { grid: true, snapGrid: false, snapItems: true }
const viewOptionsKey = 'pole.viewOptions'
try {
  const saved = JSON.parse(localStorage.getItem(viewOptionsKey))
  for (const key of Object.keys(viewOptions)) {
    if (typeof saved?.[key] === 'boolean') viewOptions[key] = saved[key]
  }
} catch {
  // The controls still work when the browser blocks storage.
}
viewport.dataset.grid = String(viewOptions.grid)
for (const input of document.querySelectorAll('[data-view-option]')) {
  const key = input.dataset.viewOption
  input.checked = viewOptions[key]
  input.onchange = () => {
    viewOptions[key] = input.checked
    viewport.dataset.grid = String(viewOptions.grid)
    if (!viewOptions.snapItems) showGuides()
    try { localStorage.setItem(viewOptionsKey, JSON.stringify(viewOptions)) } catch {}
  }
}
const viewMenu = byId('view-options')
document.addEventListener('pointerdown', event => {
  if (!viewMenu.contains(event.target)) viewMenu.open = false
})
viewMenu.addEventListener('keydown', event => {
  if (event.key === 'Escape' && viewMenu.open) {
    event.stopPropagation()
    viewMenu.open = false
    viewMenu.querySelector('summary').focus()
  }
})

let list = []
let board
let selected
let tool = 'select'
let space = false
let drag
let camera = { x: 0, y: 0, k: 1 }
let history = []
let future = []
let dirty = false
let busy = false
let pending
let timer
let failure

async function api(path = '', options) {
  const response = await fetch('/api/boards' + path, options)
  const data = await response.json()
  if (!response.ok) throw Object.assign(new Error(data.error || 'Ошибка запроса'), { status: response.status })
  return data
}
const write = (path, method, data) => api(path, {
  method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data)
})
const item = () => board?.items.find(value => value.id === selected)
const snapshot = () => structuredClone({ title: board.title, items: board.items })
function checkpoint() {
  history.push(snapshot())
  if (history.length > 80) history.shift()
  future = []
  renderHistory()
}
function renderHistory() {
  byId('undo').disabled = !history.length
  byId('redo').disabled = !future.length
}
function undo(redo = false) {
  const from = redo ? future : history
  const to = redo ? history : future
  if (busy || drag || !from.length) return
  to.push(snapshot())
  Object.assign(board, from.pop())
  if (!item()) selected = undefined
  title.value = board.title
  changed()
  renderItems()
  renderInspector()
  renderHistory()
}
function showStatus(message, error = false) {
  status.textContent = message
  status.dataset.error = String(error)
  status.disabled = !error
}
function changed() {
  dirty = true
  showStatus('Сохранение…')
  clearTimeout(timer)
  timer = setTimeout(flush, 350)
  const entry = list.find(value => value.id === board.id)
  if (entry && entry.title !== board.title) {
    entry.title = board.title
    renderList()
  }
}
function flush() {
  clearTimeout(timer)
  if (pending) return pending
  if (!dirty) return Promise.resolve(true)
  pending = (async () => {
    try {
      while (dirty) {
        dirty = false
        const result = await write('/' + board.id, 'PUT', board)
        Object.assign(board, result)
      }
      failure = undefined
      showStatus('✓ Сохранено')
      return true
    } catch (error) {
      dirty = true
      failure = error
      showStatus(error.status === 409 ? 'Конфликт версий' : 'Повторить сохранение', true)
      return false
    } finally {
      pending = undefined
    }
  })()
  return pending
}
status.onclick = async () => {
  if (failure?.status === 409) {
    if (confirm('Скачать ваши изменения в JSON и открыть версию с сервера?')) {
      const id = board.id
      download()
      await run(async () => {
        const current = await api('/' + id)
        const entry = list.find(value => value.id === id)
        if (entry) entry.title = current.title
        activate(current)
      })
    }
  } else if (dirty) {
    await flush()
  } else {
    await run(init)
  }
}
window.addEventListener('beforeunload', event => {
  if (dirty || pending || drag?.itemChanged) event.preventDefault()
})
window.addEventListener('online', () => {
  if (dirty && failure?.status !== 409) flush()
})
function renderList() {
  const entries = document.createDocumentFragment()
  for (const entry of list) {
    const link = document.createElement('button')
    link.className = 'board-link'
    link.setAttribute('aria-current', String(board?.id === entry.id))
    const icon = document.createElement('span')
    icon.className = 'board-icon'
    icon.setAttribute('aria-hidden', 'true')
    icon.textContent = '▦'
    const name = document.createElement('span')
    name.textContent = entry.title
    link.append(icon, name)
    link.onclick = () => {
      if (board?.id !== entry.id) run(async () => {
        if (await flush()) activate(await api('/' + entry.id))
      })
      if (matchMedia('(max-width:660px)').matches) setSidebar(false)
    }
    entries.append(link)
  }
  byId('boards').replaceChildren(entries)
}
function setSidebar(open) {
  document.body.classList.toggle('sidebar-collapsed', !open)
  byId('toggle-boards').setAttribute('aria-expanded', String(open))
}
byId('toggle-boards').onclick = () => setSidebar(document.body.classList.contains('sidebar-collapsed'))
if (matchMedia('(max-width:660px)').matches) setSidebar(false)

function activate(value) {
  board = value
  failure = undefined
  dirty = false
  selected = undefined
  drag = undefined
  showGuides()
  history = []
  future = []
  title.value = board?.title || ''
  title.disabled = !board
  byId('export').disabled = !board
  byId('delete-board').disabled = !board
  for (const id of ['tools', 'zoom', 'canvas-hint']) byId(id).hidden = !board
  byId('empty').hidden = Boolean(board)
  if (board) {
    const url = new URL(location.href)
    url.searchParams.set('board', board.id)
    window.history.replaceState(null, '', url)
  } else {
    window.history.replaceState(null, '', location.pathname)
  }
  showStatus(board ? '✓ Сохранено' : '')
  setTool('select')
  fit()
  renderList()
  renderItems()
  renderInspector()
  renderHistory()
}
async function run(action) {
  if (busy || drag) return
  busy = true
  title.blur()
  try { await action() }
  catch (error) {
    failure = error
    showStatus(error.message || 'Ошибка подключения', true)
  } finally {
    busy = false
  }
}
function create() {
  run(async () => {
    if (!await flush()) return
    const next = await write('', 'POST', {})
    list.unshift(next)
    activate(next)
    if (matchMedia('(max-width:660px)').matches) setSidebar(false)
    title.select()
  })
}
for (const id of ['create', 'new-board', 'empty-create']) byId(id).onclick = create
title.onchange = () => {
  if (!board) return
  const name = title.value.trim() || 'Без названия'
  title.value = name
  if (name === board.title) return
  checkpoint()
  board.title = name
  changed()
}
title.onkeydown = event => { if (event.key === 'Enter') title.blur() }
byId('delete-board').onclick = () => run(async () => {
  if (!board || !confirm('Удалить доску «' + board.title + '»?')) return
  if (!await flush()) return
  const id = board.id
  await api('/' + id, { method: 'DELETE', headers: { 'If-Match': String(board.revision) } })
  activate(undefined)
  list = list.filter(entry => entry.id !== id)
  renderList()
  if (list.length) activate(await api('/' + list[0].id))
})
function download() {
  if (!board) return
  const url = URL.createObjectURL(new Blob([JSON.stringify(snapshot(), null, 2)], { type: 'application/json' }))
  const link = document.createElement('a')
  link.href = url
  link.download = board.title.replace(/[\\/:*?"<>|]/g, '_') + '.json'
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 5000)
}
byId('export').onclick = download

function drawItem(el, value) {
  Object.assign(el.style, {
    left: value.x + 'px', top: value.y + 'px', width: value.w + 'px', height: value.h + 'px',
    fontFamily: '"' + value.font + '", sans-serif', fontSize: value.size + 'px'
  })
  el.dataset.color = value.color
  el.firstElementChild.textContent = value.text
  el.setAttribute('aria-label', value.text || labels[value.kind])
}
function renderItems() {
  const elements = document.createDocumentFragment()
  for (const value of board?.items || []) {
    const el = document.createElement('div')
    el.className = 'item ' + value.kind
    el.dataset.id = value.id
    el.tabIndex = 0
    el.setAttribute('role', 'button')
    const content = document.createElement('div')
    content.className = 'content'
    el.append(content)
    if (value.id === selected) {
      el.classList.add('selected')
      const handle = document.createElement('span')
      handle.className = 'resize'
      el.append(handle)
    }
    drawItem(el, value)
    elements.append(el)
  }
  world.replaceChildren(elements)
}
function select(id) {
  selected = id
  renderItems()
  renderInspector()
}
function renderInspector() {
  const value = item()
  byId('inspector').hidden = !value
  if (!value) return
  byId('item-kind').textContent = labels[value.kind]
  textField.value = value.text
  fontField.value = value.font
  sizeField.value = value.size
  byId('color-group').hidden = value.kind === 'text'
  for (const button of byId('swatches').children) {
    button.setAttribute('aria-pressed', String(button.dataset.color === value.color))
  }
}
function edit(fields, remember = true) {
  const value = item()
  if (!value || busy) return
  if (remember) checkpoint()
  Object.assign(value, fields)
  const el = Array.from(world.children).find(child => child.dataset.id === value.id)
  if (el) drawItem(el, value)
  changed()
}
for (const font of fonts) {
  const option = new Option(font, font)
  option.style.fontFamily = '"' + font + '"'
  fontField.add(option)
}
for (const [color, name] of Object.entries(palette)) {
  const button = document.createElement('button')
  button.dataset.color = color
  button.title = name
  button.setAttribute('aria-label', name)
  button.onclick = () => {
    if (item()?.color !== color) edit({ color })
    renderInspector()
  }
  byId('swatches').append(button)
}
let typing = false
textField.onfocus = () => { typing = false }
textField.oninput = () => {
  edit({ text: textField.value }, !typing)
  typing = true
}
fontField.onchange = () => edit({ font: fontField.value })
sizeField.onchange = () => {
  const size = Math.max(12, Math.min(120, sizeField.valueAsNumber || item()?.size || 18))
  sizeField.value = size
  if (size !== item()?.size) edit({ size })
}
byId('close-inspector').onclick = () => select()
function remove() {
  if (!item() || busy) return
  checkpoint()
  board.items = board.items.filter(value => value.id !== selected)
  select()
  changed()
}
byId('delete-item').onclick = remove

function setTool(next) {
  tool = next
  viewport.dataset.tool = next
  viewport.dataset.add = String(Boolean(labels[next]))
  for (const button of document.querySelectorAll('[data-tool].tool')) {
    button.setAttribute('aria-pressed', String(button.dataset.tool === next))
  }
}
for (const button of document.querySelectorAll('[data-tool].tool')) button.onclick = () => setTool(button.dataset.tool)
byId('undo').onclick = () => undo()
byId('redo').onclick = () => undo(true)
function updateCamera() {
  const { x, y, k } = camera
  world.style.transform = 'translate(' + x + 'px, ' + y + 'px) scale(' + k + ')'
  viewport.style.backgroundSize = gridStep * k + 'px ' + gridStep * k + 'px'
  viewport.style.backgroundPosition = x + 'px ' + y + 'px'
  byId('zoom-reset').textContent = Math.round(k * 100) + '%'
}
function fit() {
  if (!board?.items.length) {
    camera = { x: 0, y: 0, k: 1 }
  } else {
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity
    for (const value of board.items) {
      left = Math.min(left, value.x)
      top = Math.min(top, value.y)
      right = Math.max(right, value.x + value.w)
      bottom = Math.max(bottom, value.y + value.h)
    }
    const w = viewport.clientWidth, h = viewport.clientHeight
    const k = Math.max(.1, Math.min(1, (w - 56) / (right - left), (h - 136) / (bottom - top)))
    camera = { x: Math.max(25, (w - (right - left) * k) / 2) - left * k,
      y: Math.max(84, (h - (bottom - top) * k) / 2) - top * k, k }
  }
  updateCamera()
}
function zoom(next, x = viewport.clientWidth / 2, y = viewport.clientHeight / 2) {
  const k = Math.min(3, Math.max(.1, next))
  camera.x = x - (x - camera.x) * k / camera.k
  camera.y = y - (y - camera.y) * k / camera.k
  camera.k = k
  updateCamera()
}
byId('zoom-in').onclick = () => zoom(camera.k * 1.2)
byId('zoom-out').onclick = () => zoom(camera.k / 1.2)
byId('zoom-reset').onclick = () => zoom(1)
byId('fit').onclick = fit
viewport.addEventListener('wheel', event => {
  if (!board) return
  event.preventDefault()
  const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientHeight : 1
  if (event.ctrlKey || event.metaKey) {
    const rect = viewport.getBoundingClientRect()
    zoom(camera.k * Math.exp(-event.deltaY * unit * .008), event.clientX - rect.left, event.clientY - rect.top)
  } else {
    camera.x -= event.deltaX * unit
    camera.y -= event.deltaY * unit
    updateCamera()
  }
}, { passive: false })
const coordinate = value => Math.min(1e7, Math.max(-1e7, value))
const dimension = value => Math.max(28, Math.min(5000, value))
const snapGrid = value => viewOptions.snapGrid ? Math.round(value / gridStep) * gridStep : value

function snapAxis(position, offsets, axis, extent, value) {
  if (!viewOptions.snapItems) return { position: snapGrid(position) }
  let best
  let distance = 7 / camera.k
  for (const other of board.items) {
    if (other.id === value.id) continue
    const start = other[axis]
    const size = other[extent]
    for (const guide of [start, start + size / 2, start + size]) {
      for (const offset of offsets) {
        const candidate = guide - offset
        if (Math.abs(candidate - position) < distance) {
          distance = Math.abs(candidate - position)
          best = { position: candidate, guide }
        }
      }
    }
  }
  return best ?? { position: snapGrid(position) }
}
function showGuides(x, y) {
  const vertical = byId('guide-x')
  const horizontal = byId('guide-y')
  vertical.hidden = x === undefined
  horizontal.hidden = y === undefined
  if (!vertical.hidden) vertical.style.left = camera.x + x * camera.k + 'px'
  if (!horizontal.hidden) horizontal.style.top = camera.y + y * camera.k + 'px'
}
function addAt(event) {
  const rect = viewport.getBoundingClientRect()
  const kind = tool
  const value = {
    id: globalThis.crypto?.randomUUID?.() || 'item-' + Date.now() + '-' + Math.random().toString(36).slice(2),
    kind, x: coordinate(snapGrid((event.clientX - rect.left - camera.x) / camera.k)),
    y: coordinate(snapGrid((event.clientY - rect.top - camera.y) / camera.k)),
    w: kind === 'text' ? 250 : 200, h: kind === 'text' ? 75 : kind === 'note' ? 170 : 115,
    font: 'Manrope', size: kind === 'text' ? 26 : 19, color: kind === 'note' ? 'violet' : 'blue',
    text: ''
  }
  checkpoint()
  board.items.push(value)
  setTool('select')
  select(value.id)
  changed()
  textField.focus({ preventScroll: true })
}
viewport.onpointerdown = event => {
  if (!board || busy || drag || ![0, 1].includes(event.button)) return
  const target = event.target.closest('.item')
  if (!space && event.button === 0 && labels[tool]) {
    addAt(event)
    return
  }
  const pan = space || tool === 'pan' || event.button === 1 || !target
  if (pan && !target && tool === 'select' && !space && event.button === 0) select()
  const resize = event.target.classList.contains('resize')
  if (!pan && selected !== target.dataset.id) select(target.dataset.id)
  const value = pan ? camera : item()
  drag = { id: event.pointerId, sx: event.clientX, sy: event.clientY,
    x: value.x, y: value.y, w: value.w, h: value.h, pan, resize }
  if (event.button === 1) event.preventDefault()
}
viewport.onpointermove = event => {
  if (drag?.id !== event.pointerId) return
  const dx = event.clientX - drag.sx, dy = event.clientY - drag.sy
  if (!drag.moved && Math.hypot(dx, dy) < 3) return
  if (!drag.moved) {
    viewport.setPointerCapture(event.pointerId)
    viewport.classList.add('dragging')
    drag.moved = true
    if (!drag.pan) {
      checkpoint()
      drag.itemChanged = true
    }
  }
  if (drag.pan) {
    camera.x = drag.x + dx
    camera.y = drag.y + dy
    updateCamera()
  } else {
    const value = item()
    const x = drag.x + dx / camera.k
    const y = drag.y + dy / camera.k
    let sx, sy
    if (drag.resize) {
      sx = snapAxis(drag.x + dimension(drag.w + dx / camera.k), [0], 'x', 'w', value)
      sy = snapAxis(drag.y + dimension(drag.h + dy / camera.k), [0], 'y', 'h', value)
      value.w = dimension(sx.position - drag.x)
      value.h = dimension(sy.position - drag.y)
      showGuides(value.w === sx.position - drag.x ? sx.guide : undefined,
        value.h === sy.position - drag.y ? sy.guide : undefined)
    } else {
      sx = snapAxis(x, [0, value.w / 2, value.w], 'x', 'w', value)
      sy = snapAxis(y, [0, value.h / 2, value.h], 'y', 'h', value)
      value.x = coordinate(sx.position)
      value.y = coordinate(sy.position)
      showGuides(value.x === sx.position ? sx.guide : undefined,
        value.y === sy.position ? sy.guide : undefined)
    }
    drawItem(world.querySelector('.selected'), value)
  }
}
function endDrag(event) {
  if (drag?.id !== event.pointerId) return
  if (drag.itemChanged) changed()
  viewport.classList.remove('dragging')
  showGuides()
  drag = undefined
}
window.addEventListener('pointerup', endDrag)
viewport.onpointercancel = viewport.onlostpointercapture = endDrag
viewport.ondblclick = event => {
  const target = event.target.closest('.item')
  if (!target || tool !== 'select' || space) return
  if (selected !== target.dataset.id) select(target.dataset.id)
  textField.focus()
  textField.select()
}
byId('shortcuts').onclick = () => byId('shortcut-dialog').showModal()
window.addEventListener('keydown', event => {
  if (!board || busy || drag || byId('shortcut-dialog').open ||
      event.target.matches('input,textarea,select')) return
  if ((event.ctrlKey || event.metaKey) && event.code === 'KeyZ') {
    event.preventDefault()
    undo(event.shiftKey)
    return
  }
  if (event.ctrlKey || event.metaKey || event.altKey) return
  if (event.code === 'Space' && !event.target.closest('button,[role=button]')) {
    event.preventDefault()
    space = true
    viewport.classList.add('space')
  }
  if (event.code === 'Escape') {
    select()
    setTool('select')
  }
  if (event.code === 'Delete' || event.code === 'Backspace') {
    event.preventDefault()
    remove()
  }
  if (shortcuts[event.code]) setTool(shortcuts[event.code])
  if (['Enter', 'Space'].includes(event.code) && event.target.matches('.item')) {
    event.preventDefault()
    select(event.target.dataset.id)
    textField.focus()
  }
})
function releaseSpace() {
  space = false
  viewport.classList.remove('space')
}
window.addEventListener('keyup', event => { if (event.code === 'Space') releaseSpace() })
window.addEventListener('blur', releaseSpace)

async function init() {
  list = await api()
  const requested = new URL(location.href).searchParams.get('board')
  const initial = list.find(entry => entry.id === requested) || list[0]
  activate(initial ? await api('/' + initial.id) : undefined)
}
run(init)
