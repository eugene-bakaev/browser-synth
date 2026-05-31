import { createRouter, createMemoryHistory } from 'vue-router';
import StudioView from '../views/StudioView.vue';
import AccountView from '../views/AccountView.vue';

// Memory history on purpose: this app already encodes the collaboration room in
// the address bar as `/r/<roomId>` (see sync/roomId.ts), owned via raw
// history.replaceState. A path-based router (createWebHistory) fights that — it
// would redirect `/` → `/studio`, drop the room id on every nav, and mint a new
// empty room (wiping the pattern) on each reload. Memory history keeps Studio vs
// Account purely in-memory and never touches the URL, so `/r/<roomId>` survives
// navigation and reloads exactly as before the router existed.
// Trade-off: Studio/Account aren't reflected in the URL and a refresh always
// lands on Studio — acceptable here; room links `/r/<id>` still work.
export const router = createRouter({
  history: createMemoryHistory(),
  routes: [
    { path: '/', redirect: '/studio' },
    { path: '/studio', name: 'studio', component: StudioView },
    { path: '/account', name: 'account', component: AccountView },
  ],
});
