// One shared AudioContext for playback and capture. It must be created /
// resumed from a user gesture (iOS Safari), so callers go through ensure().

let ctx: AudioContext | null = null;

export async function ensureAudio(): Promise<AudioContext> {
  if (!ctx) {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    ctx = new AC({ latencyHint: 'interactive' });
  }
  if (ctx.state !== 'running') {
    try { await ctx.resume(); } catch { /* resumed on next gesture */ }
  }
  return ctx;
}

export function audioContext(): AudioContext | null {
  return ctx;
}

export const isIOS = (): boolean =>
  /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
