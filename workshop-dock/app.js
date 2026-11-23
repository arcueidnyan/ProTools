const $ = id => document.getElementById(id)
let page = 1
let totalPages = 0
let categoryApp
let browseController
let lookupController
const jobs = new Map()
let processingQueue = false
let extrasController
let currentItem

async function api(path, options) {
  let response
  try {
    response = await fetch(path, options)
  } catch (error) {
    if (error.name === 'AbortError') throw error
    throw new Error('Связь с Workshop Dock потеряна. Запустите EXE заново и используйте открывшуюся вкладку.')
  }
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}))
    const error = new Error(payload.error || 'Workshop Dock вернул ошибку HTTP ' + response.status + '.')
    error.details = payload.details
    throw error
  }
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
  const container = element('article', 'card')
  const button = element('button', 'card-open')
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
  const download = element('button', 'card-download', 'Скачать')
  download.dataset.downloadId = item.id
  download.setAttribute('aria-label', 'Скачать ' + item.title)
  download.addEventListener('click', () => enqueue(item))
  syncDownloadButton(download, item.id)
  container.append(button, download)
  return container
}

function renderPagination() {
  $('pagination').hidden = false
  $('page').textContent = totalPages ? `Страница ${page} · Всего страниц: ${totalPages}` : 'Всего страниц: 0'
  document.querySelector('#pagination > .page-controls').hidden = totalPages <= 1
  $('first').disabled = $('prev').disabled = page <= 1
  $('last').disabled = $('next').disabled = page >= totalPages

  const count = Math.min(5, totalPages)
  const start = Math.max(1, Math.min(page - 2, totalPages - count + 1))
  const buttons = Array.from({length: count}, (_, index) => {
    const number = start + index
    const button = element('button', 'secondary', String(number))
    button.setAttribute('aria-label', 'Страница ' + number)
    if (number === page) button.setAttribute('aria-current', 'page')
    else button.addEventListener('click', () => browse(number, true))
    return button
  })
  $('page-numbers').replaceChildren(...buttons)
}

function renderCategories(categories) {
  if (!Array.isArray(categories)) return
  const select = $('category')
  const all = element('option', '', 'Все категории')
  all.value = ''
  const options = categories.map(category => {
    const option = element('option', '', category.label)
    option.value = category.tag
    return option
  })
  select.replaceChildren(all, ...options)
  select.value = options.some(option => option.value === activeFilters.category) ? activeFilters.category : ''
  $('category-label').hidden = options.length === 0
}

let activeFilters
async function browse(target = 1, fromPagination = false) {
  if (!fromPagination) {
    if (!$('filters').reportValidity()) return
    const app = $('game').value === 'custom' ? $('custom').value : $('game').value
    if (categoryApp !== app) {
      categoryApp = app
      renderCategories([])
    }
    activeFilters = {
      app,
      category: $('category').value,
      sort: $('sort').value,
      q: $('search').value.trim(),
    }
  }
  browseController?.abort()
  const controller = new AbortController()
  browseController = controller
  const query = new URLSearchParams({...activeFilters, page: target})
  $('catalog-status').textContent = 'Загружаем каталог…'
  $('results').replaceChildren()
  $('pagination').hidden = true
  try {
    const payload = await (await api('/api/browse?' + query, {signal: controller.signal})).json()
    if (controller.signal.aborted) return
    totalPages = payload.totalPages
    if (totalPages && target > totalPages) {
      return browse(totalPages, true)
    }
    page = totalPages ? target : 1
    renderCategories(payload.categories)
    $('results').replaceChildren(...payload.items.map(card))
    $('catalog-status').textContent = payload.items.length ? '' : 'Моды не найдены. Попробуйте другой запрос или App ID.'
    renderPagination()
    if (fromPagination) {
      $('catalog-title').focus({preventScroll: true})
      $('catalog-title').scrollIntoView()
    }
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

function steamLink(url, label) {
  const link = element('a', '', label)
  link.href = url
  link.target = '_blank'
  link.rel = 'noopener noreferrer'
  return link
}

function showGallery(media) {
  let index = 0
  const container = $('item-media')
  container.hidden = !media.length
  $('gallery-controls').hidden = media.length <= 1
  function show() {
    const item = media[index]
    $('gallery-content').replaceChildren()
    if (!item) return
    if (item.kind === 'youtube') {
      const player = element('iframe', 'gallery-player')
      player.title = 'Видео ' + (index + 1)
      player.src = 'https://www.youtube-nocookie.com/embed/' + item.id
      player.referrerPolicy = 'strict-origin-when-cross-origin'
      player.allowFullscreen = true
      $('gallery-content').append(player, steamLink('https://www.youtube.com/watch?v=' + item.id, 'Открыть на YouTube'))
    } else {
      const image = element('img', 'gallery-image')
      image.alt = 'Скриншот ' + (index + 1)
      image.src = item.url
      const original = steamLink(item.url, '')
      original.append(image)
      $('gallery-content').append(original)
    }
    $('gallery-position').textContent = (index + 1) + ' / ' + media.length
    $('gallery-prev').disabled = index === 0
    $('gallery-next').disabled = index === media.length - 1
  }
  $('gallery-prev').onclick = () => { index -= 1; show() }
  $('gallery-next').onclick = () => { index += 1; show() }
  show()
}

async function openItem(item) {
  extrasController?.abort()
  const controller = new AbortController()
  extrasController = controller
  currentItem = item
  $('item-download-notice').textContent = ''
  $('item-title').textContent = item.title
  showGallery(item.image ? [{kind: 'image', url: item.image}] : [])
  $('requirements').hidden = true
  $('item-extras-status').textContent = 'Загружаем галерею и зависимости…'
  $('item-meta').textContent = ['App ID ' + item.app, 'Workshop ID ' + item.id, item.size ? size(item.size) : ''].filter(Boolean).join(' · ')
  $('item-description').textContent = item.description || 'Описание отсутствует.'
  $('steam-page').href = 'https://steamcommunity.com/sharedfiles/filedetails/?id=' + item.id
  syncDownloadButton($('download'), item.id)
  if (!$('item-dialog').open) $('item-dialog').showModal()
  try {
    const {media, requirements} = await (await api('/api/item-extras?id=' + item.id, {signal: controller.signal})).json()
    if (controller.signal.aborted) return
    $('item-extras-status').textContent = ''
    if (media.length) showGallery(media)
    $('requirements').hidden = !requirements.length
    $('required-items').replaceChildren(...requirements.map(requirement => {
      const row = element('li', 'row')
      row.append(steamLink(requirement.url, requirement.title || requirement.url))
      if (requirement.id) {
        const button = element('button', 'secondary', 'Скачать')
        button.dataset.downloadId = requirement.id
        button.setAttribute('aria-label', 'Скачать зависимость ' + (requirement.title || requirement.id))
        syncDownloadButton(button, requirement.id)
        button.addEventListener('click', () => enqueue(requirement))
        row.append(button)
      }
      return row
    }))
  } catch (error) {
    if (!controller.signal.aborted) $('item-extras-status').textContent = error.message
  }
}

$('item-dialog').addEventListener('close', () => {
  if ($('item-dialog').open) return
  extrasController?.abort()
  $('gallery-content').replaceChildren()
})

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

const stageLabels = {
  preparing: 'Подготовка SteamCMD…',
  updating: 'Обновление SteamCMD…',
  downloading: 'Скачивание мода…',
  packing: 'Упаковка ZIP…',
  organizing: 'Подготовка папки мода…',
  transferring: 'Передача ZIP браузеру…',
}

function syncDownloadButton(button, id) {
  const job = jobs.get(id)
  button.disabled = ['queued', 'active'].includes(job?.state)
  button.textContent = job?.state === 'queued' ? 'В очереди' :
    job?.state === 'active' ? 'Загрузка…' : 'Скачать'
}

function updateDownloadButtons() {
  for (const button of document.querySelectorAll('[data-download-id]')) {
    syncDownloadButton(button, button.dataset.downloadId)
  }
  if (currentItem) syncDownloadButton($('download'), currentItem.id)
}

function createJob(item) {
  const row = element('li', 'job')
  const name = element('strong', '', item.title || 'Workshop ' + item.id)
  const status = element('span', 'status')
  const progress = element('progress', '')
  progress.max = 100
  progress.setAttribute('aria-label', 'Прогресс загрузки ' + name.textContent)
  const result = element('div', 'job-result')
  row.append(name, status, progress, result)
  return {id: item.id, row, status, progress, result, state: 'queued'}
}

function setJobStatus(job, status, percent) {
  job.status.textContent = Number.isFinite(percent) ? status + ' ' + percent + '%' : status
  job.progress.hidden = job.state !== 'active'
  if (Number.isFinite(percent)) job.progress.value = percent
  else job.progress.removeAttribute('value')
}

function enqueue(item) {
  const existing = jobs.get(item.id)
  if (['queued', 'active'].includes(existing?.state)) return
  if (existing?.url) URL.revokeObjectURL(existing.url)
  existing?.row.remove()
  jobs.delete(item.id)
  const job = createJob(item)
  jobs.set(item.id, job)
  $('download-queue').hidden = false
  $('queue-link').hidden = false
  $('queue-items').append(job.row)
  setJobStatus(job, 'В очереди')
  $('queue-notice').textContent = 'Добавлено в очередь: ' + (item.title || item.id)
  if ($('item-dialog').open) $('item-download-notice').textContent = $('queue-notice').textContent
  if (item.file && item.app !== '233860') {
    job.state = 'done'
    setJobStatus(job, 'Прямой файл Steam')
    const link = steamLink(item.file, 'Скачать файл')
    job.result.append(link)
    link.click()
    $('queue-notice').textContent = 'Прямая ссылка открыта: ' + (item.title || item.id)
    if ($('item-dialog').open) $('item-download-notice').textContent = $('queue-notice').textContent
  } else {
    processQueue()
  }
  updateDownloadButtons()
}

async function processQueue() {
  if (processingQueue) return
  processingQueue = true
  try {
    for (const job of jobs.values()) {
      if (job.state !== 'queued') continue
      await downloadJob(job)
    }
  } finally {
    processingQueue = false
  }
}

async function downloadJob(job) {
  job.state = 'active'
  updateDownloadButtons()
  setJobStatus(job, 'Подготовка загрузки…')
  let polling = false
  const timer = setInterval(async () => {
    if (polling) return
    polling = true
    try {
      const payload = await (await api('/api/download-progress?id=' + job.id)).json()
      if (job.state === 'active' && stageLabels[payload.stage]) {
        setJobStatus(job, stageLabels[payload.stage], payload.percent)
      }
    } catch {
      // The download request provides the final result.
    } finally {
      polling = false
    }
  }, 650)
  try {
    const response = await api('/api/download?id=' + job.id, {method: 'POST'})
    if (response.headers.get('content-type').startsWith('application/json')) {
      const payload = await response.json()
      job.state = 'done'
      if (payload.modFolder) setJobStatus(job, 'Папка мода готова: ' + payload.modFolder)
      else if (payload.saved) setJobStatus(job, 'ZIP сохранён: ' + payload.saved)
      else {
        setJobStatus(job, 'Прямой файл Steam')
        job.result.append(steamLink(payload.url, 'Скачать файл'))
      }
    } else {
      job.url = URL.createObjectURL(await response.blob())
      const link = element('a', '', 'Скачать ZIP')
      link.href = job.url
      link.download = 'workshop-' + job.id + '.zip'
      job.result.append(link)
      link.click()
      job.state = 'done'
      setJobStatus(job, 'ZIP готов')
    }
  } catch (error) {
    job.state = 'error'
    setJobStatus(job, error.message)
    if (error.details) {
      const details = element('details', '')
      details.append(element('summary', '', 'Сообщение SteamCMD'), element('pre', 'download-log', error.details))
      job.result.append(details)
    }
  } finally {
    clearInterval(timer)
    updateDownloadButtons()
  }
}

$('download').addEventListener('click', () => enqueue(currentItem))
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
$('category').addEventListener('change', () => browse())
$('first').addEventListener('click', () => browse(1, true))
$('last').addEventListener('click', () => browse(totalPages, true))
$('prev').addEventListener('click', () => browse(page - 1, true))
$('next').addEventListener('click', () => browse(page + 1, true))
browse()


function showDownloadFolder(folder) {
  $('folder-path').textContent = folder || 'Выберите папку без кириллицы в полном пути, например C:\\Mods.'
}

$('choose-folder').addEventListener('click', async () => {
  const button = $('choose-folder')
  button.disabled = true
  const previous = $('folder-path').textContent
  $('folder-path').textContent = 'Выберите папку в открывшемся окне Windows…'
  try {
    const payload = await (await api('/api/download-folder', {method: 'POST'})).json()
    showDownloadFolder(payload.folder)
  } catch (error) {
    $('folder-path').textContent = previous + ' · ' + error.message
  } finally {
    button.disabled = false
  }
})

api('/api/download-folder')
  .then(response => response.json())
  .then(({enabled, folder, canExit}) => {
    $('close-app').hidden = !canExit
    $('download-folder').hidden = !enabled
    showDownloadFolder(folder)
  })
  .catch(() => {})

$('close-app').addEventListener('click', async () => {
  if (processingQueue) {
    window.alert('Дождитесь завершения очереди загрузок.')
    return
  }
  const button = $('close-app')
  button.disabled = true
  try {
    await api('/api/shutdown', {method: 'POST'})
    document.querySelector('main').replaceChildren(element('p', 'status', 'Workshop Dock закрыт. Эту вкладку можно закрыть.'))
    button.hidden = true
    $('queue-link').hidden = true
  } catch (error) {
    window.alert(error.message)
  } finally {
    button.disabled = false
  }
})
