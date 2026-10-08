import './style.css';
import { clear, type Screen } from './ui/dom.ts';
import { trainerScreen } from './ui/trainer.ts';
import { micTestScreen } from './ui/mictest.ts';
import { statsScreen } from './ui/stats.ts';
import { settingsScreen } from './ui/settings.ts';

const screens: Record<string, () => Screen> = {
  train: trainerScreen,
  mic: micTestScreen,
  stats: statsScreen,
  settings: settingsScreen,
};

const root = document.getElementById('screen')!;
let current: Screen | null = null;

function route() {
  const name = location.hash.replace(/^#\/?/, '') || 'train';
  const make = screens[name] ?? screens.train;
  current?.leave?.();
  clear(root);
  current = make();
  root.append(current.el);
  document.querySelectorAll<HTMLAnchorElement>('#tabs a').forEach((a) => a.classList.toggle('active', a.dataset.tab === name));
  window.scrollTo(0, 0);
}

window.addEventListener('hashchange', route);
route();

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(import.meta.env.BASE_URL + 'sw.js').catch(() => {});
  });
}
