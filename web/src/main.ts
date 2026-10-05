import { createPinia } from 'pinia';
import { createApp } from 'vue';

import App from './App.vue';
import './assets/theme.css';
import { i18n } from './i18n';
import { useThemeStore } from './stores/theme';

const app = createApp(App);
app.use(createPinia());
app.use(i18n);
useThemeStore().applyToDocument();
app.mount('#app');
