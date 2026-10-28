// 本地偏好设置：动效强度与顶部提示条。
// 不进 profile——那是"玩过什么"的档案，这里是"怎么显示"的开关，
// 分开存以后重置成就也不会把偏好一并清掉。

const SETTINGS_KEY = 'landlordlike.settings.v1';

export interface Settings {
  /** 减弱动效：旋转只滚一圈、面板不做弹入、数字不做缓动 */
  reducedMotion: boolean;
  /** 顶部提示条（新信件、成就解锁、错误提示之外的轻提示） */
  toasts: boolean;
}

/** 系统级偏好作为默认值：开了"减少动态效果"的玩家不该先被闪一下 */
function systemReducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

export function defaultSettings(): Settings {
  return { reducedMotion: systemReducedMotion(), toasts: true };
}

export function loadSettings(): Settings {
  const base = defaultSettings();
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return base;
    const data = JSON.parse(raw) as Partial<Settings>;
    return {
      reducedMotion: typeof data.reducedMotion === 'boolean' ? data.reducedMotion : base.reducedMotion,
      toasts: typeof data.toasts === 'boolean' ? data.toasts : base.toasts,
    };
  } catch {
    return base;
  }
}

export function saveSettings(settings: Settings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    /* 隐私模式存不下：本次会话内仍然生效 */
  }
}

/** 把设置反映到根节点上，样式表用 html[data-motion] 选择器接管 */
export function applySettings(settings: Settings): void {
  const root = document.documentElement;
  root.dataset.motion = settings.reducedMotion ? 'reduced' : 'full';
}
