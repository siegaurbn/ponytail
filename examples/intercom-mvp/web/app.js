const $ = id => document.getElementById(id);
let token, portalUrl, currentCall, polling = false, nativePending = new Map();
const deviceId = localStorage.deviceId || (localStorage.deviceId = crypto.randomUUID());
function hasNative() { return !!(window.IntercomNative || window.webkit?.messageHandlers.intercom); }
function native(action, data = {}) {
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { nativePending.delete(id); reject(new Error('Мобильный модуль не отвечает')); }, 15000);
    nativePending.set(id, { resolve, reject, timer });
    const message = { id, action, ...data };
    if (window.IntercomNative) window.IntercomNative.postMessage(JSON.stringify(message));
    else if (window.webkit?.messageHandlers.intercom) window.webkit.messageHandlers.intercom.postMessage(message);
    else { clearTimeout(timer); nativePending.delete(id); reject(new Error('Требуется мобильное приложение')); }
  });
}
window.intercomResult = (id, error, value) => {
  const pending = nativePending.get(id); if (!pending) return;
  clearTimeout(pending.timer); nativePending.delete(id);
  error ? pending.reject(new Error(error)) : pending.resolve(value);
};
window.intercomEvent = async event => {
  if (['registration_failed', 'sip_error'].includes(event.type)) $('message').textContent = 'Голосовая связь не подключена. Проверьте настройки SIP.';
  if (event.type === 'push_registration_failed') $('message').textContent = 'Фоновые вызовы не подключены. Проверьте настройки push.';
  if (event.type === 'established' && currentCall?.sipCallId === event.sipCallId) {
    await api(`/api/calls/${currentCall.id}/active`, { deviceId }).catch(showError);
  }
  if (event.type === 'closed' && currentCall?.sipCallId === event.sipCallId) {
    await api(`/api/calls/${currentCall.id}/end`, { deviceId }).catch(showError);
  }
  refresh().catch(showError);
};
const messages = { unauthorized: 'Неверный токен', door_forbidden: 'Нет доступа к двери', unlock_outcome_unknown: 'Результат открытия неизвестен. Проверьте дверь перед повтором.', http_unavailable: 'Открытие по HTTP недоступно', answered_elsewhere: 'Вызов принят на другом устройстве', video_unavailable: 'Камера недоступна', dtmf_requires_active_call: 'Для открытия нужен активный разговор' };
function showError(error) { $('message').textContent = messages[error.message] || { internal_error: 'Временная ошибка сервиса', rate_limited: 'Слишком много запросов. Подождите минуту.' }[error.message] || error.message; }
async function request(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { ...options.headers, Authorization: `Bearer ${token}` } });
  if (!response.ok) { const data = await response.json().catch(() => ({})); throw new Error(data.error || 'Ошибка подключения'); }
  return response;
}
async function api(path, data) {
  return (await request(path, data ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) } : {})).json();
}
const player = new WhepPlayer($('video'), request);
async function refresh() {
  if (!token || polling) return;
  polling = true;
  try {
    const { calls } = await api('/api/calls');
    currentCall = calls.find(call => !call.deviceId || call.deviceId === deviceId);
    $('call').hidden = !currentCall;
    if (currentCall) {
      $('caller').textContent = currentCall.name;
      $('call-state').textContent = { ringing: 'Входящий вызов', answering: 'Подключаем разговор', active: 'Разговор' }[currentCall.state];
      $('answer').disabled = currentCall.state !== 'ringing' || !hasNative();
    }
  } finally { polling = false; }
}
$('login').onsubmit = async event => {
  event.preventDefault(); token = $('token').value;
  try {
    const bootstrap = await api('/api/bootstrap'); portalUrl = bootstrap.portalUrl;
    if (hasNative()) await native('configureApi', { token, deviceId });
    $('doors').replaceChildren();
    for (const door of bootstrap.doors) {
      const section = document.createElement('section'); section.className = 'door';
      const title = document.createElement('h2'); title.textContent = door.name; section.append(title);
      const open = document.createElement('button'); open.textContent = 'Открыть дверь';
      open.onclick = async () => {
        open.disabled = true;
        try {
          const result = await api(`/api/doors/${door.id}/unlock`, { requestId: crypto.randomUUID(), callId: currentCall?.id, deviceId });
          if (result.method === 'dtmf') { await native('dtmf', result); $('message').textContent = 'Команда открытия отправлена по DTMF'; }
          else $('message').textContent = 'Панель приняла команду открытия';
        } catch (error) { showError(error); } finally { open.disabled = false; }
      };
      const watch = document.createElement('button'); watch.textContent = 'Камера';
      watch.onclick = async () => { watch.disabled = true; try { $('video').hidden = false; $('stop-video').hidden = false; await player.play(door.id); } catch (error) { showError(error); } finally { watch.disabled = false; } };
      section.append(open, watch); $('doors').append(section);
    }
    $('login').hidden = true; $('token').value = ''; $('connection').textContent = bootstrap.mode === 'demo' ? 'Демо · реле имитируются' : 'Подключено'; $('portal').hidden = !portalUrl;
    await refresh();
  } catch (error) { showError(error); }
};
$('answer').onclick = async () => {
  try { await api(`/api/calls/${currentCall.id}/answer`, { deviceId }); await native('answer', { callId: currentCall.id, sipCallId: currentCall.sipCallId }); await refresh(); }
  catch (error) { showError(error); }
};
$('end').onclick = async () => {
  try { if (hasNative()) await native('end', { sipCallId: currentCall.sipCallId }); await api(`/api/calls/${currentCall.id}/end`, { deviceId }); await refresh(); }
  catch (error) { showError(error); }
};
$('stop-video').onclick = async () => { await player.stop(); $('video').hidden = true; $('stop-video').hidden = true; };
$('portal').onclick = () => hasNative() ? native('portal', { url: portalUrl }).catch(showError) : window.open(portalUrl, '_blank', 'noopener');
setInterval(() => refresh().catch(showError), 2000);
