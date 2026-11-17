// 마감 알림을 받는 서비스 워커. 서버가 Web Push 로 {title, body} 를 보낸다.
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()))

self.addEventListener('push', e => {
  let d = {}
  try { d = e.data.json() } catch { d = { title: '우리 집', body: e.data ? e.data.text() : '' } }
  e.waitUntil(self.registration.showNotification(d.title || '우리 집', { body: d.body || '', tag: d.title }))
})

self.addEventListener('notificationclick', e => {
  e.notification.close()
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    .then(ws => ws.length ? ws[0].focus() : self.clients.openWindow('./')))
})
