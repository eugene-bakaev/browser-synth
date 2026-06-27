import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import { router } from './router'

// Pinia must be installed before the router so any store used during a route's
// setup has an active instance. Phase 0: no store is consumed yet, but the
// instance must exist for the later phases that migrate reads into the store.
createApp(App).use(createPinia()).use(router).mount('#app')
