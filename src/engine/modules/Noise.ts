const noiseBufferCache = new WeakMap<AudioContext, AudioBuffer>();

/**
 * Returns a cached 2-second mono white noise AudioBuffer for the given AudioContext.
 */
export function getNoiseBuffer(ctx: AudioContext): AudioBuffer {
  let buffer = noiseBufferCache.get(ctx);
  if (!buffer) {
    const bufferSize = ctx.sampleRate * 2; // 2 seconds of noise
    buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = Math.random() * 2 - 1;
    }
    noiseBufferCache.set(ctx, buffer);
  }
  return buffer;
}
