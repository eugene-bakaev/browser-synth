import { createRouter, createWebHistory } from 'vue-router';
import StudioView from '../views/StudioView.vue';
import AccountView from '../views/AccountView.vue';

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', redirect: '/studio' },
    { path: '/studio', name: 'studio', component: StudioView },
    { path: '/account', name: 'account', component: AccountView },
  ],
});
