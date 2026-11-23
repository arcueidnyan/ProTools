const $ = id => document.getElementById(id)
let page = 1
let browseController
let lookupController
let downloadBusy = false
let currentItem

async function api(path, options) {
  const response = await fetch(path, options)
  if (!response.ok) throw new Error((await response.json()).error)
  return response
}

function size(bytes) {
  if (bytes >= 1e9) return new Intl.NumberFormat('ru', {maximumFractionDigits: 1}).format(bytes / 1e9) + ' ГБ'
  if (bytes >= 1e6) return new Intl.NumberFormat('ru', {maximumFractionDigits: 1}).format(bytes / 1e6) + ' МБ'
  return Math.max(1, Math.round(bytes / 1000)) + ' КБ'
}

function element(tag, className, value) {
  const node = document.createElement(tag)
  node.className = className
  if (value) node.textContent = value
  return node
}

function card(item) {
  const button = element('button', 'card')
  const visual = element('div', 'visual')
  if (item.image) {
    const image = element('img', '')
    image.loading = 'lazy'
    image.alt = ''
    image.src = item.image
    image.addEventListener('error', () => image.remove())
    visual.append(image)
  }
  const info = element('div', 'card-body')
  const meta = [item.size ? size(item.size) : '', item.subscriptions ? item.subscriptions.toLocaleString('ru') + ' подписчиков' : ''].filter(Boolean)
  info.append(element('strong', '', item.title), element('span', 'meta', meta.join(' · ')))
  button.append(visual, info)
  button.addEventListener('click', () => openItem(item))
  return button
}

async function browse(target = 1) {
  if (!$('filters').reportValidity()) return
  browseController?.abort()
  const controller = new AbortController()
  browseController = controller
  const app = $('game').value === 'custom' ? $('custom').value : $('game').value
  const query = new URLSearchParams({app, sort: $('sort').value, q: $('search').value.trim(), page: target})
  $('catalog-status').textContent = 'Загружаем каталог…'
  $('results').replaceChildren()
  $('pagination').hidden = true
  try {
    const payload = await (await api('/api/browse?' + query, {signal: controller.signal})).json()
    if (controller.signal.aborted) return
    page = target
    $('results').replaceChildren(...payload.items.map(card))
    $('catalog-status').textContent = payload.items.length ? '' : 'Моды не найдены. Попробуйте другой запрос или App ID.'
    $('pagination').hidden = !(page > 1 || payload.more)
    $('prev').disabled = page <= 1
    $('next').disabled = !payload.more
    $('page').textContent = 'Страница ' + page
  } catch (error) {
    if (!controller.signal.aborted) $('catalog-status').textContent = error.message
  }
}

function workshopId(value) {
  if (/^[0-9]+$/.test(value)) return value
  try {
    const url = new URL(value.startsWith('steamcommunity.com/') ? 'https://' + value : value)
    if (['http:', 'https:'].includes(url.protocol) && url.hostname === 'steamcommunity.com' &&
        /^\/(sharedfiles|workshop)\/filedetails\/?$/.test(url.pathname)) {
      return url.searchParams.get('id')
    }
  } catch {}
  return null
}

function openItem(item) {
  currentItem = item
  $('item-title').textContent = item.title
  $('item-image').hidden = !item.image
  if (item.image) $('item-image').src = item.image
  else $('item-image').removeAttribute('src')
  $('item-meta').textContent = ['App ID ' + item.app, 'Workshop ID ' + item.id, item.size ? size(item.size) : ''].filter(Boolean).join(' · ')
  $('item-description').textContent = item.description || 'Описание отсутствует.'
  $('steam-page').href = 'https://steamcommunity.com/sharedfiles/filedetails/?id=' + item.id
  $('download').textContent = item.file ? 'Скачать файл' : 'Скачать ZIP'
  $('download').disabled = downloadBusy
  $('download-status').textContent = downloadBusy ? 'Выполняется другая загрузка…' :
    item.file ? '' : 'ZIP доступен, если Steam разрешает анонимную загрузку для этой игры.'
  if (!$('item-dialog').open) $('item-dialog').showModal()
}

$('item-image').addEventListener('error', () => { $('item-image').hidden = true })
$('lookup').addEventListener('submit', async event => {
  event.preventDefault()
  lookupController?.abort()
  const id = workshopId($('link').value.trim())
  if (!id) {
    $('lookup-status').textContent = 'Вставьте ссылку Steam Workshop или числовой ID.'
    return
  }
  const controller = new AbortController()
  lookupController = controller
  $('lookup-status').textContent = 'Ищем мод…'
  try {
    const item = await (await api('/api/item?id=' + encodeURIComponent(id), {signal: controller.signal})).json()
    if (controller.signal.aborted) return
    $('lookup-status').textContent = ''
    openItem(item)
  } catch (error) {
    if (!controller.signal.aborted) $('lookup-status').textContent = error.message
  }
})

$('download').addEventListener('click', async () => {
  const item = currentItem
  if (item.file) {
    window.open(item.file, '_blank', 'noopener,noreferrer')
    return
  }
  downloadBusy = true
  $('download').disabled = true
  $('download-status').textContent = 'SteamCMD скачивает мод и собирает ZIP…'
  let message
  try {
    const response = await api('/api/download?id=' + item.id, {method: 'POST'})
    if (response.headers.get('content-type').startsWith('application/json')) {
      window.location.assign((await response.json()).url)
      message = 'Открываем ссылку на файл Steam.'
    } else {
      const url = URL.createObjectURL(await response.blob())
      const link = element('a', '')
      link.href = url
      link.download = 'workshop-' + item.id + '.zip'
      link.click()
      setTimeout(() => URL.revokeObjectURL(url), 60_000)
      message = 'ZIP передан браузеру.'
    }
  } catch (error) {
    message = error.message
  } finally {
    downloadBusy = false
    $('download').disabled = false
    $('download-status').textContent = currentItem.id === item.id ? message : ''
  }
})
$('filters').addEventListener('submit', event => { event.preventDefault(); browse() })
$('game').addEventListener('change', () => {
  const custom = $('game').value === 'custom'
  $('custom-label').hidden = !custom
  $('custom').disabled = !custom
  $('custom').required = custom
  if (custom) $('custom').focus()
  else browse()
})
$('sort').addEventListener('change', () => browse())
$('prev').addEventListener('click', () => browse(page - 1))
$('next').addEventListener('click', () => browse(page + 1))
browse()
