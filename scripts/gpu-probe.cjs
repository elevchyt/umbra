// Standalone GPU capability probe: `node_modules/.bin/electron scripts/gpu-probe.cjs`
// Prints the WebGL2 feature set Umbra depends on, then exits. Used by M0 spike 2.
const { app, BrowserWindow } = require('electron');

const PROBE = `
(() => {
  const c = new OffscreenCanvas(64, 64);
  const gl = c.getContext('webgl2', { antialias: false, premultipliedAlpha: false });
  if (!gl) return { ok: false, error: 'no webgl2' };
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  const ext = (n) => !!gl.getExtension(n);
  const norm16 = ext('EXT_texture_norm16');
  // Verify norm16 is actually usable as a colour-attachment, not merely advertised.
  let norm16Renderable = false;
  if (norm16) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, 0x8054 /* RGBA16 */, 8, 8);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    norm16Renderable = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.deleteFramebuffer(fb); gl.deleteTexture(tex);
  }
  return {
    ok: true,
    renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : '(masked)',
    vendor: dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : '(masked)',
    version: gl.getParameter(gl.VERSION),
    maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
    maxArrayLayers: gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS),
    maxRenderbufferSize: gl.getParameter(gl.MAX_RENDERBUFFER_SIZE),
    maxTextureUnits: gl.getParameter(gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS),
    maxDrawBuffers: gl.getParameter(gl.MAX_DRAW_BUFFERS),
    norm16, norm16Renderable,
    colorBufferFloat: ext('EXT_color_buffer_float'),
    colorBufferHalfFloat: ext('EXT_color_buffer_half_float'),
    floatLinear: ext('OES_texture_float_linear'),
    parallelShaderCompile: ext('KHR_parallel_shader_compile'),
    loseContext: ext('WEBGL_lose_context'),
    crossOriginIsolated: globalThis.crossOriginIsolated === true,
    sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
    hardwareConcurrency: navigator.hardwareConcurrency,
    deviceMemory: navigator.deviceMemory ?? null,
  };
})()
`;

app.disableHardwareAcceleration === undefined; // no-op guard for older majors
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 64, height: 64 });
  await win.loadURL('data:text/html,<title>probe</title>');
  try {
    const res = await win.webContents.executeJavaScript(PROBE);
    console.log(JSON.stringify(res, null, 2));
    process.exitCode = res.ok ? 0 : 1;
  } catch (e) {
    console.error('probe failed:', e);
    process.exitCode = 1;
  }
  app.quit();
});
