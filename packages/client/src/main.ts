import { createApp } from 'vue'
import App from './App.vue'
import { router } from './router'
import { createAppRuntime, RUNTIME_KEY } from './app/AppRuntime'

// The composition root: every long-lived resource is created here (inside
// createAppRuntime) and torn down through the one shutdown() below. No other
// module creates resources at module scope, and no other module references
// page lifecycle or import.meta.hot.
const runtime = createAppRuntime()

createApp(App)
  .use(runtime.pinia)
  .use(router)
  .provide(RUNTIME_KEY, runtime)
  .mount('#app')

// Page teardown. `pagehide` covers navigation, tab close, AND bfcache-freeze
// (the frozen socket dies anyway; App.vue's pageshow.persisted handler force-
// reconnects on restore, and audio re-boots lazily on the next PLAY).
window.addEventListener('pagehide', () => runtime.shutdown())

// HMR (dev): a hot swap of this entry disposes the old core before the new one
// boots — dispose-and-recreate. Non-accepted module edits full-reload instead,
// which fires pagehide → the same shutdown. The ONLY import.meta.hot in the app.
if (import.meta.hot) {
  import.meta.hot.dispose(() => runtime.shutdown())
}
