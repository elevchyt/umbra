/**
 * WebGL2 capability probe. Everything downstream branches on this rather than on
 * `getExtension` calls scattered through the codebase (spec 03 §1: one GPU abstraction).
 */

export interface GpuCaps {
  renderer: string;
  vendor: string;
  maxTextureSize: number;
  maxArrayLayers: number;
  maxTextureUnits: number;
  /** RGBA16 textures for 16-bit layer storage. */
  norm16: boolean;
  /**
   * Whether RGBA16 also works as a colour attachment. On the reference NVIDIA/ANGLE box it
   * does NOT, so 16-bit documents store RGBA16 but accumulate into RGBA16F.
   */
  norm16Renderable: boolean;
  colorBufferFloat: boolean;
  colorBufferHalfFloat: boolean;
  floatLinear: boolean;
  parallelShaderCompile: boolean;
  loseContext: WEBGL_lose_context | null;
  /** True when the renderer string looks like a software rasteriser. */
  softwareRasterizer: boolean;
}

const SOFTWARE_HINTS = ['swiftshader', 'llvmpipe', 'softpipe', 'software', 'microsoft basic'];

export function probeCaps(gl: WebGL2RenderingContext): GpuCaps {
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  const renderer = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : '(masked)';
  const vendor = dbg ? String(gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL)) : '(masked)';

  const norm16 = !!gl.getExtension('EXT_texture_norm16');
  gl.getExtension('EXT_color_buffer_float');
  gl.getExtension('EXT_color_buffer_half_float');

  return {
    renderer,
    vendor,
    maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE) as number,
    maxArrayLayers: gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS) as number,
    maxTextureUnits: gl.getParameter(gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS) as number,
    norm16,
    norm16Renderable: norm16 && isRenderable(gl, 0x805b /* RGBA16_EXT */),
    colorBufferFloat: isRenderable(gl, gl.RGBA32F),
    colorBufferHalfFloat: isRenderable(gl, gl.RGBA16F),
    floatLinear: !!gl.getExtension('OES_texture_float_linear'),
    parallelShaderCompile: !!gl.getExtension('KHR_parallel_shader_compile'),
    loseContext: gl.getExtension('WEBGL_lose_context'),
    softwareRasterizer: SOFTWARE_HINTS.some((h) => renderer.toLowerCase().includes(h)),
  };
}

/** Advertised extensions can still fail as colour attachments; verify for real. */
function isRenderable(gl: WebGL2RenderingContext, internalFormat: number): boolean {
  const tex = gl.createTexture();
  const fb = gl.createFramebuffer();
  try {
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, internalFormat, 4, 4);
    if (gl.getError() !== gl.NO_ERROR) return false;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    return gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
  } catch {
    return false;
  } finally {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.deleteFramebuffer(fb);
    gl.deleteTexture(tex);
  }
}

/** Human-readable summary for Help ▸ System Info and the spike report. */
export function describeCaps(c: GpuCaps): string {
  return [
    `renderer: ${c.renderer}`,
    `vendor: ${c.vendor}`,
    `maxTextureSize: ${c.maxTextureSize}`,
    `maxArrayLayers: ${c.maxArrayLayers}`,
    `norm16: ${c.norm16} (renderable: ${c.norm16Renderable})`,
    `colorBufferFloat: ${c.colorBufferFloat}`,
    `colorBufferHalfFloat: ${c.colorBufferHalfFloat}`,
    `software: ${c.softwareRasterizer}`,
  ].join('\n');
}
